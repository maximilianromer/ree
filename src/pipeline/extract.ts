import type {
  ExtractionResult,
  ModelStreamReporter,
  OutputFormat,
  ProgressReporter,
  SourceBundle,
} from "../core/types.js";
import type { ExtractionAdapter } from "../model/adapter.js";
import { chunkSource } from "./chunk.js";

export interface PipelineOptions {
  format: OutputFormat;
  includeImages?: boolean;
  fast?: boolean;
  model?: string;
  customInstructions?: string;
  concurrency?: number;
  progress?: ProgressReporter;
  stream?: ModelStreamReporter;
  signal?: AbortSignal;
}

export const CHUNK_ATTEMPTS = 2;

export function normalizeModelOutput(raw: string): string {
  return `${raw.replace(/\r\n?/g, "\n").trim()}\n`;
}

function isRetryable(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  const detail = error instanceof Error ? error.message : String(error);
  // Authentication, availability, and cancellation do not improve on a retry.
  return !/cancelled|not authenticated|authentication required|unauthorized|is unavailable in this Codex account|Fast mode is unavailable/i.test(
    detail,
  );
}

async function concurrentMap<T, R>(
  values: T[],
  concurrency: number,
  signalController: AbortController,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  let firstFailure: unknown;

  async function worker(): Promise<void> {
    while (firstFailure === undefined && cursor < values.length) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value === undefined) continue;
      try {
        results[index] = await map(value, index);
      } catch (error) {
        if (firstFailure === undefined) firstFailure = error;
        signalController.abort();
        return;
      }
    }
  }

  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, values.length) }, async () =>
      worker(),
    ),
  );
  if (firstFailure !== undefined) throw firstFailure;
  return results;
}

export async function extractEvidence(
  evidence: SourceBundle,
  adapter: ExtractionAdapter,
  options: PipelineOptions,
): Promise<ExtractionResult> {
  if (options.signal?.aborted) throw new Error("Extraction cancelled");
  const chunks = chunkSource(evidence);
  if (chunks.length === 0)
    throw new Error("No source material was available for extraction");

  const progress = options.progress ?? (() => undefined);
  const stream = options.stream ?? (() => undefined);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  let completed = 0;
  try {
    const outputs = await concurrentMap(
      chunks,
      Math.max(1, Math.min(2, options.concurrency ?? 2)),
      controller,
      async (chunk) => {
        if (controller.signal.aborted) throw new Error("Extraction cancelled");
        progress({
          stage: "extracting",
          message:
            chunk.total === 1
              ? "Reading document with selected model"
              : `Reading part ${chunk.index + 1} of ${chunk.total}`,
          current: chunk.total === 1 ? undefined : completed,
          total: chunk.total === 1 ? undefined : chunk.total,
        });
        let output = "";
        let lastError: unknown;
        for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt += 1) {
          try {
            output = await adapter.extractChunk(chunk, {
              format: options.format,
              includeImages:
                options.format === "pdf" && (options.includeImages ?? true),
              fast: options.fast ?? false,
              model: options.model,
              customInstructions: options.customInstructions ?? "",
              progress,
              stream: (event) =>
                stream({
                  ...event,
                  current: chunk.index + 1,
                  total: chunk.total,
                }),
              signal: controller.signal,
            });
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            if (
              attempt === CHUNK_ATTEMPTS ||
              !isRetryable(error, controller.signal)
            )
              break;
            progress({
              stage: "extracting",
              message:
                chunk.total === 1
                  ? "Retrying the document once"
                  : `Retrying part ${chunk.index + 1} of ${chunk.total} once`,
              current: completed,
              total: chunk.total === 1 ? undefined : chunk.total,
            });
          }
        }
        if (lastError !== undefined) throw lastError;
        completed += 1;
        progress({
          stage: "extracting",
          message:
            chunk.total === 1
              ? "Document extracted"
              : `Read ${completed} of ${chunk.total} parts`,
          current: completed,
          total: chunk.total,
        });
        return normalizeModelOutput(output);
      },
    );
    if (controller.signal.aborted) throw new Error("Extraction cancelled");

    const content = `${outputs.map((output) => output.trim()).join("\n\n")}\n`;
    const includeAssets =
      options.format === "pdf" && (options.includeImages ?? true);
    return {
      format: options.format,
      content,
      title: evidence.title,
      assets: includeAssets ? evidence.assets : [],
      chunkCount: chunks.length,
    };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
