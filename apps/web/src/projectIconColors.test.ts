import { ProjectIconColor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { PROJECT_ICON_COLORS } from "./projectIconColors";

describe("PROJECT_ICON_COLORS", () => {
  it("lists every contract color in contract order", () => {
    expect(PROJECT_ICON_COLORS.map(({ value }) => value)).toEqual(ProjectIconColor.literals);
  });
});
