import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { previewRuntimeTabId } from "./previewRuntimeTabId";

describe("previewRuntimeTabId", () => {
  it("scopes tab ids to their environment and thread", () => {
    const base = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };

    expect(previewRuntimeTabId(base, "tab_1")).not.toBe(
      previewRuntimeTabId({ ...base, environmentId: EnvironmentId.make("environment-b") }, "tab_1"),
    );
    expect(previewRuntimeTabId(base, "tab_1")).not.toBe(
      previewRuntimeTabId({ ...base, threadId: ThreadId.make("thread-b") }, "tab_1"),
    );
  });
});
