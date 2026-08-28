import { createHash } from "node:crypto";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import type { ExtractionAsset, SourceBundle } from "../core/types.js";
import { createPrivateTempDir } from "../core/temp.js";
import { launchChromium } from "./browser.js";
import { gatherHtmlStringEvidence, type CapturedImage } from "./html.js";
import type { WebEvidenceOptions } from "./index.js";

const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 15_000_000;
const reusableRemoteTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export function sanitizeRemoteAssetUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.href.slice(0, 4_096);
  } catch {
    return undefined;
  }
}

export async function gatherWebpageEvidence(
  url: string,
  options: WebEvidenceOptions = {},
): Promise<SourceBundle> {
  const temporary = await createPrivateTempDir("ree-web-");
  let browser: Awaited<ReturnType<typeof launchChromium>> | undefined;
  let capturedBundle: SourceBundle | undefined;
  try {
    browser = await launchChromium();
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    });
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!response || response.status() >= 400)
      throw new Error(
        `Webpage request failed with HTTP ${response?.status() ?? "unknown"}: ${url}`,
      );

    await page.evaluate(async () => {
      const originalScroll = window.scrollY;
      const maximum = Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight,
      );
      const steps = Math.min(
        10,
        Math.max(1, Math.ceil(maximum / window.innerHeight)),
      );
      for (let step = 1; step <= steps; step += 1) {
        window.scrollTo({ top: (maximum * step) / steps, behavior: "instant" });
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      window.scrollTo({ top: originalScroll, behavior: "instant" });
    });
    await page.waitForTimeout(80);

    const imageCandidates = options.includeImages
      ? await page.evaluate((maximumImages) => {
          const candidates = [
            ...document.querySelectorAll(
              "picture, img:not(picture img), svg, canvas, video[poster]",
            ),
          ];
          const results: Array<{
            id: string;
            alt: string;
            label: string;
            sourceUrl: string;
          }> = [];
          for (const element of candidates) {
            if (results.length >= maximumImages) break;
            const htmlElement = element as HTMLElement;
            if (
              htmlElement.closest(
                'header, footer, nav, aside, [role="banner"], [role="navigation"], [role="complementary"], [aria-hidden="true"]',
              )
            )
              continue;
            const style = getComputedStyle(htmlElement);
            const bounds = htmlElement.getBoundingClientRect();
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              Number(style.opacity) === 0 ||
              bounds.width < 32 ||
              bounds.height < 32 ||
              !htmlElement.getClientRects().length
            )
              continue;
            const id = `image-${String(results.length + 1).padStart(3, "0")}`;
            htmlElement.setAttribute("data-ree-image-id", id);
            const nestedImage = element.querySelector(
              "img",
            ) as HTMLImageElement | null;
            const image =
              element instanceof HTMLImageElement ? element : nestedImage;
            const alt =
              image?.alt ||
              element.getAttribute("aria-label") ||
              element.getAttribute("title") ||
              "";
            const caption =
              element
                .closest("figure")
                ?.querySelector("figcaption")
                ?.textContent?.replace(/\s+/g, " ")
                .trim() || "";
            const video = element as HTMLVideoElement;
            results.push({
              id,
              alt,
              label: alt || caption || `Page image ${results.length + 1}`,
              sourceUrl: image?.currentSrc || image?.src || video.poster || "",
            });
          }
          return results;
        }, MAX_IMAGES)
      : [];

    if (imageCandidates.length > 0) {
      await page.evaluate(async () => {
        const images = [
          ...document.querySelectorAll<HTMLImageElement>(
            "[data-ree-image-id] img, img[data-ree-image-id]",
          ),
        ];
        await Promise.race([
          Promise.all(
            images.map(async (image) => {
              try {
                await image.decode();
              } catch {
                // The screenshot timeout below remains the final bound for
                // unavailable or broken resources.
              }
            }),
          ),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
      });
    }

    const capturedImages: CapturedImage[] = [];
    const capturedHashes = new Set<string>();
    for (const candidate of imageCandidates) {
      try {
        let data: Buffer | undefined;
        let mimeType = "image/jpeg";
        if (candidate.sourceUrl) {
          try {
            const remote = new URL(candidate.sourceUrl);
            if (["http:", "https:"].includes(remote.protocol)) {
              remote.username = "";
              remote.password = "";
              const response = await page.context().request.get(remote.href, {
                timeout: 5_000,
              });
              const responseType = (response.headers()["content-type"] ?? "")
                .split(";", 1)[0]
                ?.trim()
                .toLowerCase();
              const declaredLength = Number(
                response.headers()["content-length"] ?? 0,
              );
              if (
                response.ok() &&
                responseType &&
                reusableRemoteTypes.has(responseType) &&
                (!declaredLength || declaredLength <= MAX_IMAGE_BYTES)
              ) {
                const responseBody = await response.body();
                if (
                  responseBody.length > 0 &&
                  responseBody.length <= MAX_IMAGE_BYTES
                ) {
                  data = responseBody;
                  mimeType = responseType;
                }
              }
            }
          } catch {
            // Fall back to a bounded element screenshot below.
          }
        }
        data ??= await page
          .locator(`[data-ree-image-id="${candidate.id}"]`)
          .screenshot({
            animations: "disabled",
            timeout: 500,
            type: "jpeg",
            quality: 86,
          });
        const digest = createHash("sha256").update(data).digest("hex");
        if (capturedHashes.has(digest)) {
          await page.evaluate((id) => {
            document
              .querySelector(`[data-ree-image-id="${id}"]`)
              ?.removeAttribute("data-ree-image-id");
          }, candidate.id);
          continue;
        }
        capturedHashes.add(digest);
        capturedImages.push({
          id: candidate.id,
          dataUrl: `data:${mimeType};base64,${data.toString("base64")}`,
          label: candidate.label,
          alt: candidate.alt || undefined,
          sourceUrl: sanitizeRemoteAssetUrl(candidate.sourceUrl),
        });
      } catch {
        await page.evaluate((id) => {
          document
            .querySelector(`[data-ree-image-id="${id}"]`)
            ?.removeAttribute("data-ree-image-id");
        }, candidate.id);
      }
    }

    const html = await page.evaluate(() => document.documentElement.outerHTML);
    capturedBundle = await gatherHtmlStringEvidence(html, url, capturedImages);
    const assetCopies: ExtractionAsset[] = [];
    for (const asset of capturedBundle.assets) {
      const destination = path.join(temporary.path, asset.filename);
      await copyFile(asset.path, destination);
      assetCopies.push({ ...asset, path: destination });
    }
    const paths = new Map(assetCopies.map((asset) => [asset.id, asset.path]));
    return {
      ...capturedBundle,
      assets: assetCopies,
      sections: capturedBundle.sections.map((section) => ({
        ...section,
        attachments: section.assetIds
          .map((id) => paths.get(id))
          .filter((assetPath): assetPath is string => Boolean(assetPath)),
      })),
      cleanup: async () => {
        await capturedBundle?.cleanup();
        await temporary.cleanup();
      },
    };
  } catch (error) {
    await capturedBundle?.cleanup();
    await temporary.cleanup();
    throw error;
  } finally {
    await browser?.close();
  }
}
