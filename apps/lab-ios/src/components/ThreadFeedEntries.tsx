import { copyFeedText } from "./copyFeedText";
import { FileChangesCard, type FileReviewSelection } from "./FileChangesCard";
import { Icon } from "./Icon";
import { GalleryCard } from "./GalleryCard";
import { MarkdownText } from "./Markdown";
import {
  AgentMessageCard,
  AgentPromptRow,
  OrbitTaskCard,
  SubagentCard,
  UserBubble,
  WorkingDivider,
} from "./FeedCards";
import type { LabEntry, LabThread } from "../data/fixtures";

function FeedEntry(props: {
  readonly entry: LabEntry;
  readonly agentMessageCards: boolean;
  readonly onOpenTask: (id: number) => void;
  readonly onReview?: ((selection: FileReviewSelection) => void) | undefined;
}) {
  const { entry } = props;
  switch (entry.kind) {
    case "galleryCard":
      return <GalleryCard card={entry.card} />;
    case "work":
      return <WorkingDivider label={entry.label} steps={entry.steps} />;
    case "user":
      return <UserBubble entry={entry} time="4:48 PM" />;
    case "assistant":
      return (
        <div className="m-feed-text">
          <MarkdownText markdown={entry.text} />
          {entry.fileChanges && (
            <FileChangesCard files={entry.fileChanges} onReview={props.onReview} />
          )}
          <div className="ios-message-meta">
            <button
              aria-label="Copy message"
              onClick={() => {
                void copyFeedText(entry.text);
              }}
            >
              <Icon name="copy" size={13} />
            </button>
            <span>1:45 PM</span>
          </div>
        </div>
      );
    case "agentMessage":
      return props.agentMessageCards ? (
        <AgentMessageCard entry={entry} />
      ) : (
        <AgentPromptRow text={entry.text} />
      );
    case "orbitTask":
      return <OrbitTaskCard task={entry.task} onOpen={() => props.onOpenTask(entry.task.id)} />;
    case "subagent":
      return <SubagentCard entry={entry} />;
    case "delegatedNotice":
    case "userInput":
      return null;
  }
}

export function ThreadFeedEntries(props: {
  readonly thread: LabThread;
  readonly agentMessageCards: boolean;
  readonly onOpenTask: (id: number) => void;
  readonly hideSecretRequest?: boolean;
  readonly onReview?: ((selection: FileReviewSelection) => void) | undefined;
}) {
  return props.thread.entries.map((entry, index) => {
    if (entry.kind === "userInput" || entry.kind === "delegatedNotice") return null;
    if (props.hideSecretRequest && entry.kind === "galleryCard" && entry.card === "secret")
      return null;
    return (
      // oxlint-disable-next-line react/no-array-index-key -- static fixture list
      <div className="m-feed-item" key={index}>
        <FeedEntry
          onOpenTask={props.onOpenTask}
          entry={entry}
          agentMessageCards={props.agentMessageCards}
          onReview={props.onReview}
        />
      </div>
    );
  });
}
