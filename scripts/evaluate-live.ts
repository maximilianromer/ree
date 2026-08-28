import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type OutputFormat = "txt" | "md" | "pdf";
type RunStatus = "running" | "success" | "failure";

interface Article {
  id: string;
  title: string;
  url: string;
  category: string;
  reviewerSlot: number;
}

interface Manifest {
  schemaVersion: number;
  benchmarkId: string;
  description: string;
  formats: Array<{ id: OutputFormat; includeImages: boolean }>;
  articles: Article[];
}

interface RubricCriterion {
  id: ScoreKey;
  label: string;
  maximum: number;
  guidance: string;
}

interface Rubric {
  schemaVersion: number;
  maximumScore: number;
  criteria: RubricCriterion[];
  acceptance: {
    minimumMedianPerFormat: number;
    minimumIndividualScore: number;
    txtFormattingViolationsAllowed: number;
    visiblyDefectivePdfsAllowed: number;
    medianRuntimeMs: Record<OutputFormat, number>;
    maximumCaptureAndRenderMs: number;
    maximumModelCallMs: number;
  };
}

type ScoreKey =
  "fidelity" | "selection" | "formatCompliance" | "coherence" | "reliability";

interface ScoreEntry {
  runId: string;
  fidelity: number | null;
  selection: number | null;
  formatCompliance: number | null;
  coherence: number | null;
  reliability: number | null;
  txtFormattingViolation?: boolean | null;
  visiblyDefectivePdf?: boolean | null;
  notes?: string;
}

interface ScoresFile {
  schemaVersion: number;
  benchmarkId: string;
  scores: ScoreEntry[];
}

interface CliMetrics {
  captureMs: number | null;
  modelMs: number | null;
  renderMs: number | null;
  chunkCount: number | null;
  sourceBytes: number | null;
  outputBytes: number | null;
  imageCount: number | null;
}

interface StoredRun extends CliMetrics {
  runId: string;
  articleId: string;
  format: OutputFormat;
  status: RunStatus;
  attempts: number;
  startedAt: string;
  endedAt: string | null;
  totalMs: number | null;
  exitCode: number | null;
  failureCategory: string | null;
  outputRelativePath: string;
}

interface RunState {
  schemaVersion: 1;
  benchmarkId: string;
  updatedAt: string;
  runs: Partial<Record<string, StoredRun>>;
}

interface Options {
  articleIds: string[];
  formats: OutputFormat[];
  artifactRoot: string;
  reeBin: string;
  scoresPath?: string;
  timeoutMs: number;
  limit?: number;
  dryRun: boolean;
  reportOnly: boolean;
  publishReport: boolean;
  force: boolean;
}

interface PlannedRun {
  article: Article;
  format: OutputFormat;
}

interface SpawnResult {
  exitCode: number | null;
  timedOut: boolean;
  spawnError: boolean;
}

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const manifestPath = path.join(repoRoot, "evals", "live-articles.json");
const rubricPath = path.join(repoRoot, "evals", "rubric.json");
const emptyMetrics: CliMetrics = {
  captureMs: null,
  modelMs: null,
  renderMs: null,
  chunkCount: null,
  sourceBytes: null,
  outputBytes: null,
  imageCount: null,
};

function usage(): string {
  return `Usage: tsx scripts/evaluate-live.ts [options]

Runs the 30-output live benchmark sequentially and resumes completed work.

Options:
  --article <id>          Select an article (repeatable)
  --format <txt|md|pdf>   Select a format (repeatable)
  --limit <count>         Run at most this many selected pairs
  --ree-bin <path>        Built REE entrypoint (default: dist/cli.js)
  --artifact-root <path>  Local ignored output root (default: evals/.artifacts)
  --timeout-ms <ms>       Per-process outer timeout (default: 300000)
  --scores <path>         Reviewer score JSON used in reports
  --force                 Repeat successful selected runs
  --report-only           Regenerate reports without invoking REE
  --publish-report        Also write metadata-only reports to evals/reports
  --dry-run               List selected pairs without writing or invoking REE
  --help                   Show this help
`;
}

function optionValue(args: string[], index: number): [string, number] {
  const current = args[index];
  if (!current) throw new Error("Missing option");
  const equals = current.indexOf("=");
  if (equals >= 0) return [current.slice(equals + 1), index];
  const next = args[index + 1];
  if (!next || next.startsWith("--"))
    throw new Error(`Missing value for ${current}`);
  return [next, index + 1];
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    articleIds: [],
    formats: [],
    artifactRoot: path.join(repoRoot, "evals", ".artifacts"),
    reeBin: path.join(repoRoot, "dist", "cli.js"),
    timeoutMs: 300_000,
    dryRun: false,
    reportOnly: false,
    publishReport: false,
    force: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--report-only") options.reportOnly = true;
    else if (argument === "--publish-report") options.publishReport = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--article" || argument.startsWith("--article=")) {
      const [value, consumed] = optionValue(args, index);
      options.articleIds.push(value);
      index = consumed;
    } else if (argument === "--format" || argument.startsWith("--format=")) {
      const [value, consumed] = optionValue(args, index);
      if (value !== "txt" && value !== "md" && value !== "pdf")
        throw new Error(`Unknown format: ${value}`);
      options.formats.push(value);
      index = consumed;
    } else if (argument === "--limit" || argument.startsWith("--limit=")) {
      const [value, consumed] = optionValue(args, index);
      options.limit = parsePositiveInteger(value, "--limit");
      index = consumed;
    } else if (
      argument === "--timeout-ms" ||
      argument.startsWith("--timeout-ms=")
    ) {
      const [value, consumed] = optionValue(args, index);
      options.timeoutMs = parsePositiveInteger(value, "--timeout-ms");
      index = consumed;
    } else if (
      argument === "--artifact-root" ||
      argument.startsWith("--artifact-root=")
    ) {
      const [value, consumed] = optionValue(args, index);
      options.artifactRoot = path.resolve(value);
      index = consumed;
    } else if (argument === "--ree-bin" || argument.startsWith("--ree-bin=")) {
      const [value, consumed] = optionValue(args, index);
      options.reeBin = path.resolve(value);
      index = consumed;
    } else if (argument === "--scores" || argument.startsWith("--scores=")) {
      const [value, consumed] = optionValue(args, index);
      options.scoresPath = path.resolve(value);
      index = consumed;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readJsonIfPresent<T>(filePath: string): Promise<T | undefined> {
  try {
    return await readJson<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function planRuns(manifest: Manifest, options: Options): PlannedRun[] {
  const knownIds = new Set(manifest.articles.map((article) => article.id));
  for (const requested of options.articleIds) {
    if (!knownIds.has(requested))
      throw new Error(`Unknown article ID: ${requested}`);
  }
  const articles = options.articleIds.length
    ? manifest.articles.filter((article) =>
        options.articleIds.includes(article.id),
      )
    : manifest.articles;
  const formats = options.formats.length
    ? options.formats
    : manifest.formats.map((format) => format.id);
  const runs = articles.flatMap((article) =>
    formats.map((format) => ({ article, format })),
  );
  return options.limit ? runs.slice(0, options.limit) : runs;
}

function runIdFor(run: PlannedRun): string {
  return `${run.article.id}:${run.format}`;
}

function cleanNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function normalizeMetrics(value: Partial<CliMetrics> | undefined): CliMetrics {
  return {
    captureMs: cleanNumber(value?.captureMs),
    modelMs: cleanNumber(value?.modelMs),
    renderMs: cleanNumber(value?.renderMs),
    chunkCount: cleanNumber(value?.chunkCount),
    sourceBytes: cleanNumber(value?.sourceBytes),
    outputBytes: cleanNumber(value?.outputBytes),
    imageCount: cleanNumber(value?.imageCount),
  };
}

function commandFor(
  reeBin: string,
  reeArguments: string[],
): {
  command: string;
  args: string[];
} {
  return /\.[cm]?js$/i.test(reeBin)
    ? { command: process.execPath, args: [reeBin, ...reeArguments] }
    : { command: reeBin, args: reeArguments };
}

async function spawnRee(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  stdoutPath: string,
  stderrPath: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  return await new Promise((resolve) => {
    const stdout = createWriteStream(stdoutPath, { flags: "w", mode: 0o600 });
    const stderr = createWriteStream(stderrPath, { flags: "w", mode: 0o600 });
    const child = spawn(command, args, {
      cwd: repoRoot,
      detached: process.platform !== "win32",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    let timedOut = false;
    let spawnError = false;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process group may already have exited; fall back to the child.
        }
      }
      child.kill(signal);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      killTimer = setTimeout(() => terminate("SIGKILL"), 5_000);
    }, timeoutMs);
    child.once("error", () => {
      spawnError = true;
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      stdout.end();
      stderr.end();
      resolve({ exitCode, timedOut, spawnError });
    });
  });
}

async function runOne(
  planned: PlannedRun,
  options: Options,
  state: RunState,
  statePath: string,
): Promise<StoredRun> {
  const runId = runIdFor(planned);
  const runDirectory = path.join(
    options.artifactRoot,
    "runs",
    planned.article.id,
    planned.format,
  );
  const outputPath = path.join(runDirectory, `output.${planned.format}`);
  const metricsPath = path.join(runDirectory, "metrics.json");
  const stdoutPath = path.join(runDirectory, "stdout.log");
  const stderrPath = path.join(runDirectory, "stderr.log");
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  for (const stalePath of [outputPath, metricsPath, stdoutPath, stderrPath])
    await rm(stalePath, { force: true });

  const previous = state.runs[runId];
  const startedAt = new Date().toISOString();
  const running: StoredRun = {
    ...emptyMetrics,
    runId,
    articleId: planned.article.id,
    format: planned.format,
    status: "running",
    attempts: (previous?.attempts ?? 0) + 1,
    startedAt,
    endedAt: null,
    totalMs: null,
    exitCode: null,
    failureCategory: null,
    outputRelativePath: path.relative(repoRoot, outputPath),
  };
  state.runs[runId] = running;
  state.updatedAt = startedAt;
  await writeJsonAtomic(statePath, state);

  const reeArguments = [
    planned.article.url,
    "--format",
    planned.format,
    "--output",
    outputPath,
    "--quiet",
  ];
  const invocation = commandFor(options.reeBin, reeArguments);
  await writeJsonAtomic(path.join(runDirectory, "invocation.json"), {
    invokedAt: startedAt,
    command: path.relative(repoRoot, invocation.command),
    args: invocation.args.map((argument) =>
      argument === outputPath ? path.relative(repoRoot, outputPath) : argument,
    ),
    timeoutMs: options.timeoutMs,
  });

  const start = performance.now();
  const result = await spawnRee(
    invocation.command,
    invocation.args,
    { ...process.env, REE_EVAL_METRICS_PATH: metricsPath },
    stdoutPath,
    stderrPath,
    options.timeoutMs,
  );
  const totalMs = Math.round(performance.now() - start);
  const sidecar = await readJsonIfPresent<Partial<CliMetrics>>(metricsPath);
  const metrics = normalizeMetrics(sidecar);
  let outputSize: number | null = null;
  try {
    outputSize = (await stat(outputPath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let failureCategory: string | null = null;
  if (result.timedOut) failureCategory = "outer_timeout";
  else if (result.spawnError) failureCategory = "spawn_error";
  else if (result.exitCode !== 0)
    failureCategory = `process_exit_${result.exitCode ?? "unknown"}`;
  else if (outputSize === null) failureCategory = "missing_output";
  else if (outputSize === 0) failureCategory = "empty_output";

  const endedAt = new Date().toISOString();
  const completed: StoredRun = {
    ...running,
    ...metrics,
    outputBytes: metrics.outputBytes ?? outputSize,
    status: failureCategory ? "failure" : "success",
    endedAt,
    totalMs,
    exitCode: result.exitCode,
    failureCategory,
  };
  state.runs[runId] = completed;
  state.updatedAt = endedAt;
  await writeJsonAtomic(statePath, state);
  return completed;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const upper = sorted[midpoint];
  if (upper === undefined) return null;
  if (sorted.length % 2) return upper;
  const lower = sorted[midpoint - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

function scoreTotal(
  entry: ScoreEntry | undefined,
  rubric: Rubric,
): number | null {
  if (!entry) return null;
  let total = 0;
  for (const criterion of rubric.criteria) {
    const score = entry[criterion.id];
    if (typeof score !== "number") return null;
    if (score < 0 || score > criterion.maximum)
      throw new Error(
        `${entry.runId}: ${criterion.id} must be between 0 and ${criterion.maximum}`,
      );
    total += score;
  }
  return total;
}

function escapeCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function reportMarkdown(report: Record<string, unknown>): string {
  const summary = report.summary as Record<string, unknown>;
  const runs = report.runs as Array<Record<string, unknown>>;
  const acceptance = report.acceptance as Record<string, unknown>;
  const rows = runs
    .map(
      (run) =>
        `| ${escapeCell(run.articleId)} | ${escapeCell(run.format)} | ${escapeCell(run.status)} | ${escapeCell(run.totalMs)} | ${escapeCell(run.captureMs)} | ${escapeCell(run.modelMs)} | ${escapeCell(run.renderMs)} | ${escapeCell(run.score)} | ${escapeCell(run.failureCategory)} | ${escapeCell(run.notes)} |`,
    )
    .join("\n");
  return `# REE live benchmark report

Generated: ${String(report.generatedAt)}

This report contains metadata and scores only. Extracted article bodies, images, PDFs, screenshots, and raw logs remain in the ignored local artifact directory.

## Summary

- Benchmark: ${String(report.benchmarkId)}
- Overall status: ${String(acceptance.status)}
- Planned runs: ${String(summary.plannedRuns)}
- Successful: ${String(summary.successfulRuns)}
- Failed: ${String(summary.failedRuns)}
- Not run: ${String(summary.notRun)}
- Scored: ${String(summary.scoredRuns)}
- Runs missing phase timing telemetry: ${String(summary.missingPhaseTelemetry)}

## Runs

<!-- prettier-ignore -->
| Article | Format | Status | Total ms | Capture ms | Model ms | Render ms | Score | Failure | Reviewer note |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
${rows}

## Acceptance

\`status\` remains \`incomplete\` until all 30 runs and scores exist. Machine-readable criteria and per-format medians are in the adjacent JSON report.
`;
}

async function generateReport(
  manifest: Manifest,
  rubric: Rubric,
  state: RunState,
  scores: ScoresFile | undefined,
  options: Options,
): Promise<void> {
  if (scores && scores.benchmarkId !== manifest.benchmarkId)
    throw new Error("Scores benchmarkId does not match the manifest");
  const allPlanned = planRuns(manifest, {
    ...options,
    articleIds: [],
    formats: [],
    limit: undefined,
  });
  const knownRunIds = new Set(allPlanned.map(runIdFor));
  const scoreMap = new Map<string, ScoreEntry>();
  for (const score of scores?.scores ?? []) {
    if (!knownRunIds.has(score.runId))
      throw new Error(`Unknown score runId: ${score.runId}`);
    if (scoreMap.has(score.runId))
      throw new Error(`Duplicate score runId: ${score.runId}`);
    if ((score.notes?.length ?? 0) > 500)
      throw new Error(
        `${score.runId}: reviewer notes must be 500 characters or less`,
      );
    scoreMap.set(score.runId, score);
  }
  const runs = allPlanned.map((planned) => {
    const runId = runIdFor(planned);
    const stored = state.runs[runId];
    const scoreEntry = scoreMap.get(runId);
    return {
      runId,
      articleId: planned.article.id,
      articleTitle: planned.article.title,
      sourceUrl: planned.article.url,
      category: planned.article.category,
      reviewerSlot: planned.article.reviewerSlot,
      format: planned.format,
      status: stored?.status ?? "not_run",
      attempts: stored?.attempts ?? 0,
      captureMs: stored?.captureMs ?? null,
      modelMs: stored?.modelMs ?? null,
      renderMs: stored?.renderMs ?? null,
      totalMs: stored?.totalMs ?? null,
      chunkCount: stored?.chunkCount ?? null,
      sourceBytes: stored?.sourceBytes ?? null,
      outputBytes: stored?.outputBytes ?? null,
      imageCount: stored?.imageCount ?? null,
      failureCategory: stored?.failureCategory ?? null,
      score: scoreTotal(scoreEntry, rubric),
      txtFormattingViolation: scoreEntry?.txtFormattingViolation ?? null,
      visiblyDefectivePdf: scoreEntry?.visiblyDefectivePdf ?? null,
      notes: scoreEntry?.notes?.trim() ?? "",
    };
  });
  const successful = runs.filter((run) => run.status === "success");
  const scored = runs.filter((run) => run.score !== null);
  const summarizeFormat = (format: OutputFormat) => {
    const formatRuns = runs.filter((run) => run.format === format);
    return {
      successfulRuns: formatRuns.filter((run) => run.status === "success")
        .length,
      medianTotalMs: median(
        formatRuns.flatMap((run) =>
          run.status === "success" && run.totalMs !== null ? [run.totalMs] : [],
        ),
      ),
      medianScore: median(
        formatRuns.flatMap((run) => (run.score === null ? [] : [run.score])),
      ),
    };
  };
  const formatSummary = {
    txt: summarizeFormat("txt"),
    md: summarizeFormat("md"),
    pdf: summarizeFormat("pdf"),
  } satisfies Record<
    OutputFormat,
    {
      successfulRuns: number;
      medianTotalMs: number | null;
      medianScore: number | null;
    }
  >;
  const terminalRuns = runs.filter(
    (run) => run.status === "success" || run.status === "failure",
  );
  const complete =
    terminalRuns.length === runs.length && scored.length === runs.length;
  const allRunsSucceeded = successful.length === runs.length;
  const scoreMediansPass = (["txt", "md", "pdf"] as const).every((format) => {
    const value = formatSummary[format].medianScore;
    return value !== null && value >= rubric.acceptance.minimumMedianPerFormat;
  });
  const minimumScorePass = scored.every(
    (run) =>
      run.score !== null &&
      run.score >= rubric.acceptance.minimumIndividualScore,
  );
  const txtViolations = runs.filter(
    (run) => run.format === "txt" && run.txtFormattingViolation === true,
  ).length;
  const defectivePdfs = runs.filter(
    (run) => run.format === "pdf" && run.visiblyDefectivePdf === true,
  ).length;
  const runtimePass = (["txt", "md", "pdf"] as const).every((format) => {
    const value = formatSummary[format].medianTotalMs;
    return value !== null && value <= rubric.acceptance.medianRuntimeMs[format];
  });
  const captureRenderPass = successful.every((run) =>
    run.captureMs === null || run.renderMs === null
      ? false
      : run.captureMs + run.renderMs <=
        rubric.acceptance.maximumCaptureAndRenderMs,
  );
  const modelTimePass = successful.every(
    (run) =>
      run.modelMs !== null &&
      run.modelMs <= rubric.acceptance.maximumModelCallMs,
  );
  const pass =
    complete &&
    allRunsSucceeded &&
    scoreMediansPass &&
    minimumScorePass &&
    txtViolations <= rubric.acceptance.txtFormattingViolationsAllowed &&
    defectivePdfs <= rubric.acceptance.visiblyDefectivePdfsAllowed &&
    runtimePass &&
    captureRenderPass &&
    modelTimePass;
  const report = {
    schemaVersion: 1,
    benchmarkId: manifest.benchmarkId,
    generatedAt: new Date().toISOString(),
    artifactPolicy: "evals/ARTIFACT_POLICY.md",
    summary: {
      plannedRuns: runs.length,
      successfulRuns: successful.length,
      failedRuns: runs.filter((run) => run.status === "failure").length,
      notRun: runs.filter(
        (run) => run.status === "not_run" || run.status === "running",
      ).length,
      scoredRuns: scored.length,
      missingPhaseTelemetry: successful.filter(
        (run) =>
          run.captureMs === null ||
          run.modelMs === null ||
          run.renderMs === null,
      ).length,
      byFormat: formatSummary,
    },
    acceptance: {
      status: complete ? (pass ? "pass" : "fail") : "incomplete",
      allRunsSucceeded: complete ? allRunsSucceeded : null,
      scoreMediansPass: complete ? scoreMediansPass : null,
      minimumScorePass: complete ? minimumScorePass : null,
      txtFormattingViolations: txtViolations,
      defectivePdfs,
      runtimePass: complete ? runtimePass : null,
      captureRenderPass: complete ? captureRenderPass : null,
      modelTimePass: complete ? modelTimePass : null,
    },
    runs,
  };
  const localReportDirectory = path.join(options.artifactRoot, "reports");
  await writeJsonAtomic(path.join(localReportDirectory, "latest.json"), report);
  await mkdir(localReportDirectory, { recursive: true });
  await writeFile(
    path.join(localReportDirectory, "latest.md"),
    reportMarkdown(report),
    "utf8",
  );
  if (options.publishReport) {
    const publishDirectory = path.join(repoRoot, "evals", "reports");
    await writeJsonAtomic(
      path.join(publishDirectory, "live-report.json"),
      report,
    );
    await writeFile(
      path.join(publishDirectory, "live-report.md"),
      reportMarkdown(report),
      "utf8",
    );
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const manifest = await readJson<Manifest>(manifestPath);
  const rubric = await readJson<Rubric>(rubricPath);
  const selected = planRuns(manifest, options);
  if (options.dryRun) {
    for (const planned of selected)
      process.stdout.write(`${runIdFor(planned)} ${planned.article.url}\n`);
    process.stdout.write(
      `${selected.length} run(s) selected; no files written.\n`,
    );
    return;
  }

  await mkdir(options.artifactRoot, { recursive: true, mode: 0o700 });
  const statePath = path.join(options.artifactRoot, "state.json");
  const state =
    (await readJsonIfPresent<RunState>(statePath)) ??
    ({
      schemaVersion: 1,
      benchmarkId: manifest.benchmarkId,
      updatedAt: new Date().toISOString(),
      runs: {},
    } satisfies RunState);
  if (state.benchmarkId !== manifest.benchmarkId)
    throw new Error("Existing state benchmarkId does not match the manifest");

  let failures = 0;
  if (!options.reportOnly) {
    for (const [index, planned] of selected.entries()) {
      const runId = runIdFor(planned);
      const existing = state.runs[runId];
      const existingOutput = existing
        ? path.resolve(repoRoot, existing.outputRelativePath)
        : undefined;
      let outputExists = false;
      if (existingOutput) {
        try {
          outputExists = (await stat(existingOutput)).size > 0;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (!options.force && existing?.status === "success" && outputExists) {
        process.stdout.write(
          `[${index + 1}/${selected.length}] skip ${runId}\n`,
        );
        continue;
      }
      process.stdout.write(`[${index + 1}/${selected.length}] run ${runId}\n`);
      const completed = await runOne(planned, options, state, statePath);
      if (completed.status === "failure") {
        failures += 1;
        process.stderr.write(`${runId}: ${completed.failureCategory}\n`);
      } else {
        process.stdout.write(`${runId}: ${completed.totalMs} ms\n`);
      }
    }
  }

  const scores = options.scoresPath
    ? await readJson<ScoresFile>(options.scoresPath)
    : undefined;
  await generateReport(manifest, rubric, state, scores, options);
  process.stdout.write(
    `Metadata report: ${path.relative(repoRoot, path.join(options.artifactRoot, "reports", "latest.md"))}\n`,
  );
  if (options.publishReport)
    process.stdout.write(
      "Published metadata report: evals/reports/live-report.md\n",
    );
  if (failures) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Live evaluation error: ${message}\n`);
  process.exitCode = 1;
}
