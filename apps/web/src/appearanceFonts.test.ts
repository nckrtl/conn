// @vitest-environment jsdom

import { describe, expect, it } from "vite-plus/test";

import {
  appearanceLineHeightVariables,
  applyAppearanceFontVariables,
  areFontAdvancesMonospace,
  clampCodeFontSize,
  clampCodeLineHeight,
  clampInterfaceLineHeight,
  lineHeightOptions,
  clampInterfaceFontSize,
  clampPromptFontSize,
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  appearanceFontStack,
  cssFontFamilies,
  resolveDefaultFamilyLabel,
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
  resolveTerminalLineHeightPreference,
} from "./appearanceFonts";

describe("areFontAdvancesMonospace", () => {
  it("accepts a fixed advance and rejects any proportional glyph", () => {
    expect(areFontAdvancesMonospace([10, 10, 10, 10])).toBe(true);
    expect(areFontAdvancesMonospace([10, 10, 7, 10])).toBe(false);
    expect(areFontAdvancesMonospace([10, 10.02])).toBe(false);
  });

  it("fails open when canvas metrics are unavailable", () => {
    expect(areFontAdvancesMonospace([])).toBe(true);
    expect(areFontAdvancesMonospace([Number.NaN, Number.NaN])).toBe(true);
  });
});

describe("cssFontFamilies", () => {
  it("returns null for effectively empty input", () => {
    expect(cssFontFamilies("")).toBeNull();
    expect(cssFontFamilies("   ")).toBeNull();
    expect(cssFontFamilies(" , , ")).toBeNull();
  });

  it("quotes names with spaces and keeps single idents bare", () => {
    expect(cssFontFamilies("Fira Code")).toBe('"Fira Code"');
    expect(cssFontFamilies("monospace")).toBe("monospace");
    expect(cssFontFamilies('"Comic Mono"')).toBe('"Comic Mono"');
  });

  it("normalizes comma-separated lists and strips embedded quotes", () => {
    expect(cssFontFamilies(" Fira Code , Menlo ")).toBe('"Fira Code", Menlo');
    expect(cssFontFamilies('Bad"Name')).toBe('"BadName"');
  });

  it("quotes names that are not single CSS idents", () => {
    expect(cssFontFamilies("3270 Nerd Font")).toBe('"3270 Nerd Font"');
    expect(cssFontFamilies("M+ 1m")).toBe('"M+ 1m"');
  });
});

describe("resolveDefaultFamilyLabel", () => {
  it("skips generic keywords and returns null for a stack of only generics", () => {
    expect(resolveDefaultFamilyLabel("system-ui, sans-serif")).toBeNull();
    expect(resolveDefaultFamilyLabel("ui-monospace, monospace")).toBeNull();
  });
});

describe("appearanceFontStack", () => {
  it("prepends the custom family to the default stack", () => {
    expect(appearanceFontStack("Fira Code", DEFAULT_CODE_FONT_STACK)).toBe(
      `"Fira Code", ${DEFAULT_CODE_FONT_STACK}`,
    );
  });

  it("falls back to the default stack when unset", () => {
    expect(appearanceFontStack("", DEFAULT_SANS_FONT_STACK)).toBe(DEFAULT_SANS_FONT_STACK);
  });
});

describe("resolveTerminalFontPreference", () => {
  it("inherits the code font in simple mode", () => {
    expect(
      resolveTerminalFontPreference({ advanced: false, code: "Fira Code", terminal: "" }),
    ).toBe("Fira Code");
    expect(
      resolveTerminalFontPreference({
        advanced: false,
        code: "Fira Code",
        terminal: "Berkeley Mono",
      }),
    ).toBe("Fira Code");
  });

  it("keeps code and terminal fonts independent in advanced mode", () => {
    expect(resolveTerminalFontPreference({ advanced: true, code: "Fira Code", terminal: "" })).toBe(
      "",
    );
    expect(
      resolveTerminalFontPreference({
        advanced: true,
        code: "Fira Code",
        terminal: "Berkeley Mono",
      }),
    ).toBe("Berkeley Mono");
  });
});

describe("resolveTerminalFontSizePreference", () => {
  it("inherits the code font size in simple mode", () => {
    expect(resolveTerminalFontSizePreference({ advanced: false, code: 15, terminal: 12 })).toBe(15);
  });

  it("keeps code and terminal font sizes independent in advanced mode", () => {
    expect(resolveTerminalFontSizePreference({ advanced: true, code: 15, terminal: 12 })).toBe(12);
  });
});

describe("font size clamping", () => {
  it("keeps sizes inside the ranges the UI can absorb", () => {
    expect(clampInterfaceFontSize(16)).toBe(16);
    expect(clampInterfaceFontSize(2)).toBe(12);
    expect(clampInterfaceFontSize(96)).toBe(20);
    expect(clampPromptFontSize(40)).toBe(20);
    expect(clampCodeFontSize(1)).toBe(10);
  });

  it("rounds fractional values and falls back for unusable input", () => {
    expect(clampCodeFontSize(13.4)).toBe(13);
    expect(clampInterfaceFontSize(Number.NaN)).toBe(16);
    expect(clampPromptFontSize(Number.POSITIVE_INFINITY)).toBe(14);
  });
});

describe("line heights", () => {
  const defaults = { lineHeightInterface: 1.5, lineHeightPrompt: 1.625, lineHeightCode: 1.625 };

  it("leaves every surface as it was at the defaults", () => {
    expect(appearanceLineHeightVariables(defaults)).toEqual({
      "--line-height-interface-scale": "1",
      "--line-height-prompt": "1.625",
      "--line-height-code": "1.625",
      // Diffs keep their fixed 20px until the code value moves.
      "--diffs-line-height": null,
    });
  });

  it("scales the interface by its ratio to the 1.5 body default and routes code to diffs", () => {
    expect(
      appearanceLineHeightVariables({
        lineHeightInterface: 1.8,
        lineHeightPrompt: 1.4,
        lineHeightCode: 1.75,
      }),
    ).toEqual({
      "--line-height-interface-scale": "1.2",
      "--line-height-prompt": "1.4",
      "--line-height-code": "1.75",
      "--diffs-line-height": "1.75",
    });
  });

  it("clamps to the supported range and survives bad input", () => {
    expect(clampCodeLineHeight(9)).toBe(2);
    expect(clampCodeLineHeight(0.2)).toBe(1);
    expect(clampCodeLineHeight(Number.NaN)).toBe(1.625);
    expect(clampInterfaceLineHeight(1)).toBe(1.25);
    expect(clampCodeLineHeight(1.3500000000000001)).toBe(1.35);
  });

  it("offers every 0.05 step in range", () => {
    const options = lineHeightOptions(1.25, 2);
    expect(options[0]).toBe(1.25);
    expect(options.at(-1)).toBe(2);
    expect(options).toHaveLength(16);
    expect(options).toContain(1.35);
  });

  it("sets and removes the properties on the root", () => {
    const root = document.createElement("div");
    const preferences = {
      sans: "",
      code: "",
      composer: "",
      sizeInterface: 16,
      sizePrompt: 14,
      sizeCode: 13,
      smoothing: true,
      ...defaults,
    };
    applyAppearanceFontVariables(root, { ...preferences, lineHeightCode: 1.9 });
    expect(root.style.getPropertyValue("--diffs-line-height")).toBe("1.9");
    applyAppearanceFontVariables(root, preferences);
    expect(root.style.getPropertyValue("--diffs-line-height")).toBe("");
    expect(root.style.getPropertyValue("--line-height-code")).toBe("1.625");
  });

  it("makes the terminal follow the code value only once it was moved, in simple mode", () => {
    const input = { code: 1.625, terminal: 1.35 };
    expect(resolveTerminalLineHeightPreference({ advanced: false, ...input })).toBe(1.35);
    expect(
      resolveTerminalLineHeightPreference({ advanced: false, code: 1.9, terminal: 1.35 }),
    ).toBe(1.9);
    expect(resolveTerminalLineHeightPreference({ advanced: true, code: 1.9, terminal: 1.35 })).toBe(
      1.35,
    );
  });
});
