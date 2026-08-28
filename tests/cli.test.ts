import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrivateTempDir } from "../src/core/temp.js";
import { isSupportedNodeVersion } from "../src/doctor.js";
import {
  codexModelArgs,
  codexServiceTierArgs,
  DEFAULT_MODEL,
  normalizeModelSlug,
  resolveCodexCommand,
} from "../src/model/codex.js";

const cliPath = path.resolve("dist/cli.js");
const htmlFixture = path.resolve("fixtures/clean-article.html");
let fixtureDirectory = "";
let fakeCodexPath = "";

it("enforces the Node.js version required by runtime dependencies", () => {
  expect(isSupportedNodeVersion("20.19.5")).toBe(false);
  expect(isSupportedNodeVersion("22.12.99")).toBe(false);
  expect(isSupportedNodeVersion("22.13.0")).toBe(true);
  expect(isSupportedNodeVersion("23.0.0")).toBe(true);
});

function runCli(
  args: string[],
  options: {
    input?: string;
    useFakeCodex?: boolean;
    settingsDirectory?: string;
    codexArgsPath?: string;
  } = {},
) {
  const env = {
    ...process.env,
    REE_SETTINGS_DIR:
      options.settingsDirectory || path.join(fixtureDirectory, "settings"),
    ...(options.useFakeCodex ? { REE_CODEX_PATH: fakeCodexPath } : {}),
    ...(options.codexArgsPath
      ? { REE_TEST_CODEX_ARGS_PATH: options.codexArgsPath }
      : {}),
  };
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    input: options.input,
    env,
  });
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "ree-cli-test-"));
  const fakeCodexEntrypoint =
    process.platform === "win32"
      ? path.join(
          fixtureDirectory,
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        )
      : path.join(fixtureDirectory, "fake-codex.cjs");
  fakeCodexPath =
    process.platform === "win32"
      ? path.join(fixtureDirectory, "codex.cmd")
      : fakeCodexEntrypoint;
  await mkdir(path.dirname(fakeCodexEntrypoint), { recursive: true });
  if (process.platform === "win32") {
    await writeFile(fakeCodexPath, "@echo off\r\n");
  }
  await writeFile(
    fakeCodexEntrypoint,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli fixture 1.0\\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Logged in with deterministic fixture\\n");
  process.exit(0);
}
if (args[0] === "features" && args[1] === "list") {
  process.stdout.write("fast_mode stable true\\n");
  process.exit(0);
}
if (!args.includes("app-server") || !args.includes("--stdio")) {
  process.stderr.write("expected app-server stdio mode\\n");
  process.exit(2);
}
const requests = [];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const record = () => {
  if (process.env.REE_TEST_CODEX_ARGS_PATH) {
    fs.writeFileSync(
      process.env.REE_TEST_CODEX_ARGS_PATH,
      JSON.stringify({ args, requests }),
      "utf8",
    );
  }
};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\\n")) {
    const end = input.indexOf("\\n");
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    requests.push(message);
    record();
    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "ree-fixture" } });
    } else if (message.method === "thread/start") {
      send({
        id: message.id,
        result: { thread: { id: "fixture-thread", ephemeral: true } },
      });
    } else if (message.method === "turn/start") {
      const prompt = message.params.input.find((item) => item.type === "text").text;
      const content = prompt.includes("OUTPUT FORMAT: TXT")
        ? "Deterministic plain text edition.\\n"
        : "# Deterministic Markdown edition\\n\\n[Source](https://example.com).\\n";
      send({
        id: message.id,
        result: {
          turn: { id: "fixture-turn", status: "inProgress", items: [] },
        },
      });
      send({
        method: "item/started",
        params: {
          threadId: "fixture-thread",
          turnId: "fixture-turn",
          item: { id: "reasoning-1", type: "reasoning", summary: [] },
        },
      });
      send({
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: "fixture-thread",
          turnId: "fixture-turn",
          itemId: "reasoning-1",
          summaryIndex: 0,
          delta: "Finding the article body.",
        },
      });
      send({
        method: "item/started",
        params: {
          threadId: "fixture-thread",
          turnId: "fixture-turn",
          item: {
            id: "answer-1",
            type: "agentMessage",
            text: "",
            phase: "final_answer",
          },
        },
      });
      const middle = Math.floor(content.length / 2);
      for (const delta of [content.slice(0, middle), content.slice(middle)]) {
        send({
          method: "item/agentMessage/delta",
          params: {
            threadId: "fixture-thread",
            turnId: "fixture-turn",
            itemId: "answer-1",
            delta,
          },
        });
      }
      send({
        method: "item/completed",
        params: {
          threadId: "fixture-thread",
          turnId: "fixture-turn",
          item: {
            id: "answer-1",
            type: "agentMessage",
            text: content,
            phase: "final_answer",
          },
        },
      });
      send({
        method: "turn/completed",
        params: {
          threadId: "fixture-thread",
          turn: { id: "fixture-turn", status: "completed", items: [] },
        },
      });
    }
  }
});
`,
    { encoding: "utf8", mode: 0o700 },
  );
  if (process.platform !== "win32") {
    await chmod(fakeCodexEntrypoint, 0o700);
  }
});

afterAll(async () => {
  if (fixtureDirectory)
    await rm(fixtureDirectory, { recursive: true, force: true });
});

describe("CLI UX", () => {
  it("documents the three direct formats, Markdown default, and current sources", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("output: txt, md, or pdf");
    expect(result.stdout).toMatch(/--format <format>[\s\S]*default: "md"/);
    expect(result.stdout).toMatch(
      /webpage URL, local HTML\/PDF\/image, image\s+directory/,
    );
    expect(result.stdout).toContain("ree article.pdf > article.md");
    expect(result.stdout).toContain("ree article.html --format txt");
    expect(result.stdout).toContain("--format pdf");
    expect(result.stdout).toContain("ree page.jpg --format txt");
    expect(result.stdout).toContain("ree book-photos --format md");
    expect(result.stdout).toContain("ree page-1.jpg page-2.jpg");
    expect(result.stdout).toContain(
      "A directory is an image gallery ordered naturally by filename",
    );
    expect(result.stdout).toContain("JPEG, PNG, WebP, and GIF");
    expect(result.stdout).toContain("--no-images");
    expect(result.stdout).toContain("PDF images are included by default");
    expect(result.stdout).toContain("--fast");
    expect(result.stdout).toContain("--model <slug>");
    expect(result.stdout).toContain("--custom-instructions <text>");
    expect(result.stdout).toContain(
      'ree article.pdf --custom-instructions "Keep the appendix and footnotes"',
    );
    expect(result.stdout).toContain(
      "Custom instructions apply only to the current generation",
    );
    expect(result.stdout).toContain(DEFAULT_MODEL);
    expect(result.stdout).toContain("never asks for an API key");
    expect(result.stdout).toContain("setup-extension");
  });

  it("passes a single image and ordered image galleries to Codex as visual evidence", async () => {
    const sourceImage = path.resolve("fixtures/generated/standalone-scan.png");
    const singleArgsPath = path.join(
      fixtureDirectory,
      "single-image-args.json",
    );
    const single = runCli([sourceImage, "--format", "txt", "--quiet"], {
      useFakeCodex: true,
      codexArgsPath: singleArgsPath,
    });
    expect(single.status, single.stderr).toBe(0);
    const singleInvocation = JSON.parse(
      await readFile(singleArgsPath, "utf8"),
    ) as {
      requests: Array<{
        method?: string;
        params?: {
          input?: Array<{ type?: string; text?: string; path?: string }>;
        };
      }>;
    };
    const singleInput = singleInvocation.requests.find(
      (request) => request.method === "turn/start",
    )?.params?.input;
    expect(
      singleInput?.filter((item) => item.type === "localImage"),
    ).toHaveLength(1);
    expect(singleInput?.find((item) => item.type === "text")?.text).toContain(
      '"kind":"image"',
    );

    const galleryDirectory = path.join(fixtureDirectory, "book-photos");
    await mkdir(galleryDirectory);
    const page2 = path.join(galleryDirectory, "page-2.png");
    const page10 = path.join(galleryDirectory, "page-10.png");
    await copyFile(sourceImage, page2);
    await copyFile(sourceImage, page10);
    const galleryArgsPath = path.join(fixtureDirectory, "gallery-args.json");
    const gallery = runCli([galleryDirectory, "--format", "txt", "--quiet"], {
      useFakeCodex: true,
      codexArgsPath: galleryArgsPath,
    });
    expect(gallery.status, gallery.stderr).toBe(0);
    const galleryInvocation = JSON.parse(
      await readFile(galleryArgsPath, "utf8"),
    ) as typeof singleInvocation;
    const galleryInput = galleryInvocation.requests.find(
      (request) => request.method === "turn/start",
    )?.params?.input;
    expect(
      galleryInput?.filter((item) => item.type === "localImage"),
    ).toHaveLength(2);
    const galleryPrompt = galleryInput?.find(
      (item) => item.type === "text",
    )?.text;
    expect(galleryPrompt).toContain('"kind":"image-gallery"');
    expect(galleryPrompt!.indexOf("page-2.png")).toBeLessThan(
      galleryPrompt!.indexOf("page-10.png"),
    );

    const explicitArgsPath = path.join(
      fixtureDirectory,
      "explicit-gallery-args.json",
    );
    const explicit = runCli([page10, page2, "--format", "txt", "--quiet"], {
      useFakeCodex: true,
      codexArgsPath: explicitArgsPath,
    });
    expect(explicit.status, explicit.stderr).toBe(0);
    const explicitInvocation = JSON.parse(
      await readFile(explicitArgsPath, "utf8"),
    ) as typeof singleInvocation;
    const explicitPrompt = explicitInvocation.requests
      .find((request) => request.method === "turn/start")
      ?.params?.input?.find((item) => item.type === "text")?.text;
    expect(explicitPrompt!.indexOf("page-10.png")).toBeLessThan(
      explicitPrompt!.indexOf("page-2.png"),
    );
  }, 15_000);

  it("defaults to direct Markdown and supports deterministic TXT output", () => {
    const markdown = runCli([htmlFixture, "--quiet"], {
      useFakeCodex: true,
    });
    expect(markdown.status, markdown.stderr).toBe(0);
    expect(markdown.stderr).toBe("");
    expect(markdown.stdout).toBe(
      "# Deterministic Markdown edition\n\n[Source](https://example.com).\n",
    );

    const text = runCli([htmlFixture, "--format", "txt", "--quiet"], {
      useFakeCodex: true,
    });
    expect(text.status, text.stderr).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toBe("Deterministic plain text edition.\n");
  });

  it("passes trimmed custom instructions into the exact Codex prompt", async () => {
    const codexArgsPath = path.join(
      fixtureDirectory,
      "custom-instructions-codex-args.json",
    );
    const settingsDirectory = path.join(
      fixtureDirectory,
      "custom-instructions-settings",
    );
    const result = runCli(
      [
        htmlFixture,
        "--custom-instructions",
        "  Keep the appendix and all footnotes.  ",
        "--quiet",
      ],
      { useFakeCodex: true, codexArgsPath, settingsDirectory },
    );

    expect(result.status, result.stderr).toBe(0);
    const invocation = JSON.parse(await readFile(codexArgsPath, "utf8")) as {
      requests: Array<{
        method?: string;
        params?: { input?: Array<{ type?: string; text?: string }> };
      }>;
    };
    const turn = invocation.requests.find(
      (request) => request.method === "turn/start",
    );
    const prompt = turn?.params?.input?.find(
      (item) => item.type === "text",
    )?.text;
    expect(prompt).toContain(
      "The user has specified special instructions for this generation",
    );
    expect(prompt).toContain(
      'User custom instructions:\n"Keep the appendix and all footnotes."',
    );

    const nextResult = runCli([htmlFixture, "--quiet"], {
      useFakeCodex: true,
      codexArgsPath,
      settingsDirectory,
    });
    expect(nextResult.status, nextResult.stderr).toBe(0);
    const nextInvocation = JSON.parse(
      await readFile(codexArgsPath, "utf8"),
    ) as typeof invocation;
    const nextTurn = nextInvocation.requests.find(
      (request) => request.method === "turn/start",
    );
    const nextPrompt = nextTurn?.params?.input?.find(
      (item) => item.type === "text",
    )?.text;
    expect(nextPrompt).not.toContain("User custom instructions:");
  });

  it("rejects oversized custom instructions before capture or inference", () => {
    const result = runCli([
      htmlFixture,
      "--custom-instructions",
      "x".repeat(4_001),
      "--quiet",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Custom instructions must be 4,000 characters or fewer",
    );
    expect(result.stderr).not.toContain("Codex");
  });

  it("writes deterministic PDF output without invoking live Codex", async () => {
    const outputPath = path.join(fixtureDirectory, "cli-edition.pdf");
    const result = runCli(
      [
        htmlFixture,
        "--format",
        "pdf",
        "--no-images",
        "--quiet",
        "-o",
        outputPath,
      ],
      { useFakeCodex: true },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const bytes = await readFile(outputPath);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await stat(outputPath)).size).toBeGreaterThan(1_000);
  });

  it("rejects an unknown output format before extraction", () => {
    const result = runCli([htmlFixture, "--format", "csv", "--quiet"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown output format: csv");
    expect(result.stderr).toContain("Use txt, md, or pdf");
  });

  it("accepts future Codex model slugs without changing the default", () => {
    expect(codexModelArgs(undefined)).toEqual(["--model", DEFAULT_MODEL]);
    expect(codexModelArgs("gpt-7.2-preview-2028-01-09")).toEqual([
      "--model",
      "gpt-7.2-preview-2028-01-09",
    ]);
    expect(normalizeModelSlug("  openai/gpt-8  ")).toBe("openai/gpt-8");
    expect(() => normalizeModelSlug("")).toThrow(/cannot be empty/);
    expect(() => normalizeModelSlug("two models")).toThrow(/whitespace/);
    expect(() => normalizeModelSlug("--fast")).toThrow(/hyphen/);
    expect(() =>
      normalizeModelSlug(`gpt${String.fromCharCode(0)}future`),
    ).toThrow(/control/);
    expect(() => normalizeModelSlug(`gpt-${"x".repeat(200)}`)).toThrow(
      /200 characters/,
    );
  });

  it("rejects malformed CLI model slugs before source capture", () => {
    const result = runCli([htmlFixture, "--model", "two models", "--quiet"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("Model slug");
    expect(result.stderr).toContain("whitespace");
  });

  it("remembers an explicit CLI model slug for later runs", async () => {
    const settingsDirectory = path.join(fixtureDirectory, "remembered-model");
    const codexArgsPath = path.join(fixtureDirectory, "codex-args.json");
    const customModel = "openai/gpt-7.2-preview-2028-01-09";
    const first = runCli([htmlFixture, "--model", customModel, "--quiet"], {
      useFakeCodex: true,
      settingsDirectory,
      codexArgsPath,
    });
    expect(first.status, first.stderr).toBe(0);
    const firstInvocation = JSON.parse(
      await readFile(codexArgsPath, "utf8"),
    ) as {
      args: string[];
      requests: Array<{ method?: string; params?: Record<string, unknown> }>;
    };
    expect(firstInvocation.args).toEqual(
      expect.arrayContaining(["app-server", "--stdio"]),
    );
    expect(firstInvocation.requests).toContainEqual(
      expect.objectContaining({
        method: "thread/start",
        params: expect.objectContaining({ model: customModel }),
      }),
    );
    expect(
      JSON.parse(
        await readFile(path.join(settingsDirectory, "settings.json"), "utf8"),
      ),
    ).toEqual({ model: customModel });

    const second = runCli([htmlFixture, "--quiet"], {
      useFakeCodex: true,
      settingsDirectory,
      codexArgsPath,
    });
    expect(second.status).toBe(0);
    const secondInvocation = JSON.parse(
      await readFile(codexArgsPath, "utf8"),
    ) as {
      requests: Array<{ method?: string; params?: Record<string, unknown> }>;
    };
    expect(secondInvocation.requests).toContainEqual(
      expect.objectContaining({
        method: "thread/start",
        params: expect.objectContaining({ model: customModel }),
      }),
    );
  });

  it("selects Standard and Fast Codex service tiers explicitly", () => {
    expect(codexServiceTierArgs(false)).toEqual([
      "--config",
      'service_tier="default"',
    ]);
    expect(codexServiceTierArgs(true)).toEqual([
      "--enable",
      "fast_mode",
      "--config",
      'service_tier="fast"',
    ]);
  });

  it("doctor reports local auth, the default model, Fast mode, and Chromium", () => {
    const result = runCli(["doctor"], { useFakeCodex: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Codex CLI: codex-cli fixture 1.0");
    expect(result.stdout).toContain(
      "Codex login: Logged in with deterministic fixture",
    );
    expect(result.stdout).toContain(`Extraction model: ${DEFAULT_MODEL}`);
    expect(result.stdout).toContain("Fast inference: Available with `--fast`");
    expect(result.stdout).toContain("Chromium browser:");
    expect(`${result.stdout}${result.stderr}`).not.toMatch(
      /API key.*enter|bearer token.*paste/i,
    );
  });

  it("resolves Windows npm command shims without invoking a shell", async () => {
    const temporary = await createPrivateTempDir("ree-codex-shim-test-");
    try {
      const shim = path.join(temporary.path, "codex.cmd");
      const entrypoint = path.join(
        temporary.path,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      );
      await mkdir(path.dirname(entrypoint), { recursive: true });
      await writeFile(shim, "@echo off\r\n");
      await writeFile(entrypoint, "// fixture entrypoint\n");
      await expect(resolveCodexCommand(shim, "win32")).resolves.toEqual({
        command: process.execPath,
        prefixArgs: [entrypoint],
      });
    } finally {
      await temporary.cleanup();
    }
  });
});
