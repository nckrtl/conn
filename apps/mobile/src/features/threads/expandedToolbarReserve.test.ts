import { describe, expect, it } from "vite-plus/test";

import { expandedToolbarReserve } from "./expandedToolbarReserve";

describe("expanded toolbar reserve", () => {
  it("keeps the default 52 point reserve for default-size controls", () => {
    expect(expandedToolbarReserve(0)).toBe(52);
    expect(expandedToolbarReserve(44)).toBe(52);
  });

  it("grows with controls that Dynamic Type makes taller", () => {
    expect(expandedToolbarReserve(71.4)).toBe(80);
  });
});
