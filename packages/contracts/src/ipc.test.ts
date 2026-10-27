import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { DesktopPreviewAnnotatorOriginInputSchema } from "./ipc.ts";

const decode = Schema.decodeUnknownSync(DesktopPreviewAnnotatorOriginInputSchema);

describe("DesktopPreviewAnnotatorOriginInputSchema", () => {
  const input = {
    tabId: "tab-1",
    origin: "http://10.44.0.7:40953",
    dictation: {
      startUrl: "http://127.0.0.1:12321/dictate",
      stopUrl: "http://127.0.0.1:12321/dictate-stop",
    },
  };

  it("carries the annotator origin and the dictation URLs", () => {
    expect(decode(input)).toEqual(input);
    expect(decode({ ...input, dictation: { startUrl: null, stopUrl: null } }).dictation).toEqual({
      startUrl: null,
      stopUrl: null,
    });
  });

  it("accepts only http(s) dictation URLs", () => {
    for (const startUrl of ["file:///etc/passwd", "javascript:alert(1)", "", "127.0.0.1:12321"]) {
      expect(() => decode({ ...input, dictation: { ...input.dictation, startUrl } })).toThrow();
    }
    expect(() => decode({ ...input, dictation: undefined })).toThrow();
  });
});
