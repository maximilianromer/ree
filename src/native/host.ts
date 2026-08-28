import {
  appendFile,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gatherHtmlStringEvidence } from "../adapters/html.js";
import { gatherPdfSource } from "../adapters/pdf.js";
import type { SourceBundle } from "../core/types.js";
import { CodexExtractionAdapter } from "../model/codex.js";
import { extractEvidence } from "../pipeline/extract.js";
import { renderOutput } from "../renderers/index.js";
import { createPrivateTempDir } from "../core/temp.js";
import {
  capturedSourceSchema,
  nativeRequestSchema,
  type CapturedPdf,
  type CapturedSource,
  type NativeRequest,
  type NativeResponse,
} from "./protocol.js";

interface UploadSession {
  kind: "page" | "pdf";
  payloadPath: string;
  cleanup: () => Promise<void>;
  expectedBytes: number;
  receivedBytes: number;
  nextIndex: number;
  format: "txt" | "md" | "pdf";
  fast: boolean;
  includeImages: boolean;
  model: string;
  customInstructions: string;
  sourceUrl?: string;
  sourceTitle?: string;
}

const uploadSessions = new Map<string, UploadSession>();
const MAX_PDF_BYTES = 192 * 1024 * 1024;

export function completeUtf8ChunkLength(
  buffer: Buffer,
  requested: number,
  bytesRead = buffer.length,
): number {
  let usable = Math.min(requested, bytesRead);
  while (usable < bytesRead && (buffer[usable]! & 0xc0) === 0x80) usable += 1;
  return usable;
}

function outputDirectory(): string {
  return path.join(os.homedir(), "Documents", "REE Extractions");
}

function safeFilename(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "extraction"
  );
}

export function localDateStamp(date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function uniqueOutputPath(
  directory: string,
  base: string,
  format: "txt" | "md" | "pdf",
): Promise<string> {
  await mkdir(directory, { recursive: true });
  let suffix = 1;
  while (true) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    const outputPath = path.join(directory, `${candidate}.${format}`);
    let reservation: Awaited<ReturnType<typeof open>> | undefined;
    try {
      reservation = await open(outputPath, "wx", 0o600);
      await reservation.close();
      return outputPath;
    } catch (error) {
      await reservation?.close();
      if (reservation) await rm(outputPath, { force: true });
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    suffix += 1;
  }
}

async function allowedOutputPath(candidate: string): Promise<string> {
  const root = path.resolve(outputDirectory());
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Output access is limited to the REE output folder");
  const actualRoot = await realpath(root);
  const actual = await realpath(resolved);
  const actualRelative = path.relative(actualRoot, actual);
  if (
    !actualRelative ||
    actualRelative.startsWith("..") ||
    path.isAbsolute(actualRelative)
  )
    throw new Error("Output path leaves the REE output folder");
  return actual;
}

async function openFolder(filePath: string): Promise<void> {
  const actual = await allowedOutputPath(filePath);
  const directory = (await stat(actual)).isDirectory()
    ? actual
    : path.dirname(actual);
  const [command, args] =
    os.platform() === "darwin"
      ? ["open", [directory]]
      : os.platform() === "win32"
        ? ["explorer.exe", [directory]]
        : ["xdg-open", [directory]];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function openOutput(filePath: string): Promise<void> {
  const actual = await allowedOutputPath(filePath);
  if (!(await stat(actual)).isFile()) throw new Error("Output is not a file");
  const [command, args] =
    os.platform() === "darwin"
      ? ["open", [actual]]
      : os.platform() === "win32"
        ? ["cmd.exe", ["/c", "start", "", actual]]
        : ["xdg-open", [actual]];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function openOutputFolder(): Promise<void> {
  const directory = outputDirectory();
  await mkdir(directory, { recursive: true });
  const [command, args] =
    os.platform() === "darwin"
      ? ["open", [directory]]
      : os.platform() === "win32"
        ? ["explorer.exe", [directory]]
        : ["xdg-open", [directory]];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function assertPdfFile(filePath: string): Promise<void> {
  const information = await stat(filePath);
  if (!information.isFile()) throw new Error("The selected PDF is not a file");
  if (information.size === 0) throw new Error("The selected PDF is empty");
  if (information.size > MAX_PDF_BYTES)
    throw new Error("The selected PDF exceeds REE's 192 MB limit");
  const file = await open(filePath, "r");
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString("ascii") !== "%PDF-")
      throw new Error("The selected browser tab did not return a PDF file");
  } finally {
    await file.close();
  }
}

function capturedPdfTitle(evidence: SourceBundle, source: CapturedPdf): string {
  const embedded = evidence.title?.trim();
  return embedded && !/^(?:about:blank|untitled)$/i.test(embedded)
    ? embedded
    : source.title;
}

async function gatherCapturedPdfFile(
  filePath: string,
  source: CapturedPdf,
  includeImages: boolean,
): Promise<SourceBundle> {
  await assertPdfFile(filePath);
  const evidence = await gatherPdfSource(filePath, { includeImages });
  return {
    ...evidence,
    title: capturedPdfTitle(evidence, source),
    source: { ...evidence.source, url: source.url },
  };
}

export async function gatherCapturedPdfSource(
  source: CapturedPdf,
  includeImages: boolean,
  signal?: AbortSignal,
): Promise<SourceBundle> {
  const sourceUrl = new URL(source.url);
  if (sourceUrl.protocol === "file:") {
    const filePath = fileURLToPath(sourceUrl);
    return gatherCapturedPdfFile(filePath, source, includeImages);
  }
  if (!["http:", "https:"].includes(sourceUrl.protocol))
    throw new Error(
      "REE can only load PDF tabs from HTTP, HTTPS, or local files",
    );

  const temporary = await createPrivateTempDir("ree-browser-pdf-");
  const pdfPath = path.join(temporary.path, "source.pdf");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const response = await fetch(source.url, {
      headers: { accept: "application/pdf" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(
        `The browser PDF could not be loaded (HTTP ${response.status})`,
      );
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES)
      throw new Error("The selected PDF exceeds REE's 192 MB limit");
    if (!response.body)
      throw new Error("The browser PDF response did not contain a file");

    file = await open(pdfPath, "wx", 0o600);
    const reader = response.body.getReader();
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_PDF_BYTES) {
        await reader.cancel();
        throw new Error("The selected PDF exceeds REE's 192 MB limit");
      }
      await file.write(value);
    }
    await file.close();
    file = undefined;
    await assertPdfFile(pdfPath);
    const evidence = await gatherPdfSource(pdfPath, { includeImages });
    return {
      ...evidence,
      title: capturedPdfTitle(evidence, source),
      source: { ...evidence.source, url: source.url },
      cleanup: async () => {
        try {
          await evidence.cleanup();
        } finally {
          await temporary.cleanup();
        }
      },
    };
  } catch (error) {
    await file?.close();
    await temporary.cleanup();
    if (controller.signal.aborted && !signal?.aborted)
      throw new Error("Loading the browser PDF timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export async function gatherCapturedSourceEvidence(
  source: CapturedSource,
  includeImages: boolean,
  signal?: AbortSignal,
  uploadedPdfPath?: string,
): Promise<SourceBundle> {
  if ("kind" in source) {
    return uploadedPdfPath
      ? gatherCapturedPdfFile(uploadedPdfPath, source, includeImages)
      : gatherCapturedPdfSource(source, includeImages, signal);
  }
  return gatherHtmlStringEvidence(
    source.html,
    source.url,
    includeImages ? source.images : [],
  );
}

async function extractCapturedSource(
  id: string,
  source: CapturedSource,
  format: "txt" | "md" | "pdf",
  fast: boolean,
  includeImages: boolean,
  model: string,
  customInstructions: string,
  send: (response: NativeResponse) => void,
  signal?: AbortSignal,
  uploadedPdfPath?: string,
): Promise<void> {
  if (signal?.aborted) throw new Error("Extraction cancelled");
  const useImages = format === "pdf" && includeImages;
  const evidence = await gatherCapturedSourceEvidence(
    source,
    useImages,
    signal,
    uploadedPdfPath,
  );
  try {
    if (signal?.aborted) throw new Error("Extraction cancelled");
    const adapter = new CodexExtractionAdapter();
    const result = await extractEvidence(evidence, adapter, {
      format,
      includeImages: useImages,
      fast,
      model,
      customInstructions,
      concurrency: 2,
      signal,
      progress: (event) => send({ id, type: "progress", ...event }),
      stream: (event) => send({ id, type: "model-delta", ...event }),
    });
    const title = result.title || source.title || "Extraction";
    const base = `${safeFilename(title)}-${localDateStamp()}`;
    const directory = outputDirectory();
    const outputPath = await uniqueOutputPath(directory, base, format);
    send({
      id,
      type: "progress",
      stage: "rendering",
      message: `Creating ${format.toUpperCase()} edition`,
    });
    try {
      await renderOutput(result, {
        format,
        outputPath,
        includeImages: useImages,
      });
    } catch (error) {
      await rm(outputPath, { force: true });
      throw error;
    }
    send({
      id,
      type: "complete",
      format,
      outputPath,
      title,
    });
  } finally {
    await evidence.cleanup();
  }
}

export async function handleNativeRequest(
  request: NativeRequest,
  send: (response: NativeResponse) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (request.type === "ping") {
    send({ id: request.id, type: "pong", version: "1.0.0" });
    return;
  }
  if (request.type === "extract-begin") {
    const previous = uploadSessions.get(request.id);
    if (previous) await previous.cleanup();
    const temporary = await createPrivateTempDir("ree-native-upload-");
    const payloadPath = path.join(temporary.path, "page.json");
    await writeFile(payloadPath, "", { mode: 0o600 });
    uploadSessions.set(request.id, {
      kind: "page",
      payloadPath,
      cleanup: temporary.cleanup,
      expectedBytes: request.totalBytes,
      receivedBytes: 0,
      nextIndex: 0,
      format: request.options.format,
      fast: request.options.fast,
      includeImages: request.options.includeImages,
      model: request.options.model,
      customInstructions: request.options.customInstructions,
    });
    send({
      id: request.id,
      type: "progress",
      stage: "capturing",
      message: "Receiving captured page",
    });
    return;
  }
  if (request.type === "extract-pdf-begin") {
    const previous = uploadSessions.get(request.id);
    if (previous) await previous.cleanup();
    const temporary = await createPrivateTempDir("ree-native-pdf-upload-");
    const payloadPath = path.join(temporary.path, "source.pdf");
    await writeFile(payloadPath, "", { mode: 0o600 });
    uploadSessions.set(request.id, {
      kind: "pdf",
      payloadPath,
      cleanup: temporary.cleanup,
      expectedBytes: request.totalBytes,
      receivedBytes: 0,
      nextIndex: 0,
      format: request.options.format,
      fast: request.options.fast,
      includeImages: request.options.includeImages,
      model: request.options.model,
      customInstructions: request.options.customInstructions,
      sourceUrl: request.url,
      sourceTitle: request.title,
    });
    send({
      id: request.id,
      type: "progress",
      stage: "capturing",
      message: "Receiving selected PDF",
    });
    return;
  }
  if (request.type === "extract-chunk") {
    const session = uploadSessions.get(request.id);
    if (!session) throw new Error("Capture upload was not initialized");
    if (session.kind !== "page")
      throw new Error("Page data was sent to a PDF upload");
    if (request.index !== session.nextIndex)
      throw new Error(`Capture chunk ${request.index} arrived out of order`);
    const bytes = Buffer.byteLength(request.data, "utf8");
    if (session.receivedBytes + bytes > session.expectedBytes)
      throw new Error("Capture upload exceeded its declared size");
    await appendFile(session.payloadPath, request.data, "utf8");
    session.receivedBytes += bytes;
    session.nextIndex += 1;
    return;
  }
  if (request.type === "extract-pdf-chunk") {
    const session = uploadSessions.get(request.id);
    if (!session) throw new Error("Capture upload was not initialized");
    if (session.kind !== "pdf")
      throw new Error("PDF data was sent to a page upload");
    if (request.index !== session.nextIndex)
      throw new Error(`Capture chunk ${request.index} arrived out of order`);
    const bytes = Buffer.from(request.data, "base64");
    if (bytes.toString("base64") !== request.data)
      throw new Error("PDF chunk was not canonical base64");
    if (session.receivedBytes + bytes.length > session.expectedBytes)
      throw new Error("Capture upload exceeded its declared size");
    await appendFile(session.payloadPath, bytes);
    session.receivedBytes += bytes.length;
    session.nextIndex += 1;
    return;
  }
  if (request.type === "extract-commit") {
    const session = uploadSessions.get(request.id);
    if (!session) throw new Error("Capture upload was not initialized");
    uploadSessions.delete(request.id);
    try {
      if (session.receivedBytes !== session.expectedBytes)
        throw new Error(
          `Capture upload is incomplete (${session.receivedBytes} of ${session.expectedBytes} bytes)`,
        );
      const source =
        session.kind === "pdf"
          ? capturedSourceSchema.parse({
              kind: "pdf",
              url: session.sourceUrl,
              title: session.sourceTitle,
            })
          : capturedSourceSchema.parse(
              JSON.parse(await readFile(session.payloadPath, "utf8")),
            );
      await extractCapturedSource(
        request.id,
        source,
        session.format,
        session.fast,
        session.includeImages,
        session.model,
        session.customInstructions,
        send,
        signal,
        session.kind === "pdf" ? session.payloadPath : undefined,
      );
    } finally {
      await session.cleanup();
    }
    return;
  }
  if (request.type === "read-output") {
    const actual = await allowedOutputPath(request.path);
    const file = await open(actual, "r");
    try {
      const size = (await file.stat()).size;
      const start = Math.min(request.offset, size);
      const buffer = Buffer.alloc(Math.min(request.length + 3, size - start));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const usable = completeUtf8ChunkLength(buffer, request.length, bytesRead);
      const end = start + usable;
      send({
        id: request.id,
        type: "output-chunk",
        data: buffer.subarray(0, usable).toString("utf8"),
        offset: start,
        nextOffset: end,
        done: end >= size,
      });
    } finally {
      await file.close();
    }
    return;
  }
  if (request.type === "open-folder") {
    await openFolder(request.path);
    send({ id: request.id, type: "opened" });
    return;
  }
  if (request.type === "open-output") {
    await openOutput(request.path);
    send({ id: request.id, type: "opened" });
    return;
  }
  if (request.type === "open-output-folder") {
    await openOutputFolder();
    send({ id: request.id, type: "opened" });
    return;
  }
}

export async function runNativeHost(
  input = process.stdin,
  output = process.stdout,
): Promise<void> {
  let buffer = Buffer.alloc(0);
  let queue = Promise.resolve();
  const connectionAbort = new AbortController();
  const send = (response: NativeResponse) => {
    const body = Buffer.from(JSON.stringify(response), "utf8");
    if (body.length > 1_000_000)
      throw new Error("Native response exceeded Chromium's 1 MB limit");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    output.write(Buffer.concat([header, body]));
  };
  try {
    for await (const chunk of input) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (length > 8 * 1024 * 1024)
          throw new Error("Native request is too large");
        if (buffer.length < length + 4) break;
        const body = buffer.subarray(4, length + 4).toString("utf8");
        buffer = buffer.subarray(length + 4);
        queue = queue.then(async () => {
          let id = "unknown";
          try {
            const parsed = JSON.parse(body);
            id = typeof parsed?.id === "string" ? parsed.id : id;
            const request = nativeRequestSchema.parse(parsed);
            await handleNativeRequest(request, send, connectionAbort.signal);
          } catch (error) {
            send({
              id,
              type: "error",
              code: "REQUEST_FAILED",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
      }
    }
    connectionAbort.abort();
    await queue;
  } finally {
    connectionAbort.abort();
    await Promise.all(
      [...uploadSessions.values()].map((session) => session.cleanup()),
    );
    uploadSessions.clear();
  }
}
