import { expect, it } from "vite-plus/test";
import { orbitStartReturn } from "./orbitThreadStarts";

it("returns past Choose project and the new-thread draft that opened it", () => {
  const home = { key: "home", name: "Home" };
  const picker = { key: "picker", name: "NewTaskProject" };
  const orbit = { key: "orbit", name: "NewOrbitThread" };
  const stack = (...routes: Array<{ key: string; name: string; params?: object }>) => ({
    index: routes.length - 1,
    routes,
  });
  // New chat opens a draft without a project, which opens Choose project; the empty draft
  // closes itself on focus, so the start returns to Home.
  const emptyDraft = { key: "draft", name: "Thread", params: { draft: {} } };
  expect(orbitStartReturn(stack(home, emptyDraft, picker, orbit))).toEqual({
    back: 3,
    returnRouteKey: "home",
  });
  // A draft with a project, opened from a thread page, returns to that thread page.
  const thread = { key: "thread-x", name: "Thread", params: { threadId: "x" } };
  const draft = { key: "draft", name: "Thread", params: { draft: { projectId: "p" } } };
  expect(orbitStartReturn(stack(home, thread, draft, picker, orbit))).toEqual({
    back: 3,
    returnRouteKey: "thread-x",
  });
  expect(orbitStartReturn(stack(home, picker, orbit))).toEqual({
    back: 2,
    returnRouteKey: "home",
  });
  // A direct new/orbit link.
  expect(orbitStartReturn(stack(home, orbit))).toEqual({ back: 1, returnRouteKey: "home" });
});
