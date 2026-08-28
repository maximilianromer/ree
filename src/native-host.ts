#!/usr/bin/env node
import { runNativeHost } from "./native/host.js";

runNativeHost().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
