import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { lookup as mimeLookup } from "mime-types";
import type {
  ExtractionAsset,
  SourceBundle,
  SourceSection,
} from "../core/types.js";
import { createPrivateTempDir } from "../core/temp.js";
import type { WebEvidenceOptions } from "./index.js";

const MAX_IMAGES = 20;
const MAX_DATA_IMAGE_BYTES = 25 * 1024 * 1024;
const REMOVED_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "portal",
  "input",
  "textarea",
  "select",
  "option",
  "button",
  "datalist",
].join(",");
const IMAGE_LIKE_SELECTOR =
  "picture, img:not(picture img), svg, canvas, video[poster]";
const PREFORMATTED_SELECTOR = "pre, code, textarea, samp, kbd";
const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "caption",
  "colgroup",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "search",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const ALLOWED_ELEMENTS = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "i",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "math",
  "menu",
  "menclose",
  "mfenced",
  "mfrac",
  "mi",
  "mmultiscripts",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mprescripts",
  "mroot",
  "mrow",
  "ms",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "nav",
  "none",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "search",
  "section",
  "semantics",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
  "var",
  "wbr",
]);

const GLOBAL_ATTRIBUTES = new Set(["aria-label", "dir", "id", "lang", "role"]);
const ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
  blockquote: new Set(["cite"]),
  code: new Set(["class"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  data: new Set(["value"]),
  del: new Set(["cite", "datetime"]),
  details: new Set(["open"]),
  ins: new Set(["cite", "datetime"]),
  li: new Set(["value"]),
  ol: new Set(["reversed", "start", "type"]),
  pre: new Set(["class"]),
  q: new Set(["cite"]),
  td: new Set(["colspan", "headers", "rowspan"]),
  th: new Set(["abbr", "colspan", "headers", "rowspan", "scope"]),
  time: new Set(["datetime"]),
};

export interface CapturedImage {
  dataUrl: string;
  label: string;
  alt?: string;
  sourceUrl?: string;
  id?: string;
}

interface ImagePayload {
  bytes: Buffer;
  mimeType: string;
  extension: string;
}

function compactText(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function safeUrl(value: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(value, baseUrl);
    if (!["http:", "https:", "mailto:", "file:"].includes(url.protocol))
      return undefined;
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid)$/i.test(key))
        url.searchParams.delete(key);
    }
    return url.href.slice(0, 4_096);
  } catch {
    return undefined;
  }
}

function pageMetadata(
  document: Document,
  baseUrl: string,
): Record<string, unknown> {
  const metadata: Record<string, string> = {};
  const relevantKey =
    /(?:^|:)(?:title|description|author|byl|date|published(?:_time)?|modified(?:_time)?|section|language|locale|site_name|keywords)$/i;
  let metadataCharacters = 0;
  for (const meta of document.querySelectorAll("meta[name],meta[property]")) {
    const key = compactText(
      meta.getAttribute("name") || meta.getAttribute("property"),
    );
    const value = compactText(meta.getAttribute("content"));
    if (
      !key ||
      !value ||
      !relevantKey.test(key) ||
      metadata[key] ||
      metadataCharacters + key.length + value.length > 20_000
    )
      continue;
    metadata[key] = value.slice(0, 2_000);
    metadataCharacters += key.length + value.length;
  }
  const canonical = document
    .querySelector('link[rel~="canonical"]')
    ?.getAttribute("href");
  return {
    title: compactText(document.title) || undefined,
    language: compactText(document.documentElement.lang) || undefined,
    canonicalUrl: canonical ? safeUrl(canonical, baseUrl) : undefined,
    ...metadata,
  };
}

function isVisiblySuppressed(element: Element): boolean {
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    if (
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-hidden")?.toLowerCase() === "true"
    )
      return true;
    const style = (current.getAttribute("style") || "")
      .replace(/\s+/g, "")
      .toLowerCase();
    if (
      /(?:^|;)display:none(?:;|$)/.test(style) ||
      /(?:^|;)visibility:hidden(?:;|$)/.test(style)
    )
      return true;
  }
  return false;
}

function isMeaningfulImageElement(element: Element): boolean {
  if (isVisiblySuppressed(element)) return false;
  const width = Number(element.getAttribute("width"));
  const height = Number(element.getAttribute("height"));
  if ((width > 0 && width <= 2) || (height > 0 && height <= 2)) return false;
  const role = element.getAttribute("role")?.toLowerCase();
  const alt = compactText(
    element.getAttribute("alt") || element.getAttribute("aria-label"),
  );
  return !(role === "presentation" && !alt);
}

function imageLabel(element: Element): string | undefined {
  const direct = compactText(
    element.getAttribute("alt") ||
      element.getAttribute("aria-label") ||
      element.getAttribute("title"),
  );
  if (direct) return direct;
  const nestedImage = element.querySelector("img");
  const nested = compactText(
    nestedImage?.getAttribute("alt") ||
      nestedImage?.getAttribute("aria-label") ||
      nestedImage?.getAttribute("title"),
  );
  if (nested) return nested;
  const caption = compactText(
    element.closest("figure")?.querySelector("figcaption")?.textContent,
  );
  if (caption) return caption;
  return compactText(element.querySelector("title")?.textContent) || undefined;
}

function imageSource(element: Element): string | undefined {
  if (element.tagName.toLowerCase() === "picture") {
    const image = element.querySelector("img");
    return (
      image?.getAttribute("src") ||
      firstSrcsetUrl(image?.getAttribute("srcset"))
    );
  }
  if (element.tagName.toLowerCase() === "video")
    return element.getAttribute("poster") || undefined;
  return (
    element.getAttribute("src") ||
    firstSrcsetUrl(element.getAttribute("srcset"))
  );
}

function firstSrcsetUrl(srcset: string | null | undefined): string | undefined {
  const first = srcset?.split(",", 1)[0]?.trim();
  return first?.split(/\s+/, 1)[0] || undefined;
}

function dataImage(value: string): ImagePayload | undefined {
  const match = value.match(
    /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([a-z0-9+/=\s]+)$/i,
  );
  if (!match?.[1] || !match[2]) return undefined;
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (bytes.length === 0 || bytes.length > MAX_DATA_IMAGE_BYTES)
    return undefined;
  const mimeType = match[1].toLowerCase();
  const extension =
    mimeType === "image/jpeg"
      ? ".jpg"
      : mimeType === "image/svg+xml"
        ? ".svg"
        : `.${mimeType.slice("image/".length)}`;
  return { bytes, mimeType, extension };
}

function normalizedExtension(sourcePath: string, mimeType: string): string {
  const extension = path.extname(sourcePath).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/svg+xml") return ".svg";
  return mimeType.startsWith("image/") ? `.${mimeType.slice(6)}` : ".img";
}

function markerId(value: string | undefined, fallbackIndex: number): string {
  if (value && /^image-\d{3,}$/.test(value)) return value;
  return `image-${String(fallbackIndex).padStart(3, "0")}`;
}

/**
 * Source markup carries indentation that survives element unwrapping, so a
 * short article can serialize as hundreds of kilobytes of runs of spaces and
 * newlines. HTML collapses that whitespace when rendering, so removing it
 * changes no reading evidence while removing the dominant cost of every model
 * call. Text inside preformatted elements keeps its exact bytes.
 */
function collapseInsignificantWhitespace(document: Document): void {
  const showText = document.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = document.createTreeWalker(document.body, showText);
  const textNodes: Node[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    if (node.parentElement?.closest(PREFORMATTED_SELECTOR)) continue;
    const value = node.nodeValue ?? "";
    const collapsed = value.replace(/[ \t\r\n\f\v]+/g, " ");
    if (collapsed !== value) node.nodeValue = collapsed;
  }

  const isBlock = (node: ChildNode | null): boolean =>
    !node ||
    (node.nodeType === 1 &&
      BLOCK_ELEMENTS.has((node as Element).tagName.toLowerCase()));
  for (const node of textNodes) {
    if (!node.parentNode || (node.nodeValue ?? "").trim()) continue;
    if (node.parentElement?.closest(PREFORMATTED_SELECTOR)) continue;
    // Whitespace between two block-level boxes renders as nothing at all.
    if (isBlock(node.previousSibling) && isBlock(node.nextSibling))
      node.parentNode.removeChild(node);
  }
}

function sanitizeDocument(document: Document, baseUrl: string): void {
  document.querySelectorAll(REMOVED_ELEMENTS).forEach((node) => node.remove());
  document
    .querySelectorAll("[hidden], [aria-hidden='true' i]")
    .forEach((node) => node.remove());

  const walker = document.createTreeWalker(
    document.body,
    document.defaultView?.NodeFilter.SHOW_COMMENT ?? 128,
  );
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((comment) => comment.parentNode?.removeChild(comment));

  for (const image of [
    ...document.body.querySelectorAll(IMAGE_LIKE_SELECTOR),
  ]) {
    const id = image.getAttribute("data-ree-image-id");
    const replacement = document.createElement("ree-image");
    const alt = imageLabel(image);
    if (id && /^image-\d{3,}$/.test(id)) {
      replacement.setAttribute("id", id);
      if (alt) replacement.setAttribute("alt", alt.slice(0, 1_000));
      replacement.textContent = `[[REE_IMAGE:${id}]]`;
    } else if (alt) {
      replacement.setAttribute("alt", alt.slice(0, 1_000));
      replacement.textContent = `[Image: ${alt.slice(0, 1_000)}]`;
    }
    image.replaceWith(replacement);
  }

  for (const form of [...document.body.querySelectorAll("form")])
    form.replaceWith(...form.childNodes);

  const elements = [...document.body.querySelectorAll("*")];
  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    if (tag === "ree-image") continue;
    if (!ALLOWED_ELEMENTS.has(tag)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    const allowed = ELEMENT_ATTRIBUTES[tag] ?? new Set<string>();
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (!GLOBAL_ATTRIBUTES.has(name) && !allowed.has(name)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (["href", "cite"].includes(name)) {
        const sanitized = safeUrl(attribute.value, baseUrl);
        if (sanitized) element.setAttribute(name, sanitized);
        else element.removeAttribute(name);
      } else if (
        name === "class" &&
        !/^language-[\w+-]+$/.test(attribute.value)
      ) {
        element.removeAttribute(name);
      } else if (
        ["aria-label", "id", "role"].includes(name) &&
        attribute.value.length > 1_000
      ) {
        element.removeAttribute(name);
      }
    }
  }

  collapseInsignificantWhitespace(document);
}

function sectionLabel(element: Element, index: number): string {
  const heading = compactText(
    element.matches("h1,h2,h3,h4,h5,h6")
      ? element.textContent
      : element.querySelector("h1,h2,h3,h4,h5,h6")?.textContent,
  );
  if (heading) return heading.slice(0, 160);
  const tag = element.tagName.toLowerCase();
  return `${tag === "div" ? "Page section" : tag} ${index}`;
}

function sectionMarkup(node: ChildNode): string {
  return node.nodeType === 3
    ? compactText(node.textContent)
    : (node as Element).outerHTML?.trim() || "";
}

function hasMeaningfulSectionContent(node: ChildNode): boolean {
  if (compactText(node.textContent)) return true;
  if (node.nodeType !== 1) return false;
  const element = node as Element;
  return element.matches("hr") || Boolean(element.querySelector("hr"));
}

function sourceSections(document: Document, prefix: string): SourceSection[] {
  const sections: SourceSection[] = [];
  for (const child of [...document.body.childNodes]) {
    const content = sectionMarkup(child);
    if (!content || !hasMeaningfulSectionContent(child)) continue;
    const markerIds = [
      ...new Set(
        [...content.matchAll(/\[\[REE_IMAGE:(image-\d{3,})\]\]/g)]
          .map((match) => match[1])
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const index = sections.length + 1;
    sections.push({
      id: `${prefix}-${String(index).padStart(3, "0")}`,
      label:
        child.nodeType === 1
          ? sectionLabel(child as Element, index)
          : `Page text ${index}`,
      content,
      attachments: [],
      assetIds: markerIds,
    });
  }
  if (sections.length === 0) {
    sections.push({
      id: `${prefix}-001`,
      label: "Page content",
      content: compactText(document.body.textContent),
      attachments: [],
      assetIds: [],
    });
  }
  return sections;
}

function buildHtmlBundle(
  document: Document,
  baseUrl: string,
  source: SourceBundle["source"],
  prefix: string,
  assets: ExtractionAsset[],
  cleanup: () => Promise<void>,
): SourceBundle {
  const metadata = pageMetadata(document, baseUrl);
  sanitizeDocument(document, baseUrl);
  const sections = sourceSections(document, prefix);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  for (const section of sections) {
    section.attachments = section.assetIds
      .map((id) => assetById.get(id)?.path)
      .filter((assetPath): assetPath is string => Boolean(assetPath));
  }
  return {
    source,
    title: typeof metadata.title === "string" ? metadata.title : undefined,
    metadata,
    sections,
    assets,
    cleanup,
  };
}

async function captureLocalImages(
  document: Document,
  baseUrl: string,
  directory: string,
): Promise<ExtractionAsset[]> {
  const assets: ExtractionAsset[] = [];
  for (const element of [
    ...document.body.querySelectorAll(IMAGE_LIKE_SELECTOR),
  ]) {
    if (assets.length >= MAX_IMAGES || !isMeaningfulImageElement(element))
      continue;
    const id = markerId(undefined, assets.length + 1);
    const alt = imageLabel(element);
    const source = imageSource(element);
    let mimeType: string;
    let extension: string;
    let sourcePath: string | undefined;
    let payload: Buffer | undefined;

    if (element.tagName.toLowerCase() === "svg") {
      mimeType = "image/svg+xml";
      extension = ".svg";
      payload = Buffer.from(element.outerHTML);
    } else if (source?.startsWith("data:")) {
      const decoded = dataImage(source);
      if (!decoded) continue;
      ({ bytes: payload, mimeType, extension } = decoded);
    } else if (source) {
      try {
        const resolved = new URL(source, baseUrl);
        if (resolved.protocol !== "file:") continue;
        sourcePath = fileURLToPath(resolved);
        mimeType = String(mimeLookup(sourcePath) || "application/octet-stream");
        if (!mimeType.startsWith("image/")) continue;
        extension = normalizedExtension(sourcePath, mimeType);
      } catch {
        continue;
      }
    } else {
      continue;
    }

    const destination = path.join(directory, `${id}${extension}`);
    try {
      if (payload) await writeFile(destination, payload);
      else if (sourcePath) await copyFile(sourcePath, destination);
      else continue;
    } catch {
      continue;
    }
    element.setAttribute("data-ree-image-id", id);
    assets.push({
      id,
      mimeType,
      filename: path.basename(destination),
      path: destination,
      alt,
      sourceUrl: source ? safeUrl(source, baseUrl) : undefined,
    });
  }
  return assets;
}

export function alignedHtmlEvidence(
  html: string,
  baseUrl: string,
  prefix = "html-section",
): SourceSection[] {
  const dom = new JSDOM(html, { url: baseUrl });
  sanitizeDocument(dom.window.document, baseUrl);
  return sourceSections(dom.window.document, prefix);
}

export async function gatherHtmlEvidence(
  filePath: string,
  options: WebEvidenceOptions = {},
): Promise<SourceBundle> {
  const temporary = await createPrivateTempDir("ree-html-");
  try {
    const html = await readFile(filePath, "utf8");
    const fileUrl = pathToFileURL(path.resolve(filePath)).href;
    const dom = new JSDOM(html, { url: fileUrl });
    const assets = options.includeImages
      ? await captureLocalImages(dom.window.document, fileUrl, temporary.path)
      : [];
    return buildHtmlBundle(
      dom.window.document,
      fileUrl,
      {
        kind: "html",
        filename: path.basename(filePath),
        mimeType: "text/html",
      },
      "html-section",
      assets,
      temporary.cleanup,
    );
  } catch (error) {
    await temporary.cleanup();
    throw error;
  }
}

export async function gatherHtmlStringEvidence(
  html: string,
  sourceUrl: string | undefined,
  capturedImages: CapturedImage[] = [],
): Promise<SourceBundle> {
  const temporary = await createPrivateTempDir("ree-captured-page-");
  try {
    const baseUrl = sourceUrl || "https://captured.invalid/";
    const dom = new JSDOM(html, { url: baseUrl });
    const document = dom.window.document;
    const imageElements = [
      ...document.body.querySelectorAll(IMAGE_LIKE_SELECTOR),
    ];
    const assets: ExtractionAsset[] = [];
    const usedIds = new Set<string>();

    for (const capturedImage of capturedImages.slice(0, MAX_IMAGES)) {
      const decoded = dataImage(capturedImage.dataUrl);
      if (!decoded) continue;
      let id = markerId(capturedImage.id, assets.length + 1);
      if (usedIds.has(id)) id = markerId(undefined, assets.length + 1);
      while (usedIds.has(id))
        id = markerId(undefined, Number(id.slice("image-".length)) + 1);
      usedIds.add(id);
      const destination = path.join(
        temporary.path,
        `${id}${decoded.extension}`,
      );
      await writeFile(destination, decoded.bytes);
      const sourceImageId = capturedImage.id;
      const element = sourceImageId
        ? imageElements.find(
            (candidate) =>
              candidate.getAttribute("data-ree-image-id") === sourceImageId,
          )
        : imageElements[assets.length];
      element?.setAttribute("data-ree-image-id", id);
      assets.push({
        id,
        mimeType: decoded.mimeType,
        filename: path.basename(destination),
        path: destination,
        alt: capturedImage.alt || capturedImage.label || undefined,
        sourceUrl: capturedImage.sourceUrl
          ? safeUrl(capturedImage.sourceUrl, baseUrl)
          : undefined,
      });
    }

    return buildHtmlBundle(
      document,
      baseUrl,
      sourceUrl
        ? { kind: "webpage", url: sourceUrl, mimeType: "text/html" }
        : { kind: "html", filename: "stdin.html", mimeType: "text/html" },
      sourceUrl ? "page-section" : "html-section",
      assets,
      temporary.cleanup,
    );
  } catch (error) {
    await temporary.cleanup();
    throw error;
  }
}
