// @effect-diagnostics globalTimers:off -- Client polling follows Orbit's snapshot cadence.
import * as Schema from "effect/Schema";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import {
  gatewayFallbackMessage,
  operationPollDelayMs,
  OrbitGatewayError,
  type OrbitGatewayClient,
} from "./client.ts";
import { OrbitLaunchCopyError } from "./launchCopy.ts";
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

export function isCorrectableLaunchRefusal(error: OrbitGatewayError) {
  return error.status === 422 || (error.status === 409 && error.code === "instance.name_taken");
}

const isLaunchCopyError = Schema.is(OrbitLaunchCopyError);
const isAdmissionRefused = Schema.is(OrbitLaunchAdmissionRefused);

export function resolveOrbitLaunchError(
  error: unknown,
  fallback: string,
  resolve: MFunctionType,
): string {
  if (isLaunchCopyError(error)) return resolve(error.copy);
  const gateway = isAdmissionRefused(error) ? error.cause : error;
  if (isGatewayError(gateway)) {
    if (gateway.code === "gateway.unreachable") {
      return resolve(msg("The Orbit Gateway did not answer."));
    }
    if (gateway.code === "gateway.response_invalid") {
      return resolve(msg("The Orbit Gateway sent an unexpected response."));
    }
    if (gateway.message === gatewayFallbackMessage(gateway.status)) {
      return resolve(msg("The Orbit Gateway answered {status}."), { status: gateway.status });
    }
    return gateway.message;
  }
  return resolve(fallback);
}

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
            error: resolveOrbitLaunchError(error, msg("Could not read Orbit launches."), resolve),
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

  function setScope(next: OrbitLaunchScope | null) {
    if (next?.profileId === scope?.profileId && next?.nodeId === scope?.nodeId) return;
    scope = next;
    scopeVersion += 1;
    accessDenied = false;
    reading = false;
    clearTimeout(timer);
    publish(EMPTY);
    void refresh();
  }

  function canAcknowledge(record: OrbitLaunchScope & { admission: OrbitLaunchAdmission }) {
    return (
      scope?.profileId === record.profileId &&
      scope.nodeId === record.nodeId &&
      !accessDenied &&
      view.launches.some((launch) => matchesLaunchIdentity(launch, record.admission))
    );
  }

  function requireGateway(expected: OrbitLaunchScope) {
    const gateway = client();
    if (
      gateway === null ||
      scope?.profileId !== expected.profileId ||
      scope.nodeId !== expected.nodeId
    ) {
      throw OrbitLaunchCopyError.fromCopy(
        msg("Connect to the original Orbit profile and device before sending."),
      );
    }
    return gateway;
  }

  async function confirmBinding(
    gateway: OrbitGatewayClient,
    expected: OrbitLaunchScope,
    version: number,
  ) {
    const me = await gateway.me();
    const rebound = me.id !== expected.nodeId || me.profile?.id !== expected.profileId;
    if (rebound && scopeVersion === version) setScope(null);
    if (rebound || scopeVersion !== version) {
      throw OrbitLaunchCopyError.fromCopy(
        msg("This device's Orbit profile changed before sending."),
      );
    }
  }

  async function verifyScope(expected: OrbitLaunchScope) {
    await confirmBinding(requireGateway(expected), expected, scopeVersion);
  }

  async function submit(
    admission: OrbitLaunchAdmission,
    expected: OrbitLaunchScope,
    reconcile: boolean | "accepted",
  ) {
    const gateway = requireGateway(expected);
    if (
      admission.request.expected_profile_id !== expected.profileId ||
      admission.request.expected_node_id !== expected.nodeId
    ) {
      throw OrbitLaunchCopyError.fromCopy(
        msg("This submission belongs to a different Orbit profile or device."),
      );
    }
    const version = scopeVersion;
    const access = accessVersion;
    const ensureAccess = () => {
      if (access !== accessVersion) {
        throw OrbitLaunchCopyError.fromCopy(
          msg("Orbit access changed before Conn could confirm this launch."),
        );
      }
    };
    await confirmBinding(gateway, expected, version);
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
        throw OrbitLaunchCopyError.fromCopy(
          msg("The Orbit profile changed while checking the launch."),
        );
      ensureAccess();
      if (previous) return accept(previous, before);
      const current = observed();
      if (current !== undefined) {
        assertLaunchIdentity(current, admission);
        return current;
      }
    }
    if (reconcile === "accepted")
      throw OrbitLaunchCopyError.fromCopy(msg("This submission was already handled."));
    const before = observed();
    let accepted: OrbitLaunch;
    try {
      accepted = await api.submit(admission);
    } catch (error) {
      // A lost response may have committed the launch. Check before the UI offers an identical replay.
      if (scopeVersion !== version) throw error;
      ensureAccess();
      if (isGatewayError(error) && error.code === "conn.launch_scope_changed") {
        setScope(null);
        throw error;
      }
      if (
        isGatewayError(error) &&
        ([400, 403, 404].includes(error.status) || isCorrectableLaunchRefusal(error))
      ) {
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
      throw OrbitLaunchCopyError.fromCopy(
        msg("Orbit may have accepted the launch on your previous profile."),
      );
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
      throw OrbitLaunchCopyError.fromCopy(msg("Orbit no longer offers this action."));
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
        throw OrbitLaunchCopyError.fromCopy(msg("Orbit returned a different launch."));
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
    setScope,
    canAcknowledge,
    verifyScope,
    refresh,
    submit,
    act,
  };
}

function matchesLaunchIdentity(launch: OrbitLaunch, admission: OrbitLaunchAdmission) {
  return (
    launch.launch_id === admission.id &&
    launch.profile_id === admission.request.expected_profile_id &&
    launch.initiator_node_id === admission.request.expected_node_id &&
    launch.project_id === admission.request.project_id &&
    launch.workspace_id === (admission.request.workspace_id ?? null) &&
    (admission.request.target.kind !== "existing" ||
      launch.instance_id === admission.request.target.instance_id) &&
    launch.source === admission.request.source &&
    (launch.thread === null ||
      (launch.thread.thread_id === admission.request.thread_id &&
        launch.thread.message_id === admission.request.message_id))
  );
}

function assertLaunchIdentity(launch: OrbitLaunch, admission: OrbitLaunchAdmission) {
  if (!matchesLaunchIdentity(launch, admission))
    throw OrbitLaunchCopyError.fromCopy(msg("Orbit returned a different launch."));
}
