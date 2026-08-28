import type {
  ExtractionAsset,
  ExtractionChunk,
  SourceBundle,
  SourceSection,
} from "../core/types.js";

/** Ceiling on the markup handed to one model call. Bounds prompt size. */
export const MAX_SOURCE_CHARACTERS = 120_000;
/**
 * Ceiling on the readable text in one model call. The model reproduces that
 * text, so this — not the markup size — is what decides how long a call runs
 * and whether it survives the model timeout.
 */
export const MAX_OUTPUT_CHARACTERS = 30_000;
export const MAX_VISUAL_ATTACHMENTS = 20;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function visibleTextLength(content: string): number {
  return content
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/**
 * Markup density varies by two orders of magnitude between a plain essay and a
 * reference page, so one raw-character limit either splits dense prose far too
 * late or splits sparse markup far too often. Derive the raw budget from how
 * much readable text this specific markup carries.
 */
function rawBudgetFor(content: string): number {
  const density = visibleTextLength(content) / Math.max(1, content.length);
  return Math.min(
    MAX_SOURCE_CHARACTERS,
    Math.max(
      4_000,
      Math.floor(MAX_OUTPUT_CHARACTERS / Math.max(density, 0.01)),
    ),
  );
}

/**
 * A split part that carries no words and no standalone visual element has
 * nothing for the model to reproduce. Sending it wastes a full model call and
 * invites an empty completion, which used to fail the whole extraction.
 */
export function hasRenderableContent(content: string): boolean {
  if (content.replace(/<[^>]*>/g, " ").trim().length > 0) return true;
  return /<(?:hr|img|ree-image)\b/i.test(content);
}

function splitContent(content: string): string[] {
  const budget = rawBudgetFor(content);
  if (content.length <= budget) return [content];
  const parts: string[] = [];
  let offset = 0;
  while (offset < content.length) {
    const hardEnd = Math.min(content.length, offset + budget);
    let end = hardEnd;
    if (hardEnd < content.length) {
      const minimum = offset + Math.floor(budget * 0.6);
      const boundaries = [
        content.lastIndexOf("\n\n", hardEnd),
        content.lastIndexOf("</", hardEnd),
        content.lastIndexOf("\n", hardEnd),
      ];
      const natural = Math.max(...boundaries);
      if (natural >= minimum) {
        if (content.startsWith("\n\n", natural)) end = natural + 2;
        else if (content.startsWith("</", natural)) {
          const tagEnd = content.indexOf(">", natural + 2);
          if (tagEnd >= natural && tagEnd < hardEnd) end = tagEnd + 1;
          else end = natural;
        } else end = natural + 1;
      }
    }
    parts.push(content.slice(offset, end));
    offset = end;
  }
  return parts;
}

function groups<T>(values: T[], maximum: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += maximum)
    result.push(values.slice(index, index + maximum));
  return result;
}

function normalizeSection(
  section: SourceSection,
  assetsById: ReadonlyMap<string, ExtractionAsset>,
): SourceSection[] {
  const knownAssets = section.assetIds
    .map((id) => assetsById.get(id))
    .filter((asset): asset is ExtractionAsset => Boolean(asset));
  const attachments = unique(section.attachments);
  const contentParts = splitContent(section.content);
  const attachmentGroups = groups(attachments, MAX_VISUAL_ATTACHMENTS);
  const partCount = Math.max(1, contentParts.length, attachmentGroups.length);
  return Array.from({ length: partCount }, (_, index) => {
    const partAttachments = attachmentGroups[index] ?? [];
    const attachmentSet = new Set(partAttachments);
    return {
      id: partCount === 1 ? section.id : `${section.id}-part-${index + 1}`,
      label:
        partCount === 1
          ? section.label
          : `${section.label} (part ${index + 1} of ${partCount})`,
      content: contentParts[index] ?? "",
      attachments: partAttachments,
      assetIds: knownAssets
        .filter((asset) => attachmentSet.has(asset.path))
        .map((asset) => asset.id),
    };
  }).filter(
    (part) => part.attachments.length > 0 || hasRenderableContent(part.content),
  );
}

function makeChunk(
  bundle: SourceBundle,
  sections: SourceSection[],
): Omit<ExtractionChunk, "index" | "total"> {
  const assetIds = new Set(sections.flatMap((section) => section.assetIds));
  return {
    source: bundle.source,
    title: bundle.title,
    metadata: bundle.metadata,
    sections,
    assets: bundle.assets.filter((asset) => assetIds.has(asset.id)),
    attachments: unique(sections.flatMap((section) => section.attachments)),
  };
}

/** Split source-order sections without overlap at fixed model resource limits. */
export function chunkSource(bundle: SourceBundle): ExtractionChunk[] {
  const assetsById = new Map(bundle.assets.map((asset) => [asset.id, asset]));
  const sections = bundle.sections.flatMap((section) =>
    normalizeSection(section, assetsById),
  );
  if (sections.length === 0) return [];

  const chunkSections: SourceSection[][] = [];
  let current: SourceSection[] = [];
  let characters = 0;
  let textCharacters = 0;
  let attachments = 0;

  for (const section of sections) {
    const nextCharacters = section.content.length;
    const nextText = visibleTextLength(section.content);
    const nextAttachments = section.attachments.length;
    if (
      current.length > 0 &&
      (characters + nextCharacters > MAX_SOURCE_CHARACTERS ||
        textCharacters + nextText > MAX_OUTPUT_CHARACTERS ||
        attachments + nextAttachments > MAX_VISUAL_ATTACHMENTS)
    ) {
      chunkSections.push(current);
      current = [];
      characters = 0;
      textCharacters = 0;
      attachments = 0;
    }
    current.push(section);
    characters += nextCharacters;
    textCharacters += nextText;
    attachments += nextAttachments;
  }
  if (current.length > 0) chunkSections.push(current);

  return chunkSections.map((group, index) => ({
    ...makeChunk(bundle, group),
    index,
    total: chunkSections.length,
  }));
}
