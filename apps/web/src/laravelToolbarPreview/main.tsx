import { MoreHorizontal } from "lucide-react";
import { StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";

import "../index.css";
import { PreviewChromeRow } from "~/components/preview/PreviewChromeRow";
import { Button } from "~/components/ui/button";
import { TooltipProvider } from "~/components/ui/tooltip";
import { ToolbarProvider } from "~/laravelToolbar/context";
import { PANEL_IDS, ToolbarBar } from "~/laravelToolbar/ui/ToolbarBar";

import darkOceanCss from "./dark-ocean.css?inline";
import pageDark from "./images/page-dark.png";
import pageLight from "./images/page-light.png";
import { previewSource, seedPreview, PREVIEW_TAB_ID } from "./source";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
const light = theme === "light";
let themeStyle: HTMLStyleElement | undefined;
document.documentElement.classList.toggle("dark", !light);
if (theme !== "light" && theme !== "dark") {
  document.documentElement.dataset.themeId = "dark-ocean";
  themeStyle = document.createElement("style");
  themeStyle.textContent = darkOceanCss;
  document.head.append(themeStyle);
}

const initialPanel = PANEL_IDS.find((id) => id === params.get("panel")) ?? null;
seedPreview();
const noop = () => {};

function Preview() {
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <PreviewChromeRow
          url="https://main.drift-website.test/"
          urlInputRef={urlInputRef}
          loading={false}
          canGoBack
          canGoForward={false}
          refreshDisabled={false}
          onBack={noop}
          onForward={noop}
          onRefresh={noop}
          onSubmit={noop}
          onOpenInBrowser={noop}
          onCapture={noop}
          onPictureInPicture={noop}
          onPickElement={noop}
          trailingActions={
            <Button variant="ghost" size="icon-xs" type="button" aria-label="More">
              <MoreHorizontal />
            </Button>
          }
        />
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <img
            src={light ? pageLight : pageDark}
            alt=""
            className="absolute inset-0 size-full object-cover object-top"
          />
        </div>
        <ToolbarProvider tabId={PREVIEW_TAB_ID} source={previewSource}>
          <ToolbarBar initialPanel={initialPanel} />
        </ToolbarProvider>
      </div>
    </TooltipProvider>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);

// Fixture edits re-run this entry; release its root and theme before mounting the new version.
import.meta.hot?.dispose(() => {
  root.unmount();
  themeStyle?.remove();
});
