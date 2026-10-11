import { ProjectIconColor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectIconColors,
  resolveProjectFallbackGlyph,
  resolveProjectIconGlyph,
} from "./projectIcon";

describe("resolveProjectIconGlyph", () => {
  it("returns null without an override so the favicon can load", () => {
    expect(resolveProjectIconGlyph(null, "Nebula")).toBeNull();
    expect(resolveProjectIconGlyph(undefined, "Nebula")).toBeNull();
  });

  it("keeps the color of a Lucide override and shows the title monogram", () => {
    expect(
      resolveProjectIconGlyph({ kind: "lucide", name: "rocket", color: "rose" }, "Silver Orchard"),
    ).toEqual({ kind: "monogram", text: "SO", color: "rose" });
  });
});

describe("resolveProjectFallbackGlyph", () => {
  it("derives the same monogram and color as web from the title", () => {
    expect(resolveProjectFallbackGlyph("M7 Forge")).toMatchObject({ text: "M7" });
  });

  it("keeps the folder for a blank title", () => {
    expect(resolveProjectFallbackGlyph("   ")).toBeNull();
  });
});

describe("projectIconColors", () => {
  it("defines both appearances for every project color", () => {
    for (const color of ProjectIconColor.literals) {
      expect(projectIconColors(color, "light").text).toMatch(/^#[\da-f]{6}$/);
      expect(projectIconColors(color, "dark").text).toMatch(/^#[\da-f]{6}$/);
    }
  });
});
