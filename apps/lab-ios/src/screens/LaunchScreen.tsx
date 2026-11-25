import { useId } from "react";
import type { LaunchFailure, LaunchState } from "../urlState";
import "./LaunchScreen.css";

const statusText: Partial<Record<LaunchState, string>> = {
  checking: "Checking connection",
  setup: "Downloading threads",
  downloading: "Downloading threads",
  finalizing: "Finalizing",
};

export function LaunchScreen({ phase }: { phase: LaunchState }) {
  const message = statusText[phase];
  return (
    <div className="ios-launch">
      <span className="ios-launch-mark" aria-hidden />
      <span className="ios-launch-status" role="status" aria-atomic="true">
        {message}
      </span>
    </div>
  );
}

const errors = {
  "no-network": {
    title: "Not connected to an Orbit network",
    message: "Turn on your Orbit WireGuard tunnel, then try again.",
  },
  "no-gateway": {
    title: "Couldn’t reach the Orbit server",
    message: "Check that https://gateway.orbit is available, then try again.",
  },
};

export function ConnectionAlert({
  failure,
  retry,
  openOffline,
}: {
  failure: LaunchFailure;
  retry: () => void;
  openOffline: (() => void) | undefined;
}) {
  const id = useId();
  const { title, message } = errors[failure];
  return (
    <div className="ios-alert-backdrop">
      <section
        className="ios-connection-alert"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={id}
        aria-describedby={id + "-message"}
      >
        <h2 id={id}>{title}</h2>
        <p id={id + "-message"}>{message}</p>
        <div className="ios-alert-actions">
          {openOffline && <button onClick={openOffline}>Use offline</button>}
          <button onClick={retry}>Try again</button>
        </div>
      </section>
    </div>
  );
}
