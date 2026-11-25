import { useState } from "react";
import catalog from "../../../lab-gpui/src/mock/model-catalog.json";
import type { LabThread } from "../data/fixtures";
import { GlassButton } from "./GlassHeader";
import { Icon, ProviderIcon, type Provider } from "./Icon";

const providers = [
  { id: "codex", label: "Codex", models: ["GPT-6.2 Astra", "GPT-6.2 Sol"] },
  {
    id: "claudeAgent",
    label: "Claude",
    models: ["Claude Sonnet 5.5", "Claude Opus 5.5", "Claude Haiku 5.5"],
  },
] as const;
type Settings = Pick<LabThread, "model" | "instanceId" | "effort" | "speed" | "followUpBehavior">;
type Options = Pick<Settings, "effort" | "speed">;

function modelOptions(name: string, saved: Options) {
  const model = catalog.find(
    (entry) => entry.name.replaceAll("-", " ") === name.replaceAll("-", " "),
  );
  const efforts = model?.efforts ?? [];
  const speeds = model?.speeds ?? [];
  return {
    efforts,
    speeds,
    effort: saved.effort && efforts.includes(saved.effort) ? saved.effort : model?.defaultEffort,
    speed: saved.speed && speeds.includes(saved.speed) ? saved.speed : speeds[0],
  };
}

export function ThreadSettingsSheet({
  thread,
  close,
  save,
}: {
  thread: LabThread;
  close: () => void;
  save: (settings: Settings) => void;
}) {
  const initialModel = thread.model === "Opus 5.5" ? "Claude Opus 5.5" : thread.model;
  const initialProvider =
    providers.find((p) => p.models.some((name) => name === initialModel))?.id ?? thread.instanceId;
  const [model, setModel] = useState(initialModel);
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [browseProvider, setBrowseProvider] = useState<Provider>(provider);
  const [page, setPage] = useState<"settings" | "providers" | "models">("settings");
  const [fromProviderList, setFromProviderList] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Record<string, Options>>({ [initialModel]: thread });
  const [followUp, setFollowUp] = useState(thread.followUpBehavior ?? "steer");
  const selected = modelOptions(model, options[model] ?? {});
  const initial = modelOptions(initialModel, thread);
  const changed =
    model !== initialModel ||
    provider !== initialProvider ||
    selected.effort !== initial.effort ||
    selected.speed !== initial.speed ||
    followUp !== (thread.followUpBehavior ?? "steer");
  const browsing = providers.find((p) => p.id === browseProvider)!;
  const matches = browsing.models.filter((name) =>
    name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  function openModels(id: Provider, fromProviders: boolean) {
    setBrowseProvider(id);
    setFromProviderList(fromProviders);
    setQuery("");
    setPage("models");
  }
  function updateOption(key: keyof Options, value: string) {
    setOptions((previous) => ({ ...previous, [model]: { ...previous[model], [key]: value } }));
  }
  return (
    <div className="ios-sheet ios-model-sheet" role="dialog" aria-label="Thread settings">
      <header>
        {page === "settings" ? (
          <GlassButton icon="close" label="Cancel thread settings" onClick={close} />
        ) : (
          <GlassButton
            icon="chevron-left"
            label="Back"
            onClick={() =>
              setPage(page === "models" && fromProviderList ? "providers" : "settings")
            }
          />
        )}
        <span>
          {page === "settings"
            ? "Thread settings"
            : page === "providers"
              ? "Provider"
              : browsing.label}
        </span>
        {page === "settings" && (
          <button
            onClick={() =>
              changed
                ? save({
                    model,
                    instanceId: provider,
                    effort: selected.effort,
                    speed: selected.speed,
                    followUpBehavior: followUp,
                  })
                : close()
            }
          >
            {changed ? "Save" : "Done"}
          </button>
        )}
      </header>
      <div className="ios-model-list m-scroll" key={page}>
        {page === "settings" && (
          <>
            <div className="ios-thread-options">
              <button onClick={() => setPage("providers")}>
                Provider{" "}
                <span>
                  <ProviderIcon provider={provider} />
                  {providers.find((p) => p.id === provider)?.label}
                  <Icon name="chevron-right" size={14} />
                </span>
              </button>
              <button onClick={() => openModels(provider, false)}>
                Model{" "}
                <span>
                  {model.replace(/^Claude /, "")}
                  <Icon name="chevron-right" size={14} />
                </span>
              </button>
              {selected.efforts.length > 0 && (
                <label>
                  Effort
                  <select
                    value={selected.effort}
                    onChange={(e) => updateOption("effort", e.target.value)}
                  >
                    {selected.efforts.map((level) => (
                      <option key={level} value={level}>
                        {level === "xhigh"
                          ? "Extra High"
                          : level.charAt(0).toUpperCase() + level.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {selected.speeds.length > 0 && (
                <label>
                  Speed
                  <select
                    value={selected.speed}
                    onChange={(e) => updateOption("speed", e.target.value)}
                  >
                    {selected.speeds.map((speed) => (
                      <option key={speed}>{speed}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="ios-thread-options">
              <label>
                Follow-up messages
                <select
                  value={followUp}
                  onChange={(e) => setFollowUp(e.target.value === "queue" ? "queue" : "steer")}
                >
                  <option value="steer">Steer</option>
                  <option value="queue">Queue</option>
                </select>
              </label>
            </div>
            <p className="ios-follow-up-help">
              {followUp === "steer"
                ? "Send follow-ups to the running turn."
                : "Send follow-ups after the running turn finishes."}
            </p>
          </>
        )}
        {page === "providers" && (
          <div className="ios-group">
            {providers.map((p) => (
              <button key={p.id} onClick={() => openModels(p.id, true)}>
                <ProviderIcon provider={p.id} />
                {p.label}
                <Icon name="chevron-right" size={14} />
              </button>
            ))}
          </div>
        )}
        {page === "models" && (
          <>
            <div className="ios-group">
              {matches.map((name) => (
                <button
                  key={name}
                  aria-pressed={model === name}
                  onClick={() => {
                    setProvider(browseProvider);
                    setModel(name);
                    setPage("settings");
                  }}
                >
                  <ProviderIcon provider={browseProvider} />
                  {name.replace(/^Claude /, "")}
                  {model === name && <Icon name="check" size={16} />}
                </button>
              ))}
            </div>
            {!matches.length && <p className="ios-empty">No models match your search.</p>}
          </>
        )}
      </div>
      {page === "models" && (
        <label className="ios-search-field">
          <Icon name="search" size={16} />
          <input
            aria-label="Find a model"
            placeholder="Find a model"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
    </div>
  );
}
