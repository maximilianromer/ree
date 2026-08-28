import { chmod } from "node:fs/promises";

// `tsc` emits plain files, so a linked `ree` on PATH loses its executable bit on
// every rebuild. npm sets the bit when installing a published tarball; a linked
// checkout has to set it itself.
const binaries = ["dist/cli.js", "dist/native-host.js"];
for (const binary of binaries) {
  const target = new URL(`../${binary}`, import.meta.url);
  await chmod(target, 0o755);
}
console.log(`Marked ${binaries.length} entrypoints executable`);
