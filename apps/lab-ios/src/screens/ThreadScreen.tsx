import { OfflinePill } from "../components/OfflinePill";
import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { Composer } from "../components/Composer";
import { ComposerApprovalCard, type ApprovalExample } from "../components/ComposerApprovalCard";
import { ThreadFeedEntries } from "../components/ThreadFeedEntries";
import { FileChangeStats, type FileReviewSelection } from "../components/FileChangesCard";
import { GlassButton, GlassHeader } from "../components/GlassHeader";
import { QuestionPanel } from "../components/QuestionPanel";
import { QUESTION_SCENARIOS, type LabAttachment, type LabThread } from "../data/fixtures";
import { contextMarkdown, useQuestionFlow } from "./useQuestionFlow";
import "./ThreadScreen.css";

const FilePatch = lazy(() => import("../components/FilePatch"));

function Feed(props: {
  readonly thread: LabThread;
  readonly agentMessageCards: boolean;
  readonly onOpenTask: (id: number) => void;
  readonly onReview: (selection: FileReviewSelection) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a thread opens at its newest message
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && props.thread.entries.length) node.scrollTop = node.scrollHeight;
  }, [props.thread.entries.length]);
  return (
    <div className="m-feed m-scroll" ref={ref}>
      <div className="m-feed-inner">
        <ThreadFeedEntries
          onOpenTask={props.onOpenTask}
          thread={props.thread}
          agentMessageCards={props.agentMessageCards}
          onReview={props.onReview}
        />
      </div>
    </div>
  );
}

export function ThreadScreen({
  offline = false,
  thread,
  agentMessageCards,
  scenarioId,
  approvalExample,
  onOpenTask,
  onBack,
  onSend,
  finishQuestion,
  onModel,
  model,
  provider,
}: {
  offline?: boolean;
  thread: LabThread;
  agentMessageCards: boolean;
  scenarioId?: string | undefined;
  approvalExample?: ApprovalExample | undefined;
  onOpenTask: (id: number) => void;
  onBack: () => void;
  onSend: (text: string, attachments: readonly LabAttachment[]) => void;
  finishQuestion: (answer?: string) => void;
  onModel: () => void;
  model: string;
  provider: LabThread["instanceId"];
}) {
  const scenario = QUESTION_SCENARIOS[scenarioId ?? "single"] ?? QUESTION_SCENARIOS.single!;
  const flow = useQuestionFlow(scenario);
  const questionOpen = !!scenarioId;
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState(false);
  const [review, setReview] = useState<FileReviewSelection | null>(null);
  const feed = thread;
  function submitAnswers() {
    if (!flow.canSubmit) return;
    const answer = flow.list
      .map((q) => {
        const { picked, custom } = flow.draftOf(q.id);
        return [...picked, custom.trim()].filter(Boolean).join(", ");
      })
      .join("\n");
    finishQuestion(answer);
  }
  function send(attachments: readonly LabAttachment[]) {
    if (questionOpen) {
      if (flow.canSubmit) submitAnswers();
      else if (flow.draft.custom.trim() && flow.step < flow.list.length - 1)
        flow.goTo(flow.step + 1);
      return;
    }
    if (draft.trim() || attachments.length) {
      onSend(draft.trim(), attachments);
      setDraft("");
    }
  }
  return (
    <div className="m-thread">
      <div className="m-thread-chat" inert={review !== null}>
        <GlassHeader
          title={feed.title}
          subtitle={[feed.project, feed.branch].filter(Boolean).join(" · ")}
          leading={<GlassButton label="Back" icon="chevron-left" onClick={onBack} />}
          trailing={
            <GlassButton
              label="More actions"
              icon="more-horizontal"
              onClick={() => setMenu(!menu)}
            />
          }
        />
        {menu && (
          <div className="ios-menu thread-menu">
            {["Terminal", "Git controls", "Open files"].map((v) => (
              <button key={v} onClick={() => setMenu(false)}>
                {v}
              </button>
            ))}
          </div>
        )}
        <Feed
          onOpenTask={onOpenTask}
          thread={feed}
          agentMessageCards={agentMessageCards}
          onReview={setReview}
        />
        {offline && <OfflinePill />}
        <div className="m-thread-bottom" inert={offline}>
          {approvalExample && (
            <div className="m-thread-panel">
              <ComposerApprovalCard key={approvalExample} example={approvalExample} />
            </div>
          )}
          {questionOpen && (
            <div className="m-thread-panel">
              <QuestionPanel
                flow={flow}
                context={contextMarkdown(scenario)}
                onDismiss={() => finishQuestion()}
                onSubmit={submitAnswers}
              />
            </div>
          )}
          <Composer
            value={questionOpen ? flow.draft.custom : draft}
            onChange={questionOpen ? flow.setCustom : setDraft}
            onModel={onModel}
            model={model}
            provider={provider}
            onSend={send}
            allowsAttachments={!questionOpen}
            canSend={questionOpen && flow.canSubmit}
            placeholder={questionOpen ? "Type your own answer…" : "Ask anything"}
          />
        </div>
      </div>
      {review && (
        <section className="m-thread-review" aria-label="Review changes">
          <GlassHeader
            title="Latest turn"
            subtitle={
              <FileChangeStats
                additions={review.files.reduce((total, file) => total + file.additions, 0)}
                deletions={review.files.reduce((total, file) => total + file.deletions, 0)}
              />
            }
            leading={
              <GlassButton
                label="Back to chat"
                icon="chevron-left"
                onClick={() => setReview(null)}
              />
            }
          />
          <Suspense fallback={<p role="status">Loading diff…</p>}>
            <FilePatch {...review} />
          </Suspense>
        </section>
      )}
    </div>
  );
}
