import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { DeviceHostId, DeviceId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  hasServerAcknowledgedLocalDispatch,
  latestTurnStartFailureId,
} from "../components/ChatView.logic";
import { useQueuedMessageStore, useQueuedMessages } from "../queuedMessageStore";
import { derivePhase } from "../session-logic";
import { deviceEnvironment } from "../state/device";
import { useThread, useThreadStatus } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { waitingIdsToSend } from "./annotatorQueue";
import {
  useAnnotationWatch,
  useAnnotationWatchStore,
  useConfirmedDeviceWatchUrl,
} from "./annotationWatchStore";
import {
  type DeviceWatchConfirmFlight,
  deviceWatchConfirmKey,
  startDeviceWatchConfirm,
} from "./deviceWatchConfirm";
import { sendAnnotationPrompt } from "./sendAnnotationPrompt";
import { useAnnotatorQueue } from "./useAnnotatorQueue";

/**
 * Watch mode: prompts each watched thread when it is idle and annotations it has not
 * been told about are waiting. Mounted once, in the main window, next to the queued
 * message sender that does the actual send.
 */
export function AnnotationWatchCoordinator() {
  const threadKeys = useAnnotationWatchStore(
    useShallow((state) => Object.keys(state.watchingByThreadKey)),
  );
  return threadKeys.map((threadKey) => (
    <ThreadAnnotationWatch key={threadKey} threadKey={threadKey} />
  ));
}

function ThreadAnnotationWatch({ threadKey }: { threadKey: string }) {
  const deviceId = useAnnotationWatchStore(
    (state) => state.watchingByThreadKey[threadKey]?.device?.deviceId,
  );
  if (deviceId !== undefined) return <DeviceThreadAnnotationWatch threadKey={threadKey} />;
  return <PageThreadAnnotationWatch threadKey={threadKey} />;
}

function PageThreadAnnotationWatch({ threadKey }: { threadKey: string }) {
  const annotationsUrl = useAnnotationWatch(threadKey)?.annotationsUrl ?? null;
  return <AnnotationWatchSender threadKey={threadKey} annotationsUrl={annotationsUrl} />;
}

function DeviceThreadAnnotationWatch({ threadKey }: { threadKey: string }) {
  const entry = useAnnotationWatchStore((state) => state.watchingByThreadKey[threadKey] ?? null);
  const confirmed = useConfirmedDeviceWatchUrl(threadKey);
  const annotationsUrl =
    entry?.device !== undefined && confirmed === entry.annotationsUrl ? entry.annotationsUrl : null;
  const setWatching = useAnnotationWatchStore((state) => state.setWatching);
  const noteDeviceAnnotatorUrl = useAnnotationWatchStore((state) => state.noteDeviceAnnotatorUrl);
  const ensureAnnotator = useAtomCommand(deviceEnvironment.annotator, { reportFailure: false });
  const threadRef = useMemo(() => parseScopedThreadKey(threadKey), [threadKey]);
  const sessions = useEnvironmentQuery(
    threadRef === null
      ? null
      : deviceEnvironment.state({ environmentId: threadRef.environmentId, input: {} }),
  );
  const flight = useRef<DeviceWatchConfirmFlight>({ key: null, token: 0 });
  const stopConfirm = useRef<(() => void) | null>(null);
  const activeKey = useRef<string | null>(null);
  const savedUrl = entry?.annotationsUrl ?? null;
  const hostId = entry?.device?.hostId ?? null;
  const deviceId = entry?.device?.deviceId ?? null;
  const deviceLive =
    hostId !== null &&
    deviceId !== null &&
    sessions.isSuccess &&
    (sessions.data?.sessions ?? []).some(
      (session) => session.hostId === hostId && session.deviceId === deviceId,
    );
  useEffect(() => {
    if (hostId === null || deviceId === null || threadRef === null || !sessions.isSuccess) return;
    // No open session for this device, so Watch has nothing left to poll.
    if (!deviceLive) setWatching(threadKey, null);
  }, [deviceId, deviceLive, hostId, sessions.isSuccess, setWatching, threadKey, threadRef]);
  // A failed confirm retries after a short gap. The device may not publish
  // another snapshot, including one that arrived while the call was in flight.
  useEffect(() => {
    if (
      !deviceLive ||
      hostId === null ||
      deviceId === null ||
      savedUrl === null ||
      threadRef === null
    ) {
      stopConfirm.current?.();
      stopConfirm.current = null;
      activeKey.current = null;
      return;
    }
    if (confirmed === savedUrl) {
      stopConfirm.current?.();
      stopConfirm.current = null;
      activeKey.current = null;
      return;
    }
    const device = { hostId, deviceId };
    const key = deviceWatchConfirmKey(device, savedUrl);
    if (activeKey.current === key) return;
    stopConfirm.current?.();
    const environmentId = threadRef.environmentId;
    activeKey.current = key;
    stopConfirm.current = startDeviceWatchConfirm({
      device,
      annotationsUrl: savedUrl,
      flight: flight.current,
      confirm: () =>
        ensureAnnotator({
          environmentId,
          input: {
            hostId: DeviceHostId.make(hostId),
            deviceId: DeviceId.make(deviceId),
          },
        }).then((result) =>
          result._tag === "Success"
            ? result.value.error
              ? null
              : result.value.annotationsUrl
            : null,
        ),
      readEntry: () => useAnnotationWatchStore.getState().watchingByThreadKey[threadKey],
      note: (url) => noteDeviceAnnotatorUrl(threadKey, device, url),
      schedule: (delayMs, run) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      },
    });
  }, [
    confirmed,
    deviceId,
    deviceLive,
    ensureAnnotator,
    hostId,
    noteDeviceAnnotatorUrl,
    savedUrl,
    threadKey,
    threadRef,
  ]);
  useEffect(() => {
    return () => {
      stopConfirm.current?.();
      stopConfirm.current = null;
      activeKey.current = null;
    };
  }, []);
  return <AnnotationWatchSender threadKey={threadKey} annotationsUrl={annotationsUrl} />;
}

function AnnotationWatchSender({
  threadKey,
  annotationsUrl,
}: {
  threadKey: string;
  annotationsUrl: string | null;
}) {
  const threadRef = useMemo(() => parseScopedThreadKey(threadKey), [threadKey]);
  const lastSentIds = useAnnotationWatchStore(
    (state) => state.lastSentIdsByThreadKey[threadKey] ?? EMPTY_IDS,
  );
  const endpoint = useMemo(
    () => (annotationsUrl === null ? null : { annotationsUrl, injectUrl: "", origin: "" }),
    [annotationsUrl],
  );
  const annotations = useAnnotatorQueue(endpoint).annotations;
  const threadIdle = useThreadIdle(threadKey);

  const toSend = waitingIdsToSend({
    watching: annotationsUrl !== null,
    threadIdle,
    annotations: annotations ?? [],
    lastSentIds,
  });
  const sendKey = toSend.join(",");
  const send = useEffectEvent(() => {
    if (threadRef === null || annotationsUrl === null || annotations === null) return;
    sendAnnotationPrompt({ threadRef, annotationsUrl, annotations });
  });
  // Keyed on the ids to send; the annotations array changes identity on every fetch.
  useEffect(() => {
    if (sendKey !== "") send();
  }, [sendKey]);
  return null;
}

const EMPTY_IDS: string[] = [];

/** The same "can take a message now" rules the queued message sender uses, plus an empty queue. */
function useThreadIdle(threadKey: string): boolean {
  const threadRef = useMemo(() => parseScopedThreadKey(threadKey), [threadKey]);
  const thread = useThread(threadRef);
  const threadStatus = useThreadStatus(threadRef);
  const environment = useEnvironment(threadRef?.environmentId ?? null);
  const queue = useQueuedMessages(threadKey);
  const pendingRequests = useMemo(
    () => derivePendingRequests(thread?.activities ?? []),
    [thread?.activities],
  );
  const phase = derivePhase(thread?.session ?? null);
  const lastDispatch = useQueuedMessageStore(
    (state) => state.lastDispatchByThreadKey[threadKey]?.thread ?? null,
  );
  if (threadRef === null || thread === null || threadStatus !== "live") return false;
  if (environment !== null && environment.connection.phase !== "connected") return false;
  if (queue.length > 0) return false;
  if (phase === "running" || phase === "connecting") return false;
  if (pendingRequests.approvals.length > 0 || pendingRequests.userInputs.length > 0) return false;
  const latestUserMessageId = thread.messages.findLast((m) => m.role === "user")?.id ?? null;
  return (
    lastDispatch === null ||
    hasServerAcknowledgedLocalDispatch({
      localDispatch: lastDispatch,
      phase,
      latestTurn: thread.latestTurn ?? null,
      latestUserMessageId,
      session: thread.session ?? null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      latestTurnStartFailureId: latestTurnStartFailureId(thread, latestUserMessageId),
      threadError: null,
    })
  );
}
