import { describe, expect, it } from "vite-plus/test";

import {
  inlineBindings,
  modelCount,
  errorReportingLabel,
  formatBytes,
  formatUptime,
  framework,
  iniSwitch,
  phpLimit,
  propRows,
  requestKind,
  rowFromData,
  stages,
  summarize,
  toolbarModels,
} from "./model";
import type { ToolbarData } from "./types";

const page: ToolbarData = {
  request_id: "r1",
  profiler: {
    total_wall_time: { formattedValue: "41ms", value: 41.27 },
    stages: [
      { label: "Bootstrapping", color: "#FC3D46", wall_time: { measurement: { value: 8.28 } } },
      {
        label: "Controller",
        color: "#64BAFF",
        wall_time: { measurement: { value: 1 } },
        memory_real_delta: { measurement: { value: 26368 } },
      },
    ],
  },
  request: { method: "GET", uri: "/", route_name: "home", is_inertia: true, view_name: "Home" },
  response: { status_code: 200, size: "9.97 KB" },
};

describe("laravel toolbar model", () => {
  it("names error_reporting levels and ini switches", () => {
    expect(errorReportingLabel("22527", "8.5.9")).toBe("E_ALL & ~E_DEPRECATED");
    expect(errorReportingLabel("22527", "8.3.1")).toBe("E_ALL & ~E_DEPRECATED & ~E_STRICT");
    expect(errorReportingLabel("30719", "8.5.0")).toBe("E_ALL");
    expect(errorReportingLabel("32767", "8.2.0")).toBe("E_ALL");
    expect(errorReportingLabel("0", "8.5.0")).toBe("None");
    expect(iniSwitch("")).toBe("Off");
    expect(iniSwitch("1")).toBe("On");
    expect(formatUptime(57898)).toBe("16h 4m");
    expect(errorReportingLabel("-1", "8.5.0")).toBe("E_ALL");
    expect(phpLimit("-1")).toBe("Unlimited");
    expect(phpLimit("0", "s")).toBe("Unlimited");
    expect(phpLimit("30", "s")).toBe("30s");
  });

  it("falls back to the route's URI when it has no name", () => {
    const row = { id: "r1", method: "GET", uri: "/", name: "-" };
    expect(summarize(row).route).toBe("/");
    expect(summarize({ ...row, name: "home" }).route).toBe("home");
    expect(summarize(row, { request: { route_uri: "posts/{post}", uri: "/posts/1" } }).route).toBe(
      "/posts/{post}",
    );
  });

  it("adds Inertia's prop metadata and lists deferred props that are not loaded", () => {
    const rows = propRows({
      request: { view_data: { auth: { user: null }, releases: [] } },
      inertia: {
        props: {
          auth: { shared: true, type: "always", source: { file: "/app/Share.php", line: 21 } },
          releases: { shared: false, type: null },
          downloads: { type: "defer", defer_group: "stats", loaded: false },
        },
      },
    });
    expect(rows.map((row) => [row.name, row.loaded, row.badges])).toEqual([
      ["auth", true, ["Shared", "Always"]],
      ["releases", true, []],
      ["downloads", false, ["Deferred"]],
    ]);
    expect(rows[0]?.source).toEqual({ file: "/app/Share.php", line: 21 });
  });

  it("lists no prop values when the bridge redacts view data", () => {
    const rows = propRows({
      request: { view_data: "[redacted]" },
      inertia: { props: { stats: { type: "defer", loaded: false } } },
    });
    expect(rows.map((row) => [row.name, row.loaded])).toEqual([["stats", false]]);
  });

  it("reads the response size as text or as a measurement", () => {
    const measured = { ...page, response: { size: { formattedValue: "9.97 KB", value: 10209 } } };
    expect(summarize(rowFromData(measured)!, measured).size).toBe("9.97 KB");
    expect(summarize(rowFromData(page)!, page).size).toBe("9.97 KB");
  });

  it("lays stages end to end", () => {
    expect(stages(page).map((stage) => [stage.label, stage.startMs])).toEqual([
      ["Bootstrapping", 0],
      ["Controller", 8.28],
    ]);
  });

  it("builds a history row for a page load that sent none", () => {
    expect(rowFromData(page)).toMatchObject({ id: "r1", is_xhr: false, status_code: 200 });
  });

  it("tells page loads, Inertia visits and plain XHR apart", () => {
    expect(requestKind({ is_xhr: false })).toBe("page");
    expect(requestKind({ is_xhr: true, response_type: "Inertia" })).toBe("inertia");
    expect(requestKind({ is_xhr: true, response_type: null })).toBe("xhr");
  });

  it("completes a history row with its loaded payload", () => {
    const summary = summarize({ id: "r1", method: "GET", uri: "/", duration: "40ms" }, page);
    expect(summary).toMatchObject({ component: "Home", duration: "41ms", status: 200 });
  });

  it("formats freed memory with a sign", () => {
    expect(formatBytes(-14162)).toBe("-13.83 KB");
  });

  it("reads models as the bridge's rows or the package's per-class entries", () => {
    const rows = { models: [{ model: "App\\Models\\Page", retrieved: 2, created: 1 }] };
    expect(toolbarModels(rows)).toEqual(rows.models);
    const entries: ToolbarData = {
      models: {
        "App\\Models\\Page": { model: "App\\Models\\Page", action: "retrieved", count: 1 },
        "App\\Models\\Article": { model: "App\\Models\\Article", action: "retrieved", count: 4 },
      },
    };
    expect(toolbarModels(entries)).toEqual([
      { model: "App\\Models\\Page", retrieved: 1 },
      { model: "App\\Models\\Article", retrieved: 4 },
    ]);
    expect(modelCount(entries)).toBe(5);
  });

  it("names the framework from the bridge's section, else from the package's", () => {
    expect(framework({ ...page, laravel: { version: "13.4.0", timezone: "UTC" } })).toMatchObject({
      name: "Laravel",
      isLaravel: true,
      version: "13.4.0",
      timezone: "UTC",
    });
    expect(
      framework({ ...page, framework: { name: "Symfony", version: "8.1.2", debug: true } }),
    ).toMatchObject({ name: "Symfony", isLaravel: false, version: "8.1.2", timezone: null });
    expect(framework(page)).toMatchObject({ name: "Laravel", version: null });
  });
});

describe("inlineBindings", () => {
  it("writes bindings into placeholders outside quotes", () => {
    expect(
      inlineBindings("select * from `t?` where a = ? and b = ? and c = '?' and d = ?", [
        "it's",
        3,
        null,
      ]),
    ).toBe("select * from `t?` where a = 'it''s' and b = 3 and c = '?' and d = NULL");
    expect(inlineBindings("select ? , ?", [true])).toBe("select 1 , ?");
  });
});
