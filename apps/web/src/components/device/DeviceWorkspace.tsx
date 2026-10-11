import type { DeviceSummary, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  captureDeviceScreenshot,
  DeviceScreenshotError,
} from "@t3tools/client-runtime/device/screenshot";
import { deviceEnvironment, refreshDeviceHubAccess, useDeviceHubAccess } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  useAnnotationWatchStore,
  useConfirmedDeviceWatchUrl,
} from "~/annotations/annotationWatchStore";
import { useAnnotatorQueue } from "~/annotations/useAnnotatorQueue";
import { DeviceAnnotationControl } from "./DeviceAnnotationControl";
import { annotationsForPathname, deviceAnnotationPathname } from "./deviceAnnotations";
import { DeviceControlsRail } from "./DeviceControlsRail";
import { DeviceStreamView, type DeviceStreamHandle } from "./DeviceStreamView";
import { DeviceToolsPanel } from "./DeviceToolsPanel";
import { useDeviceControls } from "./useDeviceControls";

/** Keyed by environment and device; the screen, quick controls and drawer share the same session. */
export function DeviceWorkspace(props: {
  threadRef: ScopedThreadRef;
  environmentId: EnvironmentId;
  device: DeviceSummary;
  hostLabel: string;
  hostDiagnostics: string | undefined;
  visible: boolean;
  onFloat: () => void;
  onClose: () => void;
  onPowerOff: () => void;
}) {
  const [handle, setHandle] = useState<DeviceStreamHandle | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [axOverlay, setAxOverlay] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [annotator, setAnnotator] = useState<{ url: string | null; error: string | null }>({
    url: null,
    error: null,
  });
  const startingRef = useRef(false);
  const [screenshotPending, setScreenshotPending] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const captureRef = useRef<AbortController | null>(null);
  const downloadRef = useRef<string | null>(null);
  const access = useDeviceHubAccess(props.environmentId, props.device.hostId);
  const controls = useDeviceControls({ ...props, access });
  const ensureAnnotator = useAtomCommand(deviceEnvironment.annotator, { reportFailure: false });
  const threadKey = scopedThreadKey(props.threadRef);
  const noteDeviceAnnotatorUrl = useAnnotationWatchStore((state) => state.noteDeviceAnnotatorUrl);
  const confirmedUrl = useConfirmedDeviceWatchUrl(threadKey);
  const savedDeviceWatchUrl = useAnnotationWatchStore((state) => {
    const entry = state.watchingByThreadKey[threadKey];
    if (
      entry?.device?.hostId !== props.device.hostId ||
      entry.device.deviceId !== props.device.id
    ) {
      return null;
    }
    return entry.annotationsUrl;
  });
  const pathname = deviceAnnotationPathname(props.device.hostId, props.device.id);
  const annotatorEndpoint = useMemo(
    () =>
      annotator.url === null
        ? null
        : { annotationsUrl: annotator.url, injectUrl: "", origin: pathname },
    [annotator.url, pathname],
  );
  const queue = useAnnotatorQueue(annotatorEndpoint);
  const annotations = useMemo(
    () => (queue.annotations === null ? null : annotationsForPathname(queue.annotations, pathname)),
    [pathname, queue.annotations],
  );
  // Confirm a saved watch only when this panel already has that URL.
  // A different saved URL stays for the coordinator. Noting the cache would drop it.
  useEffect(() => {
    if (annotator.url === null || savedDeviceWatchUrl !== annotator.url) return;
    if (confirmedUrl === annotator.url) return;
    noteDeviceAnnotatorUrl(
      threadKey,
      { hostId: props.device.hostId, deviceId: props.device.id },
      annotator.url,
    );
  }, [
    annotator.url,
    confirmedUrl,
    noteDeviceAnnotatorUrl,
    props.device.hostId,
    props.device.id,
    savedDeviceWatchUrl,
    threadKey,
  ]);
  const toggleAnnotating = () => {
    if (annotating) {
      setAnnotating(false);
      return;
    }
    // `start` is idempotent. A cached URL can belong to a process that has exited.
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setAnnotator((current) => ({ url: current.url, error: null }));
    void ensureAnnotator({
      environmentId: props.environmentId,
      input: { hostId: props.device.hostId, deviceId: props.device.id },
    }).then((result) => {
      startingRef.current = false;
      setStarting(false);
      if (result._tag !== "Success") {
        setAnnotator({ url: null, error: formatEnvironmentQueryError(result.cause) });
        return;
      }
      const url = result.value.error ? null : result.value.annotationsUrl;
      if (!url) {
        setAnnotator({
          url: null,
          error: result.value.error ?? "The annotation server did not start.",
        });
        return;
      }
      setAnnotator({ url, error: null });
      setAnnotating(true);
      // This URL just came back from device.annotator. A match confirms; a different saved URL is dropped.
      noteDeviceAnnotatorUrl(
        threadKey,
        { hostId: props.device.hostId, deviceId: props.device.id },
        url,
      );
    });
  };
  useEffect(() => {
    if (!access || !props.visible) captureRef.current?.abort();
    return () => {
      captureRef.current?.abort();
      if (downloadRef.current) URL.revokeObjectURL(downloadRef.current);
      downloadRef.current = null;
    };
  }, [access, props.visible]);
  const saveScreenshot = () => {
    if (!access || captureRef.current || !props.visible) return;
    const controller = new AbortController();
    captureRef.current = controller;
    setScreenshotPending(true);
    setScreenshotError(null);
    return captureDeviceScreenshot(
      { access, platform: props.device.platform, deviceId: props.device.id },
      controller.signal,
    )
      .then((image) => {
        if (controller.signal.aborted) return;
        if (downloadRef.current) URL.revokeObjectURL(downloadRef.current);
        const url = URL.createObjectURL(image);
        downloadRef.current = url;
        const link = document.createElement("a");
        link.href = url;
        link.download = `${props.device.name.replace(/[^a-z0-9-]/gi, "-")}-${Date.now()}.png`;
        document.body.append(link);
        link.click();
        link.remove();
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          if (cause instanceof DeviceScreenshotError && cause.status === 401)
            refreshDeviceHubAccess(props.environmentId);
          setScreenshotError(
            cause instanceof Error ? cause.message : "Screenshot capture failed. Try again.",
          );
        }
      })
      .finally(() => {
        if (captureRef.current === controller) {
          captureRef.current = null;
          setScreenshotPending(false);
        }
      });
  };
  return (
    <>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {screenshotError || (controls.error && !toolsOpen) ? (
          <p role="alert" className="px-3 py-2 text-xs text-destructive">
            {screenshotError ?? controls.error}
          </p>
        ) : null}
        <div className="min-h-0 flex-1">
          <DeviceStreamView
            environmentId={props.environmentId}
            platform={props.device.platform}
            deviceName={props.device.name}
            deviceDescription={`${props.hostLabel} · ${props.device.version}`}
            deviceId={props.device.id}
            hostId={props.device.hostId}
            visible={props.visible}
            axOverlay={axOverlay}
            annotating={annotating}
            annotations={annotations ?? []}
            annotationsUrl={annotator.url}
            onToggleAnnotating={toggleAnnotating}
            allowPhoneView
            onHandle={setHandle}
            renderControls={(view) => (
              <DeviceControlsRail
                platform={props.device.platform}
                handle={handle}
                view={view}
                controls={controls}
                screenshotPending={screenshotPending}
                onScreenshot={() => void saveScreenshot()}
                annotation={
                  <DeviceAnnotationControl
                    threadRef={props.threadRef}
                    hostId={props.device.hostId}
                    deviceId={props.device.id}
                    annotating={annotating}
                    onToggle={toggleAnnotating}
                    annotationsUrl={annotator.url}
                    annotations={annotations}
                    error={annotator.error}
                    starting={starting}
                    unreachable={queue.unreachable}
                  />
                }
                toolsOpen={toolsOpen}
                onTools={() => setToolsOpen(!toolsOpen)}
                onFloat={props.onFloat}
                onClose={props.onClose}
                onPowerOff={props.onPowerOff}
              />
            )}
          />
        </div>
      </div>
      {toolsOpen ? (
        <DeviceToolsPanel
          device={props.device}
          controls={controls}
          hostDiagnostics={props.hostDiagnostics}
          access={access}
          axOverlay={axOverlay}
          onAxOverlayChange={setAxOverlay}
          onClose={() => setToolsOpen(false)}
          className="absolute inset-y-0 right-0 z-10 w-full max-w-72 border-l shadow-lg @[700px]:static @[700px]:w-72 @[700px]:shrink-0 @[700px]:shadow-none"
        />
      ) : null}
    </>
  );
}
