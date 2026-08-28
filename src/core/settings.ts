import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MODEL, normalizeModelSlug } from "../model/selection.js";

interface ReeSettings {
  model: string;
}

export function settingsDirectory(): string {
  const override = process.env.REE_SETTINGS_DIR;
  if (override) return path.resolve(override);
  if (os.platform() === "win32")
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "REE",
    );
  if (os.platform() === "darwin")
    return path.join(os.homedir(), "Library", "Application Support", "REE");
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "ree",
  );
}

export function settingsPath(): string {
  return path.join(settingsDirectory(), "settings.json");
}

export async function readRememberedModel(): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath(), "utf8")) as {
      model?: unknown;
    };
    if (typeof parsed.model !== "string") return DEFAULT_MODEL;
    return normalizeModelSlug(parsed.model);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return DEFAULT_MODEL;
    if (error instanceof SyntaxError)
      throw new Error(`REE settings are not valid JSON: ${settingsPath()}`);
    throw error;
  }
}

export async function rememberModel(value: string): Promise<string> {
  const model = normalizeModelSlug(value);
  const directory = settingsDirectory();
  const destination = settingsPath();
  const temporary = path.join(
    directory,
    `.settings-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  const settings: ReeSettings = { model };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return model;
}

export async function resolveRememberedModel(
  explicitModel?: string,
): Promise<string> {
  return explicitModel === undefined
    ? readRememberedModel()
    : rememberModel(explicitModel);
}
