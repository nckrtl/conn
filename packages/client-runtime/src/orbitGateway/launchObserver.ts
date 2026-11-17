// @effect-diagnostics globalTimers:off -- Client polling follows Orbit's snapshot cadence.
import * as Schema from "effect/Schema";

import { operationPollDelayMs, OrbitGatewayError, type OrbitGatewayClient } from "./client.ts";
import {
  type OrbitLaunch,
  type OrbitLaunchAction,
  type OrbitLaunchAdmission,
  type OrbitLaunchScope,
} from "./launches.ts";

const isGatewayError = Schema.is(OrbitGatewayError);

export interface OrbitLaunchView {
  readonly launches: readonly OrbitLaunch[];
  readonly loaded: boolean;
  readonly error: string | null;
}

const EMPTY: OrbitLaunchView = { launches: [], loaded: false, error: null };

export function createOrbitLaunchObserver(client: () => OrbitGatewayClient | null) {
  let view = EMPTY;
  let scope: OrbitLaunchScope | null = null;
  let scopeVersion = 0;
  let revision = 0;
  let reading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  function publish(next: OrbitLaunchView) {
    view = next;
    for (const listener of listeners) listener();
  }

  function schedule() {
    clearTimeout(timer);
    if (scope === null) return;
    const active = view.launches.flatMap((launch) =>
      launch.poll_after_seconds === null ? [] : [operationPollDelayMs(launch.poll_after_seconds)],
    );
    const delay = view.error !== null ? 15_000 : Math.min(...active, 30_000);
    timer = setTimeout(() => void refresh(), delay);
  }

  async function refresh() {
    const api = client()?.launches;
    if (api === undefined || scope === null || reading) return;
    const version = scopeVersion;
    const { profileId } = scope;
    const requested = revision;
    reading = true;
    try {
      const launches = await api.list();
      if (version === scopeVersion && requested === revision) {
        publish({
          launches: launches.filter((launch) => launch.profile_id === profileId),
          loaded: true,
          error: null,
        });
      }
    } catch (error) {
      if (version === scopeVersion && requested === revision) {
        const denied = isGatewayError(error) && [401, 403, 404, 409].includes(error.status);
        publish({
          launches: denied ? [] : view.launches,
          loaded: true,
          error: error instanceof Error ? error.message : "Could not read Orbit launches.",
        });
      }
    } finally {
      if (version === scopeVersion) {
        reading = false;
        schedule();
      }
    }
  }

  function apply(launch: OrbitLaunch, version: number) {
    if (version !== scopeVersion) return;
    revision += 1;
    const index = view.launches.findIndex((row) => row.id === launch.id);
    const launches =
      index < 0
        ? [launch, ...view.launches]
        : view.launches.map((row, i) => (i === index ? launch : row));
    publish({ ...view, launches });
    schedule();
  }

  async function submit(
    admission: OrbitLaunchAdmission,
    expected: OrbitLaunchScope,
    reconcile: boolean,
  ) {
    const gateway = client();
    if (
      gateway === null ||
      scope?.profileId !== expected.profileId ||
      scope.nodeId !== expected.nodeId
    ) {
      throw new Error("Connect to the original Orbit profile and device before sending.");
    }
    if (
      admission.request.expected_profile_id !== expected.profileId ||
      admission.request.expected_node_id !== expected.nodeId
    ) {
      throw new Error("This submission belongs to a different Orbit profile or device.");
    }
    const version = scopeVersion;
    const me = await gateway.me();
    if (
      me.id !== expected.nodeId ||
      me.profile?.id !== expected.profileId ||
      scopeVersion !== version
    ) {
      throw new Error("This device's Orbit profile changed before sending.");
    }
    const api = gateway.launches;
    if (reconcile) {
      const previous = (await api.list()).find((row) => row.launch_id === admission.id);
      if (scopeVersion !== version)
        throw new Error("The Orbit profile changed while checking the launch.");
      if (previous) {
        assertLaunchIdentity(previous, admission);
        apply(previous, version);
        return previous;
      }
    }
    try {
      const accepted = await api.submit(admission);
      if (scopeVersion !== version)
        throw new Error("Orbit may have accepted the launch on your previous profile.");
      assertLaunchIdentity(accepted, admission);
      apply(accepted, version);
      return accepted;
    } catch (error) {
      // A lost response may have committed the launch. Check before the UI offers an identical replay.
      if (
        isGatewayError(error) &&
        error.status > 0 &&
        error.status < 500 &&
        ![408, 425, 429].includes(error.status)
      )
        throw error;
      if (scopeVersion !== version) throw error;
      const launches = await api.list().catch(() => null);
      if (scopeVersion !== version) throw error;
      const accepted = launches?.find((row) => row.launch_id === admission.id);
      if (accepted === undefined) throw error;
      assertLaunchIdentity(accepted, admission);
      apply(accepted, version);
      return accepted;
    }
  }

  async function act(id: number, action: OrbitLaunchAction) {
    const launch = view.launches.find((row) => row.id === id);
    const api = client()?.launches;
    if (
      api === undefined ||
      scope === null ||
      view.error !== null ||
      !launch?.actions[action].available
    ) {
      void refresh();
      throw new Error("Orbit no longer offers this action.");
    }
    const version = scopeVersion;
    try {
      const next =
        action === "cancel"
          ? await api.cancel(id)
          : await api.retry(id, action === "retry_launch" ? "launch" : "application");
      if (
        next.id !== id ||
        next.launch_id !== launch.launch_id ||
        next.profile_id !== launch.profile_id
      ) {
        throw new Error("Orbit returned a different launch.");
      }
      if (version === scopeVersion) {
        if (view.launches.find((row) => row.id === id) === launch) apply(next, version);
        else void refresh();
      }
    } catch (error) {
      void refresh();
      throw error;
    }
  }

  return {
    view: () => view,
    scope: () => scope,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setScope: (next: OrbitLaunchScope | null) => {
      if (next?.profileId === scope?.profileId && next?.nodeId === scope?.nodeId) return;
      scope = next;
      scopeVersion += 1;
      reading = false;
      clearTimeout(timer);
      publish(EMPTY);
      void refresh();
    },
    refresh,
    submit,
    act,
  };
}

function assertLaunchIdentity(launch: OrbitLaunch, admission: OrbitLaunchAdmission) {
  if (
    launch.launch_id !== admission.id ||
    launch.profile_id !== admission.request.expected_profile_id ||
    launch.initiator_node_id !== admission.request.expected_node_id ||
    launch.project_id !== admission.request.project_id ||
    launch.source !== admission.request.source ||
    (launch.thread !== null &&
      (launch.thread.thread_id !== admission.request.thread_id ||
        launch.thread.message_id !== admission.request.message_id))
  )
    throw new Error("Orbit returned a different launch.");
}
