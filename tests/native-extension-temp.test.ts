import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createPrivateTempDir } from "../src/core/temp.js";
import {
  completeUtf8ChunkLength,
  gatherCapturedPdfSource,
  handleNativeRequest,
  localDateStamp,
  runNativeHost,
  uniqueOutputPath,
} from "../src/native/host.js";
import {
  capturedPdfSchema,
  capturedPageSchema,
  capturedSourceSchema,
  nativeRequestSchema,
} from "../src/native/protocol.js";
import { windowsSeaMain } from "../src/native/setup.js";

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function decodeFrames(buffer: Buffer): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  let offset = 0;
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const start = offset + 4;
    messages.push(
      JSON.parse(buffer.subarray(start, start + length).toString("utf8")),
    );
    offset = start + length;
  }
  return messages;
}

describe("privacy, selected-format protocol, and extension contract", () => {
  it("uses the local calendar date in automatic output filenames", () => {
    const lateEvening = new Date(2026, 7, 27, 23, 30);
    expect(localDateStamp(lateEvening)).toBe("2026-08-27");
  });

  it("cleans private temporary directories idempotently", async () => {
    const temporary = await createPrivateTempDir("ree-test-cleanup-");
    await expect(stat(temporary.path)).resolves.toBeTruthy();
    await temporary.cleanup();
    await temporary.cleanup();
    await expect(stat(temporary.path)).rejects.toThrow();
  });

  it("uses Chromium framing, reports v1.0, and cleans incomplete uploads", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const running = runNativeHost(input, output);
    input.end(
      Buffer.concat([
        frame({ id: "ping-1", type: "ping" }),
        frame({
          id: "upload-1",
          type: "extract-begin",
          totalBytes: 5,
          options: { format: "txt", fast: true, includeImages: false },
        }),
        frame({
          id: "upload-1",
          type: "extract-chunk",
          index: 0,
          data: "x",
        }),
        frame({ id: "upload-1", type: "extract-commit" }),
        frame({
          id: "pdf-upload-1",
          type: "extract-pdf-begin",
          totalBytes: 9,
          url: "https://documents.example/report.pdf",
          title: "Report.pdf",
          options: { format: "txt", includeImages: false },
        }),
        frame({
          id: "pdf-upload-1",
          type: "extract-pdf-chunk",
          index: 0,
          data: Buffer.from("not-a-pdf").toString("base64"),
        }),
        frame({ id: "pdf-upload-1", type: "extract-commit" }),
      ]),
    );
    await running;

    const messages = decodeFrames(Buffer.concat(chunks));
    expect(messages).toContainEqual(
      expect.objectContaining({
        id: "ping-1",
        type: "pong",
        version: "1.0.0",
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        id: "upload-1",
        type: "progress",
        message: "Receiving captured page",
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        id: "upload-1",
        type: "error",
        message: expect.stringContaining("Capture upload is incomplete"),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        id: "pdf-upload-1",
        type: "progress",
        message: "Receiving selected PDF",
      }),
    );
  });

  it("rejects a streamed browser payload that is not actually a PDF", async () => {
    const responses: Array<Record<string, unknown>> = [];
    const send = (response: Record<string, unknown>) =>
      responses.push(response);
    await handleNativeRequest(
      nativeRequestSchema.parse({
        id: "invalid-pdf-upload",
        type: "extract-pdf-begin",
        totalBytes: 9,
        url: "https://documents.example/report.pdf",
        title: "Report.pdf",
        options: { format: "txt", includeImages: false },
      }),
      send,
    );
    await handleNativeRequest(
      nativeRequestSchema.parse({
        id: "invalid-pdf-upload",
        type: "extract-pdf-chunk",
        index: 0,
        data: Buffer.from("not-a-pdf").toString("base64"),
      }),
      send,
    );
    await expect(
      handleNativeRequest(
        nativeRequestSchema.parse({
          id: "invalid-pdf-upload",
          type: "extract-commit",
        }),
        send,
      ),
    ).rejects.toThrow("did not return a PDF file");
    expect(responses).toContainEqual(
      expect.objectContaining({
        id: "invalid-pdf-upload",
        message: "Receiving selected PDF",
      }),
    );
  });

  it("defaults to Markdown and validates all selected-format begin options", () => {
    expect(
      nativeRequestSchema.parse({
        id: "default-1",
        type: "extract-begin",
        totalBytes: 10,
      }),
    ).toMatchObject({
      options: {
        format: "md",
        fast: false,
        includeImages: true,
        model: "gpt-5.6-luna",
        customInstructions: "",
      },
    });

    for (const format of ["txt", "md", "pdf"] as const) {
      expect(
        nativeRequestSchema.parse({
          id: `${format}-1`,
          type: "extract-begin",
          totalBytes: 10,
          options: {
            format,
            fast: format === "txt",
            includeImages: format === "pdf",
            model: "openai/gpt-7.2-preview",
            customInstructions: "Keep footnotes.",
          },
        }),
      ).toMatchObject({
        options: {
          format,
          fast: format === "txt",
          includeImages: format === "pdf",
          model: "openai/gpt-7.2-preview",
          customInstructions: "Keep footnotes.",
        },
      });
    }

    expect(() =>
      nativeRequestSchema.parse({
        id: "bad-format",
        type: "extract-begin",
        totalBytes: 10,
        options: { format: "json" },
      }),
    ).toThrow();
    expect(() =>
      nativeRequestSchema.parse({
        id: "long-instructions",
        type: "extract-begin",
        totalBytes: 10,
        options: { customInstructions: "x".repeat(4_001) },
      }),
    ).toThrow();
    expect(() =>
      nativeRequestSchema.parse({
        id: "bad-model",
        type: "extract-begin",
        totalBytes: 10,
        options: { model: "two models" },
      }),
    ).toThrow();
  });

  it("validates semantic image IDs and bounded ordered upload chunks", () => {
    expect(
      capturedPageSchema.parse({
        url: "https://example.com/article",
        title: "Article",
        html: '<figure data-ree-image-id="image-001"></figure>',
        images: [
          {
            id: "image-001",
            dataUrl: "data:image/png;base64,aW1hZ2U=",
            label: "Article figure",
          },
        ],
      }),
    ).toMatchObject({ images: [{ id: "image-001" }] });
    expect(() =>
      capturedPageSchema.parse({
        url: "https://example.com/article",
        title: "Article",
        html: "<main>Article</main>",
        images: [
          {
            id: "hero",
            dataUrl: "data:image/png;base64,aW1hZ2U=",
            label: "Hero",
          },
        ],
      }),
    ).toThrow();
    expect(
      nativeRequestSchema.parse({
        id: "capture-1",
        type: "extract-chunk",
        index: 4,
        data: "page evidence",
      }),
    ).toMatchObject({ type: "extract-chunk", index: 4 });
    expect(() =>
      nativeRequestSchema.parse({
        id: "capture-1",
        type: "extract-chunk",
        index: 0,
        data: "x".repeat(1_000_001),
      }),
    ).toThrow();
    expect(
      nativeRequestSchema.parse({
        id: "pdf-capture-1",
        type: "extract-pdf-begin",
        totalBytes: 9,
        url: "https://documents.example/report.pdf",
        title: "Report.pdf",
      }),
    ).toMatchObject({
      type: "extract-pdf-begin",
      options: { format: "md", model: "gpt-5.6-luna" },
    });
    expect(
      nativeRequestSchema.parse({
        id: "pdf-capture-1",
        type: "extract-pdf-chunk",
        index: 0,
        data: Buffer.from("%PDF-test").toString("base64"),
      }),
    ).toMatchObject({ type: "extract-pdf-chunk", index: 0 });
    expect(() =>
      nativeRequestSchema.parse({
        id: "pdf-capture-1",
        type: "extract-pdf-chunk",
        index: 0,
        data: "not base64!",
      }),
    ).toThrow();
  });

  it("accepts browser PDF sources without treating viewer HTML as evidence", () => {
    const source = {
      kind: "pdf",
      url: "https://documents.example/report.pdf?token=signed",
      title: "Annual Report.pdf",
    } as const;
    expect(capturedPdfSchema.parse(source)).toEqual(source);
    expect(capturedSourceSchema.parse(source)).toEqual(source);
    expect(() =>
      capturedPdfSchema.parse({
        ...source,
        url: "chrome-extension://pdf-viewer/index.html",
      }),
    ).toThrow();
    expect(() =>
      capturedPdfSchema.parse({
        ...source,
        url: "data:application/pdf;base64,JVBERi0=",
      }),
    ).toThrow();
  });

  it("loads local and HTTP browser PDF sources through the PDF adapter", async () => {
    const fixturePath = path.resolve("fixtures/generated/normal-text.pdf");
    const localEvidence = await gatherCapturedPdfSource(
      {
        kind: "pdf",
        url: pathToFileURL(fixturePath).href,
        title: "Local Wind Atlas.pdf",
      },
      false,
    );
    try {
      expect(localEvidence.source.kind).toBe("pdf");
      expect(localEvidence.title).toBe("Local Wind Atlas.pdf");
      expect(localEvidence.sections[0]?.content).toContain(
        "The north wind leaves a blue notation on the ridge.",
      );
    } finally {
      await localEvidence.cleanup();
    }

    const pdf = await readFile(fixturePath);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/not-a-pdf"))
        return new Response("<!doctype html><title>Not a PDF</title>", {
          headers: { "content-type": "text/html" },
        });
      return new Response(pdf, {
        headers: {
          "content-type": "application/pdf",
          "content-length": String(pdf.length),
        },
      });
    };
    try {
      const base = "https://documents.example";
      const remoteEvidence = await gatherCapturedPdfSource(
        {
          kind: "pdf",
          url: `${base}/report.pdf?token=signed`,
          title: "Remote Wind Atlas.pdf",
        },
        false,
      );
      try {
        expect(remoteEvidence.source.url).toBe(
          `${base}/report.pdf?token=signed`,
        );
        expect(remoteEvidence.sections[0]?.content).toContain(
          "The south wind answers in dust.",
        );
      } finally {
        await remoteEvidence.cleanup();
      }
      await expect(
        gatherCapturedPdfSource(
          {
            kind: "pdf",
            url: `${base}/not-a-pdf`,
            title: "Not a PDF",
          },
          false,
        ),
      ).rejects.toThrow("did not return a PDF file");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reserves one unique file for only the selected output format", async () => {
    const temporary = await createPrivateTempDir("ree-test-outputs-");
    try {
      await writeFile(path.join(temporary.path, "article.md"), "existing");
      const markdownPaths = await Promise.all([
        uniqueOutputPath(temporary.path, "article", "md"),
        uniqueOutputPath(temporary.path, "article", "md"),
      ]);
      const pdfPath = await uniqueOutputPath(temporary.path, "article", "pdf");

      expect(markdownPaths.map((entry) => path.basename(entry)).sort()).toEqual(
        ["article-2.md", "article-3.md"],
      );
      expect(path.basename(pdfPath)).toBe("article.pdf");
      await expect(stat(markdownPaths[0]!)).resolves.toBeTruthy();
      await expect(stat(markdownPaths[1]!)).resolves.toBeTruthy();
      await expect(stat(pdfPath)).resolves.toBeTruthy();
      await expect(
        stat(path.join(temporary.path, "article-2.pdf")),
      ).rejects.toThrow();
      await expect(
        stat(path.join(temporary.path, "article.txt")),
      ).rejects.toThrow();
    } finally {
      await temporary.cleanup();
    }
  });

  it("confines read and open requests to the REE output folder", async () => {
    const temporary = await createPrivateTempDir("ree-test-outside-");
    try {
      const outsidePath = path.join(temporary.path, "outside.md");
      await writeFile(outsidePath, "private");
      for (const type of [
        "read-output",
        "open-folder",
        "open-output",
      ] as const) {
        const request = nativeRequestSchema.parse({
          id: `outside-${type}`,
          type,
          path: outsidePath,
        });
        await expect(
          handleNativeRequest(request, () => undefined),
        ).rejects.toThrow("Output access is limited to the REE output folder");
      }
    } finally {
      await temporary.cleanup();
    }
  });

  it("never splits multibyte output across native response chunks", () => {
    const bytes = Buffer.from("A€B", "utf8");
    const length = completeUtf8ChunkLength(bytes, 2);
    expect(length).toBe(4);
    expect(bytes.subarray(0, length).toString("utf8")).toBe("A€");
  });

  it("passes the selected extension model and emits one completion path", async () => {
    const host = await readFile("src/native/host.ts", "utf8");
    const protocol = await readFile("src/native/protocol.ts", "utf8");
    expect(host).toContain("model: request.options.model");
    expect(host).toContain(
      "customInstructions: request.options.customInstructions",
    );
    expect(host).toContain("session.model,");
    expect(host).toContain("session.customInstructions,");
    expect(host).toContain('format === "pdf" && includeImages');
    expect(host).toContain("outputPath,");
    expect(protocol).toContain("outputPath: string");
    expect(protocol).toContain('type: "model-delta"');
    expect(host).toContain(
      'stream: (event) => send({ id, type: "model-delta", ...event })',
    );
  });

  it("builds a Windows SEA entrypoint instead of a batch-file host", () => {
    const modulePath = "C:\\Program Files\\REE\\dist\\native-host.js";
    const source = windowsSeaMain(modulePath);
    expect(source).toContain("pathToFileURL");
    expect(source).toContain(JSON.stringify(modulePath));
    expect(source).not.toContain("cmd.exe");
  });

  it("runs the generated SEA entrypoint against the installed host module", async () => {
    const temporary = await createPrivateTempDir("ree-sea-entry-test-");
    try {
      const entrypoint = path.join(temporary.path, "native-host.cjs");
      await writeFile(
        entrypoint,
        windowsSeaMain(path.resolve("dist/native-host.js")),
      );
      const result = spawnSync(
        process.execPath,
        [entrypoint, "chrome-extension://komlllipnoacgedoailjegbglfihcgkh/"],
        {
          input: frame({ id: "sea-ping", type: "ping" }),
          maxBuffer: 2_000_000,
        },
      );
      expect(result.status).toBe(0);
      expect(decodeFrames(result.stdout)).toContainEqual(
        expect.objectContaining({ id: "sea-ping", type: "pong" }),
      );
    } finally {
      await temporary.cleanup();
    }
  });

  it("keeps extension permissions narrow and its identity stable", async () => {
    const manifest = JSON.parse(
      await readFile("extension/manifest.json", "utf8"),
    );
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(["activeTab", "scripting", "nativeMessaging"]),
    );
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.key.length).toBeGreaterThan(300);
    const hex = createHash("sha256")
      .update(Buffer.from(manifest.key, "base64"))
      .digest("hex")
      .slice(0, 32);
    const extensionId = [...hex]
      .map((character) => "abcdefghijklmnop"[Number.parseInt(character, 16)])
      .join("");
    expect(extensionId).toBe("komlllipnoacgedoailjegbglfihcgkh");
    expect(await readFile("extension/background.js", "utf8")).toContain(
      "settleJob(",
    );
  });
});
