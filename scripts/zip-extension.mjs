import archiver from "archiver";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

await mkdir("dist", { recursive: true });
const outputPath = path.resolve("dist/ree-extension.zip");
const output = createWriteStream(outputPath);
const archive = archiver("zip", { zlib: { level: 9 } });
archive.pipe(output);
archive.directory("dist/extension", false);
await archive.finalize();
await new Promise((resolve, reject) => {
  output.on("close", resolve);
  output.on("error", reject);
});
console.log(`Created ${outputPath}`);
