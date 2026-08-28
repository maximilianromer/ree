import { describe, expect, it } from "vitest";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  detectFileType,
  gatherEvidence,
  isPublicUrl,
} from "../src/adapters/index.js";
import {
  alignedHtmlEvidence,
  gatherHtmlEvidence,
  gatherHtmlStringEvidence,
} from "../src/adapters/html.js";
import { gatherPdfSource } from "../src/adapters/pdf.js";
import { createPrivateTempDir } from "../src/core/temp.js";
import { writeFigurePdfFixture } from "./helpers.js";

const generated = path.resolve("fixtures/generated");

function combinedContent(sections: Array<{ content: string }>): string {
  return sections.map((section) => section.content).join("\n");
}

describe("direct source adapters", () => {
  it("detects local HTML, PDF, and image files by content", async () => {
    await expect(
      detectFileType(path.join(generated, "normal-text.pdf")),
    ).resolves.toBe("pdf");
    await expect(
      detectFileType(path.resolve("fixtures/noisy-article.html")),
    ).resolves.toBe("html");
    await expect(
      detectFileType(path.join(generated, "standalone-scan.png")),
    ).resolves.toBe("image");
  });

  it("turns one image into private visual evidence", async () => {
    const sourcePath = path.join(generated, "standalone-scan.png");
    const bundle = await gatherEvidence(sourcePath, () => undefined);
    try {
      expect(bundle.source).toMatchObject({
        kind: "image",
        filename: "standalone-scan.png",
        mimeType: "image/png",
        imageCount: 1,
      });
      expect(bundle.sections).toHaveLength(1);
      expect(bundle.sections[0]?.label).toContain("standalone-scan.png");
      expect(bundle.sections[0]?.attachments).toHaveLength(1);
      expect(bundle.sections[0]?.attachments[0]).not.toBe(sourcePath);
      expect(bundle.assets).toEqual([]);
      expect(bundle.metadata.images).toEqual([
        expect.objectContaining({
          position: 1,
          filename: "standalone-scan.png",
          mimeType: "image/png",
        }),
      ]);
    } finally {
      await bundle.cleanup();
    }
  });

  it("reads directory galleries in natural filename order and explicit galleries in argument order", async () => {
    const temporary = await createPrivateTempDir("ree-image-gallery-test-");
    try {
      const page2 = path.join(temporary.path, "page-2.png");
      const page10 = path.join(temporary.path, "page-10.png");
      await copyFile(path.join(generated, "standalone-scan.png"), page2);
      await copyFile(path.join(generated, "standalone-scan.png"), page10);
      await writeFile(path.join(temporary.path, "notes.txt"), "ignored");

      const directoryGallery = await gatherEvidence(
        temporary.path,
        () => undefined,
      );
      try {
        expect(directoryGallery.source).toMatchObject({
          kind: "image-gallery",
          imageCount: 2,
        });
        expect(
          directoryGallery.sections.map((section) => section.label),
        ).toEqual(["Image 1 of 2: page-2.png", "Image 2 of 2: page-10.png"]);
      } finally {
        await directoryGallery.cleanup();
      }

      const explicitGallery = await gatherEvidence(
        [page10, page2],
        () => undefined,
      );
      try {
        expect(
          explicitGallery.sections.map((section) => section.label),
        ).toEqual(["Image 1 of 2: page-10.png", "Image 2 of 2: page-2.png"]);
      } finally {
        await explicitGallery.cleanup();
      }
    } finally {
      await temporary.cleanup();
    }
  });

  it("recognizes only public HTTP(S) URL inputs", () => {
    expect(isPublicUrl("https://example.test/article")).toBe(true);
    expect(isPublicUrl("http://example.test/article")).toBe(true);
    expect(isPublicUrl("file:///tmp/article.html")).toBe(false);
    expect(isPublicUrl("data:text/html,article")).toBe(false);
    expect(isPublicUrl("./article.html")).toBe(false);
  });

  it("preserves semantic HTML and metadata while removing executable, private, form, style, and framework data", async () => {
    const html = `<!doctype html>
      <html lang="en"><head>
        <title>Semantic Source</title>
        <meta name="author" content="Ada Example">
        <meta property="article:published_time" content="2026-08-09">
        <link rel="canonical" href="/story?utm_source=tracker&edition=1">
        <style>.secret { display: block }</style>
        <script>globalThis.exfiltrate = true</script>
      </head><body data-reactroot="private" onclick="steal()" style="color:red">
        <!-- private build comment -->
        <article data-next-state="private"><h1>Semantic Source</h1>
          <p>Keep <strong>strong</strong>, <em>emphasis</em>, and
          <a href="/reference?utm_medium=email&edition=1" data-token="secret">a link</a>.</p>
          <blockquote cite="javascript:alert(1)">Quoted evidence.</blockquote>
          <pre><code class="language-ts" data-framework="noise">const answer = 42;</code></pre>
          <table><caption>Signals</caption><tr><th>North</th><td>17</td></tr></table>
          <form action="/submit"><input name="token" value="private"></form>
          <img src="tracking.gif" width="1" height="1" alt="tracker">
        </article>
      </body></html>`;
    const bundle = await gatherHtmlStringEvidence(
      html,
      "https://reader:password@example.test/original",
    );
    try {
      const content = combinedContent(bundle.sections);
      expect(bundle.title).toBe("Semantic Source");
      expect(bundle.metadata).toMatchObject({
        title: "Semantic Source",
        language: "en",
        author: "Ada Example",
        "article:published_time": "2026-08-09",
        canonicalUrl: "https://example.test/story?edition=1",
      });
      expect(content).toContain("<article>");
      expect(content).toContain("<strong>strong</strong>");
      expect(content).toContain("<em>emphasis</em>");
      expect(content).toContain(
        '<a href="https://example.test/reference?edition=1">a link</a>',
      );
      expect(content).toContain("<blockquote>Quoted evidence.</blockquote>");
      expect(content).toContain('<code class="language-ts">');
      expect(content).toContain("<table>");
      expect(content).not.toMatch(
        /script|style=|onclick|data-react|data-next|data-token|data-framework|javascript:|private build|<form|<input/i,
      );
      expect(content).not.toContain("tracking.gif");
    } finally {
      await bundle.cleanup();
    }
  });

  it("retains stable, sanctioned markers only for captured image assets", async () => {
    const png = await readFile(path.join(generated, "standalone-scan.png"));
    const bundle = await gatherHtmlStringEvidence(
      '<!doctype html><article><h1>Captured</h1><figure><img data-ree-image-id="image-009" src="https://example.test/figure.png" alt="Instrument diagram"><figcaption>Descent profile</figcaption></figure><img data-ree-image-id="bad-id" src="tracking.png" alt="Uncaptured image"></article>',
      "https://example.test/article",
      [
        {
          id: "image-009",
          dataUrl: `data:image/png;base64,${png.toString("base64")}`,
          label: "Instrument diagram",
          alt: "Instrument diagram",
          sourceUrl: "https://example.test/figure.png?utm_source=feed",
        },
      ],
    );
    try {
      const content = combinedContent(bundle.sections);
      expect(content).toContain("[[REE_IMAGE:image-009]]");
      expect(content).not.toContain("[[REE_IMAGE:bad-id]]");
      expect(content).toContain("[Image: Uncaptured image]");
      expect(bundle.assets).toHaveLength(1);
      expect(bundle.assets[0]).toMatchObject({
        id: "image-009",
        alt: "Instrument diagram",
        sourceUrl: "https://example.test/figure.png",
      });
      expect(bundle.sections[0]?.assetIds).toEqual(["image-009"]);
      expect(bundle.sections[0]?.attachments).toEqual([bundle.assets[0]?.path]);
    } finally {
      await bundle.cleanup();
    }
  });

  it("keeps complete sanitized DOM sections in source order", () => {
    const sections = alignedHtmlEvidence(
      "<!doctype html><body>Preface<main><h1>Article</h1><p>First body.</p><section><h2>Details</h2><p>Second body.</p></section></main><footer>Source note</footer></body>",
      "https://example.test/article",
    );
    expect(sections.map((section) => section.id)).toEqual([
      "html-section-001",
      "html-section-002",
      "html-section-003",
    ]);
    expect(combinedContent(sections)).toContain(
      "<main><h1>Article</h1><p>First body.</p><section><h2>Details</h2><p>Second body.</p></section></main>",
    );
    expect(sections.map((section) => section.content).join("|")).toBe(
      "Preface|<main><h1>Article</h1><p>First body.</p><section><h2>Details</h2><p>Second body.</p></section></main>|<footer>Source note</footer>",
    );
  });

  it("collapses source indentation that would otherwise dominate the evidence", () => {
    const filler = "\n      \n        \n  ".repeat(2_000);
    const sections = alignedHtmlEvidence(
      `<!doctype html><body><article>${filler}<p>First body.</p>${filler}<p>Second body.</p>${filler}</article></body>`,
      "https://example.test/article",
    );
    const content = combinedContent(sections);

    // The article survives intact; the 36,000 characters of layout
    // indentation around it do not.
    expect(content).toContain("<p>First body.</p>");
    expect(content).toContain("<p>Second body.</p>");
    expect(filler.length).toBeGreaterThan(30_000);
    expect(content.length).toBeLessThan(200);
    expect(/\s{2,}/.test(content)).toBe(false);
  });

  it("preserves exact whitespace inside preformatted code", () => {
    const sections = alignedHtmlEvidence(
      "<!doctype html><body><article><pre><code>def f():\n    return 1\n</code></pre></article></body>",
      "https://example.test/article",
    );

    expect(combinedContent(sections)).toContain("def f():\n    return 1\n");
  });

  it("retains horizontal rules even when a source section has no text", () => {
    const sections = alignedHtmlEvidence(
      "<!doctype html><body><article><p>Before.</p><hr><p>After.</p></article><section><hr></section><hr></body>",
      "https://example.test/article",
    );
    const content = combinedContent(sections);

    expect(content.match(/<hr>/g)).toHaveLength(3);
    expect(sections.map((section) => section.content)).toEqual([
      "<article><p>Before.</p><hr><p>After.</p></article>",
      "<section><hr></section>",
      "<hr>",
    ]);
  });

  it("loads local HTML and resolves optional relative image assets", async () => {
    const temporary = await createPrivateTempDir("ree-local-html-test-");
    try {
      await copyFile(
        path.join(generated, "standalone-scan.png"),
        path.join(temporary.path, "illustration.png"),
      );
      const htmlPath = path.join(temporary.path, "page with spaces.html");
      await writeFile(
        htmlPath,
        '<!doctype html><title>Local evidence</title><main><h1>Local evidence</h1><img src="illustration.png?edition=1" alt="Field log illustration"></main>',
      );

      const textOnly = await gatherHtmlEvidence(htmlPath);
      try {
        expect(textOnly.assets).toHaveLength(0);
        expect(combinedContent(textOnly.sections)).not.toContain(
          "[[REE_IMAGE:",
        );
      } finally {
        await textOnly.cleanup();
      }

      const withImages = await gatherHtmlEvidence(htmlPath, {
        includeImages: true,
      });
      try {
        expect(withImages.assets).toHaveLength(1);
        expect(withImages.assets[0]).toMatchObject({
          id: "image-001",
          alt: "Field log illustration",
          mimeType: "image/png",
        });
        expect(combinedContent(withImages.sections)).toContain(
          "[[REE_IMAGE:image-001]]",
        );
        expect(withImages.sections[0]?.attachments).toEqual([
          withImages.assets[0]?.path,
        ]);
      } finally {
        await withImages.cleanup();
      }
    } finally {
      await temporary.cleanup();
    }
  });

  it("provides normal PDF text plus one page rendering as visual evidence", async () => {
    const bundle = await gatherPdfSource(
      path.join(generated, "normal-text.pdf"),
    );
    try {
      expect(bundle.source).toMatchObject({ kind: "pdf", pageCount: 1 });
      expect(bundle.sections).toHaveLength(1);
      expect(bundle.sections[0]?.content).toContain("A Small Atlas of Wind");
      expect(bundle.sections[0]?.content).toContain("Embedded text layer:");
      expect(bundle.sections[0]?.attachments).toHaveLength(1);
      expect(bundle.assets).toHaveLength(0);
    } finally {
      await bundle.cleanup();
    }
  });

  it("preserves both columns from a multicolumn PDF in one page section", async () => {
    const bundle = await gatherPdfSource(
      path.join(generated, "multi-column.pdf"),
    );
    try {
      const content = bundle.sections[0]?.content ?? "";
      expect(content).toContain("LEFT COLUMN.");
      expect(content).toContain("RIGHT COLUMN.");
      expect(content.indexOf("LEFT COLUMN.")).toBeLessThan(
        content.indexOf("RIGHT COLUMN."),
      );
      expect(bundle.sections[0]?.attachments).toHaveLength(1);
    } finally {
      await bundle.cleanup();
    }
  });

  it("keeps a scanned PDF usable through page visual evidence without duplicating it as a figure", async () => {
    const bundle = await gatherPdfSource(
      path.join(generated, "scanned-no-text.pdf"),
      { includeImages: true },
    );
    try {
      expect(bundle.sections[0]?.content).toContain(
        "no usable embedded text layer",
      );
      expect(bundle.sections[0]?.attachments).toHaveLength(1);
      expect(bundle.sections[0]?.assetIds).toEqual([]);
      expect(bundle.assets).toEqual([]);
    } finally {
      await bundle.cleanup();
    }
  });

  it("crops a distinct embedded PDF figure and advertises its sanctioned marker", async () => {
    const temporary = await createPrivateTempDir("ree-figure-pdf-test-");
    try {
      const fixturePath = path.join(temporary.path, "figure.pdf");
      await writeFigurePdfFixture(fixturePath);
      const bundle = await gatherPdfSource(fixturePath, {
        includeImages: true,
      });
      try {
        expect(bundle.sections[0]?.content).toContain("Figure-bearing report");
        expect(bundle.assets).toHaveLength(1);
        expect(bundle.assets[0]).toMatchObject({
          id: "pdf-image-001",
          mimeType: "image/png",
        });
        expect(bundle.sections[0]?.assetIds).toEqual(["pdf-image-001"]);
        expect(bundle.sections[0]?.content).toContain(
          "[[REE_IMAGE:pdf-image-001]]",
        );
        expect(bundle.sections[0]?.attachments).toHaveLength(1);
      } finally {
        await bundle.cleanup();
      }
    } finally {
      await temporary.cleanup();
    }
  });
});
