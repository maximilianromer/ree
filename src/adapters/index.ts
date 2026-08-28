import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ProgressReporter,
  SourceBundle,
  SourceKind,
} from "../core/types.js";
import { gatherHtmlEvidence, gatherHtmlStringEvidence } from "./html.js";
import {
  gatherImageSource,
  supportedImageExtensions,
  type ImageSource,
} from "./image.js";
import { gatherPdfSource } from "./pdf.js";
import { gatherWebpageEvidence } from "./webpage.js";

function detectImageMimeType(header: Buffer): string | undefined {
  if (
    header.length >= 8 &&
    header
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (
    header.length >= 3 &&
    header[0] === 0xff &&
    header[1] === 0xd8 &&
    header[2] === 0xff
  )
    return "image/jpeg";
  const signature = header.subarray(0, 6).toString("ascii");
  if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return undefined;
}

async function inspectFile(filePath: string): Promise<{
  kind: SourceKind;
  mimeType?: string;
}> {
  const extension = path.extname(filePath).toLowerCase();
  const file = await open(filePath, "r");
  const header = Buffer.alloc(512);
  let bytesRead = 0;
  try {
    ({ bytesRead } = await file.read(header, 0, header.length, 0));
    if (bytesRead === 0) throw new Error(`Input file is empty: ${filePath}`);
  } finally {
    await file.close();
  }
  const bytes = header.subarray(0, bytesRead);
  const leading = bytes.toString("utf8").trimStart();
  if (bytes.subarray(0, 5).toString() === "%PDF-") return { kind: "pdf" };
  if (
    [".html", ".htm", ".xhtml"].includes(extension) ||
    /^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(leading)
  )
    return { kind: "html" };
  const imageMimeType = detectImageMimeType(bytes);
  if (imageMimeType) return { kind: "image", mimeType: imageMimeType };
  throw new Error(
    `Unsupported input format: ${extension || "unknown file type"}. REE supports URLs, HTML, PDF, and images.`,
  );
}

export async function detectFileType(filePath: string): Promise<SourceKind> {
  return (await inspectFile(filePath)).kind;
}

export function isPublicUrl(source: string): boolean {
  try {
    const parsed = new URL(source);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export interface WebEvidenceOptions {
  includeImages?: boolean;
}

const gallerySorter = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

async function imageSource(filePath: string): Promise<ImageSource> {
  const inspected = await inspectFile(filePath);
  if (inspected.kind !== "image" || !inspected.mimeType)
    throw new Error(
      `Image gallery entries must be images: ${path.basename(filePath)}`,
    );
  return { path: filePath, mimeType: inspected.mimeType };
}

async function gatherImageDirectory(directory: string): Promise<SourceBundle> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        supportedImageExtensions.has(path.extname(entry.name).toLowerCase()),
    )
    .sort((left, right) => gallerySorter.compare(left.name, right.name));
  if (entries.length === 0)
    throw new Error(`Image gallery contains no supported images: ${directory}`);
  const images = await Promise.all(
    entries.map((entry) => imageSource(path.join(directory, entry.name))),
  );
  return gatherImageSource(images, {
    galleryName: path.basename(directory),
    forceGallery: true,
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const html = Buffer.concat(chunks).toString("utf8");
  if (!html.trim()) throw new Error("HTML input from stdin is empty");
  return html;
}

export async function gatherEvidence(
  source: string | string[],
  progress: ProgressReporter,
  options: WebEvidenceOptions = {},
): Promise<SourceBundle> {
  const sources = Array.isArray(source) ? source : [source];
  if (sources.length === 0) throw new Error("No source was provided");
  if (sources.length > 1) {
    progress({ stage: "capturing", message: "Gathering image gallery" });
    const images = await Promise.all(
      sources.map((entry) => imageSource(path.resolve(entry))),
    );
    return gatherImageSource(images, { forceGallery: true });
  }

  const onlySource = sources[0]!;
  if (onlySource === "-") {
    progress({ stage: "capturing", message: "Reading HTML from stdin" });
    return gatherHtmlStringEvidence(await readStdin(), undefined);
  }
  if (isPublicUrl(onlySource)) {
    progress({ stage: "loading", message: "Loading webpage in Chromium" });
    return gatherWebpageEvidence(onlySource, options);
  }
  const absolute = path.resolve(onlySource);
  if ((await stat(absolute)).isDirectory()) {
    progress({ stage: "capturing", message: "Gathering image gallery" });
    return gatherImageDirectory(absolute);
  }
  const inspected = await inspectFile(absolute);
  const kind = inspected.kind;
  progress({
    stage: "capturing",
    message: `Gathering ${kind.toUpperCase()} source material`,
  });
  if (kind === "pdf") return gatherPdfSource(absolute, options);
  if (kind === "html") return gatherHtmlEvidence(absolute, options);
  if (kind === "image" && inspected.mimeType)
    return gatherImageSource([
      { path: absolute, mimeType: inspected.mimeType },
    ]);
  throw new Error(`Unsupported source kind: ${kind}`);
}
