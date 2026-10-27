import { POPUP_HEIGHT, POPUP_WIDTH, percentToViewportX, popupPosition } from "../dom";
import { useRefValue, viewportTick, type FinishingDraft } from "../state";

/** A closed draft that stays where it was, read-only, until its transcript arrives. */
export default function FinishingAnnotation({ entry }: { entry: FinishingDraft }) {
  useRefValue(viewportTick);
  const { draft, typed } = entry;
  const anchorY = draft.isFixed ? draft.y : draft.y - window.scrollY;
  const position = popupPosition(percentToViewportX(draft.x), anchorY, {
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
  });
  const text = typed.trim();

  return (
    <div
      data-annotation-finishing
      aria-busy="true"
      className="pointer-events-auto absolute w-72 rounded-xl border border-white/10 bg-[#111111]/95 px-[13px] py-2 leading-[var(--toolbar-annotation-line-height)] text-white backdrop-blur-xl"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {text ? <p className="m-0 break-words whitespace-pre-wrap">{text}</p> : null}
      <p className="m-0 text-white/35">Transcribing…</p>
    </div>
  );
}
