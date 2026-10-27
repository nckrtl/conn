import { holdCapture } from "./capture-gate";
import {
  cancelHostSession,
  startHostDictation,
  stopHostSession,
  triggerDictation,
  usesHostSessions,
} from "./dictation-trigger";
import { useEffect, useRef, useState } from "react";
import { dictate, triggersDesktopDictation, type DictationSettings } from "./dictation";
import { setDictationKeyHandlers } from "./dictation-keys";
import { isDictationEnabled, isUnrelatedEditable, mergeTranscript } from "./dictation-settings";
import type { Ref } from "./state";

export type DictationState = "idle" | "recording" | "transcribing" | "triggering";

type Options = {
  comment: Ref<string>;
  autoStart: boolean;
  settings: DictationSettings;
  /** The host dictation session id; the draft's own id. */
  sessionId: string;
  onBeforeTrigger: () => void;
  onSubmit: () => void;
  /** Enter on a host session that is still recording: hand it to the finishing list. */
  onFinish: () => void;
};

export function useDictation(options: Options) {
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [emptySpeech, setEmptySpeech] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState([0.12, 0.16, 0.14, 0.18]);
  const enabled = isDictationEnabled(options.settings);
  const hostSessions = usesHostSessions(options.settings) && options.sessionId !== "";

  const session = useRef<{
    stop: AbortController | null;
    abort: AbortController | null;
    elapsedTimer: number;
    elapsedStarted: number;
    state: DictationState;
    comment: Ref<string>;
    settings: DictationSettings;
    onSubmit: () => void;
    onFinish: () => void;
    enabled: boolean;
    hostSessions: boolean;
    sessionId: string;
    handedOff: boolean;
    disposed: boolean;
  }>({
    stop: null,
    abort: null,
    elapsedTimer: 0,
    elapsedStarted: 0,
    state: "idle",
    comment: options.comment,
    settings: options.settings,
    onSubmit: options.onSubmit,
    onFinish: options.onFinish,
    enabled,
    hostSessions,
    sessionId: options.sessionId,
    handedOff: false,
    disposed: false,
  });

  session.current.comment = options.comment;
  session.current.settings = options.settings;
  session.current.onSubmit = options.onSubmit;
  session.current.onFinish = options.onFinish;
  session.current.enabled = enabled;
  session.current.hostSessions = hostSessions;
  session.current.sessionId = options.sessionId;

  const sessionLive = () =>
    session.current.hostSessions &&
    (session.current.state === "recording" || session.current.state === "transcribing");

  const startElapsed = () => {
    session.current.elapsedStarted = Date.now();
    setElapsedMs(0);
    window.clearInterval(session.current.elapsedTimer);
    session.current.elapsedTimer = window.setInterval(() => {
      setElapsedMs(Date.now() - session.current.elapsedStarted);
    }, 200);
  };

  const stopElapsed = () => {
    window.clearInterval(session.current.elapsedTimer);
    session.current.elapsedTimer = 0;
  };

  const stopHostRecording = () => {
    stopElapsed();
    session.current.state = "transcribing";
    setState("transcribing");
    void stopHostSession(session.current.sessionId)
      .then(
        (text) => {
          if (session.current.disposed) return;
          session.current.comment.value = mergeTranscript(session.current.comment.value, text);
        },
        () => undefined,
      )
      .finally(() => {
        if (session.current.disposed) return;
        session.current.state = "idle";
        setState("idle");
      });
  };

  const beginStop = (): boolean => {
    if (session.current.hostSessions && session.current.state === "recording") {
      stopHostRecording();
      return true;
    }

    if (session.current.state !== "recording" || !session.current.stop) {
      return false;
    }

    stopElapsed();
    session.current.state = "transcribing";
    setState("transcribing");
    session.current.stop.abort();

    return true;
  };

  const cancelSession = () => {
    if (sessionLive() && !session.current.handedOff) {
      cancelHostSession(session.current.sessionId);
    }
    stopElapsed();
    session.current.abort?.abort();
    session.current.stop = null;
    session.current.abort = null;
    session.current.state = "idle";
    setState("idle");
  };

  const startHostRecording = async (releaseCapture: () => void): Promise<void> => {
    const id = session.current.sessionId;
    session.current.state = "triggering";
    setState("triggering");
    options.onBeforeTrigger();
    let mode: "session" | "paste";
    try {
      // Not aborted on unmount: a start that reaches the host is then cancelled below.
      const request = startHostDictation(id, new AbortController().signal);
      releaseCapture();
      mode = await request;
    } catch (cause) {
      if (session.current.disposed) return cancelHostSession(id);
      setError(
        cause instanceof Error
          ? `Could not trigger local dictation: ${cause.message}`
          : "Could not trigger local dictation.",
      );
      session.current.state = "idle";
      setState("idle");
      return;
    } finally {
      releaseCapture();
    }
    if (mode === "paste") {
      // An older dictation app records and pastes as before; this box stops on its own.
      session.current.hostSessions = false;
      if (session.current.disposed) return;
      session.current.state = "idle";
      setState("idle");
      return;
    }
    if (session.current.disposed) return cancelHostSession(id);
    session.current.state = "recording";
    setState("recording");
    startElapsed();
  };

  /** Releases a live host session to the caller, who stops it; null when none is live. */
  const handOff = (): string | null => {
    if (!sessionLive()) return null;
    session.current.handedOff = true;
    stopElapsed();
    return session.current.sessionId;
  };

  const start = async (): Promise<void> => {
    if (session.current.disposed || !session.current.enabled || session.current.state !== "idle") {
      return;
    }

    setEmptySpeech(false);
    setError(null);
    const releaseCapture = holdCapture();
    if (session.current.hostSessions) {
      await startHostRecording(releaseCapture);
      return;
    }
    session.current.stop = new AbortController();
    session.current.abort = new AbortController();
    if (triggersDesktopDictation(session.current.settings)) {
      session.current.state = "triggering";
      setState("triggering");
      options.onBeforeTrigger();
      try {
        const request = triggerDictation(
          session.current.settings,
          "start",
          AbortSignal.any([session.current.abort.signal, AbortSignal.timeout(10000)]),
        );
        releaseCapture();
        await request;
      } catch (cause) {
        if (!session.current.disposed) {
          setError(
            cause instanceof Error
              ? `Could not trigger local dictation: ${cause.message}`
              : "Could not trigger local dictation.",
          );
        }
      } finally {
        releaseCapture();
        if (!session.current.disposed) {
          session.current.state = "idle";
          setState("idle");
        }
        session.current.stop = null;
        session.current.abort = null;
      }
      return;
    }
    session.current.state = "recording";
    setState("recording");
    startElapsed();

    try {
      const text = await dictate({
        wsUrl: session.current.settings.wsUrl!,
        codec: session.current.settings.codec,
        stopSignal: session.current.stop.signal,
        abortSignal: session.current.abort.signal,
        onLevels: (next) => {
          setLevels(next);
        },
        onRecording: releaseCapture,
      });

      if (session.current.disposed) {
        return;
      }

      if (text.trim() === "") {
        setEmptySpeech(true);
        session.current.state = "idle";
        setState("idle");
        return;
      }

      session.current.comment.value = mergeTranscript(session.current.comment.value, text);
      session.current.state = "idle";
      setState("idle");
    } catch (cause) {
      if (session.current.disposed) {
        return;
      }

      if (cause instanceof DOMException && cause.name === "AbortError") {
        session.current.state = "idle";
        setState("idle");
        return;
      }

      setError(cause instanceof Error ? cause.message : "Could not start dictation.");
      session.current.state = "idle";
      setState("idle");
    } finally {
      releaseCapture();
      stopElapsed();
      session.current.stop = null;
      session.current.abort = null;
    }
  };

  const toggle = () => {
    if (session.current.state === "recording") {
      beginStop();
      return;
    }

    if (session.current.state === "idle") {
      void start();
    }
  };

  const onEnter = (): boolean => {
    if (sessionLive()) {
      session.current.onFinish();
      return true;
    }

    if (beginStop()) {
      return true;
    }

    if (!session.current.comment.value.trim()) {
      return false;
    }

    session.current.onSubmit();

    return true;
  };

  const onEscape = (): boolean => false;

  useEffect(() => {
    session.current.disposed = false;
    setDictationKeyHandlers({
      onEnter: () => {
        if (isUnrelatedEditable(document.activeElement)) {
          return false;
        }

        return onEnter();
      },
      onEscape,
    });

    if (enabled && options.autoStart) {
      void start();
    }

    return () => {
      session.current.disposed = true;
      setDictationKeyHandlers(null);
      cancelSession();
    };
  }, []);

  return {
    enabled,
    state,
    emptySpeech,
    error,
    elapsedMs,
    levels,
    toggle,
    onEnter,
    onEscape,
    handOff,
  };
}
