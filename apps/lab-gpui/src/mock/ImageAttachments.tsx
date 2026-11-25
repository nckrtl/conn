import { Icon } from "./Icon";

const samples = import.meta.glob<string>(
  [
    "../../../marketing/public/95/providers/{antigravity,claude-code,codex,cursor,grok,opencode}-320.webp",
    "../../../marketing/public/95/t3-code-concepts/{t3-code-lime,t3-code-nightly-clouds}-320.webp",
    "../../../marketing/src/assets/{app-desktop,social-card}.webp",
    "../../image-preview/handoff.webp",
    "../../../../docs/internals/images/mobile-workspace-split.png",
  ],
  { eager: true, import: "default", query: "?url" },
);

export const sampleImages = Object.entries(samples).map(([path, src]) => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  src,
}));
export type SampleImage = (typeof sampleImages)[number];

const comparisonImages = [
  "handoff.webp",
  "t3-code-lime-320.webp",
  "claude-code-320.webp",
  "app-desktop.webp",
  "codex-320.webp",
].map((name) => sampleImages.find((image) => image.name === name)!);

export function ImageLayoutExamples() {
  return [1, 2, 3, 5].map((count) => (
    <ImageMessage
      key={count}
      images={comparisonImages.slice(0, count)}
      text={count === 1 ? "1 image" : `${count} images`}
    />
  ));
}

export function ImageMessage({ images, text }: { images: SampleImage[]; text: string }) {
  return (
    <div className="bubble image-message">
      {text && <span>{text}</span>}
      <ImageAttachments images={images} />
    </div>
  );
}

export function ImageAttachments({
  images,
  onRemove,
}: {
  images: SampleImage[];
  onRemove?: (image: SampleImage) => void;
}) {
  return (
    <div className={onRemove ? "staged-images" : "sent-images"}>
      {images.map((image) => (
        <div className="attachment-cell" key={image.name} data-tip={image.name}>
          <img src={image.src} alt={image.name} />
          {onRemove && (
            <button aria-label={`Remove ${image.name}`} onClick={() => onRemove(image)}>
              <Icon name="close" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
