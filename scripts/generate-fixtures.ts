import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { launchChromium } from "../src/adapters/browser.js";

const output = path.resolve("fixtures/generated");
await mkdir(output, { recursive: true });

async function writePdf(filename: string, body: string): Promise<void> {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: Letter; margin: 0.75in; }
      body { margin: 0; color: #202124; font: 11pt/1.5 Georgia, serif; }
      h1 { font-size: 23pt; line-height: 1.15; }
      .columns { column-count: 2; column-gap: 0.55in; }
      figure { margin: 24px auto; text-align: center; }
      figure img { max-width: 480px; }
      figcaption { color: #555; font: 9pt/1.4 Arial, sans-serif; }
    </style></head><body>${body}</body></html>`,
      { waitUntil: "load" },
    );
    await page.pdf({
      path: path.join(output, filename),
      format: "Letter",
      printBackground: true,
      margin: {
        top: "0.75in",
        right: "0.75in",
        bottom: "0.75in",
        left: "0.75in",
      },
    });
  } finally {
    await browser.close();
  }
}

await writePdf(
  "normal-text.pdf",
  `<h1>A Small Atlas of Wind</h1>
   <p>The north wind leaves a blue notation on the ridge. The south wind answers in dust.</p>
   <p>Each observation in this synthetic fixture has a valid embedded text layer.</p>`,
);

await writePdf(
  "multi-column.pdf",
  `<h1 style="text-align:center">Two Columns, One Argument</h1>
   <div class="columns">
     <p><strong>LEFT COLUMN.</strong> The first survey began at dawn. Instruments were calibrated against a copper standard. The result was recorded before the second team arrived.</p>
     <p><strong>RIGHT COLUMN.</strong> The comparison survey began at noon. Its instruments used the same standard. Agreement was within one tenth of a degree.</p>
   </div>`,
);

const scan = createCanvas(1275, 1650);
const context = scan.getContext("2d");
context.fillStyle = "#eee9dd";
context.fillRect(0, 0, scan.width, scan.height);
context.fillStyle = "#20201e";
context.font = "bold 54px Georgia";
context.fillText("FIELD LOG 7", 115, 150);
context.font = "31px Georgia";
const scanLines = [
  "No embedded text layer exists on this page.",
  "The lantern remained visible through the ash until 22:04.",
  "A second light appeared east of the marker stone.",
  "We recorded both bearings before leaving the ridge.",
];
scanLines.forEach((line, index) =>
  context.fillText(line, 115, 270 + index * 62),
);
context.strokeStyle = "#7a756b";
context.lineWidth = 3;
context.strokeRect(90, 80, 1095, 500);
const scanPng = scan.toBuffer("image/png");
await writeFile(path.join(output, "standalone-scan.png"), scanPng);
const scanDataUrl = `data:image/png;base64,${scanPng.toString("base64")}`;
await writePdf(
  "scanned-no-text.pdf",
  `<img src="${scanDataUrl}" alt="Scanned field log" style="position:fixed;inset:-0.75in;width:8.5in;height:11in">`,
);

const figure = createCanvas(960, 520);
const figureContext = figure.getContext("2d");
figureContext.fillStyle = "#f5f1e8";
figureContext.fillRect(0, 0, figure.width, figure.height);
figureContext.strokeStyle = "#263c51";
figureContext.lineWidth = 6;
figureContext.beginPath();
figureContext.moveTo(90, 420);
for (const [index, value] of [330, 350, 255, 300, 180, 125, 82].entries()) {
  figureContext.lineTo(110 + index * 120, value);
}
figureContext.stroke();
figureContext.fillStyle = "#263c51";
figureContext.font = "bold 32px Arial";
figureContext.fillText("Signal strength over seven observations", 90, 75);
const figureDataUrl = `data:image/png;base64,${figure.toBuffer("image/png").toString("base64")}`;
await writePdf(
  "figure-bearing.pdf",
  `<h1>The Falling Signal</h1>
   <p>Seven observations show a clear decline after the fourth measurement.</p>
   <figure><img src="${figureDataUrl}" alt="A descending line chart"><figcaption>Figure 1. Signal strength over seven observations.</figcaption></figure>
   <p>The embedded figure should be cropped once and placed near this discussion.</p>`,
);

const longParagraphs = Array.from(
  { length: 900 },
  (_, index) =>
    `<section><h2>Observation ${index + 1}</h2><p>Sequence ${String(index + 1).padStart(4, "0")}: the recorder preserved this sentence so chunk boundaries can be checked without ambiguity. The next observation follows in strict numeric order.</p></section>`,
).join("\n");
await writeFile(
  path.join(output, "long-document.html"),
  `<!doctype html><html><head><title>Nine Hundred Observations</title></head><body><main><h1>Nine Hundred Observations</h1>${longParagraphs}</main></body></html>`,
);

const mediumParagraphs = Array.from(
  { length: 260 },
  (_, index) =>
    `<section><h2>Reading ${index + 1}</h2><p>Reading ${String(index + 1).padStart(3, "0")}: this exact sentence establishes stable order across a live chunk boundary.</p></section>`,
).join("\n");
await writeFile(
  path.join(output, "live-multi-chunk.html"),
  `<!doctype html><html><head><title>Two Hundred Sixty Readings</title></head><body><main><h1>Two Hundred Sixty Readings</h1>${mediumParagraphs}</main></body></html>`,
);

console.log(`Generated deterministic fixtures in ${output}`);
