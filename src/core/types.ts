export type OutputFormat = "txt" | "md" | "pdf";

export type SourceKind = "webpage" | "html" | "pdf" | "image" | "image-gallery";

export interface SourceDescriptor {
  kind: SourceKind;
  url?: string;
  filename?: string;
  mimeType?: string;
  pageCount?: number;
  imageCount?: number;
}

/** A reusable source image that may be embedded in an image-enabled PDF. */
export interface ExtractionAsset {
  id: string;
  mimeType: string;
  filename: string;
  path: string;
  alt?: string;
  sourceUrl?: string;
}

/**
 * One indivisible source-order unit supplied by an input adapter.
 *
 * `attachments` are local visual-evidence paths for the model. `assetIds`
 * identify the subset of those visuals that may be emitted with a
 * `[[REE_IMAGE:<id>]]` marker. Adapters should keep both arrays in matching
 * order when an attachment is also a reusable asset.
 */
export interface SourceSection {
  id: string;
  label: string;
  content: string;
  attachments: string[];
  assetIds: string[];
}

export interface SourceBundle {
  source: SourceDescriptor;
  title?: string;
  metadata: Record<string, unknown>;
  sections: SourceSection[];
  assets: ExtractionAsset[];
  cleanup: () => Promise<void>;
}

export interface ExtractionChunk {
  index: number;
  total: number;
  source: SourceDescriptor;
  title?: string;
  metadata: Record<string, unknown>;
  sections: SourceSection[];
  assets: ExtractionAsset[];
  attachments: string[];
}

export interface ExtractionResult {
  format: OutputFormat;
  content: string;
  title?: string;
  assets: ExtractionAsset[];
  chunkCount: number;
}

export type ProgressStage =
  "preparing" | "loading" | "capturing" | "extracting" | "rendering" | "done";

export interface ProgressEvent {
  stage: ProgressStage;
  message: string;
  current?: number;
  total?: number;
}

export type ProgressReporter = (event: ProgressEvent) => void;

export interface ModelStreamEvent {
  kind: "output" | "reasoning";
  delta: string;
  current?: number;
  total?: number;
}

export type ModelStreamReporter = (event: ModelStreamEvent) => void;
