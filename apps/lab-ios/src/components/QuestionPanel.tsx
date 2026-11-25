import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { observeResize } from "../../../web/src/lib/observeResize";
import { MarkdownText, markdownPreviewText } from "./Markdown";
import { Icon } from "./Icon";
import { isAnswered, type QuestionFlow } from "../screens/useQuestionFlow";
import { ComposerPanelDeck } from "./ComposerPanelDeck";
import "./QuestionPanel.css";

const CONTEXT_CLAMP_LINES = 3;
const CONTEXT_LINE_HEIGHT = 21;

/** Agents mark their pick with a trailing "(Recommended)"; the row shows it as a pill. */
function splitRecommended(label: string) {
  const match = /^(.*\S)\s*[([]\s*recommended\s*[)\]]\s*$/i.exec(label);
  return match?.[1] ? { text: match[1], recommended: true } : { text: label, recommended: false };
}

/** What the agent wrote just before asking: muted, three lines with an inline "… Show more". */
function AgentContext(props: { readonly markdown: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = markdownPreviewText(props.markdown);
  const meterRef = useRef<HTMLDivElement>(null);
  // undefined: not measured yet; null: it fits in three lines; a string: the text that fits with "… Show more".
  const [clamped, setClamped] = useState<string | null | undefined>(undefined);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the wrapped text in the DOM
  useLayoutEffect(() => {
    const meter = meterRef.current;
    if (!meter) return;
    const fits = (text: string, withMore: boolean) => {
      const more = document.createElement("span");
      more.textContent = "Show more";
      more.style.fontWeight = "500";
      meter.replaceChildren(
        document.createTextNode(text),
        ...(withMore ? [document.createTextNode("… "), more] : []),
      );
      return meter.scrollHeight <= CONTEXT_LINE_HEIGHT * CONTEXT_CLAMP_LINES + 1;
    };
    if (fits(preview, false)) {
      setClamped(null);
      return;
    }
    let low = 0;
    let high = preview.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(preview.slice(0, mid).trimEnd(), true)) low = mid;
      else high = mid - 1;
    }
    // End on a whole word with no dangling punctuation, so it reads "trade-off… Show more", never "off:…".
    const cut = preview.slice(0, low);
    const atWord = /\s/.test(preview.charAt(low)) ? cut : cut.replace(/\s+\S*$/, "");
    setClamped(atWord.trimEnd().replace(/[\s:;,.\-–—]+$/, ""));
  }, [preview]);

  return (
    <div className="m-q-context">
      <div ref={meterRef} className="m-q-context-meter" aria-hidden />
      {expanded || clamped === null ? (
        <>
          <MarkdownText markdown={props.markdown} muted />
          {expanded && clamped !== null ? (
            <button className="m-q-more" onClick={() => setExpanded(false)}>
              Show less
            </button>
          ) : null}
        </>
      ) : (
        <div className="m-q-context-text">
          {clamped ?? preview}
          {clamped !== undefined ? (
            <>
              {"… "}
              <button className="m-q-more m-q-more-inline" onClick={() => setExpanded(true)}>
                Show more
              </button>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

function SelectionMark(props: { readonly selected: boolean; readonly multiple: boolean }) {
  return (
    <span className="m-q-mark" data-selected={props.selected} data-multiple={props.multiple}>
      {props.selected ? props.multiple ? <SmallCheck /> : <span className="m-q-mark-dot" /> : null}
    </span>
  );
}

/** The 16px solid check, drawn for small sizes; the 24px glyph turns hairline when scaled down this far. */
function SmallCheck() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z"
      />
    </svg>
  );
}

function OptionRow(props: {
  readonly selected: boolean;
  readonly multiple: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  /** Sits on its own line above the title, so the mark lines up with the title, not the badge. */
  readonly badge?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <button
      className="m-q-option m-continuous"
      role={props.multiple ? "checkbox" : "radio"}
      aria-checked={props.selected}
      data-selected={props.selected}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.badge ? <span className="m-q-option-badge">{props.badge}</span> : null}
      <span className="m-q-option-row">
        <span className="m-q-option-mark">
          <SelectionMark selected={props.selected} multiple={props.multiple} />
        </span>
        <span className="m-q-option-body">{props.children}</span>
      </span>
    </button>
  );
}

/** The scrollable question above the composer, with its title and controls outside the scroll area. */
export function QuestionPanel(props: {
  readonly flow: QuestionFlow;
  readonly onDismiss: () => void;
  readonly onSubmit: () => void;
  readonly context: string | undefined;
  readonly queuedAfter?: number;
}) {
  const { flow } = props;
  const { question, step, list, draft } = flow;
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const scrollRef = useRef<HTMLDivElement>(null);
  const measure = () => {
    const node = scrollRef.current;
    if (!node) return;
    const top = node.scrollTop > 1;
    const bottom = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
    setEdges((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads scroll metrics from the DOM after each step renders
  useLayoutEffect(measure, [question?.id, flow.draft, props.context]);
  // The context clamps and fonts load after the first layout, so re-measure whenever the content resizes;
  // otherwise a stale "overflowing" reading leaves a fade over content that fits.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes DOM size changes
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    return observeResize([node, ...node.children], measure);
  });

  if (!question) return null;
  const isLast = step === list.length - 1;
  const answered = isAnswered(draft);
  const customActive = draft.custom.trim().length > 0;
  const showNext =
    !isLast && flow.advancing !== step && (question.multiSelect === true || answered);
  const showSend = isLast && flow.canSubmit;
  const multiple = question.multiSelect === true;

  return (
    <ComposerPanelDeck remaining={list.length - step + (props.queuedAfter ?? 0)} kind="question">
      <div className="m-composer-panel" data-testid="question-panel">
        <div className="m-composer-panel-header">
          <Icon name="comment-text" size={14} />
          <span>Question</span>
          {list.length > 1 && (
            <span className="m-q-progress" role="status">
              {step + 1} of {list.length}
            </span>
          )}
        </div>
        <div className="m-composer-panel-body" data-testid="question-column">
          <div
            className="m-composer-panel-scroll m-scroll"
            key={question.id}
            ref={scrollRef}
            onScroll={measure}
          >
            <div className="m-q-content">
              <MarkdownText markdown={question.question} />
              {props.context ? <AgentContext markdown={props.context} /> : null}
              {question.options.length > 0 || customActive ? (
                <div className="m-q-options" data-testid="question-options">
                  {question.options.map((option) => {
                    const { text, recommended } = splitRecommended(option.label);
                    return (
                      <OptionRow
                        key={option.label}
                        selected={draft.picked.includes(option.label)}
                        multiple={multiple}
                        onPress={() => flow.select(option.label)}
                        badge={recommended ? <span className="m-q-pill">Recommended</span> : null}
                      >
                        <span className="m-q-option-title">{text}</span>
                        {option.description !== option.label ? (
                          <span className="m-q-option-description">{option.description}</span>
                        ) : null}
                      </OptionRow>
                    );
                  })}
                  {customActive ? (
                    <OptionRow selected multiple={multiple} disabled onPress={() => undefined}>
                      <span className="m-q-option-your">Your answer</span>
                      <span className="m-q-option-text">{draft.custom}</span>
                    </OptionRow>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          {edges.top ? <div className="m-q-fade m-q-fade-top" /> : null}
          {edges.bottom ? <div className="m-q-fade m-q-fade-bottom" /> : null}
        </div>
        <div className="m-composer-panel-actions m-q-actions" data-testid="question-actions">
          {step > 0 && (
            <button className="m-composer-text-action m-q-back" onClick={() => flow.goTo(step - 1)}>
              Back
            </button>
          )}
          <button
            className="m-composer-text-action m-q-skip"
            aria-label="Skip question without answering"
            onClick={props.onDismiss}
          >
            Skip
          </button>
          {showSend ? (
            <button className="m-q-button" aria-label="Send answers" onClick={props.onSubmit}>
              Send
            </button>
          ) : null}
          {showNext ? (
            <button className="m-q-button" disabled={!answered} onClick={() => flow.goTo(step + 1)}>
              Next
            </button>
          ) : null}
        </div>
      </div>
    </ComposerPanelDeck>
  );
}
