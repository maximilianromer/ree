import { createRequire } from "node:module";
import { chmod, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { ExtractionAsset, ExtractionResult } from "../core/types.js";
import { launchChromium } from "../adapters/browser.js";

const require = createRequire(import.meta.url);

interface MarkdownToken {
  content: string;
  meta?: unknown;
}

interface MarkdownState {
  pos: number;
  posMax: number;
  src: string;
  push(type: string, tag: string, nesting: number): MarkdownToken;
}

interface MarkdownRenderer {
  rules: Record<
    string,
    | ((
        tokens: MarkdownToken[],
        index: number,
        options: unknown,
        environment: unknown,
        self: unknown,
      ) => string)
    | undefined
  >;
}

interface MarkdownItInstance {
  inline: {
    ruler: {
      before(
        beforeName: string,
        ruleName: string,
        rule: (state: MarkdownState, silent: boolean) => boolean,
      ): void;
    };
  };
  renderer: MarkdownRenderer;
  utils: { escapeHtml(value: string): string };
  use(plugin: (instance: MarkdownItInstance) => void): MarkdownItInstance;
  render(markdown: string): string;
}

type MarkdownItConstructor = new (options: {
  html: boolean;
  linkify: boolean;
  typographer: boolean;
  breaks: boolean;
}) => MarkdownItInstance;

interface EmbeddedAsset {
  asset: ExtractionAsset;
  dataUrl: string;
}

const markerPattern = /^\[\[REE_IMAGE:([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\]\]/;
const printableImageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

const stylesheet = String.raw`
  :root {
    color-scheme: light;
    font-family: Georgia, "Times New Roman", Times, serif;
    font-size: 10.8pt;
    line-height: 1.56;
    color: #202326;
    background: #ffffff;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body {
    font-family: Georgia, "Times New Roman", Times, serif;
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
  }
  main { margin: 0 auto; max-width: 7in; }
  h1, h2, h3, h4, h5, h6 {
    color: #121416;
    font-family: Georgia, "Times New Roman", Times, serif;
    line-height: 1.18;
    break-after: avoid-page;
    page-break-after: avoid;
    margin: 1.35em 0 0.48em;
  }
  h1 { font-size: 25pt; letter-spacing: -0.025em; margin-top: 0; }
  h2 { font-size: 18pt; letter-spacing: -0.015em; border-bottom: 0.6pt solid #d8d9da; padding-bottom: 0.2em; }
  h3 { font-size: 14.5pt; }
  h4 { font-size: 12pt; }
  h5, h6 { font-size: 10.5pt; font-family: Arial, Helvetica, sans-serif; text-transform: uppercase; letter-spacing: 0.055em; }
  p { margin: 0 0 0.86em; orphans: 3; widows: 3; }
  a { color: #315f7d; text-decoration-thickness: 0.6pt; text-underline-offset: 1.5pt; }
  strong { color: #151719; }
  hr { border: 0; border-top: 0.7pt solid #b8bdc1; width: 36%; margin: 1.65em auto; }
  blockquote {
    break-inside: avoid-page;
    page-break-inside: avoid;
    margin: 1.1em 0 1.2em;
    padding: 0.05em 0 0.05em 1.05em;
    border-left: 2.2pt solid #9aa2a8;
    color: #454b50;
    font-style: italic;
  }
  blockquote > :last-child { margin-bottom: 0; }
  ul, ol { margin: 0.25em 0 0.95em; padding-left: 1.55em; }
  li { margin: 0.18em 0; orphans: 2; widows: 2; }
  li > ul, li > ol { margin-bottom: 0.25em; }
  code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; }
  code { font-size: 0.88em; background: #f2f3f4; border-radius: 2pt; padding: 0.08em 0.24em; }
  pre {
    break-inside: avoid-page;
    page-break-inside: avoid;
    max-width: 100%;
    margin: 1em 0 1.1em;
    padding: 0.8em 0.9em;
    border: 0.6pt solid #d9dcde;
    border-radius: 4pt;
    background: #f6f7f8;
    font-size: 8.2pt;
    line-height: 1.42;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  pre code { padding: 0; background: transparent; font-size: inherit; }
  table {
    width: 100%;
    table-layout: fixed;
    border-collapse: collapse;
    margin: 1.1em 0 1.25em;
    font-size: 8.6pt;
    line-height: 1.35;
  }
  thead { display: table-header-group; }
  tr { break-inside: avoid-page; page-break-inside: avoid; }
  th, td {
    border: 0.6pt solid #cfd3d5;
    padding: 5pt 6pt;
    text-align: left;
    vertical-align: top;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  th { background: #eef0f1; color: #202326; font-family: Arial, Helvetica, sans-serif; font-weight: 600; }
  .ree-figure {
    display: flex;
    width: 100%;
    margin: 1.1em auto 1.25em;
    break-inside: avoid-page;
    page-break-inside: avoid;
    justify-content: center;
    align-items: center;
  }
  .ree-figure img {
    display: block;
    max-width: 100%;
    max-height: 7.15in;
    width: auto;
    height: auto;
    object-fit: contain;
  }
  .footnotes { margin-top: 1.8em; border-top: 0.7pt solid #c9ccce; padding-top: 0.7em; color: #4b5156; font-size: 8.7pt; }
  .footnotes-sep { display: none; }
  .footnote-backref { text-decoration: none; }
  sup { line-height: 0; }
  img { max-width: 100%; }
  @page { size: Letter; }
  @media print {
    h1, h2, h3, h4, h5, h6 { break-after: avoid-page; }
    pre, blockquote, table, .ree-figure { break-inside: avoid-page; }
  }
`;

function htmlDocument(body: string, title: string): string {
  const escapedTitle = title
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedTitle}</title>
  <style>${stylesheet}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

async function loadEmbeddedAssets(
  assets: ExtractionAsset[],
): Promise<Map<string, EmbeddedAsset>> {
  const embedded = new Map<string, EmbeddedAsset>();
  await Promise.all(
    assets.map(async (asset) => {
      if (!markerPattern.test(`[[REE_IMAGE:${asset.id}]]`)) return;
      const mimeType = asset.mimeType.toLowerCase();
      if (!printableImageTypes.has(mimeType)) return;
      try {
        const bytes = await readFile(asset.path);
        embedded.set(asset.id, {
          asset,
          dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
        });
      } catch {
        // Missing or unreadable assets are omitted; markers never become an
        // arbitrary local path or remote request.
      }
    }),
  );
  return embedded;
}

function createMarkdownRenderer(
  embeddedAssets: Map<string, EmbeddedAsset>,
): MarkdownItInstance {
  const MarkdownIt = require("markdown-it") as MarkdownItConstructor;
  const footnoteModule = require("markdown-it-footnote") as {
    default?: (instance: MarkdownItInstance) => void;
  } & ((instance: MarkdownItInstance) => void);
  const footnote = footnoteModule.default ?? footnoteModule;
  const markdown = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
    breaks: false,
  });
  markdown.use(footnote);

  markdown.inline.ruler.before(
    "link",
    "ree_image",
    (state: MarkdownState, silent: boolean): boolean => {
      if (state.src.charCodeAt(state.pos) !== 0x5b) return false;
      const match = state.src
        .slice(state.pos, state.posMax)
        .match(markerPattern);
      if (!match) return false;
      if (!silent) {
        const token = state.push("ree_image", "", 0);
        token.meta = { id: match[1] };
      }
      state.pos += match[0].length;
      return true;
    },
  );

  markdown.renderer.rules.ree_image = (tokens, index) => {
    const id = (tokens[index]?.meta as { id?: string } | undefined)?.id;
    const embedded = id ? embeddedAssets.get(id) : undefined;
    if (!embedded) return "";
    const alt = markdown.utils.escapeHtml(embedded.asset.alt ?? "");
    return `<span class="ree-figure"><img src="${embedded.dataUrl}" alt="${alt}"></span>`;
  };
  // PDF images are accepted only through REE markers resolved against the
  // extraction's known local assets. Ordinary Markdown image syntax remains
  // text-only and cannot fetch an untrusted source.
  markdown.renderer.rules.image = (tokens, index) =>
    markdown.utils.escapeHtml(tokens[index]?.content ?? "");
  return markdown;
}

function temporaryOutputPath(outputPath: string): string {
  const parsed = path.parse(outputPath);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(parsed.dir, `.${parsed.name}-${nonce}.tmp${parsed.ext}`);
}

export async function renderPdf(
  result: Pick<ExtractionResult, "content" | "title" | "assets">,
  outputPath: string,
  includeImages = true,
): Promise<void> {
  const absoluteOutput = path.resolve(outputPath);
  const temporaryOutput = temporaryOutputPath(absoluteOutput);
  const embeddedAssets = await loadEmbeddedAssets(
    includeImages ? result.assets : [],
  );
  const markdown = createMarkdownRenderer(embeddedAssets);
  const rendered = markdown.render(result.content);
  const document = htmlDocument(
    rendered,
    result.title?.trim() || "REE reading edition",
  );
  let browser: Awaited<ReturnType<typeof launchChromium>> | undefined;
  try {
    browser = await launchChromium();
    const page = await browser.newPage();
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === "about:blank" || url.startsWith("data:")) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });
    await page.setContent(document, { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    await page.pdf({
      path: temporaryOutput,
      format: "Letter",
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate:
        '<div style="width:100%;font:8px Arial,Helvetica,sans-serif;color:#73787c;text-align:center"><span class="pageNumber"></span></div>',
      margin: {
        top: "0.7in",
        right: "0.76in",
        bottom: "0.72in",
        left: "0.76in",
      },
      printBackground: true,
      preferCSSPageSize: true,
      tagged: true,
      outline: true,
    });
    await chmod(temporaryOutput, 0o600);
    await rename(temporaryOutput, absoluteOutput);
  } catch (error) {
    await unlink(temporaryOutput).catch(() => undefined);
    throw new Error(
      `Could not render PDF ${path.basename(absoluteOutput)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await browser?.close();
  }
}
