import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

import {
  CREDENTIAL_INSERT_FUNCTION,
  CREDENTIAL_LOCK_EXPRESSION,
  REDACTED_VALUE,
  redactCdpMessage,
  redactSensitiveValues,
} from "./credentialFill.ts";

const SECRET = "hunter2-correct&horse";

describe("credential field insertion", () => {
  const fixture = () => {
    const context = NodeVM.createContext({});
    NodeVM.runInContext(
      `
      const document = {};
      const location = { origin: "https://example.com" };
      class Event { constructor(type) { this.type = type; } }
      class InputEvent extends Event {}
      class HTMLInputElement {
        constructor() {
          this.type = "password"; this.isConnected = true;
          this.ownerDocument = document; this.events = []; this.storedValue = "old value";
        }
        get value() { return this.storedValue; }
        set value(value) { this.storedValue = value; }
        dispatchEvent(event) { this.events.push(event.type); }
      }
      const field = new HTMLInputElement();
      const composer = { value: "Draft to preserve" };
      const insert = (${CREDENTIAL_INSERT_FUNCTION});
    `,
      context,
    );
    return (expression: string): unknown => NodeVM.runInContext(expression, context);
  };

  it("replaces only the bound field while the composer has focus", () => {
    const run = fixture();
    run("document.activeElement = composer");
    expect(run('insert.call(field, "password", "new value", "https://example.com")')).toBe(
      "filled",
    );
    expect(run("field.value")).toBe("new value");
    expect(run("composer.value")).toBe("Draft to preserve");
    expect(run("field.events.join(',')")).toBe("input,change");
    expect(run('field[Symbol.for("t3code.credentialFilled")]')).toBe(true);
  });

  it.each([
    ['location.origin = "https://other.example"', "origin_mismatch"],
    ['field.type = "text"', "not_editable"],
    ["field.isConnected = false", "not_editable"],
    ["field.disabled = true", "not_editable"],
    ["field.readOnly = true", "not_editable"],
    ["field.ownerDocument = {}", "not_editable"],
  ])("refuses a changed target: %s", (change, status) => {
    const run = fixture();
    run(change);
    expect(run('insert.call(field, "password", "secret", "https://example.com")')).toBe(status);
    expect(run("field.value")).toBe("old value");
    expect(run("field.events.length")).toBe(0);
  });
});

describe("credential document lock", () => {
  const fixture = () => {
    const context = NodeVM.createContext({});
    NodeVM.runInContext(
      `
      var window = globalThis;
      var document = {};
      var location = { origin: "https://example.com" };
      class Event { constructor(type) { this.type = type; } }
      class InputEvent extends Event {}
      class HTMLInputElement {
        constructor() {
          this.type = "password"; this.isConnected = true;
          this.ownerDocument = document; this.storedValue = "old value";
        }
        get value() { return this.storedValue; }
        set value(value) { this.storedValue = value; }
        dispatchEvent() {}
      }
      var field = new HTMLInputElement();
      var insert = (${CREDENTIAL_INSERT_FUNCTION});
    `,
      context,
    );
    return (expression: string): unknown => NodeVM.runInContext(expression, context);
  };

  it("marks the document for a locked fill, and the page cannot clear it", () => {
    const run = fixture();
    expect(run(CREDENTIAL_LOCK_EXPRESSION)).toBe(false);
    expect(run('insert.call(field, "password", "secret", "https://example.com", true)')).toBe(
      "filled",
    );
    run("delete window.__t3codeCredentialLocked; window.__t3codeCredentialLocked = false;");
    expect(run(CREDENTIAL_LOCK_EXPRESSION)).toBe(true);
  });

  it("leaves the document unmarked for an unlocked fill or a username", () => {
    const run = fixture();
    run('insert.call(field, "password", "secret", "https://example.com", false)');
    run('field.type = "email"');
    run('insert.call(field, "username", "me@example.com", "https://example.com", true)');
    expect(run(CREDENTIAL_LOCK_EXPRESSION)).toBe(false);
  });

  it("inserts nothing when the page blocks the mark", () => {
    const run = fixture();
    run(
      'Object.defineProperty(window, "__t3codeCredentialLocked", { get: () => false, configurable: false })',
    );
    expect(run('insert.call(field, "password", "secret", "https://example.com", true)')).toBe(
      "insert_failed",
    );
    expect(run("field.value")).toBe("old value");
  });
});

describe("redactCdpMessage", () => {
  it("redacts a secret from a CDP event and keeps the message valid JSON", () => {
    const message = JSON.stringify({
      method: "Runtime.consoleAPICalled",
      params: { args: [{ type: "string", value: `typed ${SECRET}` }] },
    });
    const redacted = redactCdpMessage(message, [SECRET]);
    expect(redacted).not.toContain("hunter2");
    expect(JSON.parse(redacted)).toEqual({
      method: "Runtime.consoleAPICalled",
      params: { args: [{ type: "string", value: `typed ${REDACTED_VALUE}` }] },
    });
  });

  it("returns messages without a secret unchanged", () => {
    const message = '{"id":1,"result":{"value":"nothing to hide"}}';
    expect(redactCdpMessage(message, [SECRET])).toBe(message);
  });

  it("leaves base64 payloads intact", () => {
    const data = "abcd".repeat(400);
    const message = JSON.stringify({ id: 2, result: { data } });
    expect(JSON.parse(redactCdpMessage(message, ["abcd"])).result.data).toBe(data);
  });
});

describe("redactSensitiveValues", () => {
  it("removes a secret from nested strings and keys", () => {
    const value = {
      visibleText: `Your password is ${SECRET}.`,
      elements: [{ name: SECRET }, { name: "Sign in" }],
      [SECRET]: 1,
    };
    const redacted = redactSensitiveValues(value, [SECRET]);
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(redacted.visibleText).toBe(`Your password is ${REDACTED_VALUE}.`);
    expect(redacted.elements[1]!.name).toBe("Sign in");
  });

  it("removes URI-encoded and JSON-escaped forms", () => {
    const quoted = 'pa"ss\\word';
    const redacted = redactSensitiveValues(
      {
        body: `user=nick&password=${encodeURIComponent(SECRET)}`,
        json: JSON.stringify({ password: quoted }),
      },
      [SECRET, quoted],
    );
    expect(redacted.body).toBe(`user=nick&password=${REDACTED_VALUE}`);
    expect(redacted.json).not.toContain("ss\\\\word");
    expect(redacted.json).toContain(REDACTED_VALUE);
  });

  it("only redacts exact matches of very short values", () => {
    const redacted = redactSensitiveValues({ a: "abc", b: "abcdef" }, ["abc"]);
    expect(redacted).toEqual({ a: REDACTED_VALUE, b: "abcdef" });
  });

  it("returns the value untouched without secrets", () => {
    const value = { a: "text", n: 1, nested: [true, null] };
    expect(redactSensitiveValues(value, [])).toBe(value);
    expect(redactSensitiveValues(value, [""])).toBe(value);
  });

  it("redacts a bare string result", () => {
    expect(redactSensitiveValues(SECRET, [SECRET])).toBe(REDACTED_VALUE);
    expect(redactSensitiveValues(42, [SECRET])).toBe(42);
  });
});
