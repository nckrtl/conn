// Tests for `browser_passkeys.js`, the passkey shim Conn injects into HTTPS pages.
// Run with `node --test crates/conn-app/src/panels/browser_passkeys.test.mjs` from `apps/conn-gpui`.
// The shim runs in a `node:vm` context with a stand-in for the WebAuthn classes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const PREFIX = "__CONN_OVERLAY_RPC__:";
const PLACEHOLDER = '"__CONN_PASSKEY_TOKEN__"';
const source = readFileSync(new URL("./browser_passkeys.js", import.meta.url), "utf8");

function page({ protocol = "https:", topFrame = true, secure = true } = {}) {
  class CredentialsContainer {
    create() {
      return Promise.resolve("native-create");
    }
    get() {
      return Promise.resolve("native-get");
    }
  }
  class PublicKeyCredential {}
  class AuthenticatorAttestationResponse {}
  class AuthenticatorAssertionResponse {}
  const messages = [];
  const timers = [];
  let uuid = 0;
  const sandbox = {
    CredentialsContainer,
    PublicKeyCredential,
    AuthenticatorAttestationResponse,
    AuthenticatorAssertionResponse,
    DOMException,
    TextEncoder,
    btoa,
    atob,
    location: { protocol },
    isSecureContext: secure,
    navigator: { credentials: new CredentialsContainer() },
    console: { debug: (line) => messages.push(line) },
    crypto: { randomUUID: () => `request-${++uuid}` },
    setTimeout: (fn, ms) => timers.push({ fn, ms, live: true }),
    clearTimeout: (handle) => {
      if (timers[handle - 1]) timers[handle - 1].live = false;
    },
  };
  sandbox.window = sandbox;
  sandbox.top = topFrame ? sandbox : {};
  vm.createContext(sandbox);
  assert.ok(source.includes(PLACEHOLDER), "the token placeholder is in the shim");
  vm.runInContext(source.replace(PLACEHOLDER, '"tok"'), sandbox);
  const sent = () =>
    messages.filter((line) => line.startsWith(PREFIX)).map((line) => JSON.parse(line.slice(PREFIX.length)));
  return { sandbox, sent, timers, CredentialsContainer, PublicKeyCredential };
}

const bytes = (...values) => new Uint8Array(values);
const getOptions = (extra = {}) => ({
  publicKey: { challenge: new Uint8Array(16).fill(1), rpId: "example.com", timeout: 5000, ...extra },
});

const assertion = {
  id: "AQID",
  rawId: "AQID",
  type: "public-key",
  authenticatorAttachment: "platform",
  clientExtensionResults: {},
  response: { clientDataJSON: "AQ", authenticatorData: "Ag", signature: "Aw", userHandle: "BA" },
};
const attestation = {
  id: "AQID",
  rawId: "AQID",
  type: "public-key",
  authenticatorAttachment: "platform",
  clientExtensionResults: { credProps: { rk: true } },
  response: {
    clientDataJSON: "AQ",
    attestationObject: "Ag",
    authenticatorData: "Aw",
    publicKey: "BA",
    publicKeyAlgorithm: -7,
    transports: ["internal"],
  },
};

test("sends a sign-in in the extension's wire format with the page token", async () => {
  const { sandbox, sent } = page();
  const options = getOptions({
    allowCredentials: [{ type: "public-key", id: bytes(1, 2, 3) }],
    user: undefined,
  });
  const result = sandbox.navigator.credentials.get(options);
  const [request] = sent();
  assert.equal(request.type, "passkey");
  assert.equal(request.token, "tok");
  assert.equal(request.op, "start");
  assert.equal(request.mode, "passkey-get");
  assert.equal(request.id, "request-1");
  const wire = JSON.parse(request.options);
  assert.deepEqual(Object.keys(wire), ["publicKey"]);
  assert.equal(wire.publicKey.challenge, "AQEBAQEBAQEBAQEBAQEBAQ");
  assert.equal(wire.publicKey.allowCredentials[0].id, "AQID");
  assert.equal(wire.publicKey.rpId, "example.com");

  sandbox.__CONN_PASSKEY_REPLY__("request-1", true, JSON.stringify(assertion));
  const credential = await result;
  assert.ok(credential instanceof sandbox.PublicKeyCredential);
  assert.ok(credential.response instanceof sandbox.AuthenticatorAssertionResponse);
  assert.equal(credential.id, "AQID");
  assert.deepEqual([...new Uint8Array(credential.rawId)], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(credential.response.signature)], [3]);
  assert.deepEqual([...new Uint8Array(credential.response.userHandle)], [4]);
  assert.equal(credential.authenticatorAttachment, "platform");
  assert.equal(JSON.stringify(credential.getClientExtensionResults()), "{}");
  assert.equal(credential.toJSON().id, "AQID");
});

test("sends a creation and rebuilds the attestation response", async () => {
  const { sandbox, sent } = page();
  const result = sandbox.navigator.credentials.create({
    publicKey: {
      challenge: bytes(...new Array(16).fill(9)),
      rp: { name: "Example", id: "example.com" },
      user: { id: bytes(7, 8), name: "nick", displayName: "Nick" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [{ type: "public-key", id: bytes(5) }],
    },
  });
  const [request] = sent();
  assert.equal(request.mode, "passkey-create");
  const wire = JSON.parse(request.options).publicKey;
  assert.equal(wire.user.id, "Bwg");
  assert.equal(wire.user.name, "nick");
  assert.equal(wire.excludeCredentials[0].id, "BQ");

  sandbox.__CONN_PASSKEY_REPLY__(request.id, true, JSON.stringify(attestation));
  const credential = await result;
  assert.ok(credential.response instanceof sandbox.AuthenticatorAttestationResponse);
  assert.deepEqual([...new Uint8Array(credential.response.attestationObject)], [2]);
  assert.deepEqual([...new Uint8Array(credential.response.getAuthenticatorData())], [3]);
  assert.deepEqual([...new Uint8Array(credential.response.getPublicKey())], [4]);
  assert.equal(credential.response.getPublicKeyAlgorithm(), -7);
  assert.equal(JSON.stringify(credential.response.getTransports()), '["internal"]');
  assert.equal(JSON.stringify(credential.getClientExtensionResults()), '{"credProps":{"rk":true}}');
});

test("maps Vault errors to DOMException names", async () => {
  for (const name of ["NotAllowedError", "InvalidStateError", "SecurityError", "NotSupportedError", "AbortError"]) {
    const { sandbox, sent } = page();
    const result = sandbox.navigator.credentials.get(getOptions());
    sandbox.__CONN_PASSKEY_REPLY__(sent()[0].id, false, name);
    await assert.rejects(result, (error) => error instanceof DOMException && error.name === name);
  }
  for (const unknown of ["Surprise", undefined]) {
    const { sandbox, sent } = page();
    const result = sandbox.navigator.credentials.get(getOptions());
    sandbox.__CONN_PASSKEY_REPLY__(sent()[0].id, false, unknown);
    await assert.rejects(result, (error) => error.name === "NotAllowedError");
  }
});

test("a bad credential rejects with NotAllowedError", async () => {
  const { sandbox, sent } = page();
  const result = sandbox.navigator.credentials.get(getOptions());
  sandbox.__CONN_PASSKEY_REPLY__(sent()[0].id, true, "not json");
  await assert.rejects(result, (error) => error.name === "NotAllowedError");
});

test("ignores a reply for a request it does not hold", async () => {
  const { sandbox, sent } = page();
  const result = sandbox.navigator.credentials.get(getOptions());
  sandbox.__CONN_PASSKEY_REPLY__("someone-else", true, JSON.stringify(assertion));
  sandbox.__CONN_PASSKEY_REPLY__(sent()[0].id, false, "NotAllowedError");
  await assert.rejects(result, (error) => error.name === "NotAllowedError");
});

test("allows one ceremony at a time", async () => {
  const { sandbox, sent } = page();
  const first = sandbox.navigator.credentials.get(getOptions());
  await assert.rejects(sandbox.navigator.credentials.get(getOptions()), (error) => error.name === "NotAllowedError");
  assert.equal(sent().length, 1);
  sandbox.__CONN_PASSKEY_REPLY__(sent()[0].id, true, JSON.stringify(assertion));
  await first;
  // The slot is free again.
  const next = sandbox.navigator.credentials.get(getOptions());
  assert.equal(sent().length, 2);
  sandbox.__CONN_PASSKEY_REPLY__(sent()[1].id, false, "NotAllowedError");
  await assert.rejects(next);
});

test("an AbortSignal cancels the ceremony and tells Conn", async () => {
  const { sandbox, sent } = page();
  const controller = new AbortController();
  const result = sandbox.navigator.credentials.get({ ...getOptions(), signal: controller.signal });
  controller.abort();
  await assert.rejects(result, (error) => error.name === "AbortError");
  assert.deepEqual(
    sent().map((message) => message.op),
    ["start", "abort"],
  );
  assert.equal(sent()[1].id, sent()[0].id);
  // A late reply cannot resolve it.
  sandbox.__CONN_PASSKEY_REPLY__(sent()[0].id, true, JSON.stringify(assertion));
});

test("an already aborted signal rejects without asking Conn", async () => {
  const { sandbox, sent } = page();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    sandbox.navigator.credentials.get({ ...getOptions(), signal: controller.signal }),
    (error) => error.name === "AbortError",
  );
  assert.equal(sent().length, 0);
});

test("times out like the extension: the page's timeout, between 1 s and 120 s", async () => {
  for (const [requested, expected] of [
    [500, 1000],
    [5000, 5000],
    [900000, 120000],
    [undefined, 120000],
  ]) {
    const { sandbox, sent, timers } = page();
    const result = sandbox.navigator.credentials.get(getOptions({ timeout: requested }));
    assert.equal(timers[0].ms, expected);
    timers[0].fn();
    await assert.rejects(result, (error) => error.name === "NotAllowedError");
    assert.deepEqual(
      sent().map((message) => message.op),
      ["start", "abort"],
    );
  }
});

test("other credential types and conditional requests stay native", async () => {
  const { sandbox, sent } = page();
  assert.equal(await sandbox.navigator.credentials.get({ password: true }), "native-get");
  assert.equal(await sandbox.navigator.credentials.get({}), "native-get");
  assert.equal(await sandbox.navigator.credentials.get(), "native-get");
  assert.equal(await sandbox.navigator.credentials.create({ password: { id: "a", password: "b" } }), "native-create");
  assert.equal(await sandbox.navigator.credentials.get({ ...getOptions(), mediation: "conditional" }), "native-get");
  assert.equal(await sandbox.navigator.credentials.get({ ...getOptions(), mediation: "silent" }), "native-get");
  assert.equal(sent().length, 0);
});

test("reports platform support and no conditional mediation", async () => {
  const { sandbox } = page();
  assert.equal(await sandbox.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), true);
  assert.equal(await sandbox.PublicKeyCredential.isConditionalMediationAvailable(), false);
});

test("rejects options it cannot encode", async () => {
  const { sandbox, sent } = page();
  await assert.rejects(
    sandbox.navigator.credentials.get({ publicKey: { rpId: "example.com" } }),
    (error) => error.name === "TypeError",
  );
  await assert.rejects(
    sandbox.navigator.credentials.get({ publicKey: { challenge: new Uint8Array(5000) } }),
    (error) => error.name === "NotSupportedError",
  );
  await assert.rejects(
    sandbox.navigator.credentials.get(getOptions({ allowCredentials: [{ type: "public-key", id: new Uint8Array(0) }] })),
    (error) => error.name === "TypeError",
  );
  const big = sandbox.navigator.credentials.get(
    getOptions({ allowCredentials: Array.from({ length: 400 }, () => ({ type: "public-key", id: bytes(1, 2, 3, 4, 5, 6) })) }),
  );
  await assert.rejects(big, (error) => error.name === "NotSupportedError");
  assert.equal(sent().length, 0);
});

test("installs nothing outside the top frame of a secure HTTPS page", async () => {
  for (const options of [{ protocol: "http:" }, { topFrame: false }, { secure: false }]) {
    const { sandbox, sent, CredentialsContainer } = page(options);
    assert.equal(sandbox.__CONN_PASSKEY_REPLY__, undefined);
    assert.equal(sandbox.__CONN_GPUI_PASSKEYS__, undefined);
    assert.equal(await sandbox.navigator.credentials.get(getOptions()), "native-get");
    assert.equal(CredentialsContainer.prototype.get.name, "get");
    assert.equal(sent().length, 0);
  }
});

test("a second injection into the same page does nothing", () => {
  const { sandbox, sent } = page();
  const reply = sandbox.__CONN_PASSKEY_REPLY__;
  const get = sandbox.CredentialsContainer.prototype.get;
  vm.runInContext(source.replace(PLACEHOLDER, '"other"'), sandbox);
  assert.equal(sandbox.__CONN_PASSKEY_REPLY__, reply);
  assert.equal(sandbox.CredentialsContainer.prototype.get, get);
  sandbox.navigator.credentials.get(getOptions());
  assert.equal(sent()[0].token, "tok");
});
