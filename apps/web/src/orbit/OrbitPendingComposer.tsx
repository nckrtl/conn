import { ArrowUpIcon, MicIcon, PaperclipIcon } from "lucide-react";

import { ComposerSurface } from "../components/chat/ComposerSurface";
import { DEFAULT_COMPOSER_PLACEHOLDER } from "../composerPlaceholder";

/**
 * Conn: the prompt box of a thread whose Orbit Instance is still being made. It shows from the
 * moment of send, in the composer's place and look, disabled (dimmed, not typeable, send off);
 * the real thread's composer takes over in the same place and enables once the Instance is ready.
 */
export function OrbitPendingComposer() {
  return (
    <div
      data-orbit-pending-composer
      data-orbit-composer-locked="true"
      inert
      className="chat-composer-lane w-full shrink-0 pt-2 pb-5 opacity-50"
    >
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div className="rounded-2xl">
              <div className="min-h-14 px-3 pt-3 pb-1 text-sm text-placeholder">
                {DEFAULT_COMPOSER_PLACEHOLDER}
              </div>
              <div className="flex min-w-0 items-center px-2 pb-2">
                <span className="me-2 flex size-7 items-center justify-center text-muted-foreground">
                  <PaperclipIcon aria-hidden className="size-4 translate-y-px" />
                </span>
                <span className="flex min-w-0 flex-1 items-center justify-end gap-2">
                  <span className="flex size-7 items-center justify-center text-muted-foreground">
                    <MicIcon aria-hidden className="size-4" />
                  </span>
                  <span className="flex size-8 items-center justify-center rounded-full bg-foreground/12 text-muted-foreground">
                    <ArrowUpIcon aria-hidden className="size-3.5" />
                  </span>
                </span>
              </div>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}
