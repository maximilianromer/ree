import type {
  ExtractionChunk,
  ModelStreamReporter,
  OutputFormat,
  ProgressReporter,
} from "../core/types.js";

export interface ExtractionOptions {
  format: OutputFormat;
  includeImages: boolean;
  fast: boolean;
  model?: string;
  customInstructions: string;
  progress: ProgressReporter;
  stream: ModelStreamReporter;
  signal?: AbortSignal;
}

/** A model backend that returns the requested edition directly as text. */
export interface ExtractionAdapter {
  readonly name: string;
  extractChunk(
    chunk: ExtractionChunk,
    options: ExtractionOptions,
  ): Promise<string>;
}
