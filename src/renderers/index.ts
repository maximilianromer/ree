import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtractionResult, OutputFormat } from "../core/types.js";
import { renderPdf } from "./pdf.js";

export type { OutputFormat } from "../core/types.js";

export interface RenderOptions {
  format: OutputFormat;
  outputPath?: string;
  includeImages?: boolean;
}

function temporaryOutputPath(outputPath: string): string {
  const parsed = path.parse(outputPath);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(parsed.dir, `.${parsed.name}-${nonce}.tmp${parsed.ext}`);
}

async function writeTextAtomically(
  outputPath: string,
  content: string,
): Promise<void> {
  const temporary = temporaryOutputPath(outputPath);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, outputPath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function renderOutput(
  result: ExtractionResult,
  options: RenderOptions,
): Promise<{ text?: string; outputPath?: string }> {
  const outputPath = options.outputPath
    ? path.resolve(options.outputPath)
    : undefined;

  if (options.format === "pdf") {
    if (!outputPath) {
      throw new Error(
        "PDF output needs a file destination. Use `-o reading-edition.pdf`.",
      );
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    await renderPdf(result, outputPath, options.includeImages !== false);
    return { outputPath };
  }

  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeTextAtomically(outputPath, result.content);
    return { outputPath };
  }
  return { text: result.content };
}
