import { describe, expect, it } from "vitest";
import type { ExtractionChunk, OutputFormat } from "../src/core/types.js";
import { extractionPrompt } from "../src/model/prompts.js";

function dividerChunk(): ExtractionChunk {
  return {
    index: 0,
    total: 1,
    source: {
      kind: "webpage",
      url: "https://example.test/article",
      mimeType: "text/html",
    },
    title: "Divider fixture",
    metadata: {},
    sections: [
      {
        id: "page-section-001",
        label: "Article",
        content: "<article><p>Before.</p><hr><p>After.</p></article>",
        attachments: [],
        assetIds: [],
      },
    ],
    assets: [],
    attachments: [],
  };
}

describe("extraction prompts", () => {
  it.each(["md", "pdf"] as const)(
    "requires retained horizontal rules in %s output",
    (format: OutputFormat) => {
      const prompt = extractionPrompt(dividerChunk(), format, false);

      expect(prompt).toContain(
        "emit exactly one Markdown thematic break as --- on its own line",
      );
      expect(prompt).toContain(
        "<article><p>Before.</p><hr><p>After.</p></article>",
      );
    },
  );

  it("keeps dividers out of TTS-friendly TXT output", () => {
    const prompt = extractionPrompt(dividerChunk(), "txt", false);

    expect(prompt).toContain("Do not emit Markdown");
    expect(prompt).toContain("dividers");
    expect(prompt).not.toContain("emit exactly one Markdown thematic break");
  });

  it("includes nonblank custom instructions as user-specified generation guidance", () => {
    const prompt = extractionPrompt(
      dividerChunk(),
      "md",
      false,
      "  Keep the appendix, even if it looks supplementary.  ",
    );

    expect(prompt).toContain(
      "The user has specified special instructions for this generation",
    );
    expect(prompt).toContain(
      'User custom instructions:\n"Keep the appendix, even if it looks supplementary."',
    );
  });

  it("does not add a custom-instruction section when the field is blank", () => {
    const prompt = extractionPrompt(dividerChunk(), "md", false, "  \n ");

    expect(prompt).not.toContain("User custom instructions:");
  });
});
