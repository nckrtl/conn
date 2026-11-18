// @effect-diagnostics globalTimers:off -- Client polling follows Orbit's snapshot cadence.
import * as Schema from "effect/Schema";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { operationPollDelayMs, OrbitGatewayError, type OrbitGatewayClient } from "./client.ts";
import {
  type OrbitLaunch,
  type OrbitLaunchAction,
  type OrbitLaunchAdmission,
  type OrbitLaunchClient,
  type OrbitLaunchScope,
} from "./launches.ts";

const isGatewayError = Schema.is(OrbitGatewayError);
const isAccessDenial = (error: unknown) =>
  isGatewayError(error) && [401, 403, 404, 409].includes(error.status);

export class OrbitLaunchAdmissionRefused extends Schema.TaggedError<
  OrbitLaunchAdmissionRefused,
  { readonly brand: unique symbol }
>()("OrbitLaunchAdmissionRefused", {
  cause: OrbitGatewayError,
  message: Schema.String,
}) {}

export interface OrbitLaunchView {
  readonly launches: readonly OrbitLaunch[];
  readonly loaded: boolean;
  readonly error: string | null;
}

const EMPTY: OrbitLaunchView = { launches: [], loaded: false, error: null };

export function createOrbitLaunchObserver(
  client: () => OrbitGatewayClient | null,
  resolve: MFunctionType = mFallback,
) {
  let view = EMPTY;
  let scope: OrbitLaunchScope | null = null;
  let scopeVersion = 0;
  let accessVersion = 0;
  let accessDenied = false;
  let readSequence = 0;
  let accessEvidenceSequence = 0;
  let launchRevision = 0;
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

  async function readLaunches(
    api: OrbitLaunchClient,
    profileId: number,
    version: number,
    purpose: "refresh" | "reconcile",
  ) {
    const access = accessVersion;
    const sequence = ++readSequence;
    const requested = launchRevision;
    const canUpdatePoll = () => purpose === "refresh" && requested === launchRevision;
    // List responses establish access independently of admission and action receipts.
    const isCurrent = () =>
      version === scopeVersion && access === accessVersion && sequence > accessEvidenceSequence;
    try {
      const launches = await api.list();
      if (isCurrent()) {
        accessEvidenceSequence = sequence;
        const restored = accessDenied;
        accessDenied = false;
        if (restored || canUpdatePoll()) {
          publish({
            launches: launches.filter((launch) => launch.profile_id === profileId),
            loaded: true,
            error: null,
          });
          if (purpose === "reconcile") schedule();
        }
      }
      return launches;
    } catch (error) {
      if (isCurrent()) {
        const denied = isAccessDenial(error);
        if (denied) {
          accessEvidenceSequence = sequence;
          accessVersion += 1;
          accessDenied = true;
        }
        if (denied || (!accessDenied && canUpdatePoll())) {
          publish({
            launches: denied ? [] : view.launches,
            loaded: true,
            error:
              error instanceof Error
                ? error.message
                : resolve(msg("Could not read Orbit launches.")),
          });
          if (purpose === "reconcile") schedule();
        }
      }
      throw error;
    } finally {
      if (purpose === "refresh" && version === scopeVersion) {
        reading = false;
        schedule();
      }
    }
  }

  async function refresh() {
    const api = client()?.launches;
    if (api === undefined || scope === null || reading) return;
    reading = true;
    await readLaunches(api, scope.profileId, scopeVersion, "refresh").catch(() => {});
  }

  function apply(launch: OrbitLaunch, version: number) {
    if (version !== scopeVersion) return;
    launchRevision += 1;
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
    const access = accessVersion;
    const ensureAccess = () => {
      if (access !== accessVersion) {
        throw new Error("Orbit access changed before Conn could confirm this launch.");
      }
    };
    const me = await gateway.me();
    if (
      me.id !== expected.nodeId ||
      me.profile?.id !== expected.profileId ||
      scopeVersion !== version
    ) {
      throw new Error("This device's Orbit profile changed before sending.");
    }
    ensureAccess();
    const api = gateway.launches;
    const readAdmissions = () => readLaunches(api, expected.profileId, version, "reconcile");
    const observed = () => view.launches.find((row) => row.launch_id === admission.id);
    const accept = (launch: OrbitLaunch, before: OrbitLaunch | undefined) => {
      ensureAccess();
      assertLaunchIdentity(launch, admission);
      const current = observed();
      if (current === launch) return launch;
      if (current !== before) {
        void refresh();
        if (current !== undefined) assertLaunchIdentity(current, admission);
        return current ?? launch;
      }
      apply(launch, version);
      return launch;
    };
    if (reconcile || accessDenied) {
      const before = observed();
      const previous = (await readAdmissions()).find((row) => row.launch_id === admission.id);
      if (scopeVersion !== version)
        throw new Error("The Orbit profile changed while checking the launch.");
      ensureAccess();
      if (previous) return accept(previous, before);
      const current = observed();
      if (current !== undefined) {
        assertLaunchIdentity(current, admission);
        return current;
      }
    }
    const before = observed();
    let accepted: OrbitLaunch;
    try {
      accepted = await api.submit(admission);
    } catch (error) {
      // A lost response may have committed the launch. Check before the UI offers an identical replay.
      if (scopeVersion !== version) throw error;
      ensureAccess();
      if (isGatewayError(error) && [400, 403, 404, 422].includes(error.status)) {
        const current = observed();
        if (current !== undefined) {
          assertLaunchIdentity(current, admission);
          return current;
        }
        throw new OrbitLaunchAdmissionRefused({ cause: error, message: error.message });
      }
      if (
        isGatewayError(error) &&
        error.status > 0 &&
        error.status < 500 &&
        ![408, 425, 429].includes(error.status)
      )
        throw error;
      const beforeRead = observed();
      if (beforeRead !== undefined) {
        assertLaunchIdentity(beforeRead, admission);
        return beforeRead;
      }
      const launches = await readAdmissions().catch(() => null);
      if (scopeVersion !== version) throw error;
      ensureAccess();
      const recovered = observed() ?? launches?.find((row) => row.launch_id === admission.id);
      if (recovered === undefined) throw error;
      return accept(recovered, beforeRead);
    }
    if (scopeVersion !== version)
      throw new Error("Orbit may have accepted the launch on your previous profile.");
    return accept(accepted, before);
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
      accessDenied = false;
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
