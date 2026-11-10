import { describe, expect, it } from "vite-plus/test";

import { parseDuration } from "../model";
import { nextTableSort, sortTableRows } from "./tableSort";

describe("toolbar table sorting", () => {
  it("cycles ascending, descending, original order and starts new columns ascending", () => {
    const ascending = nextTableSort(null, "duration");
    const descending = nextTableSort(ascending, "duration");
    expect(ascending).toEqual({ column: "duration", direction: "ascending" });
    expect(descending).toEqual({ column: "duration", direction: "descending" });
    expect(nextTableSort(descending, "duration")).toBeNull();
    expect(nextTableSort(descending, "status")).toEqual({
      column: "status",
      direction: "ascending",
    });
  });

  it("sorts durations across units and restores untouched source order", () => {
    const rows = ["1.2 s", "9ms", "100ms", "500µs", "2 min"];
    const value = (row: string) => parseDuration(row);
    expect(sortTableRows(rows, { column: "duration", direction: "ascending" }, value)).toEqual([
      "500µs",
      "9ms",
      "100ms",
      "1.2 s",
      "2 min",
    ]);
    expect(sortTableRows(rows, { column: "duration", direction: "descending" }, value)).toEqual([
      "2 min",
      "1.2 s",
      "100ms",
      "9ms",
      "500µs",
    ]);
    expect(sortTableRows(rows, null, value)).toBe(rows);
    expect(rows).toEqual(["1.2 s", "9ms", "100ms", "500µs", "2 min"]);
  });

  it("keeps missing values last and tied rows stable in either direction", () => {
    const rows = [
      { id: 1, n: null },
      { id: 2, n: 3 },
      { id: 3, n: 3 },
      { id: 4, n: 9 },
    ];
    const value = (row: (typeof rows)[number]) => row.n;
    expect(
      sortTableRows(rows, { column: "n", direction: "ascending" }, value).map((row) => row.id),
    ).toEqual([2, 3, 4, 1]);
    expect(
      sortTableRows(rows, { column: "n", direction: "descending" }, value).map((row) => row.id),
    ).toEqual([4, 2, 3, 1]);
  });

  it("uses natural ordering for package versions and numeric names", () => {
    const rows = ["3.10.0", "3.2.0", "3.9.0"];
    expect(
      sortTableRows(rows, { column: "version", direction: "ascending" }, (row) => row),
    ).toEqual(["3.2.0", "3.9.0", "3.10.0"]);
    expect(parseDuration("–")).toBeNull();
    expect(parseDuration(null)).toBeNull();
    expect(parseDuration("1,234 ms")).toBe(1234);
    expect(parseDuration("2 min 5 s")).toBe(125_000);
    expect(parseDuration("5 s later")).toBeNull();
  });
});
