import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  legacyRegisterInput,
  registerOrbitWorkspace,
  useLegacyOrbitThreadStore,
  useOrbitWorkspaces,
} from "./orbitWorkspaces";

const handingOver = new Set<string>();

/**
 * Hands registrations this client started before the server took them over to the
 * server, once each. Mounted once, in the main window.
 */
export function OrbitRegistrationSync() {
  const keys = useLegacyOrbitThreadStore(
    useShallow((state) =>
      Object.keys(state.byThreadKey).filter(
        (key) => state.byThreadKey[key]?.phase === "registering",
      ),
    ),
  );
  return (
    <>
      {keys.map((key) => (
        <LegacyRegistrationHandoff key={key} threadKey={key} />
      ))}
    </>
  );
}

function LegacyRegistrationHandoff(props: { readonly threadKey: string }) {
  const instance = useLegacyOrbitThreadStore((state) => state.byThreadKey[props.threadKey]);
  const environmentId = instance?.environmentId ?? null;
  // The first list means the environment is connected and can take the registration.
  const connected = useOrbitWorkspaces(environmentId) !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands a stored registration to the server once its environment connects
  useEffect(() => {
    if (!connected || instance === undefined || handingOver.has(props.threadKey)) return;
    handingOver.add(props.threadKey);
    void registerOrbitWorkspace(
      instance.environmentId as EnvironmentId,
      legacyRegisterInput(instance),
    )
      .catch((error: unknown) => console.error("Could not hand the Orbit registration over", error))
      .finally(() => handingOver.delete(props.threadKey));
  }, [connected, instance, props.threadKey]);

  return null;
}
