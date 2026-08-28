#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { stat, writeFile } from "node:fs/promises";
import chalk from "chalk";
import { Command, Option } from "commander";
import { gatherEvidence } from "./adapters/index.js";
import type { ProgressEvent } from "./core/types.js";
import { resolveRememberedModel } from "./core/settings.js";
import { runDoctor } from "./doctor.js";
import { CodexExtractionAdapter, DEFAULT_MODEL } from "./model/codex.js";
import { setupNativeMessaging, DEFAULT_EXTENSION_ID } from "./native/setup.js";
import { extractEvidence } from "./pipeline/extract.js";
import { renderOutput, type OutputFormat } from "./renderers/index.js";

interface CliOptions {
  format?: string;
  output?: string;
  fast: boolean;
  images: boolean;
  model?: string;
  customInstructions?: string;
  verbose: boolean;
  quiet: boolean;
}

function normalizeCustomInstructions(value: string | undefined): string {
  const instructions = (value ?? "").trim();
  if (instructions.length > 4_000)
    throw new Error("Custom instructions must be 4,000 characters or fewer.");
  return instructions;
}

function normalizeFormat(value: string | undefined): OutputFormat {
  const selected = (value || "md").toLowerCase();
  if (selected === "md" || selected === "txt" || selected === "pdf")
    return selected;
  throw new Error(`Unknown output format: ${selected}. Use txt, md, or pdf.`);
}

function progressReporter(options: Pick<CliOptions, "quiet" | "verbose">) {
  let previous = "";
  return (event: ProgressEvent) => {
    if (options.quiet) return;
    const detail = event.total ? ` (${event.current ?? 0}/${event.total})` : "";
    const line = `${event.message}${detail}`;
    if (line === previous && !options.verbose) return;
    previous = line;
    process.stderr.write(`${chalk.dim("ree")} ${line}\n`);
  };
}

function inferPdfPath(sources: string[]): string {
  if (sources.length > 1) return path.resolve("gallery-ree.pdf");
  const source = sources[0]!;
  if (source === "-") return path.resolve("stdin-ree.pdf");
  if (/^https?:\/\//i.test(source)) {
    const host = new URL(source).hostname.replace(/^www\./, "");
    return path.resolve(`${host}-ree.pdf`);
  }
  const parsed = path.parse(source);
  return path.join(parsed.dir || ".", `${parsed.name || "document"}-ree.pdf`);
}

async function extractCommand(
  sources: string[],
  options: CliOptions,
): Promise<void> {
  if (sources.length === 0)
    throw new Error(
      "Provide a webpage URL, an HTML/PDF/image path, an image directory, or - for HTML on stdin. Run `ree --help` for examples.",
    );
  const customInstructions = normalizeCustomInstructions(
    options.customInstructions,
  );
  const model = await resolveRememberedModel(options.model);
  const format = normalizeFormat(options.format);
  const includeImages = format === "pdf" && options.images;
  const reporter = progressReporter(options);
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt);
  let evidence: Awaited<ReturnType<typeof gatherEvidence>> | undefined;
  const startedAt = performance.now();
  let captureFinishedAt = startedAt;
  let modelFinishedAt = startedAt;
  try {
    reporter({ stage: "preparing", message: "Preparing source" });
    evidence = await gatherEvidence(sources, reporter, {
      includeImages,
    });
    captureFinishedAt = performance.now();
    const extraction = await extractEvidence(
      evidence,
      new CodexExtractionAdapter(),
      {
        format,
        includeImages,
        fast: options.fast,
        model,
        customInstructions,
        concurrency: 2,
        progress: reporter,
        signal: abort.signal,
      },
    );
    modelFinishedAt = performance.now();
    const outputPath =
      options.output || (format === "pdf" ? inferPdfPath(sources) : undefined);
    reporter({
      stage: "rendering",
      message: `Rendering ${format.toUpperCase()}`,
    });
    const result = await renderOutput(extraction, {
      format,
      outputPath,
      includeImages,
    });
    const renderFinishedAt = performance.now();
    const metricsPath = process.env.REE_EVAL_METRICS_PATH;
    if (metricsPath) {
      const outputBytes = result.outputPath
        ? (await stat(result.outputPath)).size
        : Buffer.byteLength(extraction.content, "utf8");
      await writeFile(
        path.resolve(metricsPath),
        `${JSON.stringify({
          captureMs: Math.round(captureFinishedAt - startedAt),
          modelMs: Math.round(modelFinishedAt - captureFinishedAt),
          renderMs: Math.round(renderFinishedAt - modelFinishedAt),
          chunkCount: extraction.chunkCount,
          sourceBytes: evidence.sections.reduce(
            (total, section) =>
              total + Buffer.byteLength(section.content, "utf8"),
            0,
          ),
          outputBytes,
          imageCount: evidence.source.imageCount ?? evidence.assets.length,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
    if (result.text !== undefined) process.stdout.write(result.text);
    else if (result.outputPath && !options.quiet)
      process.stderr.write(`${chalk.green("Saved")} ${result.outputPath}\n`);
  } finally {
    process.removeListener("SIGINT", interrupt);
    await evidence?.cleanup();
  }
}

const program = new Command();
program
  .name("ree")
  .description(
    "Extract the body a human actually meant to read through your existing Codex login.",
  )
  .version("1.0.0")
  .argument(
    "[sources...]",
    "webpage URL, local HTML/PDF/image, image directory, or - for HTML on stdin",
  )
  .addOption(
    new Option("-f, --format <format>", "output: txt, md, or pdf").default(
      "md",
    ),
  )
  .option(
    "-o, --output <path>",
    "write output to a file (text formats otherwise use stdout)",
  )
  .option(
    "--fast",
    "use Codex Fast inference when supported (higher credit cost)",
    false,
  )
  .option(
    "--model <slug>",
    `Codex model slug to use and remember (initial default: ${DEFAULT_MODEL})`,
  )
  .option(
    "--custom-instructions <text>",
    "special instructions for this generation (maximum 4,000 characters)",
  )
  .option("--no-images", "omit images from PDF output")
  .option("--verbose", "show additional progress information", false)
  .option("-q, --quiet", "suppress progress on stderr", false)
  .addHelpText(
    "after",
    `\nExamples:\n  ree article.pdf > article.md\n  ree article.html --format txt -o article.txt\n  ree page.jpg --format txt -o page.txt\n  ree book-photos --format md -o book.md\n  ree page-1.jpg page-2.jpg --format txt -o pages.txt\n  ree article.pdf --custom-instructions "Keep the appendix and footnotes" > article.md\n  ree https://example.com/article --fast -o article.md\n  ree https://example.com/article --format pdf\n  ree paper.pdf --format pdf --no-images -o paper-text-only.pdf\n  cat page.html | ree -\n\nA directory is an image gallery ordered naturally by filename; multiple image paths keep argument order. Supported images are JPEG, PNG, WebP, and GIF. TXT and Markdown use stdout unless -o is supplied. PDF output infers a destination when -o is omitted. PDF images are included by default; use --no-images to omit them. Custom instructions apply only to the current generation.\n\nREE never asks for an API key. It invokes the selected model through the local authenticated Codex CLI. The initial default is ${chalk.bold(DEFAULT_MODEL)}; an explicit --model value is remembered for later runs.`,
  )
  .action(extractCommand);

program
  .command("doctor")
  .description("diagnose Codex, browser, and extension integration")
  .action(async () => {
    const checks = await runDoctor();
    for (const check of checks) {
      const marker = check.ok
        ? chalk.green("✓")
        : check.required
          ? chalk.red("✗")
          : chalk.yellow("○");
      process.stdout.write(`${marker} ${check.name}: ${check.detail}\n`);
    }
    if (checks.some((check) => check.required && !check.ok))
      process.exitCode = 3;
  });

program
  .command("setup-extension")
  .description(
    "register the local native-messaging bridge for Chromium browsers",
  )
  .option(
    "--extension-id <id>",
    "override the bundled extension ID",
    DEFAULT_EXTENSION_ID,
  )
  .option("--dry-run", "show registration targets without writing them", false)
  .action(async (options: { extensionId: string; dryRun: boolean }) => {
    const results = await setupNativeMessaging(
      options.extensionId,
      options.dryRun,
    );
    for (const result of results)
      process.stdout.write(
        `${options.dryRun ? "Would register" : "Registered"} ${result.browser}: ${result.manifestPath}\n`,
      );
    if (!options.dryRun)
      process.stdout.write(
        "Reload REE on chrome://extensions or edge://extensions, then click Extract.\n",
      );
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${chalk.red("REE error:")} ${message}\n`);
  process.exitCode = /cancelled/i.test(message)
    ? 130
    : /Codex|Luna|model|authenticated/i.test(message)
      ? 3
      : /Unsupported|Unknown output|Provide a webpage URL|Image gallery|must be images/i.test(
            message,
          )
        ? 2
        : process.exitCode || 1;
}
