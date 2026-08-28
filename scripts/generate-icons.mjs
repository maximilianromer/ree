import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const source = await readFile(
  new URL("../assets/ree-mark.svg", import.meta.url),
  "utf8",
);
const darkSvg = source.replaceAll("currentColor", "#111416");
const image = await loadImage(Buffer.from(darkSvg));
const destination = new URL("../extension/icons/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, size, size);
  context.drawImage(image, 0, 0, size, size);
  await writeFile(
    new URL(`icon${size}.png`, destination),
    canvas.toBuffer("image/png"),
  );
}
console.log("Generated extension icons");
