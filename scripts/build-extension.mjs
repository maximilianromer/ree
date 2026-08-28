import { cp, mkdir, rm } from "node:fs/promises";

const source = new URL("../extension", import.meta.url);
const target = new URL("../dist/extension", import.meta.url);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log("Built Chromium extension at dist/extension");
