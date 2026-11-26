// Passkey (WebAuthn) shim for Conn GPUI's browser. WebAuthn transport only: the Vault Mac app is
// the authenticator and does all cryptography, as it does for its Chrome extension. The wire
// format mirrors Vault's `ChromeExtension/passkeys-main.js`; the error mapping mirrors Conn's
// Electron `PasskeyBridge.ts`.
//
// Conn injects this into the main frame of an HTTPS page before the page's scripts run, with
// `__CONN_PASSKEY_TOKEN__` replaced by a random token it made for this page load. The token stays
// in this closure. Conn answers a request only when it carries the token, which a subframe cannot
// read, and it takes the page's address from the browser, never from a message.
(function (TOKEN) {
  "use strict";
  try {
    if (window !== window.top || !window.isSecureContext || location.protocol !== "https:") return;
    if (
      typeof PublicKeyCredential === "undefined" ||
      typeof CredentialsContainer === "undefined" ||
      !navigator.credentials
    ) {
      return;
    }
    if (window.__CONN_GPUI_PASSKEYS__) return;
    Object.defineProperty(window, "__CONN_GPUI_PASSKEYS__", { value: true });

    const PREFIX = "__CONN_OVERLAY_RPC__:";
    const MAX_TIMEOUT_MS = 120000;
    const MAX_OPTIONS_BYTES = 12000;
    const MAX_BUFFER_BYTES = 4096;
    const NOT_ALLOWED_MESSAGE =
      "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.";
    const NAMES = new Set([
      "AbortError",
      "InvalidStateError",
      "NotAllowedError",
      "NotSupportedError",
      "SecurityError",
    ]);

    const debug = console.debug.bind(console);
    const emit = (message) => {
      try {
        debug(PREFIX + JSON.stringify(Object.assign({ type: "passkey", token: TOKEN }, message)));
      } catch (_) {}
    };

    const nativeCreate = CredentialsContainer.prototype.create;
    const nativeGet = CredentialsContainer.prototype.get;
    const define = (target, key, value) =>
      Object.defineProperty(target, key, { value, configurable: true, writable: true });

    // One ceremony at a time, as in the extension: Conn refuses a second one too.
    const pending = new Map();

    const failure = (name) =>
      new DOMException(NOT_ALLOWED_MESSAGE, NAMES.has(name) ? name : "NotAllowedError");
    const abortReason = (signal) =>
      signal.reason !== undefined ? signal.reason : new DOMException("The operation was aborted.", "AbortError");

    const encode = (value) => {
      let bytes;
      if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      } else if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
        bytes = new Uint8Array(value);
      } else {
        throw new TypeError("The passkey request options are invalid.");
      }
      if (!bytes.length) throw new TypeError("The passkey request options are invalid.");
      if (bytes.length > MAX_BUFFER_BYTES) {
        throw new DOMException("Unsupported passkey buffer.", "NotSupportedError");
      }
      let binary = "";
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const decode = (value) => {
      const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    };

    // The extension's wire format: buffers are base64url without padding, wrapped as `{publicKey}`.
    const wire = (key) => {
      const result = Object.assign({}, key, { challenge: encode(key.challenge) });
      if (key.user) result.user = Object.assign({}, key.user, { id: encode(key.user.id) });
      for (const list of ["allowCredentials", "excludeCredentials"]) {
        if (key[list]) {
          result[list] = Array.from(key[list], (item) => Object.assign({}, item, { id: encode(item.id) }));
        }
      }
      return JSON.stringify({ publicKey: result });
    };

    const withValues = (target, values) => {
      for (const key of Object.keys(values)) {
        Object.defineProperty(target, key, { value: values[key], enumerable: true, configurable: true });
      }
      return target;
    };

    // Rebuilds the credential from Vault's JSON, as `passkeys-main.js` does.
    const credential = (value, creating) => {
      const source = value.response;
      const buffers = {};
      for (const key of creating
        ? ["clientDataJSON", "attestationObject"]
        : ["clientDataJSON", "authenticatorData", "signature", "userHandle"]) {
        buffers[key] = source[key] == null ? null : decode(source[key]);
      }
      const response = withValues(
        Object.create((creating ? AuthenticatorAttestationResponse : AuthenticatorAssertionResponse).prototype),
        buffers,
      );
      if (creating) {
        const transports = source.transports || ["internal"];
        withValues(response, {
          getTransports: () => Array.from(transports),
          getAuthenticatorData: () => decode(source.authenticatorData),
          getPublicKey: () => (source.publicKey ? decode(source.publicKey) : null),
          getPublicKeyAlgorithm: () => source.publicKeyAlgorithm,
        });
      }
      const extensionResults = value.clientExtensionResults || {};
      return withValues(Object.create(PublicKeyCredential.prototype), {
        id: value.id,
        rawId: decode(value.rawId),
        type: "public-key",
        authenticatorAttachment: value.authenticatorAttachment == null ? "platform" : value.authenticatorAttachment,
        response,
        getClientExtensionResults: () => extensionResults,
        // Browser ponyfills replace this with their own serializer.
        toJSON: () => value,
      });
    };

    const settle = (id) => {
      const entry = pending.get(id);
      if (!entry) return null;
      pending.delete(id);
      clearTimeout(entry.timer);
      if (entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
      return entry;
    };

    // Conn's answer. Anything that does not match a pending request is dropped.
    Object.defineProperty(window, "__CONN_PASSKEY_REPLY__", {
      value: (id, ok, payload) => {
        const entry = settle(String(id));
        if (!entry) return;
        if (ok) {
          try {
            entry.resolve(credential(JSON.parse(payload), entry.creating));
          } catch (_) {
            entry.reject(failure("NotAllowedError"));
          }
        } else {
          entry.reject(failure(payload));
        }
      },
    });

    const run = (mode, options) => {
      const signal = options.signal;
      if (signal && signal.aborted) return Promise.reject(abortReason(signal));
      let json;
      try {
        json = wire(options.publicKey);
      } catch (error) {
        return Promise.reject(
          error instanceof DOMException || error instanceof TypeError
            ? error
            : new TypeError("The passkey request options are invalid."),
        );
      }
      if (new TextEncoder().encode(json).length > MAX_OPTIONS_BYTES) {
        return Promise.reject(new DOMException("Unsupported passkey request.", "NotSupportedError"));
      }
      if (pending.size) return Promise.reject(failure("NotAllowedError"));
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const requested = options.publicKey.timeout;
        const wait = Math.min(MAX_TIMEOUT_MS, Math.max(1000, typeof requested === "number" ? requested : MAX_TIMEOUT_MS));
        const entry = { resolve, reject, creating: mode === "passkey-create", signal, timer: 0, onAbort: null };
        entry.timer = setTimeout(() => {
          if (!settle(id)) return;
          emit({ op: "abort", id });
          reject(failure("NotAllowedError"));
        }, wait);
        if (signal) {
          entry.onAbort = () => {
            if (!settle(id)) return;
            emit({ op: "abort", id });
            reject(abortReason(signal));
          };
          signal.addEventListener("abort", entry.onAbort, { once: true });
        }
        pending.set(id, entry);
        emit({ op: "start", id, mode, options: json });
      });
    };

    // Conditional and silent requests stay with Chromium: Conn offers no passkey autofill.
    const delegated = (options) =>
      !options || !options.publicKey || options.mediation === "conditional" || options.mediation === "silent";

    define(CredentialsContainer.prototype, "create", function create(options) {
      return delegated(options) ? Reflect.apply(nativeCreate, this, arguments) : run("passkey-create", options);
    });
    define(CredentialsContainer.prototype, "get", function get(options) {
      return delegated(options) ? Reflect.apply(nativeGet, this, arguments) : run("passkey-get", options);
    });

    define(PublicKeyCredential, "isUserVerifyingPlatformAuthenticatorAvailable", async function () {
      return true;
    });
    define(PublicKeyCredential, "isConditionalMediationAvailable", async function () {
      return false;
    });
    const nativeCapabilities = PublicKeyCredential.getClientCapabilities;
    if (typeof nativeCapabilities === "function") {
      define(PublicKeyCredential, "getClientCapabilities", async function () {
        const native = await Reflect.apply(nativeCapabilities, PublicKeyCredential, []);
        return Object.assign({}, native, {
          conditionalCreate: false,
          conditionalGet: false,
          passkeyPlatformAuthenticator: true,
          userVerifyingPlatformAuthenticator: true,
        });
      });
    }
  } catch (_) {}
})("__CONN_PASSKEY_TOKEN__");
