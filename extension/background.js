const HOST = "tools.ree.native_host";
const PREFERENCES_KEY = "reePreferences";
const TAB_STATE_PREFIX = "reeTabState:";
const DEFAULT_MODEL = "gpt-5.6-luna";
const MAX_PDF_BYTES = 192 * 1024 * 1024;
const RUNTIME_PROTOCOL_VERSION = 1;
const jobs = new Map();
const stateUpdates = new Map();
let terminalBadge = null;
let terminalBadgeTimer = null;

const initialState = {
  status: "idle",
  stage: "Ready",
  detail: "This tab stays private until you click Extract.",
  progress: 0,
  startedAt: null,
  result: null,
  error: null,
  format: "md",
  fast: false,
  includeImages: true,
  model: DEFAULT_MODEL,
};

function normalizeModelSlug(value) {
  const model = String(value ?? DEFAULT_MODEL).trim();
  const containsControlCharacter = [...model].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!model) throw new Error("Model slug cannot be empty.");
  if (model.length > 200)
    throw new Error("Model slug must be 200 characters or fewer.");
  if (model.startsWith("-") || /\s/.test(model) || containsControlCharacter)
    throw new Error(
      "Model slug cannot start with a hyphen or contain whitespace or control characters.",
    );
  return model;
}

function storedModel(value) {
  try {
    return normalizeModelSlug(value);
  } catch {
    return DEFAULT_MODEL;
  }
}

function normalizeCustomInstructions(value) {
  const instructions = String(value ?? "").trim();
  if (instructions.length > 4_000)
    throw new Error("Custom instructions must be 4,000 characters or fewer.");
  return instructions;
}

function tabStateKey(tabId) {
  return `${TAB_STATE_PREFIX}${tabId}`;
}

async function getPreferences() {
  const stored = await chrome.storage.local.get(PREFERENCES_KEY);
  const preferences = stored[PREFERENCES_KEY] || {};
  return {
    fast: Boolean(preferences.fast),
    includeImages: preferences.includeImages !== false,
    model: storedModel(preferences.model),
  };
}

async function setPreferences(patch) {
  const current = await getPreferences();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [PREFERENCES_KEY]: next });
  return next;
}

async function getTabState(tabId) {
  const key = tabStateKey(tabId);
  const [stored, preferences] = await Promise.all([
    chrome.storage.local.get(key),
    getPreferences(),
  ]);
  const state = stored[key] || {};
  return {
    ...initialState,
    ...preferences,
    ...state,
    model: storedModel(state.model ?? preferences.model),
    tabId,
  };
}

function setTabState(tabId, patch) {
  const previous = stateUpdates.get(tabId) || Promise.resolve();
  const update = previous
    .catch(() => undefined)
    .then(async () => {
      const key = tabStateKey(tabId);
      const current = await getTabState(tabId);
      const next = { ...current, ...patch, tabId };
      await chrome.storage.local.set({ [key]: next });
      chrome.runtime
        .sendMessage({ type: "state-updated", tabId, state: next })
        .catch(() => {});
      return next;
    });
  stateUpdates.set(tabId, update);
  void update.finally(() => {
    if (stateUpdates.get(tabId) === update) stateUpdates.delete(tabId);
  });
  return update;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("REE could not find an active browser tab.");
  return tab;
}

async function tabForMessage(message) {
  if (Number.isInteger(message.tabId) && message.tabId > 0) {
    try {
      const tab = await chrome.tabs.get(message.tabId);
      if (!tab?.id) throw new Error("Missing tab");
      return tab;
    } catch {
      throw new Error("This browser tab is no longer available.");
    }
  }
  return activeTab();
}

async function updateAction(updates) {
  const results = await Promise.allSettled(updates);
  for (const result of results) {
    if (result.status === "rejected")
      console.warn("REE could not update the toolbar status", result.reason);
  }
}

async function renderBadge() {
  const running = jobs.size;
  if (running > 0) {
    const updates = [
      chrome.action.setBadgeText({
        text: running > 99 ? "99+" : String(running),
      }),
      chrome.action.setBadgeBackgroundColor({ color: "#e2b93b" }),
      chrome.action.setTitle({
        title: `${running} REE extraction${running === 1 ? "" : "s"} running`,
      }),
    ];
    if (chrome.action.setBadgeTextColor)
      updates.push(chrome.action.setBadgeTextColor({ color: "#15181a" }));
    await updateAction(updates);
    return;
  }
  if (terminalBadge) {
    const updates = [
      chrome.action.setBadgeText({
        text: terminalBadge.kind === "done" ? "\u2713" : "!",
      }),
      chrome.action.setBadgeBackgroundColor({
        color: terminalBadge.kind === "done" ? "#57a468" : "#c84e3f",
      }),
      chrome.action.setTitle({
        title:
          terminalBadge.kind === "done"
            ? "REE extraction complete"
            : "REE extraction needs attention",
      }),
    ];
    if (chrome.action.setBadgeTextColor)
      updates.push(chrome.action.setBadgeTextColor({ color: "#ffffff" }));
    await updateAction(updates);
    return;
  }
  await updateAction([
    chrome.action.setBadgeText({ text: "" }),
    chrome.action.setTitle({ title: "Extract with REE" }),
  ]);
}

function dismissTerminalBadge() {
  terminalBadge = null;
  if (terminalBadgeTimer) clearTimeout(terminalBadgeTimer);
  terminalBadgeTimer = null;
  return renderBadge();
}

function showTerminalBadge(kind) {
  const notification = { kind };
  terminalBadge = notification;
  if (terminalBadgeTimer) clearTimeout(terminalBadgeTimer);
  terminalBadgeTimer = setTimeout(() => {
    if (terminalBadge !== notification) return;
    terminalBadge = null;
    terminalBadgeTimer = null;
    void renderBadge();
  }, 5_000);
  return renderBadge();
}

async function execute(tabId, functionToRun, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: functionToRun,
    args,
  });
  return results[0]?.result;
}

async function serializePage(tabId, collectImages) {
  return execute(
    tabId,
    async (shouldCollectImages) => {
      const originalScroll = window.scrollY;
      if (document.documentElement.scrollHeight > window.innerHeight * 1.4) {
        window.scrollTo({
          top: document.documentElement.scrollHeight,
          behavior: "instant",
        });
        await new Promise((resolve) => setTimeout(resolve, 120));
        window.scrollTo({ top: originalScroll, behavior: "instant" });
      }
      const clone = document.documentElement.cloneNode(true);
      clone
        .querySelectorAll(
          "script,style,noscript,template,iframe,object,embed,form,input,textarea,select,button",
        )
        .forEach((node) => node.remove());
      clone
        .querySelectorAll('[hidden],[aria-hidden="true"]')
        .forEach((node) => node.remove());

      const originalAssets = [
        ...document.querySelectorAll("picture,img,svg,canvas,video[poster]"),
      ];
      const clonedAssets = [
        ...clone.querySelectorAll("picture,img,svg,canvas,video[poster]"),
      ];
      const assetCandidates = [];
      if (shouldCollectImages) {
        for (let index = 0; index < originalAssets.length; index += 1) {
          const element = originalAssets[index];
          const cloned = clonedAssets[index];
          if (!element || !cloned) continue;
          if (element.tagName === "IMG" && element.closest("picture")) continue;
          if (
            element.closest(
              'header, footer, nav, aside, [role="banner"], [role="navigation"], [role="complementary"], [aria-hidden="true"]',
            )
          )
            continue;
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          const image =
            element.tagName === "PICTURE"
              ? element.querySelector("img")
              : element.tagName === "IMG"
                ? element
                : null;
          const width = Math.max(bounds.width, image?.naturalWidth || 0);
          const height = Math.max(bounds.height, image?.naturalHeight || 0);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity) === 0 ||
            width < 96 ||
            height < 96
          )
            continue;
          const id = `image-${String(assetCandidates.length + 1).padStart(3, "0")}`;
          const caption = element
            .closest("figure")
            ?.querySelector("figcaption");
          const alt = (
            image?.alt ||
            element.getAttribute("aria-label") ||
            ""
          ).trim();
          cloned.setAttribute("data-ree-image-id", id);
          assetCandidates.push({
            id,
            selectorIndex: index,
            label:
              caption?.textContent?.trim().slice(0, 300) ||
              alt.slice(0, 300) ||
              `Page image ${assetCandidates.length + 1}`,
            alt: alt.slice(0, 2_000) || undefined,
          });
          if (assetCandidates.length === 20) break;
        }
      }

      const retainedAttributes = new Set([
        "alt",
        "aria-label",
        "content",
        "data-ree-image-id",
        "datetime",
        "href",
        "itemprop",
        "itemscope",
        "itemtype",
        "lang",
        "name",
        "property",
        "rel",
        "src",
        "srcset",
        "type",
        "width",
        "height",
        "poster",
      ]);
      clone.querySelectorAll("*").forEach((element) => {
        for (const attribute of [...element.attributes]) {
          if (!retainedAttributes.has(attribute.name))
            element.removeAttribute(attribute.name);
        }
      });
      const pdfPlugin = document.querySelector(
        'pdf-viewer, edge-pdf-viewer, embed[type*="pdf" i], object[type*="pdf" i]',
      );
      const pdfViewer =
        document.contentType === "application/pdf" || Boolean(pdfPlugin);
      return {
        html: clone.outerHTML.slice(0, 30_000_000),
        title: document.title,
        url: location.href,
        pdfViewer,
        pdfUrl:
          pdfPlugin?.getAttribute("src") ||
          pdfPlugin?.getAttribute("data") ||
          location.href,
        assetCandidates,
      };
    },
    [collectImages],
  );
}

async function captureMeaningfulImages(tabId, candidates) {
  return (
    (await execute(
      tabId,
      async (requestedCandidates) => {
        const readDataUrl = (blob) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        const load = async (candidate) => {
          const elements = [
            ...document.querySelectorAll(
              "picture,img,svg,canvas,video[poster]",
            ),
          ];
          const element = elements[candidate.selectorIndex];
          if (!element) return null;
          const image =
            element.tagName === "PICTURE"
              ? element.querySelector("img")
              : element.tagName === "IMG"
                ? element
                : null;
          let sourceUrl =
            image?.currentSrc ||
            image?.src ||
            (element.tagName === "VIDEO" ? element.poster : "");
          if (element.tagName === "CANVAS") {
            try {
              return {
                id: candidate.id,
                dataUrl: element.toDataURL("image/png"),
                label: candidate.label,
                alt: candidate.alt,
              };
            } catch {
              return null;
            }
          }
          if (element.tagName === "SVG") {
            const serialized = new XMLSerializer().serializeToString(element);
            const blob = new Blob([serialized], { type: "image/svg+xml" });
            if (blob.size > 10_000_000) return null;
            return {
              id: candidate.id,
              dataUrl: await readDataUrl(blob),
              label: candidate.label,
              alt: candidate.alt,
            };
          }
          if (
            sourceUrl.startsWith("data:image/") &&
            sourceUrl.length <= 14_000_000
          )
            return {
              id: candidate.id,
              dataUrl: sourceUrl,
              label: candidate.label,
              alt: candidate.alt,
            };
          if (!/^https?:|^blob:/.test(sourceUrl)) return null;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 4_000);
          try {
            const response = await fetch(sourceUrl, {
              credentials: "omit",
              cache: "force-cache",
              signal: controller.signal,
            });
            if (!response.ok) return null;
            const blob = await response.blob();
            if (
              ![
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/gif",
                "image/svg+xml",
              ].includes(blob.type) ||
              blob.size > 10_000_000
            )
              return null;
            const url = new URL(sourceUrl, location.href);
            url.username = "";
            url.password = "";
            url.search = "";
            url.hash = "";
            return {
              id: candidate.id,
              dataUrl: await readDataUrl(blob),
              label: candidate.label,
              alt: candidate.alt,
              sourceUrl: ["http:", "https:"].includes(url.protocol)
                ? url.href
                : undefined,
            };
          } catch {
            return null;
          } finally {
            clearTimeout(timeout);
          }
        };
        const loaded = await Promise.all(requestedCandidates.map(load));
        const seen = new Set();
        return loaded.filter((asset) => {
          if (!asset || seen.has(asset.dataUrl)) return false;
          seen.add(asset.dataUrl);
          return true;
        });
      },
      [candidates],
    )) || []
  );
}

function pdfSourceForTab(tab, requirePdfHint = true) {
  const title = String(tab.title || "").trim();
  for (const rawCandidate of [tab.url, tab.pendingUrl]) {
    let candidate = rawCandidate || "";
    try {
      const visibleUrl = new URL(candidate);
      if (
        ["chrome-extension:", "edge-extension:", "chrome-untrusted:"].includes(
          visibleUrl.protocol,
        )
      ) {
        candidate =
          ["file", "url", "src"]
            .map((key) => visibleUrl.searchParams.get(key))
            .find(Boolean) || "";
      }
      const sourceUrl = new URL(candidate);
      if (!["http:", "https:", "file:"].includes(sourceUrl.protocol)) continue;
      const hasPdfHint =
        /\.pdf$/i.test(decodeURIComponent(sourceUrl.pathname)) ||
        /\.pdf(?:\s|$)/i.test(title);
      if (requirePdfHint && !hasPdfHint) continue;
      sourceUrl.hash = "";
      return {
        kind: "pdf",
        url: sourceUrl.href,
        browserFetch:
          ["http:", "https:"].includes(visibleUrl.protocol) &&
          ["http:", "https:"].includes(sourceUrl.protocol),
        title:
          title.replace(/\s+-\s+.*PDF Viewer.*$/i, "").trim() ||
          decodeURIComponent(sourceUrl.pathname.split("/").pop() || "") ||
          "PDF document",
      };
    } catch {
      continue;
    }
  }
  return null;
}

async function capturePdfTab(source, format, fast, includeImages, model, job) {
  await setTabState(job.tabId, {
    status: "working",
    stage: "Reading PDF",
    detail: "Passing the selected PDF to the local document reader…",
    progress: 18,
    startedAt: Date.now(),
    error: null,
    result: null,
    format,
    fast,
    includeImages,
    model,
  });
  if (job.abortController.signal.aborted)
    throw new Error("Extraction cancelled");
  const { browserFetch, ...pdfSource } = source;
  if (!browserFetch) return pdfSource;
  const response = await fetch(source.url, {
    cache: "no-store",
    credentials: "include",
    headers: { accept: "application/pdf" },
    redirect: "follow",
    signal: job.abortController.signal,
  });
  if (!response.ok)
    throw new Error(
      `The selected PDF could not be loaded (HTTP ${response.status}).`,
    );
  const blob = await response.blob();
  if (blob.size === 0) throw new Error("The selected PDF is empty.");
  if (blob.size > MAX_PDF_BYTES)
    throw new Error("The selected PDF exceeds REE’s 192 MB limit.");
  const header = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  if (header.length !== 5 || String.fromCharCode(...header) !== "%PDF-")
    throw new Error("The selected browser tab did not return a PDF file.");
  return { ...pdfSource, kind: "pdf-upload", blob };
}

async function capturePage(tab, format, fast, includeImages, model, job) {
  if (!tab.id || !tab.windowId) {
    throw new Error("REE could not identify the current browser tab.");
  }
  const collectImages = format === "pdf" && includeImages;
  const hintedPdf = pdfSourceForTab(tab);
  if (hintedPdf)
    return capturePdfTab(hintedPdf, format, fast, includeImages, model, job);
  if (!/^https?:/.test(tab.url || "")) {
    throw new Error(
      "REE can extract webpages and PDF tabs. Browser settings and other extension pages cannot be captured.",
    );
  }
  await setTabState(job.tabId, {
    status: "working",
    stage: "Reading page",
    detail: "Collecting the document structure without taking page snapshots…",
    progress: 6,
    startedAt: Date.now(),
    error: null,
    result: null,
    format,
    fast,
    includeImages,
    model,
  });
  let capture;
  try {
    capture = await serializePage(tab.id, collectImages);
  } catch (error) {
    if (job.abortController.signal.aborted)
      throw new Error("Extraction cancelled");
    const pdfSource = pdfSourceForTab(tab, false);
    if (pdfSource)
      return capturePdfTab(pdfSource, format, fast, includeImages, model, job);
    throw error;
  }
  if (job.abortController.signal.aborted)
    throw new Error("Extraction cancelled");
  if (!capture) throw new Error("The page did not return document evidence.");
  if (capture.pdfViewer) {
    const pdfSource = pdfSourceForTab(
      {
        url: capture.pdfUrl || capture.url,
        pendingUrl: tab.url,
        title: capture.title || tab.title,
      },
      false,
    );
    if (!pdfSource)
      throw new Error(
        "REE found Chromium’s PDF viewer but could not resolve the original PDF address.",
      );
    return capturePdfTab(pdfSource, format, fast, includeImages, model, job);
  }
  const images = collectImages
    ? await captureMeaningfulImages(tab.id, capture.assetCandidates)
    : [];
  if (job.abortController.signal.aborted)
    throw new Error("Extraction cancelled");
  const {
    assetCandidates: _assetCandidates,
    pdfViewer: _pdfViewer,
    pdfUrl: _pdfUrl,
    ...page
  } = capture;
  await setTabState(job.tabId, {
    stage: "Preparing evidence",
    detail: collectImages
      ? `Document ready with ${images.length} meaningful image${images.length === 1 ? "" : "s"}.`
      : `Document ready for ${format.toUpperCase()} extraction.`,
    progress: 18,
  });
  return { ...page, images };
}

function progressFor(stage, current, total) {
  const ratio = total ? Math.min(1, Math.max(0, (current || 0) / total)) : 0;
  if (stage === "extracting") return total ? 24 + ratio * 66 : 28;
  if (stage === "rendering") return 94;
  return 24;
}

function connectNative(job) {
  const port = chrome.runtime.connectNative(HOST);
  job.port = port;
  port.onDisconnect.addListener(() => {
    if (job.port !== port || job.settled || job.cancelled) return;
    const detail =
      chrome.runtime.lastError?.message || "The REE native host disconnected.";
    void settleJob(
      job,
      {
        status: "error",
        stage: "Bridge unavailable",
        detail: `${detail} Run: ree setup-extension`,
        error: detail,
      },
      "error",
    );
  });
  port.onMessage.addListener((message) => {
    if (message.id !== job.id || job.settled || job.cancelled) return;
    if (message.type === "model-delta") {
      chrome.runtime
        .sendMessage({
          type: "model-delta",
          tabId: job.tabId,
          kind: message.kind,
          delta: message.delta,
          current: message.current,
          total: message.total,
        })
        .catch(() => {});
    } else if (message.type === "progress") {
      const nextProgress = progressFor(
        message.stage,
        message.current,
        message.total,
      );
      if (nextProgress < job.progress) return;
      job.progress = nextProgress;
      setTabState(job.tabId, {
        status: "working",
        stage: message.message,
        detail: stageDetail(message.stage, message.current, message.total),
        progress: nextProgress,
      });
    } else if (message.type === "complete") {
      job.progress = 100;
      void getTabState(job.tabId).then((state) => {
        if (
          !["txt", "md", "pdf"].includes(message.format) ||
          !message.outputPath
        ) {
          return settleJob(
            job,
            {
              status: "error",
              stage: "Extraction failed",
              detail: "The local bridge did not return an output file.",
              error: "Missing extraction output path",
            },
            "error",
          );
        }
        return settleJob(
          job,
          {
            status: "done",
            stage: "Extraction complete",
            detail: message.title,
            progress: 100,
            result: {
              format: message.format,
              outputPath: message.outputPath,
              title: message.title,
            },
            error: null,
          },
          "done",
        );
      });
    } else if (message.type === "error") {
      void settleJob(
        job,
        {
          status: "error",
          stage: "Extraction failed",
          detail: message.message,
          error: message.message,
        },
        "error",
      );
    }
  });
  return port;
}

async function settleJob(job, state, badgeKind) {
  if (job.settled) return;
  job.settled = true;
  jobs.delete(job.tabId);
  try {
    await setTabState(job.tabId, state).catch(() => undefined);
    await showTerminalBadge(badgeKind).catch(() => undefined);
  } finally {
    const port = job.port;
    job.port = null;
    port?.disconnect();
  }
}

async function cancelJob(tabId) {
  const job = jobs.get(tabId);
  if (!job) {
    const state = await getTabState(tabId);
    if (state.status !== "working") return state;
    return resetTabState(tabId, "Extraction cancelled. You can start again.");
  }
  job.cancelled = true;
  job.settled = true;
  jobs.delete(tabId);
  job.abortController.abort();
  const port = job.port;
  job.port = null;
  port?.disconnect();
  const state = await resetTabState(
    tabId,
    "Extraction cancelled. You can start again.",
  );
  await renderBadge();
  return state;
}

function stageDetail(stage, current, total) {
  if (total && total > 1) return `${current || 0} of ${total} parts complete`;
  return (
    {
      extracting: "The selected model is reconstructing the article body…",
      rendering: "Creating the selected local output…",
    }[stage] || "Working locally through your Codex session…"
  );
}

async function runExtraction(
  tab,
  job,
  format,
  fast,
  includeImages,
  requestedModel,
  requestedCustomInstructions,
) {
  if (!["txt", "md", "pdf"].includes(format))
    throw new Error("Choose TXT, Markdown, or PDF output.");
  const model = normalizeModelSlug(requestedModel);
  const customInstructions = normalizeCustomInstructions(
    requestedCustomInstructions,
  );
  const source = await capturePage(
    tab,
    format,
    fast,
    includeImages,
    model,
    job,
  );
  if (job.abortController.signal.aborted)
    throw new Error("Extraction cancelled");
  job.progress = 22;
  await setTabState(job.tabId, {
    status: "working",
    stage: `Reading with ${model}${fast ? " — Fast" : ""}`,
    detail: fast
      ? "Using Codex Fast inference for this page—not your browser credentials…"
      : "Sending this page—not your browser credentials—to the local REE host…",
    progress: 22,
  });
  if (job.abortController.signal.aborted)
    throw new Error("Extraction cancelled");
  const port = connectNative(job);
  const id = job.id;
  if (source.kind === "pdf-upload") {
    port.postMessage({
      id,
      type: "extract-pdf-begin",
      totalBytes: source.blob.size,
      url: source.url,
      title: source.title,
      options: {
        format,
        fast,
        includeImages: format === "pdf" && includeImages,
        model,
        customInstructions,
      },
    });
    const maximumBytes = 512_000;
    let index = 0;
    for (let offset = 0; offset < source.blob.size; offset += maximumBytes) {
      const bytes = new Uint8Array(
        await source.blob.slice(offset, offset + maximumBytes).arrayBuffer(),
      );
      let binary = "";
      for (let start = 0; start < bytes.length; start += 32_768) {
        binary += String.fromCharCode(...bytes.subarray(start, start + 32_768));
      }
      port.postMessage({
        id,
        type: "extract-pdf-chunk",
        index,
        data: btoa(binary),
      });
      index += 1;
    }
    port.postMessage({ id, type: "extract-commit" });
    return;
  }

  const payload = JSON.stringify(source);
  const totalBytes = new Blob([payload]).size;
  if (totalBytes > 256_000_000)
    throw new Error(
      "This page capture exceeds REE’s 256 MB local bridge limit. Try the article’s print view or save it as PDF first.",
    );
  port.postMessage({
    id,
    type: "extract-begin",
    totalBytes,
    options: {
      format,
      fast,
      includeImages: format === "pdf" && includeImages,
      model,
      customInstructions,
    },
  });
  let offset = 0;
  let index = 0;
  const maximumCharacters = 750_000;
  while (offset < payload.length) {
    let end = Math.min(payload.length, offset + maximumCharacters);
    const finalCharacter = payload.charCodeAt(end - 1);
    if (finalCharacter >= 0xd800 && finalCharacter <= 0xdbff) end -= 1;
    port.postMessage({
      id,
      type: "extract-chunk",
      index,
      data: payload.slice(offset, end),
    });
    offset = end;
    index += 1;
  }
  port.postMessage({ id, type: "extract-commit" });
}

async function nativeRequest(request) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(HOST);
    port.onMessage.addListener((response) => {
      if (response.id !== request.id) return;
      port.disconnect();
      if (response.type === "error") reject(new Error(response.message));
      else resolve(response);
    });
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError)
        reject(new Error(chrome.runtime.lastError.message));
    });
    port.postMessage(request);
  });
}

async function readOutput(outputPath) {
  let offset = 0;
  let content = "";
  while (true) {
    const response = await nativeRequest({
      id: crypto.randomUUID(),
      type: "read-output",
      path: outputPath,
      offset,
      length: 120_000,
    });
    content += response.data;
    if (response.done) return content;
    offset = response.nextOffset;
  }
}

async function resetTabState(tabId, detail = initialState.detail) {
  const state = await getTabState(tabId);
  const resetState = {
    ...initialState,
    detail,
    format: ["txt", "md", "pdf"].includes(state.format) ? state.format : "md",
    fast: Boolean(state.fast),
    includeImages: state.includeImages !== false,
    model: storedModel(state.model),
    tabId,
  };
  return setTabState(tabId, resetState);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const tab = await tabForMessage(message);
    if (message.type === "get-state") {
      await dismissTerminalBadge();
      return {
        ...(await getTabState(tab.id)),
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      };
    }
    if (message.type === "start-extraction") {
      if (jobs.has(tab.id))
        throw new Error("An extraction is already running for this tab.");
      const preferences = await getPreferences();
      await setPreferences({
        fast: Boolean(message.fast),
        includeImages: message.includeImages !== false,
        model: normalizeModelSlug(message.model ?? preferences.model),
      });
      const job = {
        id: crypto.randomUUID(),
        tabId: tab.id,
        port: null,
        progress: 0,
        settled: false,
        cancelled: false,
        abortController: new AbortController(),
      };
      jobs.set(tab.id, job);
      await renderBadge();
      void runExtraction(
        tab,
        job,
        message.format || "md",
        Boolean(message.fast),
        message.includeImages !== false,
        message.model ?? preferences.model,
        message.customInstructions,
      ).catch(async (error) => {
        if (job.cancelled || job.settled) return;
        await settleJob(
          job,
          {
            status: "error",
            stage: "Couldn’t extract this page",
            detail:
              error?.name === "AbortError"
                ? "Extraction cancelled"
                : error.message,
            error:
              error?.name === "AbortError"
                ? "Extraction cancelled"
                : error.message,
          },
          "error",
        );
      });
      return { accepted: true };
    }
    if (message.type === "set-model") {
      const model = normalizeModelSlug(message.model);
      await setPreferences({ model });
      return setTabState(tab.id, { model });
    }
    if (message.type === "cancel-extraction") return cancelJob(tab.id);
    if (message.type === "reset") return resetTabState(tab.id);
    if (message.type === "open-output-folder")
      return nativeRequest({
        id: crypto.randomUUID(),
        type: "open-output-folder",
      });
    const state = await getTabState(tab.id);
    if (!state.result) throw new Error("No extraction is available yet.");
    if (message.type === "copy") {
      if (state.result.format === "pdf")
        throw new Error("PDF output cannot be copied as text.");
      return { content: await readOutput(state.result.outputPath) };
    }
    if (message.type === "open-folder")
      return nativeRequest({
        id: crypto.randomUUID(),
        type: "open-folder",
        path: state.result.outputPath,
      });
    if (message.type === "open-output")
      return nativeRequest({
        id: crypto.randomUUID(),
        type: "open-output",
        path: state.result.outputPath,
      });
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message }));
  return true;
});

void renderBadge().catch(() => undefined);
