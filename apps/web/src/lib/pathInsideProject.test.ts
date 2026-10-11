import { describe, expect, it } from "vite-plus/test";

import { isPathInsideProject } from "./pathInsideProject";

describe("isPathInsideProject", () => {
  it("accepts files inside the root, with or without a line", () => {
    expect(isPathInsideProject("/Users/me/app/app/Models/User.php", "/Users/me/app")).toBe(true);
    expect(isPathInsideProject("/Users/me/app/app/Models/User.php:12", "/Users/me/app/")).toBe(
      true,
    );
    expect(isPathInsideProject("/Users/me/app/a.php:12:3", "/Users/me/app")).toBe(true);
  });

  it("refuses paths outside the root, including ones that climb out of it", () => {
    expect(isPathInsideProject("/etc/passwd", "/Users/me/app")).toBe(false);
    expect(isPathInsideProject("/Users/me/app/../.ssh/id_rsa", "/Users/me/app")).toBe(false);
    expect(isPathInsideProject("/Users/me/app-other/a.php", "/Users/me/app")).toBe(false);
    expect(isPathInsideProject("/Users/me/app", "/Users/me/app")).toBe(false);
  });

  it("refuses relative paths", () => {
    expect(isPathInsideProject("app/Models/User.php:3", "/Users/me/app")).toBe(false);
    expect(isPathInsideProject("../secret", "/Users/me/app")).toBe(false);
  });

  it("handles Windows paths", () => {
    expect(isPathInsideProject("C:\\Work\\App\\app\\User.php:4", "c:/work/app")).toBe(true);
    expect(isPathInsideProject("D:\\Work\\App\\User.php", "C:\\Work\\App")).toBe(false);
  });
});
