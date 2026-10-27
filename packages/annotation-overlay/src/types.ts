export type AnnotationRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AnnotationStatus = "pending" | "in_progress" | "applied" | "resolved" | "cancelled";

export type AppearanceSnapshot = {
  classes: string[];
  computed: Record<string, string>;
  utilities: Record<string, string>;
};

export type ComponentFrame = {
  name: string;
  file?: string | undefined;
  line?: number | undefined;
};

export type VisualChange = {
  simple?: boolean | undefined;
  applied?: boolean | undefined;
  from?: string | undefined;
  to?: string | undefined;
  axis?: string | undefined;
  file?: string | undefined;
  confidence?: number | undefined;
  reason?: string | undefined;
};

export type Annotation = {
  /** Stable sequence assigned by the local annotation server. */
  number?: number | undefined;
  revision?: number | undefined;
  delivery?: "queued" | "sending" | "sent" | "error" | "cancelled" | undefined;
  syncError?: string | undefined;
  summary?: string | undefined;
  question?: boolean | undefined;
  id: string;
  x: number;
  y: number;
  /** Host context from the `metadata` hook. */
  metadata?: Record<string, unknown> | undefined;
  comment: string;
  element: string;
  elementPath: string;
  timestamp: number;
  status?: AnnotationStatus | undefined;
  boundingBox?: AnnotationRect | undefined;
  isFixed?: boolean | undefined;
  url?: string | undefined;
  pathname?: string | undefined;
  component?: string | undefined;
  controller?: string | undefined;
  route?: string | undefined;
  screenSize?: string | undefined;
  scrollPosition?: string | undefined;
  breakpoint?: string | undefined;
  screenshot?: string | undefined;
  react?: string | undefined;
  components?: ComponentFrame[] | undefined;
  appearance?: AppearanceSnapshot | undefined;
  change?: VisualChange | undefined;
};

export type AnnotationDraft = {
  draftId?: string | undefined;
  annotationId?: string | undefined;
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  element: string;
  elementPath: string;
  boundingBox: AnnotationRect;
  isFixed: boolean;
  /** Host context from the `metadata` hook. */
  metadata?: Record<string, unknown> | undefined;
  comment: string;
  targetElement?: HTMLElement | undefined;
  url?: string | undefined;
  pathname?: string | undefined;
  component?: string | undefined;
  controller?: string | undefined;
  route?: string | undefined;
  screenSize?: string | undefined;
  scrollPosition?: string | undefined;
  breakpoint?: string | undefined;
  screenshot?: string | undefined;
  react?: string | undefined;
  components?: ComponentFrame[] | undefined;
  appearance?: AppearanceSnapshot | undefined;
};

export type HoverTarget = {
  name: string;
  path: string;
  reactComponents?: string | null | undefined;
  rect: AnnotationRect;
  cursorX: number;
  cursorY: number;
};
