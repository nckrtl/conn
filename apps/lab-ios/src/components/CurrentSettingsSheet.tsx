import { useState } from "react";
import { GlassButton } from "./GlassHeader";
import { Icon } from "./Icon";

export interface PreviewEnvironments {
  paired: boolean;
  linked: boolean;
}

export function CurrentSettingsSheet({
  environments,
  change,
  offline,
  reconnect,
  close,
}: {
  environments: PreviewEnvironments;
  change: (environments: PreviewEnvironments) => void;
  offline: boolean;
  reconnect: () => void;
  close: () => void;
}) {
  const [detail, setDetail] = useState(false);
  const [linking, setLinking] = useState(false);
  const [message, setMessage] = useState("");
  const { paired, linked } = environments;
  const title = detail ? "Environments" : "Settings";
  return (
    <div className="ios-sheet ios-settings-sheet" role="dialog" aria-label={title}>
      <header>
        <GlassButton
          icon={detail ? "chevron-left" : "close"}
          label={detail ? "Back" : "Close settings"}
          onClick={() => {
            if (detail) {
              setDetail(false);
              setLinking(false);
              setMessage("");
            } else close();
          }}
        />
        {title}
        <i />
      </header>
      {!detail ? (
        <section aria-label="Connections">
          <h2 className="ios-group-title">Connections</h2>
          <div className="ios-group">
            <button onClick={() => setDetail(true)}>
              <Icon name="desktop" size={22} />
              <span className="ios-settings-label">Environments</span>
              <span>{Number(paired) + Number(linked)}</span>
              <Icon name="chevron-right" size={15} />
            </button>
          </div>
        </section>
      ) : (
        <>
          <section aria-label="Connected environment">
            <h2 className="ios-group-title">Connected environment</h2>
            <div className="ios-group">
              {paired && (
                <p>
                  Server <span className="ios-option-value">conn.example</span>
                </p>
              )}
              <p>
                Status{" "}
                <span className="ios-option-value">
                  {!paired ? "Disconnected" : offline ? "Not connected" : "Connected"}
                </span>
              </p>
              {paired && (
                <>
                  <button
                    onClick={() => {
                      reconnect();
                      setMessage(offline ? "Reconnect requested." : "Connected to conn.example.");
                    }}
                  >
                    Reconnect
                  </button>
                  <button
                    onClick={() => {
                      change({ paired: false, linked: false });
                      setMessage("");
                      setLinking(false);
                    }}
                  >
                    Disconnect
                  </button>
                </>
              )}
            </div>
          </section>
          <section aria-label="Linked environments">
            <h2 className="ios-group-title">Linked environments</h2>
            <div className="ios-group">
              {linked && (
                <>
                  <p>
                    build.example{" "}
                    <span className="ios-option-value">
                      {offline ? "Not connected" : "Connected"}
                    </span>
                  </p>
                  <button
                    aria-label="Disconnect build.example"
                    onClick={() => {
                      change({ ...environments, linked: false });
                      setMessage("");
                    }}
                  >
                    Disconnect
                  </button>
                </>
              )}
              {linking ? (
                <>
                  <p>
                    Pairing URL <span className="ios-option-value">build.example/pair</span>
                  </p>
                  <button
                    onClick={() => {
                      setLinking(false);
                      if (offline) {
                        setMessage("Reconnect to link an environment.");
                        return;
                      }
                      change({ ...environments, linked: true });
                      setMessage("");
                    }}
                  >
                    Connect sample environment
                  </button>
                  <button onClick={() => setLinking(false)}>Cancel</button>
                </>
              ) : (
                <button
                  disabled={linked}
                  onClick={() => {
                    setLinking(true);
                    setMessage("");
                  }}
                >
                  Link environment
                </button>
              )}
            </div>
          </section>
          {message && (
            <p className="ios-follow-up-help" role="status">
              {message}
            </p>
          )}
        </>
      )}
    </div>
  );
}
