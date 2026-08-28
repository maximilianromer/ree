import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function createPrivateTempDir(prefix = "ree-"): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  let cleanupPromise: Promise<void> | undefined;
  return {
    path: directory,
    cleanup: () => {
      cleanupPromise ??= rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }).catch((error: unknown) => {
        cleanupPromise = undefined;
        throw error;
      });
      return cleanupPromise;
    },
  };
}

export async function withCleanup<T>(
  cleanup: () => Promise<void>,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } finally {
    await cleanup();
  }
}
