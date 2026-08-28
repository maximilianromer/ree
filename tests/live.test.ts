import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const live = process.env.REE_LIVE_TESTS === "1";

async function runCli(args: string[]): Promise<string> {
  const child = spawn(process.execPath, ["dist/cli.js", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(stderr || `REE exited with ${code}`);
  return stdout;
}

async function temporaryDirectory<T>(
  work: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ree-live-test-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe.skipIf(!live)("live direct Luna extraction", () => {
  it(
    "extracts scan-only and multicolumn PDFs directly to TXT",
    async () => {
      const scan = await runCli([
        "fixtures/generated/scanned-no-text.pdf",
        "--format",
        "txt",
        "--quiet",
      ]);
      expect(scan).toContain("lantern remained visible through the ash");
      expect(scan).not.toMatch(/[[\]#*_>`]/);

      const columns = await runCli([
        "fixtures/generated/multi-column.pdf",
        "--format",
        "txt",
        "--quiet",
      ]);
      expect(
        columns.indexOf("first survey began at dawn"),
      ).toBeGreaterThanOrEqual(0);
      expect(
        columns.indexOf("comparison survey began at noon"),
      ).toBeGreaterThan(columns.indexOf("first survey began at dawn"));
    },
    10 * 60_000,
  );

  it(
    "removes page furniture while preserving Markdown structure",
    async () => {
      const markdown = await runCli([
        "fixtures/noisy-article.html",
        "--format",
        "md",
        "--quiet",
      ]);
      expect(markdown).toContain("Signals Beneath the Salt");
      expect(markdown).toContain("eighty-one seconds");
      expect(markdown).not.toContain("MIRACLE PAN");
      expect(markdown).not.toContain("Accept all cookies");
    },
    10 * 60_000,
  );

  it(
    "creates a searchable PDF direct edition",
    async () => {
      await temporaryDirectory(async (directory) => {
        const output = path.join(directory, "reading-edition.pdf");
        await runCli([
          "fixtures/generated/figure-bearing.pdf",
          "--format",
          "pdf",
          "-o",
          output,
          "--quiet",
        ]);
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const loadingTask = pdfjs.getDocument({
          data: new Uint8Array(await readFile(output)),
        });
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ");
        expect(text).toContain("The Falling Signal");
        expect(text).toContain("clear decline");
        await loadingTask.destroy();
      });
    },
    10 * 60_000,
  );

  it(
    "preserves all ordered records across direct chunks without a merge call",
    async () => {
      const text = await runCli([
        "fixtures/generated/long-document.html",
        "--format",
        "txt",
        "--quiet",
      ]);
      const observations = [...text.matchAll(/Sequence (\d{4}):/g)].map(
        (match) => match[1],
      );
      expect(observations).toHaveLength(900);
      expect(new Set(observations).size).toBe(900);
      expect(observations).toEqual(
        Array.from({ length: 900 }, (_, index) =>
          String(index + 1).padStart(4, "0"),
        ),
      );
    },
    15 * 60_000,
  );
});
