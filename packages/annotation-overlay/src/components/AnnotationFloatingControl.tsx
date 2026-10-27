import { useStore } from "../core/store";
import { removalError, serviceConnection, UNAVAILABLE_MESSAGE } from "../sync";
import { openPinCount } from "../store";
import { ChatBubbleBottomCenterTextIcon, TrashIcon } from "../icons";
import { annotationMode, clearAllAnnotations, toggleAnnotationMode } from "../runtime";
import { useRefValue } from "../state";
import { cn } from "../lib/utils";

/** Shared floating pill for annotation mode and clearing saved pins. */
export function AnnotationFloatingControl() {
  const deleteError = useStore(removalError);
  const unavailable = useStore(serviceConnection) === "Unavailable";
  const isActive = useRefValue(annotationMode);
  const count = useStore(openPinCount);

  return (
    <div
      data-feedback-toolbar=""
      data-annotation-fab=""
      className={cn(
        "pointer-events-auto fixed right-5 bottom-5 z-[2147483646] flex origin-bottom-right scale-[0.825] items-center rounded-full border border-white/10 p-1 shadow-lg backdrop-blur-xl transition-colors",
        isActive ? "bg-white text-black" : "bg-[#111111]/92 text-white",
      )}
    >
      {(deleteError || (unavailable && isActive)) && (
        <p
          role="alert"
          className="absolute right-0 bottom-full mb-3 w-72 rounded-lg border border-red-400/30 bg-[#171717] p-3 text-sm text-red-300"
        >
          {deleteError || UNAVAILABLE_MESSAGE}
        </p>
      )}
      <button
        type="button"
        aria-label="Clear all annotations"
        title="Clear all annotations on this site (⌘⇧R / Ctrl+Shift+R)"
        aria-keyshortcuts="Meta+Shift+R Control+Shift+R"
        className={cn(
          "inline-flex size-9 items-center justify-center rounded-full bg-transparent text-inherit transition-colors",
          isActive ? "hover:bg-black/10" : "hover:bg-white/10",
        )}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          clearAllAnnotations();
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <TrashIcon className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        data-annotation-chrome=""
        data-active={isActive ? "" : undefined}
        aria-pressed={isActive}
        aria-label={isActive ? "Exit annotation mode" : "Enter annotation mode"}
        title="Toggle annotation mode (⌘⇧A / Ctrl+Shift+A)"
        aria-keyshortcuts="Meta+Shift+A Control+Shift+A"
        className={cn(
          "relative inline-flex size-9 items-center justify-center rounded-full bg-transparent text-inherit transition-colors",
          isActive ? "hover:bg-black/10" : "hover:bg-white/10",
        )}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleAnnotationMode();
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <ChatBubbleBottomCenterTextIcon className="size-5" aria-hidden="true" />
        {count > 0 ? (
          <span
            data-annotation-count
            className={cn(
              "absolute -top-1 -right-1 inline-flex min-w-[1.1rem] items-center justify-center rounded-full px-1 text-[0.65rem] leading-4",
              isActive ? "bg-black/15 text-[#111]" : "bg-white text-[#111]",
            )}
          >
            {count}
          </span>
        ) : null}
      </button>
    </div>
  );
}
