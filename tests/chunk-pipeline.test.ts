import { describe, expect, it } from "vitest";
import type { ExtractionAdapter } from "../src/model/adapter.js";
import {
  MAX_OUTPUT_CHARACTERS,
  MAX_SOURCE_CHARACTERS,
  MAX_VISUAL_ATTACHMENTS,
  chunkSource,
  hasRenderableContent,
} from "../src/pipeline/chunk.js";
import {
  CHUNK_ATTEMPTS,
  extractEvidence,
  normalizeModelOutput,
} from "../src/pipeline/extract.js";
import {
  DeterministicAdapter,
  sourceBundle,
  sourceSection,
} from "./helpers.js";

function fourChunkBundle() {
  return sourceBundle(
    // Plain prose is bounded by the readable-text budget, so one section of
    // that size is exactly one model call.
    Array.from({ length: 4 }, (_, index) =>
      sourceSection(
        `section-${index + 1}`,
        `${index + 1}${"x".repeat(MAX_OUTPUT_CHARACTERS - 2)}`,
      ),
    ),
  );
}

describe("direct extraction pipeline", () => {
  it("uses exactly one model call for an ordinary source and propagates the selected edition", async () => {
    const adapter = new DeterministicAdapter({
      output: () => "  Direct rendition\r\n\r\nBody text.  ",
    });
    const result = await extractEvidence(
      sourceBundle([sourceSection("article", "<article>Body text.</article>")]),
      adapter,
      {
        format: "pdf",
        includeImages: false,
        fast: true,
        model: "gpt-test-direct",
        customInstructions: "Retain the appendix.",
      },
    );

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.options).toMatchObject({
      format: "pdf",
      includeImages: false,
      fast: true,
      model: "gpt-test-direct",
      customInstructions: "Retain the appendix.",
    });
    expect(adapter.calls[0]?.chunk).toMatchObject({ index: 0, total: 1 });
    expect(result).toMatchObject({
      format: "pdf",
      content: "Direct rendition\n\nBody text.\n",
      chunkCount: 1,
    });
  });

  it("enforces the markup, readable-text, and attachment limits without overlap", () => {
    const attachments = Array.from(
      { length: MAX_VISUAL_ATTACHMENTS + 3 },
      (_, index) => `/tmp/visual-${index + 1}.png`,
    );
    const sections = [
      sourceSection(
        "oversized",
        `${"A".repeat(MAX_SOURCE_CHARACTERS)}${"B".repeat(17)}`,
        attachments,
      ),
      sourceSection("tail", "TAIL"),
    ];
    const chunks = chunkSource(sourceBundle(sections));

    expect(MAX_SOURCE_CHARACTERS).toBe(120_000);
    expect(MAX_VISUAL_ATTACHMENTS).toBe(20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every(
        (chunk) =>
          chunk.sections.reduce(
            (characters, section) => characters + section.content.length,
            0,
          ) <= MAX_SOURCE_CHARACTERS &&
          chunk.attachments.length <= MAX_VISUAL_ATTACHMENTS,
      ),
    ).toBe(true);
    expect(
      chunks.flatMap((chunk) => chunk.sections).map((section) => section.id),
    ).toHaveLength(
      new Set(
        chunks.flatMap((chunk) => chunk.sections).map((section) => section.id),
      ).size,
    );
    expect(
      chunks
        .flatMap((chunk) => chunk.sections)
        .map((section) => section.content)
        .join(""),
    ).toBe(sections.map((section) => section.content).join(""));
    expect(chunks.flatMap((chunk) => chunk.attachments)).toEqual(attachments);
  });

  it("runs at most two model calls concurrently", async () => {
    const adapter = new DeterministicAdapter({
      delayMs: () => 20,
      output: (chunk) => `part ${chunk.index + 1}`,
    });
    await extractEvidence(fourChunkBundle(), adapter, {
      format: "md",
      concurrency: 20,
    });

    expect(adapter.calls).toHaveLength(4);
    expect(adapter.maxActiveCalls).toBe(2);
  });

  it("joins out-of-order completions in source order with one blank line", async () => {
    const adapter = new DeterministicAdapter({
      delayMs: (chunk) => [60, 40, 20, 0][chunk.index] ?? 0,
      output: (chunk) => `  edition ${chunk.index + 1}\r\n  `,
    });
    const result = await extractEvidence(fourChunkBundle(), adapter, {
      format: "txt",
    });

    expect(result.content).toBe(
      "edition 1\n\nedition 2\n\nedition 3\n\nedition 4\n",
    );
  });

  it("forwards genuine model deltas with their source-part position", async () => {
    const streamed: Array<Record<string, unknown>> = [];
    const adapter = new DeterministicAdapter({
      output: (chunk, options) => {
        options.stream({ kind: "reasoning", delta: `reason ${chunk.index}` });
        options.stream({ kind: "output", delta: `output ${chunk.index}` });
        return `edition ${chunk.index}`;
      },
    });

    await extractEvidence(fourChunkBundle(), adapter, {
      format: "md",
      concurrency: 1,
      stream: (event) => streamed.push(event),
    });

    expect(streamed).toEqual(
      [0, 1, 2, 3].flatMap((index) => [
        {
          kind: "reasoning",
          delta: `reason ${index}`,
          current: index + 1,
          total: 4,
        },
        {
          kind: "output",
          delta: `output ${index}`,
          current: index + 1,
          total: 4,
        },
      ]),
    );
  });

  it("retries a failed chunk once, then aborts siblings and starts no later chunks", async () => {
    const started: number[] = [];
    let siblingAborted = false;
    const adapter: ExtractionAdapter = {
      name: "failing direct-output adapter",
      async extractChunk(chunk, options) {
        started.push(chunk.index);
        if (chunk.index === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          throw new Error("primary chunk failed");
        }
        return new Promise<string>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              siblingAborted = true;
              reject(new Error("sibling cancelled"));
            },
            { once: true },
          );
        });
      },
    };

    await expect(
      extractEvidence(fourChunkBundle(), adapter, { format: "md" }),
    ).rejects.toThrow("primary chunk failed");
    // The failing chunk is retried once before the extraction gives up, and no
    // chunk beyond the two in flight is ever started.
    expect(started.filter((index) => index === 0)).toHaveLength(CHUNK_ATTEMPTS);
    expect([...new Set(started)].sort()).toEqual([0, 1]);
    expect(siblingAborted).toBe(true);
  });

  it("does not retry an unrecoverable authentication failure", async () => {
    let attempts = 0;
    const adapter: ExtractionAdapter = {
      name: "unauthenticated adapter",
      async extractChunk() {
        attempts += 1;
        throw new Error("Codex is not authenticated. Run `codex login`.");
      },
    };

    await expect(
      extractEvidence(sourceBundle([sourceSection("only", "Body")]), adapter, {
        format: "md",
      }),
    ).rejects.toThrow("not authenticated");
    expect(attempts).toBe(1);
  });

  it("never sends a part that has no readable content to the model", () => {
    const chunks = chunkSource(
      sourceBundle([
        sourceSection("lead", "<p>Real article body.</p>"),
        sourceSection("filler", "<div><span> </span></div>\n   \n  "),
        sourceSection("rule", "<hr>"),
      ]),
    );

    const parts = chunks.flatMap((chunk) => chunk.sections);
    expect(parts.map((part) => part.id)).toEqual(["lead", "rule"]);
    expect(hasRenderableContent("<div><span>  </span></div>")).toBe(false);
    expect(hasRenderableContent("<hr>")).toBe(true);
    expect(hasRenderableContent("<p>text</p>")).toBe(true);
  });

  it("normalizes only line endings, surrounding whitespace, and the final newline", () => {
    expect(normalizeModelOutput(" \r\n# Heading\rBody  \r\n ")).toBe(
      "# Heading\nBody\n",
    );
    expect(normalizeModelOutput("inside   spacing")).toBe("inside   spacing\n");
  });

  it("does not start model work when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new DeterministicAdapter();

    await expect(
      extractEvidence(
        sourceBundle([sourceSection("article", "body")]),
        adapter,
        { format: "md", signal: controller.signal },
      ),
    ).rejects.toThrow("Extraction cancelled");
    expect(adapter.calls).toHaveLength(0);
  });
});
