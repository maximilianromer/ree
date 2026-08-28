import { codexStatus, DEFAULT_MODEL } from "./model/codex.js";
import { findChromiumExecutable } from "./adapters/browser.js";
import { inspectNativeMessagingRegistration } from "./native/setup.js";
import { readRememberedModel } from "./core/settings.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export function isSupportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (![major, minor, patch].every(Number.isFinite)) return false;
  return (
    major > 22 || (major === 22 && (minor > 13 || (minor === 13 && patch >= 0)))
  );
}

export async function runDoctor(): Promise<DoctorCheck[]> {
  const [codex, browser, registrations, rememberedModel] = await Promise.all([
    codexStatus(),
    findChromiumExecutable(),
    inspectNativeMessagingRegistration(),
    readRememberedModel(),
  ]);
  return [
    {
      name: "Node.js",
      ok: isSupportedNodeVersion(process.versions.node),
      detail: process.version,
      required: true,
    },
    {
      name: "Codex CLI",
      ok: Boolean(codex.executable),
      detail: codex.executable
        ? `${codex.version} at ${codex.executable}`
        : codex.loginMessage,
      required: true,
    },
    {
      name: "Codex login",
      ok: codex.authenticated,
      detail: codex.loginMessage || "Not authenticated",
      required: true,
    },
    {
      name: "Extraction model",
      ok: codex.authenticated,
      detail: `${rememberedModel} is the remembered CLI model; ${DEFAULT_MODEL} is the initial default`,
      required: true,
    },
    {
      name: "Fast inference",
      ok: codex.fastModeSupported,
      detail: codex.fastModeSupported
        ? "Available with `--fast`; speed and credit cost depend on the selected model"
        : "Update Codex to enable REE's optional Fast mode",
      required: false,
    },
    {
      name: "Chromium browser",
      ok: Boolean(browser),
      detail:
        browser ||
        "Chrome, Edge, Brave, or Chromium is required for webpage capture and PDF output",
      required: true,
    },
    {
      name: "Extension bridge",
      ok: registrations.some((registration) => registration.installed),
      detail: registrations.some((registration) => registration.installed)
        ? registrations
            .filter((registration) => registration.installed)
            .map((registration) => registration.browser)
            .join(", ")
        : "Not registered; run `ree setup-extension` after loading the extension",
      required: false,
    },
  ];
}
