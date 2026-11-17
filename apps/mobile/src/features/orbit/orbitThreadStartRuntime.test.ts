import { expect, it, vi } from "vite-plus/test";
import { newOrbitLaunchAdmission } from "@t3tools/client-runtime/orbit-gateway";

const navigation = vi.hoisted(() => ({
  dispatch: vi.fn(),
  listeners: new Set<() => void>(),
}));
const gateway = vi.hoisted(() => ({
  pair: vi.fn(),
  environments: vi.fn(),
  state: vi.fn(),
  checkInstanceName: vi.fn(),
  fileText: vi.fn(),
}));

vi.mock("react-native", () => ({ AppState: {} }));
vi.mock("expo-file-system", () => ({
  Paths: { document: "document" },
  File: class {
    exists = true;
    text = gateway.fileText;
  },
}));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => ({ entries: new Map() }) },
}));
vi.mock("../../state/orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("../../state/threads", () => ({ environmentThreadShells: {} }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "launch-id" }));
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: {
    getRootState: () => ({ key: "root" }),
    dispatch: navigation.dispatch,
    addListener: (_event: string, listener: () => void) => {
      navigation.listeners.add(listener);
      return () => {
        navigation.listeners.delete(listener);
      };
    },
  },
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  startOpeningDetail: () => {},
}));
vi.mock("./orbitGatewayClient", () => ({
  orbitGatewayClient: {
    environments: gateway.environments,
    checkInstanceName: gateway.checkInstanceName,
  },
}));
vi.mock("./orbitGatewayStore", () => ({
  connectOrbitEnvironment: gateway.pair,
  orbitGatewayState: gateway.state,
}));

import { openMobileOrbitThread, startOrbitThread } from "./orbitThreadStartRuntime";

it("does not send a name check for an unresolved draft after a profile or Node change", async () => {
  const original = { nodeId: 7, profileId: 12 };
  const prompt = "Private acquisition project";
  const admission = newOrbitLaunchAdmission(() => "id", original, {
    project_id: 78,
    target: { kind: "new", name: "private-acquisition-project-abcdef" },
    source: "mobile",
    prompt,
  });
  gateway.checkInstanceName.mockClear();
  gateway.fileText.mockResolvedValue(
    JSON.stringify([{ ...original, draftId: "sheet:78", admission }]),
  );
  for (const scope of [
    { nodeId: 7, profileId: 13 },
    { nodeId: 8, profileId: 12 },
  ]) {
    gateway.state.mockReturnValue({
      provider: "orbit",
      node: { id: scope.nodeId, profile: { id: scope.profileId } },
    });
    await expect(startOrbitThread({ id: 78 }, prompt, "sheet")).rejects.toThrow(
      "original Orbit profile and device",
    );
  }
  expect(gateway.checkInstanceName).not.toHaveBeenCalled();
});

it("opens the canonical thread after pairing only if the user has not navigated away", async () => {
  navigation.dispatch.mockClear();
  const started = Promise.withResolvers<void>();
  const pairing = Promise.withResolvers<boolean>();
  const thread = { thread_id: "canonical", environment_id: "clone" };
  gateway.environments.mockResolvedValue([{ environmentId: "clone", registeredAt: null }]);
  gateway.pair
    .mockImplementationOnce(() => {
      started.resolve();
      return pairing.promise;
    })
    .mockResolvedValueOnce(true);

  const opening = openMobileOrbitThread(thread);
  await started.promise;
  for (const listener of navigation.listeners) listener();
  pairing.resolve(true);
  await opening;
  expect(navigation.dispatch).not.toHaveBeenCalled();
  expect(navigation.listeners.size).toBe(0);

  await openMobileOrbitThread(thread);
  expect(navigation.dispatch).toHaveBeenCalledOnce();
  expect(navigation.dispatch.mock.calls[0]?.[0]).toMatchObject({
    target: "root",
    payload: {
      detail: { name: "Thread", params: { environmentId: "clone", threadId: "canonical" } },
    },
  });
  expect(navigation.listeners.size).toBe(0);
});
