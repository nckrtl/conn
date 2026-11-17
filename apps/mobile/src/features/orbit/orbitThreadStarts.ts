import { isDraftThreadRoute } from "../threads/thread-route-state";

/**
 * Where Start goes back to, from the Orbit project screen on top of `state`: past Choose project,
 * and past the new-thread draft that opened it, which closes itself on focus when it has no
 * project. The thread opens on send only while that route still shows.
 */
export function orbitStartReturn(
  state:
    | {
        readonly index: number;
        readonly routes: ReadonlyArray<{
          readonly key: string;
          readonly name: string;
          readonly params?: object;
        }>;
      }
    | undefined,
): { readonly back: number; readonly returnRouteKey: string | undefined } {
  if (state === undefined) return { back: 1, returnRouteKey: undefined };
  let back = state.routes[state.index - 1]?.name === "NewTaskProject" ? 2 : 1;
  if (isDraftThreadRoute(state.routes[state.index - back])) back += 1;
  return { back, returnRouteKey: state.routes[state.index - back]?.key };
}
