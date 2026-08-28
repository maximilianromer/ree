import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import type {
  ExtractionAsset,
  SourceBundle,
  SourceSection,
} from "../core/types.js";
import { createPrivateTempDir } from "../core/temp.js";

export interface PdfSourceOptions {
  includeImages?: boolean;
}

interface NormalizedBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

class NapiCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }

  reset(
    target: { canvas: ReturnType<typeof createCanvas>; context: unknown },
    width: number,
    height: number,
  ) {
    target.canvas.width = width;
    target.canvas.height = height;
  }

  destroy(target: {
    canvas: ReturnType<typeof createCanvas> | null;
    context: unknown;
  }) {
    if (target.canvas) {
      target.canvas.width = 0;
      target.canvas.height = 0;
    }
    target.canvas = null;
    target.context = null;
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function recordedImageBounds(
  coordinates: ArrayLike<number> | null | undefined,
): NormalizedBounds[] {
  if (!coordinates) return [];
  const result: NormalizedBounds[] = [];
  for (let index = 0; index + 5 < coordinates.length; index += 6) {
    const x0 = Number(coordinates[index]);
    const y0 = Number(coordinates[index + 1]);
    const x1 = Number(coordinates[index + 2]);
    const y1 = Number(coordinates[index + 3]);
    const x2 = Number(coordinates[index + 4]);
    const y2 = Number(coordinates[index + 5]);
    if (![x0, y0, x1, y1, x2, y2].every(Number.isFinite)) continue;
    const x3 = x1 + x2 - x0;
    const y3 = y1 + y2 - y0;
    const left = clamp(Math.min(x0, x1, x2, x3));
    const top = clamp(Math.min(y0, y1, y2, y3));
    const right = clamp(Math.max(x0, x1, x2, x3));
    const bottom = clamp(Math.max(y0, y1, y2, y3));
    if (right > left && bottom > top) result.push({ left, top, right, bottom });
  }
  return result;
}

function intersectionOverUnion(
  left: NormalizedBounds,
  right: NormalizedBounds,
): number {
  const intersectionWidth = Math.max(
    0,
    Math.min(left.right, right.right) - Math.max(left.left, right.left),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top),
  );
  const intersection = intersectionWidth * intersectionHeight;
  const leftArea = (left.right - left.left) * (left.bottom - left.top);
  const rightArea = (right.right - right.left) * (right.bottom - right.top);
  return intersection / (leftArea + rightArea - intersection || 1);
}

function distinctFigureBounds(
  coordinates: ArrayLike<number> | null | undefined,
  canvasWidth: number,
  canvasHeight: number,
): NormalizedBounds[] {
  const retained: NormalizedBounds[] = [];
  for (const bounds of recordedImageBounds(coordinates)) {
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    const area = width * height;

    // A page-sized raster is visual evidence for the model, not a reusable
    // figure. Keeping it would duplicate an entire source page in the output.
    if (area >= 0.8 || (width >= 0.8 && height >= 0.8)) continue;
    if (width * canvasWidth < 96 || height * canvasHeight < 64) continue;
    if (Math.max(width / height, height / width) > 14) continue;
    if (retained.some((prior) => intersectionOverUnion(prior, bounds) >= 0.9))
      continue;
    retained.push(bounds);
  }
  return retained;
}

function textFromPage(items: any[]): string {
  return items
    .map((item) =>
      typeof item.str === "string"
        ? `${item.str}${item.hasEOL ? "\n" : " "}`
        : "",
    )
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function pageSectionContent(
  pageNumber: number,
  pageCount: number,
  text: string,
  assets: ExtractionAsset[],
  bounds: NormalizedBounds[],
): string {
  const parts = [
    `PDF page ${pageNumber} of ${pageCount}`,
    "",
    text
      ? `Embedded text layer:\n${text}`
      : "This page has no usable embedded text layer; use the attached page rendering as the source.",
  ];
  if (assets.length > 0) {
    parts.push("", "Reusable figure candidates from this page:");
    assets.forEach((asset, index) => {
      const candidate = bounds[index]!;
      const horizontal = `${Math.round(candidate.left * 100)}%-${Math.round(candidate.right * 100)}%`;
      const vertical = `${Math.round(candidate.top * 100)}%-${Math.round(candidate.bottom * 100)}%`;
      parts.push(
        `- [[REE_IMAGE:${asset.id}]] (page ${pageNumber}, horizontal ${horizontal}, vertical ${vertical})`,
      );
    });
  }
  return parts.join("\n");
}

export async function gatherPdfSource(
  filePath: string,
  options: PdfSourceOptions = {},
): Promise<SourceBundle> {
  const temporary = await createPrivateTempDir("ree-pdf-");
  let loadingTask:
    { promise: Promise<any>; destroy(): Promise<void> } | undefined;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const bytes = new Uint8Array(await readFile(filePath));
    loadingTask = pdfjs.getDocument({
      data: bytes,
      useSystemFonts: true,
      CanvasFactory: NapiCanvasFactory,
    } as any);
    const pdf = await loadingTask.promise;
    const metadata = await pdf
      .getMetadata()
      .catch(() => ({ info: {}, metadata: null }));
    const information = (metadata.info ?? {}) as Record<string, unknown>;
    const sections: SourceSection[] = [];
    const assets: ExtractionAsset[] = [];
    let imageNumber = 0;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.75 });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      const renderTask = page.render({
        canvas,
        canvasContext: context as any,
        viewport,
        recordImages: options.includeImages === true,
      } as any);
      await renderTask.promise;
      const pagePath = path.join(
        temporary.path,
        `page-${String(pageNumber).padStart(4, "0")}.png`,
      );
      await writeFile(pagePath, canvas.toBuffer("image/png"));

      const textContent = await page
        .getTextContent()
        .catch(() => ({ items: [] as any[] }));
      const text = textFromPage(textContent.items);
      const figureBounds = options.includeImages
        ? distinctFigureBounds(
            page.imageCoordinates ?? renderTask.imageCoordinates,
            width,
            height,
          )
        : [];
      const pageAssets: ExtractionAsset[] = [];

      for (const bounds of figureBounds) {
        const left = Math.max(0, Math.floor(bounds.left * width) - 2);
        const top = Math.max(0, Math.floor(bounds.top * height) - 2);
        const right = Math.min(width, Math.ceil(bounds.right * width) + 2);
        const bottom = Math.min(height, Math.ceil(bounds.bottom * height) + 2);
        const cropWidth = right - left;
        const cropHeight = bottom - top;
        if (cropWidth <= 0 || cropHeight <= 0) continue;
        const crop = createCanvas(cropWidth, cropHeight);
        crop
          .getContext("2d")
          .drawImage(
            canvas,
            left,
            top,
            cropWidth,
            cropHeight,
            0,
            0,
            cropWidth,
            cropHeight,
          );
        imageNumber += 1;
        const id = `pdf-image-${String(imageNumber).padStart(3, "0")}`;
        const cropPath = path.join(temporary.path, `${id}.png`);
        await writeFile(cropPath, crop.toBuffer("image/png"));
        const asset: ExtractionAsset = {
          id,
          mimeType: "image/png",
          filename: `${id}.png`,
          path: cropPath,
          alt: `Figure from PDF page ${pageNumber}`,
        };
        assets.push(asset);
        pageAssets.push(asset);
      }

      sections.push({
        id: `pdf-page-${String(pageNumber).padStart(4, "0")}`,
        label: `PDF page ${pageNumber}`,
        content: pageSectionContent(
          pageNumber,
          pdf.numPages,
          text,
          pageAssets,
          figureBounds,
        ),
        attachments: [pagePath],
        assetIds: pageAssets.map((asset) => asset.id),
      });
      page.cleanup();
    }

    const metadataTitle = information.Title;
    return {
      source: {
        kind: "pdf",
        filename: path.basename(filePath),
        mimeType: "application/pdf",
        pageCount: pdf.numPages,
      },
      title:
        typeof metadataTitle === "string" && metadataTitle.trim()
          ? metadataTitle.trim()
          : undefined,
      metadata: { pdfInfo: information },
      sections,
      assets,
      cleanup: temporary.cleanup,
    };
  } catch (error) {
    await temporary.cleanup();
    throw new Error(
      `Could not render PDF ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await loadingTask?.destroy().catch(() => undefined);
  }
}
