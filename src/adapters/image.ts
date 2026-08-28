import { chmod, copyFile } from "node:fs/promises";
import path from "node:path";
import { loadImage } from "@napi-rs/canvas";
import type { SourceBundle, SourceSection } from "../core/types.js";
import { createPrivateTempDir } from "../core/temp.js";

export const supportedImageExtensions = new Set([
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);

const extensionByMimeType: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export interface ImageSource {
  path: string;
  mimeType: string;
}

export interface ImageSourceOptions {
  galleryName?: string;
  forceGallery?: boolean;
}

export async function gatherImageSource(
  images: ImageSource[],
  options: ImageSourceOptions = {},
): Promise<SourceBundle> {
  if (images.length === 0) throw new Error("Image gallery contains no images");
  const temporary = await createPrivateTempDir("ree-images-");
  try {
    const sections: SourceSection[] = [];
    const imageMetadata: Array<Record<string, unknown>> = [];
    for (const [index, source] of images.entries()) {
      let decoded: Awaited<ReturnType<typeof loadImage>>;
      try {
        decoded = await loadImage(source.path);
      } catch (error) {
        throw new Error(
          `Could not decode image ${path.basename(source.path)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const position = index + 1;
      const extension = extensionByMimeType[source.mimeType] ?? ".img";
      const attachmentPath = path.join(
        temporary.path,
        `image-${String(position).padStart(4, "0")}${extension}`,
      );
      await copyFile(source.path, attachmentPath);
      await chmod(attachmentPath, 0o600);
      const filename = path.basename(source.path);
      const displayFilename = [...filename]
        .map((character) => {
          const code = character.charCodeAt(0);
          return code <= 31 || code === 127 ? " " : character;
        })
        .join("");
      sections.push({
        id: `image-${String(position).padStart(4, "0")}`,
        label: `Image ${position} of ${images.length}: ${displayFilename}`,
        content: `Photographed document page ${position} of ${images.length}. Source filename: ${JSON.stringify(filename)}. No text layer is available.`,
        attachments: [attachmentPath],
        assetIds: [],
      });
      imageMetadata.push({
        position,
        filename,
        mimeType: source.mimeType,
        width: decoded.width,
        height: decoded.height,
      });
    }

    const isGallery = options.forceGallery === true || images.length > 1;
    return {
      source: {
        kind: isGallery ? "image-gallery" : "image",
        filename:
          options.galleryName ??
          (images.length === 1 ? path.basename(images[0]!.path) : "gallery"),
        mimeType: isGallery ? "image/*" : images[0]!.mimeType,
        imageCount: images.length,
      },
      metadata: { images: imageMetadata },
      sections,
      assets: [],
      cleanup: temporary.cleanup,
    };
  } catch (error) {
    await temporary.cleanup();
    throw error;
  }
}
