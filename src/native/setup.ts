import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateTempDir } from "../core/temp.js";

export const NATIVE_HOST_NAME = "tools.ree.native_host";
export const DEFAULT_EXTENSION_ID = "komlllipnoacgedoailjegbglfihcgkh";

export interface RegistrationResult {
  browser: string;
  manifestPath: string;
  installed: boolean;
  detail?: string;
}

function macTargets(): Array<{ browser: string; directory: string }> {
  const support = path.join(os.homedir(), "Library", "Application Support");
  return [
    {
      browser: "Google Chrome",
      directory: path.join(support, "Google", "Chrome", "NativeMessagingHosts"),
    },
    {
      browser: "Microsoft Edge",
      directory: path.join(support, "Microsoft Edge", "NativeMessagingHosts"),
    },
    {
      browser: "Brave",
      directory: path.join(
        support,
        "BraveSoftware",
        "Brave-Browser",
        "NativeMessagingHosts",
      ),
    },
    {
      browser: "Chromium",
      directory: path.join(support, "Chromium", "NativeMessagingHosts"),
    },
  ];
}

function linuxTargets(): Array<{ browser: string; directory: string }> {
  return [
    {
      browser: "Google Chrome",
      directory: path.join(
        os.homedir(),
        ".config",
        "google-chrome",
        "NativeMessagingHosts",
      ),
    },
    {
      browser: "Microsoft Edge",
      directory: path.join(
        os.homedir(),
        ".config",
        "microsoft-edge",
        "NativeMessagingHosts",
      ),
    },
    {
      browser: "Brave",
      directory: path.join(
        os.homedir(),
        ".config",
        "BraveSoftware",
        "Brave-Browser",
        "NativeMessagingHosts",
      ),
    },
    {
      browser: "Chromium",
      directory: path.join(
        os.homedir(),
        ".config",
        "chromium",
        "NativeMessagingHosts",
      ),
    },
  ];
}

function windowsTargets(): Array<{ browser: string; registryKey: string }> {
  return [
    {
      browser: "Google Chrome",
      registryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    },
    {
      browser: "Microsoft Edge",
      registryKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    },
    {
      browser: "Brave",
      registryKey: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    },
    {
      browser: "Chromium",
      registryKey: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    },
  ];
}

export function windowsSeaMain(currentModule: string): string {
  return `const { pathToFileURL } = require("node:url");\nimport(pathToFileURL(${JSON.stringify(currentModule)}).href).catch((error) => {\n  process.stderr.write(\`REE native host failed: \${error && error.message ? error.message : String(error)}\\n\`);\n  process.exitCode = 1;\n});\n`;
}

async function buildWindowsNativeHost(
  currentModule: string,
  launcher: string,
): Promise<void> {
  const temporary = await createPrivateTempDir("ree-windows-host-");
  try {
    const mainPath = path.join(temporary.path, "native-host.cjs");
    const blobPath = path.join(temporary.path, "native-host.blob");
    const configPath = path.join(temporary.path, "sea-config.json");
    const executablePath = path.join(temporary.path, "ree-native-host.exe");
    await writeFile(mainPath, windowsSeaMain(currentModule), "utf8");
    await writeFile(
      configPath,
      JSON.stringify({
        main: mainPath,
        output: blobPath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      }),
      "utf8",
    );
    const sea = spawnSync(
      process.execPath,
      ["--experimental-sea-config", configPath],
      { encoding: "utf8", windowsHide: true },
    );
    if (sea.status !== 0)
      throw new Error(
        `Node could not prepare the Windows native host: ${sea.stderr || sea.stdout}`,
      );
    await copyFile(process.execPath, executablePath);
    const require = createRequire(import.meta.url);
    const postject = path.join(
      path.dirname(require.resolve("postject")),
      "cli.js",
    );
    const injection = spawnSync(
      process.execPath,
      [
        postject,
        executablePath,
        "NODE_SEA_BLOB",
        blobPath,
        "--sentinel-fuse",
        "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (injection.status !== 0)
      throw new Error(
        `Could not create the Windows native-host executable: ${injection.stderr || injection.stdout}`,
      );
    await copyFile(executablePath, launcher);
  } finally {
    await temporary.cleanup();
  }
}

export async function resolveNativeHostExecutable(
  install = false,
): Promise<string> {
  const currentModule = fileURLToPath(
    new URL("../native-host.js", import.meta.url),
  );
  try {
    await access(currentModule);
  } catch {
    throw new Error(
      "Could not locate the REE native host module. Run `npm run build` or reinstall REE globally, then retry.",
    );
  }
  const directory =
    os.platform() === "win32"
      ? path.join(process.env.LOCALAPPDATA || os.homedir(), "REE")
      : path.join(os.homedir(), ".local", "share", "ree");
  const launcher = path.join(
    directory,
    os.platform() === "win32" ? "ree-native-host.exe" : "ree-native-host",
  );
  if (install) {
    await mkdir(directory, { recursive: true });
    if (os.platform() === "win32") {
      await buildWindowsNativeHost(currentModule, launcher);
      await rm(path.join(directory, "ree-native-host.cmd"), { force: true });
    } else {
      const quoteShell = (value: string) =>
        `'${value.replaceAll("'", `'\\''`)}'`;
      const contents = `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(currentModule)}\n`;
      await writeFile(launcher, contents, { encoding: "utf8", mode: 0o700 });
      await chmod(launcher, 0o700);
    }
  }
  return launcher;
}

function manifest(executable: string, extensionId: string) {
  return {
    name: NATIVE_HOST_NAME,
    description: "REE local extraction bridge",
    path: executable,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

export async function setupNativeMessaging(
  extensionId = DEFAULT_EXTENSION_ID,
  dryRun = false,
): Promise<RegistrationResult[]> {
  if (!/^[a-p]{32}$/.test(extensionId))
    throw new Error(
      "The extension ID must be the 32-character ID shown on chrome://extensions.",
    );
  const executable = await resolveNativeHostExecutable(!dryRun);
  const contents = `${JSON.stringify(manifest(executable, extensionId), null, 2)}\n`;
  const results: RegistrationResult[] = [];

  if (os.platform() === "win32") {
    const directory = path.join(
      process.env.LOCALAPPDATA || os.homedir(),
      "REE",
    );
    const manifestPath = path.join(directory, `${NATIVE_HOST_NAME}.json`);
    if (!dryRun) {
      await mkdir(directory, { recursive: true });
      await writeFile(manifestPath, contents, "utf8");
      for (const target of windowsTargets()) {
        const registration = spawnSync(
          "reg",
          [
            "ADD",
            target.registryKey,
            "/ve",
            "/t",
            "REG_SZ",
            "/d",
            manifestPath,
            "/f",
          ],
          { windowsHide: true, encoding: "utf8" },
        );
        if (registration.status !== 0)
          throw new Error(
            `Could not register the Windows native host for ${target.browser}: ${registration.stderr || registration.stdout}`,
          );
      }
    }
    return windowsTargets().map((target) => ({
      browser: target.browser,
      manifestPath,
      installed: !dryRun,
    }));
  }

  const targets = os.platform() === "darwin" ? macTargets() : linuxTargets();
  for (const target of targets) {
    const manifestPath = path.join(
      target.directory,
      `${NATIVE_HOST_NAME}.json`,
    );
    if (!dryRun) {
      await mkdir(target.directory, { recursive: true });
      await writeFile(manifestPath, contents, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    results.push({ browser: target.browser, manifestPath, installed: !dryRun });
  }
  return results;
}

export async function inspectNativeMessagingRegistration(): Promise<
  RegistrationResult[]
> {
  if (os.platform() === "win32") {
    return Promise.all(
      windowsTargets().map(async (target) => {
        const query = spawnSync("reg", ["QUERY", target.registryKey, "/ve"], {
          windowsHide: true,
          encoding: "utf8",
        });
        const manifestPath =
          query.stdout.match(/REG_SZ\s+(.+)\r?$/m)?.[1]?.trim() || "";
        try {
          const data = JSON.parse(await readFile(manifestPath, "utf8"));
          await access(data.path);
          return {
            browser: target.browser,
            manifestPath,
            installed:
              query.status === 0 &&
              data.name === NATIVE_HOST_NAME &&
              Array.isArray(data.allowed_origins),
          };
        } catch {
          return {
            browser: target.browser,
            manifestPath,
            installed: false,
          };
        }
      }),
    );
  }
  const targets = os.platform() === "darwin" ? macTargets() : linuxTargets();
  return Promise.all(
    targets.map(async (target) => {
      const manifestPath = path.join(
        target.directory,
        `${NATIVE_HOST_NAME}.json`,
      );
      try {
        const data = JSON.parse(await readFile(manifestPath, "utf8"));
        return {
          browser: target.browser,
          manifestPath,
          installed: data.name === NATIVE_HOST_NAME,
        };
      } catch {
        return { browser: target.browser, manifestPath, installed: false };
      }
    }),
  );
}
