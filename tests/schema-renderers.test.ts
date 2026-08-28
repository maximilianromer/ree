import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtractionResult } from "../src/core/types.js";
import { renderOutput } from "../src/renderers/index.js";

function directResult(
  content: string,
  overrides: Partial<ExtractionResult> = {},
): ExtractionResult {
  return {
    format: "md",
    content,
    title: "Direct output fixture",
    assets: [],
    chunkCount: 1,
    ...overrides,
  };
}

async function openPdf(outputPath: string) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = await readFile(outputPath);
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  return { pdfjs, loadingTask, pdf: await loadingTask.promise, bytes };
}

async function pageText(
  pdf: Awaited<ReturnType<typeof openPdf>>["pdf"],
  pageNumber: number,
): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items
    .flatMap((item) => ("str" in item ? [item.str] : []))
    .join(" ");
}

describe("direct-output renderers", () => {
  it.each(["txt", "md"] as const)(
    "returns %s model output without rewriting it",
    async (format) => {
      const content =
        format === "txt"
          ? "A direct title\n\nBy Ada Example\n\nBody text.\n"
          : "# A direct title\n\nBody with [a link](https://example.com).\n";
      const rendered = await renderOutput(directResult(content, { format }), {
        format,
      });
      expect(rendered).toEqual({ text: content });
    },
  );

  it.each(["txt", "md"] as const)(
    "atomically replaces a %s destination with the exact model output",
    async (format) => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), `ree-${format}-output-test-`),
      );
      const outputPath = path.join(directory, `edition.${format}`);
      const content =
        format === "txt"
          ? "Title\n\nThe TTS edition is unchanged.\n"
          : "# Title\n\nThe **Markdown** edition is unchanged.\n";
      try {
        await writeFile(outputPath, "stale partial output", "utf8");
        await expect(
          renderOutput(directResult(content, { format }), {
            format,
            outputPath,
          }),
        ).resolves.toEqual({ outputPath: path.resolve(outputPath) });
        expect(await readFile(outputPath, "utf8")).toBe(content);
        if (process.platform !== "win32") {
          expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
        }
        expect(
          (await readdir(directory)).filter((name) => name.startsWith(".")),
        ).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("requires a destination for PDF output", async () => {
    await expect(
      renderOutput(directResult("# Edition\n", { format: "pdf" }), {
        format: "pdf",
      }),
    ).rejects.toThrow("PDF output needs a file destination");
  });

  it("renders Markdown thematic breaks as visible PDF divider rules", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "ree-pdf-divider-test-"),
    );
    const outputPath = path.join(directory, "divider.pdf");
    try {
      await renderOutput(
        directResult("# Divider proof\n\nBefore.\n\n---\n\nAfter.\n", {
          format: "pdf",
        }),
        { format: "pdf", outputPath, includeImages: false },
      );

      const { pdfjs, loadingTask, pdf } = await openPdf(outputPath);
      try {
        const page = await pdf.getPage(1);
        const operators = await page.getOperatorList();
        const hasWideThinRule = operators.fnArray.some((operator, index) => {
          if (operator !== pdfjs.OPS.constructPath) return false;
          const bounds = operators.argsArray[index]?.[2] as
            Float32Array | undefined;
          return (
            bounds !== undefined &&
            bounds[2]! - bounds[0]! > 100 &&
            bounds[3]! - bounds[1]! <= 2
          );
        });
        expect(hasWideThinRule).toBe(true);
      } finally {
        await loadingTask.destroy();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("renders a searchable, linked, paginated PDF with controlled images", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ree-pdf-test-"));
    const outputPath = path.join(directory, "edition.pdf");
    const knownImage = path.resolve("extension/icons/icon128.png");
    const rows = Array.from(
      { length: 110 },
      (_, index) => `| Row ${index + 1} | Value ${index + 1} |`,
    ).join("\n");
    const markdown = `# Searchable edition

München, naïve café, résumé, and Δ remain searchable Unicode text.

[Clickable source](https://example.com/source)

The supported image follows.

[[REE_IMAGE:image-001]]

An unknown marker is discarded: [[REE_IMAGE:image-unknown]].

An ordinary image stays text-only: ![remote image must not load](https://example.com/tracker.png).

A footnote survives the print pipeline.[^1]

[^1]: Evidence in a compact footnote.

| Signal | Value |
| --- | --- |
${rows}
`;
    try {
      await renderOutput(
        directResult(markdown, {
          format: "pdf",
          assets: [
            {
              id: "image-001",
              mimeType: "image/png",
              filename: "icon128.png",
              path: knownImage,
              alt: "Known REE image",
            },
            {
              id: "ordinary-image",
              mimeType: "text/html",
              filename: "not-an-image.html",
              path: path.resolve("fixtures/clean-article.html"),
              alt: "Blocked non-image asset",
            },
          ],
        }),
        { format: "pdf", outputPath, includeImages: true },
      );

      const { pdfjs, loadingTask, pdf, bytes } = await openPdf(outputPath);
      try {
        expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
        expect(bytes.length).toBeGreaterThan(5_000);
        expect(pdf.numPages).toBeGreaterThan(1);

        const allText = (
          await Promise.all(
            Array.from({ length: pdf.numPages }, (_, index) =>
              pageText(pdf, index + 1),
            ),
          )
        ).join(" ");
        expect(allText).toContain("Searchable edition");
        expect(allText).toContain("München, naïve café, résumé, and Δ");
        expect(allText).toContain("Evidence in a compact footnote.");
        expect(allText).toContain("Signal");
        expect(allText).toContain("Row 110");
        expect(allText).not.toContain("REE_IMAGE");
        expect(allText).not.toContain("image-unknown");
        expect(allText).not.toContain("tracker.png");
        expect(allText).toContain("remote image must not load");

        const firstPage = await pdf.getPage(1);
        const annotations = await firstPage.getAnnotations();
        expect(
          annotations.some(
            (annotation) =>
              annotation.subtype === "Link" &&
              annotation.url === "https://example.com/source",
          ),
        ).toBe(true);
        expect(
          annotations.some(
            (annotation) =>
              "url" in annotation && annotation.url?.includes("tracker.png"),
          ),
        ).toBe(false);

        let paintedImages = 0;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          const page = await pdf.getPage(pageNumber);
          const operators = await page.getOperatorList();
          paintedImages += operators.fnArray.filter(
            (operator) =>
              operator === pdfjs.OPS.paintImageXObject ||
              operator === pdfjs.OPS.paintInlineImageXObject ||
              operator === pdfjs.OPS.paintImageMaskXObject,
          ).length;
        }
        expect(paintedImages).toBe(1);
      } finally {
        await loadingTask.destroy();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("omits even known marker images when PDF images are disabled", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "ree-pdf-no-images-test-"),
    );
    const outputPath = path.join(directory, "text-only.pdf");
    try {
      await renderOutput(
        directResult("# Text only\n\n[[REE_IMAGE:image-001]]\n", {
          format: "pdf",
          assets: [
            {
              id: "image-001",
              mimeType: "image/png",
              filename: "icon128.png",
              path: path.resolve("extension/icons/icon128.png"),
            },
          ],
        }),
        { format: "pdf", outputPath, includeImages: false },
      );
      const { pdfjs, loadingTask, pdf } = await openPdf(outputPath);
      try {
        let paintedImages = 0;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          const page = await pdf.getPage(pageNumber);
          const operators = await page.getOperatorList();
          paintedImages += operators.fnArray.filter(
            (operator) =>
              operator === pdfjs.OPS.paintImageXObject ||
              operator === pdfjs.OPS.paintInlineImageXObject ||
              operator === pdfjs.OPS.paintImageMaskXObject,
          ).length;
        }
        expect(paintedImages).toBe(0);
      } finally {
        await loadingTask.destroy();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes a temporary PDF when the requested destination cannot be replaced", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "ree-pdf-atomic-test-"),
    );
    const collidingDestination = path.join(directory, "edition.pdf");
    await writeFile(path.join(directory, "keep.txt"), "keep", "utf8");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(collidingDestination),
    );
    try {
      await expect(
        renderOutput(
          directResult("# Complete temporary edition\n", { format: "pdf" }),
          {
            format: "pdf",
            outputPath: collidingDestination,
          },
        ),
      ).rejects.toThrow("Could not render PDF edition.pdf");
      await expect(stat(collidingDestination)).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
      expect((await stat(collidingDestination)).isDirectory()).toBe(true);
      expect(await readFile(path.join(directory, "keep.txt"), "utf8")).toBe(
        "keep",
      );
      expect(
        (await readdir(directory)).filter((name) =>
          /^\.edition-.*\.tmp\.pdf$/.test(name),
        ),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
