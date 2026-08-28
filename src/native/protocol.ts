import { z } from "zod";
import { DEFAULT_MODEL, normalizeModelSlug } from "../model/selection.js";

const capturedImageSchema = z.object({
  id: z.string().regex(/^image-\d{3,}$/),
  dataUrl: z.string().max(80_000_000),
  label: z.string().max(300),
  alt: z.string().max(2_000).optional(),
  sourceUrl: z.string().url().max(8_000).optional(),
});

export const outputFormatSchema = z.enum(["txt", "md", "pdf"]);
export type OutputFormat = z.infer<typeof outputFormatSchema>;

const extractionOptionsSchema = z.object({
  format: outputFormatSchema.default("md"),
  fast: z.boolean().default(false),
  includeImages: z.boolean().default(true),
  model: z.string().transform(normalizeModelSlug).default(DEFAULT_MODEL),
  customInstructions: z.string().trim().max(4_000).default(""),
});

const defaultExtractionOptions = {
  format: "md",
  fast: false,
  includeImages: true,
  model: DEFAULT_MODEL,
  customInstructions: "",
} as const;

export const capturedPageSchema = z.object({
  url: z.string().url(),
  title: z.string().max(2_000),
  html: z.string().max(50_000_000),
  images: z.array(capturedImageSchema).max(20).default([]),
});

export const capturedPdfSchema = z.object({
  kind: z.literal("pdf"),
  url: z
    .string()
    .url()
    .max(32_000)
    .refine(
      (value) => ["http:", "https:", "file:"].includes(new URL(value).protocol),
      "PDF source must use HTTP, HTTPS, or a local file URL",
    ),
  title: z.string().max(2_000),
});

export const capturedSourceSchema = z.union([
  capturedPageSchema,
  capturedPdfSchema,
]);

export const nativeRequestSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().max(100), type: z.literal("ping") }),
  z.object({
    id: z.string().max(100),
    type: z.literal("extract-begin"),
    totalBytes: z.number().int().positive().max(256_000_000),
    options: extractionOptionsSchema.default(defaultExtractionOptions),
  }),
  z.object({
    id: z.string().max(100),
    type: z.literal("extract-pdf-begin"),
    totalBytes: z
      .number()
      .int()
      .positive()
      .max(192 * 1024 * 1024),
    url: capturedPdfSchema.shape.url,
    title: capturedPdfSchema.shape.title,
    options: extractionOptionsSchema.default(defaultExtractionOptions),
  }),
  z.object({
    id: z.string().max(100),
    type: z.literal("extract-chunk"),
    index: z.number().int().nonnegative().max(1_000),
    data: z.string().max(1_000_000),
  }),
  z.object({
    id: z.string().max(100),
    type: z.literal("extract-pdf-chunk"),
    index: z.number().int().nonnegative().max(1_000),
    data: z
      .string()
      .max(900_000)
      .refine(
        (value) =>
          value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
        "PDF chunk must be canonical base64",
      ),
  }),
  z.object({
    id: z.string().max(100),
    type: z.literal("extract-commit"),
  }),
  z.object({
    id: z.string().max(100),
    type: z.literal("read-output"),
    path: z.string().max(32_000),
    offset: z.number().int().nonnegative().default(0),
    length: z.number().int().positive().max(120_000).default(120_000),
  }),
  z.object({
    id: z.string().max(100),
    type: z.literal("open-folder"),
    path: z.string().max(32_000),
  }),
  z.object({
    id: z.string().max(100),
    type: z.literal("open-output"),
    path: z.string().max(32_000),
  }),
  z.object({ id: z.string().max(100), type: z.literal("open-output-folder") }),
]);

export type NativeRequest = z.infer<typeof nativeRequestSchema>;
export type CapturedPage = z.infer<typeof capturedPageSchema>;
export type CapturedPdf = z.infer<typeof capturedPdfSchema>;
export type CapturedSource = z.infer<typeof capturedSourceSchema>;

export type NativeResponse =
  | { id: string; type: "pong"; version: string }
  | {
      id: string;
      type: "progress";
      stage: string;
      message: string;
      current?: number;
      total?: number;
    }
  | {
      id: string;
      type: "model-delta";
      kind: "output" | "reasoning";
      delta: string;
      current?: number;
      total?: number;
    }
  | {
      id: string;
      type: "complete";
      format: OutputFormat;
      outputPath: string;
      title: string;
    }
  | {
      id: string;
      type: "output-chunk";
      data: string;
      offset: number;
      nextOffset: number;
      done: boolean;
    }
  | { id: string; type: "opened" }
  | { id: string; type: "error"; code: string; message: string };
