import { useState, type ReactNode } from "react";
import { ComposerApprovalCard } from "../../../lab-ios/src/components/ComposerApprovalCard";
import { ComposerPanelDeck } from "../../../lab-ios/src/components/ComposerPanelDeck";
import { Icon } from "../../../lab-ios/src/components/Icon";
import { QuestionPanel } from "../../../lab-ios/src/components/QuestionPanel";
import { ThreadFeedEntries } from "../../../lab-ios/src/components/ThreadFeedEntries";
import { FEED_THREAD, QUESTION_SCENARIOS } from "../../../lab-ios/src/data/fixtures";
import { nativeThemeTokens } from "../../../lab-ios/src/nativeTheme";
import { contextMarkdown, useQuestionFlow } from "../../../lab-ios/src/screens/useQuestionFlow";
import type { currentTheme } from "./themes";
import "../../../lab-ios/src/screens/ThreadScreen.css";
import "../../../lab-ios/src/screens/TasksScreen.css";
import "../../../lab-ios/src/theme.generated.css";
import "./ThreadCardFeed.css";

type Theme = ReturnType<typeof currentTheme>;

function ThreadTheme({ theme, children }: { theme: Theme; children: ReactNode }) {
  const light = theme.appearance === "light";
  return (
    <div
      className="m-thread"
      data-ios-theme={light ? "light" : "dark"}
      data-mobile-theme={light ? "light" : "dark-mono"}
      style={nativeThemeTokens(theme.colors, light)}
    >
      {children}
    </div>
  );
}

export default function ThreadCardFeed({
  theme,
  onOpenTask,
}: {
  theme: Theme;
  onOpenTask: (id: number) => void;
}) {
  return (
    <section className="desktop-card-feed" aria-label={FEED_THREAD.title} data-code-cards="true">
      <ThreadTheme theme={theme}>
        <div className="m-feed">
          <div className="m-feed-inner">
            <ThreadFeedEntries
              onOpenTask={onOpenTask}
              thread={FEED_THREAD}
              agentMessageCards
              hideSecretRequest
            />
          </div>
        </div>
      </ThreadTheme>
    </section>
  );
}

const requests = ["approval", "question", "secret"] as const;
const questionScenario = QUESTION_SCENARIOS.single!;

export function DesktopRequestDock({ theme }: { theme: Theme }) {
  const [progress, setProgress] = useState({ index: 0, result: "" });
  const flow = useQuestionFlow(questionScenario);
  const [token, setToken] = useState("");
  const remaining = requests.length - progress.index;
  const request = requests[progress.index];
  function complete(result: string) {
    setProgress({ index: progress.index + 1, result });
  }

  return (
    <section className="desktop-card-feed desktop-request-dock" aria-label="Requests">
      <ThreadTheme theme={theme}>
        <div className="desktop-request-status" role="status">
          {progress.result}
        </div>
        {request === "approval" && (
          <ComposerApprovalCard
            example="command"
            queuedAfter={remaining - 1}
            onComplete={complete}
          />
        )}
        {request === "question" && (
          <QuestionPanel
            flow={flow}
            context={contextMarkdown(questionScenario)}
            queuedAfter={remaining - 1}
            onDismiss={() => complete("Question skipped")}
            onSubmit={() => complete("Answer sent")}
          />
        )}
        {request === "secret" && (
          <ComposerPanelDeck remaining={remaining} kind="secret">
            <form
              className="m-composer-panel"
              aria-label="Secret request"
              onSubmit={(event) => {
                event.preventDefault();
                if (!token.trim()) return;
                setToken("");
                complete("Demo token saved");
              }}
            >
              <div className="m-composer-panel-header">
                <Icon name="pin" size={14} />
                <span>Secret request</span>
              </div>
              <div className="m-composer-panel-body">
                <div className="m-composer-panel-scroll desktop-secret-content">
                  <label htmlFor="desktop-demo-token">Review service token</label>
                  <span>Enter sample-token to preview how a secret request is answered.</span>
                  <input
                    id="desktop-demo-token"
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                  />
                </div>
              </div>
              <div className="m-composer-panel-actions m-composer-decision-actions">
                <button
                  type="button"
                  data-decision="decline"
                  onClick={() => {
                    setToken("");
                    complete("Secret request declined");
                  }}
                >
                  Decline
                </button>
                <button type="submit" data-decision="accept" disabled={!token.trim()}>
                  Save
                </button>
              </div>
            </form>
          </ComposerPanelDeck>
        )}
      </ThreadTheme>
    </section>
  );
}
