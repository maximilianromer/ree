import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";

const macCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Arc.app/Contents/MacOS/Arc",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

function windowsCandidates(): string[] {
  const roots = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ].filter((value): value is string => Boolean(value));
  return roots.flatMap((root) => [
    path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(
      root,
      "BraveSoftware",
      "Brave-Browser",
      "Application",
      "brave.exe",
    ),
  ]);
}

const linuxCandidates = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/microsoft-edge",
  "/usr/bin/microsoft-edge-stable",
  "/usr/bin/brave-browser",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export async function findChromiumExecutable(): Promise<string | undefined> {
  const override = process.env.REE_CHROMIUM_PATH;
  const candidates = override
    ? [override]
    : os.platform() === "darwin"
      ? macCandidates
      : os.platform() === "win32"
        ? windowsCandidates()
        : linuxCandidates;

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next conventional location.
    }
  }
  try {
    const bundled = chromium.executablePath();
    await access(bundled);
    return bundled;
  } catch {
    return undefined;
  }
}

export async function launchChromium(): Promise<Browser> {
  const executablePath = await findChromiumExecutable();
  if (!executablePath) {
    throw new Error(
      "No Chromium browser was found. Install Chrome, Edge, Brave, or Chromium, or set REE_CHROMIUM_PATH.",
    );
  }
  return chromium.launch({
    executablePath,
    headless: true,
    args: ["--disable-background-networking", "--disable-component-update"],
  });
}
