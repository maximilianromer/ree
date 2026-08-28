import { writeFile } from "node:fs/promises";
import type {
  ExtractionChunk,
  SourceBundle,
  SourceSection,
} from "../src/core/types.js";
import type {
  ExtractionAdapter,
  ExtractionOptions,
} from "../src/model/adapter.js";

export interface DeterministicAdapterCall {
  chunk: ExtractionChunk;
  options: ExtractionOptions;
}

export interface DeterministicAdapterOptions {
  delayMs?: (chunk: ExtractionChunk) => number;
  output?: (
    chunk: ExtractionChunk,
    options: ExtractionOptions,
  ) => string | Promise<string>;
}

/** A direct-output model double: one input chunk produces one edition string. */
export class DeterministicAdapter implements ExtractionAdapter {
  readonly name = "deterministic direct-output adapter";
  readonly calls: DeterministicAdapterCall[] = [];
  activeCalls = 0;
  maxActiveCalls = 0;

  constructor(private readonly fixture: DeterministicAdapterOptions = {}) {}

  async extractChunk(
    chunk: ExtractionChunk,
    options: ExtractionOptions,
  ): Promise<string> {
    this.calls.push({ chunk, options });
    this.activeCalls += 1;
    this.maxActiveCalls = Math.max(this.maxActiveCalls, this.activeCalls);
    try {
      const delay = this.fixture.delayMs?.(chunk) ?? 0;
      if (delay > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (options.signal?.aborted) throw new Error("Extraction cancelled");
      if (this.fixture.output) return this.fixture.output(chunk, options);
      return chunk.sections.map((section) => section.content).join("\n");
    } finally {
      this.activeCalls -= 1;
    }
  }
}

export function sourceSection(
  id: string,
  content: string,
  attachments: string[] = [],
): SourceSection {
  return {
    id,
    label: id,
    content,
    attachments,
    assetIds: [],
  };
}

export function sourceBundle(sections: SourceSection[]): SourceBundle {
  return {
    source: { kind: "html", filename: "fixture.html", mimeType: "text/html" },
    title: "Direct fixture",
    metadata: { author: "Ada Example" },
    sections,
    assets: [],
    cleanup: async () => undefined,
  };
}

/** Write a tiny PDF with text plus a partial-page raster XObject. */
export async function writeFigurePdfFixture(filePath: string): Promise<void> {
  const content = [
    "BT /F1 18 Tf 72 710 Td (Figure-bearing report) Tj ET",
    "q 180 0 0 120 72 500 cm /Im1 Do Q",
  ].join("\n");
  const image = "ff000000ff00000fffffffff>";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${Buffer.byteLength(image)} >>\nstream\n${image}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  await writeFile(filePath, pdf, "binary");
}
