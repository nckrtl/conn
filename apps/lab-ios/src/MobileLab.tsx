import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PhoneFrame, PHONE_HEIGHT, PHONE_WIDTH } from "./components/PhoneFrame";
import { NativeWorkspace, usePhoneFixtures } from "./NativeWorkspace";
import { ConnectionAlert, LaunchScreen } from "./screens/LaunchScreen";
import {
  CONNECTIONS,
  INSIGHT_VARIANTS,
  LAUNCH_STATES,
  LAUNCH_DELAYS,
  isTimedPhase,
  SCREENS,
  useLabUrlState,
  type Connection,
  type LaunchState,
  type ScreenId,
  type ThemeChoice,
} from "./urlState";

const THEMES: ReadonlyArray<{ id: ThemeChoice; label: string }> = [
  { id: "dark-ocean", label: "Dark Ocean" },
  { id: "light", label: "Light" },
  { id: "both", label: "Both" },
];
const SCALES = [0, 0.5, 0.75, 1, 1.25, 1.5];

export function MobileLab() {
  const fixtures = usePhoneFixtures();
  const toolbar = useRef<HTMLDivElement>(null),
    [fit, setFit] = useState(1);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fit the whole phone, including its toolbar, in the preview viewport.
  useLayoutEffect(() => {
    const el = toolbar.current!;
    const resize = () =>
      setFit(
        Math.max(
          0.25,
          Math.min(
            1,
            (innerWidth - 48) / PHONE_WIDTH,
            (innerHeight - el.offsetHeight - 56) / PHONE_HEIGHT,
          ),
        ),
      );
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);

  const [url, update] = useLabUrlState();
  const failure =
    url.launch === "no-network" || url.launch === "no-gateway" ? url.launch : undefined;
  const setup =
    url.launch === "setup" || url.launch === "downloading" || url.launch === "finalizing";
  const workspace =
    url.launch === "workspace" || url.launch === "offline" || (!!failure && url.device === "saved");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The lab clock stands in for Orbit discovery and cache initialization.
  useEffect(() => {
    const phase = url.launch;
    if (!isTimedPhase(phase)) return;
    const timer = window.setTimeout(() => {
      switch (phase) {
        case "splash":
          update({ launch: "checking" });
          break;
        case "checking":
          update({
            launch:
              url.connection === "online"
                ? url.device === "new"
                  ? "downloading"
                  : "workspace"
                : url.connection,
          });
          break;
        case "downloading":
          update({ launch: "finalizing" });
          break;
        case "finalizing":
          update({
            launch: "workspace",
            device: "saved",
            screen: "thread-list",
            state: "populated",
            thread: "",
          });
          break;
      }
    }, LAUNCH_DELAYS[phase]);
    return () => window.clearTimeout(timer);
  }, [url.launch, url.connection, url.device, update]);
  function selectLaunch(launch: LaunchState) {
    if (launch === "workspace" || launch === "offline") update({ launch, device: "saved" });
    else update({ launch });
  }
  const selectedPhase =
    failure || url.launch === "checking" ? "splash" : setup ? "setup" : url.launch;
  const themes = url.theme === "both" ? (["dark-ocean", "light"] as const) : ([url.theme] as const);
  const insightGallery = url.screen === "tasks" && url.insights !== undefined;
  const states: readonly string[] = insightGallery
    ? ["strip", "chart"]
    : SCREENS[url.screen].states;
  return (
    <div className="mlab" data-backdrop={url.theme === "light" ? "light" : "dark"}>
      <div className="mlab-toolbar" ref={toolbar}>
        <div className="mlab-launch-controls" role="group" aria-label="App launch">
          <span>App launch</span>
          <div className="mlab-segment">
            {Object.entries(LAUNCH_STATES).map(([phase, label]) => (
              <button
                key={phase}
                aria-pressed={selectedPhase === phase}
                data-active={selectedPhase === phase}
                onClick={() => selectLaunch(phase as LaunchState)}
              >
                {label}
              </button>
            ))}
          </div>
          <label>
            Device
            <select
              aria-label="Device"
              value={url.device}
              onChange={(e) =>
                update({ device: e.target.value === "new" ? "new" : "saved", launch: "splash" })
              }
            >
              <option value="new">First launch</option>
              <option value="saved">Saved screen</option>
            </select>
          </label>
          <label>
            Connection
            <select
              aria-label="Connection"
              value={url.connection}
              onChange={(e) =>
                update({
                  connection: e.target.value as Connection,
                  launch: failure ? url.launch : "splash",
                })
              }
            >
              {Object.entries(CONNECTIONS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button className="mlab-replay" onClick={() => selectLaunch("splash")}>
            Replay launch
          </button>
        </div>
        <label>
          Screen
          <select
            value={url.screen}
            onChange={(event) =>
              update({
                screen: event.target.value as ScreenId,
                thread: "",
                launch: url.launch === "offline" ? "offline" : "workspace",
                device: "saved",
              })
            }
          >
            {Object.entries(SCREENS).map(([id, screen]) => (
              <option key={id} value={id}>
                {screen.label}
              </option>
            ))}
          </select>
        </label>
        {workspace && states.length > 0 ? (
          <div className="mlab-segment" role="group" aria-label="State">
            {states.map((state) => (
              <button
                key={state}
                aria-pressed={url.state === state}
                data-active={url.state === state}
                onClick={() => update({ state })}
              >
                {state}
              </button>
            ))}
          </div>
        ) : null}
        {workspace && insightGallery && (
          <div className="mlab-segment" role="group" aria-label="Insights">
            {INSIGHT_VARIANTS.map((variant) => (
              <button
                key={variant}
                aria-pressed={url.insights === variant}
                data-active={url.insights === variant}
                onClick={() => update({ insights: variant })}
              >
                {variant.toUpperCase()}
              </button>
            ))}
          </div>
        )}
        <div className="mlab-segment" role="group" aria-label="Theme">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              data-active={url.theme === theme.id}
              onClick={() => update({ theme: theme.id })}
            >
              {theme.label}
            </button>
          ))}
        </div>
        <div className="mlab-segment" role="group" aria-label="Scale">
          {SCALES.map((scale) => (
            <button key={scale} data-active={url.scale === scale} onClick={() => update({ scale })}>
              {scale ? Math.round(scale * 100) + "%" : "Fit"}
            </button>
          ))}
        </div>
      </div>
      <div
        className="mlab-stage"
        data-screen={url.screen}
        data-code-cards={url.screen === "thread"}
      >
        {themes.map((theme) => (
          <PhoneFrame
            key={theme}
            theme={theme}
            scale={url.scale || fit}
            offline={url.launch === "offline"}
          >
            <div className="mlab-phone-content" inert={!!failure}>
              {workspace ? (
                <NativeWorkspace
                  key={
                    ["tasks", "pull-requests", "task-detail", "pr-detail"].includes(url.screen)
                      ? "records"
                      : url.screen === "new-chat"
                        ? url.screen + url.state
                        : url.screen
                  }
                  url={url}
                  update={update}
                  fixtures={fixtures}
                  light={theme === "light"}
                />
              ) : (
                <LaunchScreen phase={url.launch} />
              )}
            </div>
            {failure && (
              <ConnectionAlert
                failure={failure}
                retry={() => selectLaunch("splash")}
                openOffline={url.device === "saved" ? () => selectLaunch("offline") : undefined}
              />
            )}
          </PhoneFrame>
        ))}
      </div>
    </div>
  );
}
