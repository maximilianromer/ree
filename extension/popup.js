const panels = ["idle", "working", "done", "error"];
const DEFAULT_MODEL = "gpt-5.6-luna";
const REQUIRED_RUNTIME_PROTOCOL_VERSION = 1;
const toast = document.querySelector("#toast");
const modelStream = document.querySelector("#model-stream");
let currentStreamKind = null;
let currentTabId = null;

function clearModelStream() {
  modelStream.replaceChildren();
  currentStreamKind = null;
}

function appendModelDelta(kind, delta) {
  if (!delta || !["output", "reasoning"].includes(kind)) return;
  let block = modelStream.lastElementChild;
  if (!block || currentStreamKind !== kind) {
    block = document.createElement(kind === "reasoning" ? "i" : "span");
    block.className = `model-stream-${kind}`;
    modelStream.append(block);
    currentStreamKind = kind;
  }
  block.append(document.createTextNode(delta));
  modelStream.scrollTop = modelStream.scrollHeight;
}
const previewState = new URLSearchParams(location.search).get("state");
const isExtensionRuntime = Boolean(globalThis.chrome?.runtime?.id);
const previewStates = {
  working: {
    status: "working",
    stage: "Reading with gpt-5.6-luna",
    detail: "The selected model is reconstructing the article body…",
    progress: 64,
    startedAt: Date.now() - 42_000,
    result: null,
    error: null,
  },
  done: {
    status: "done",
    stage: "Extraction complete",
    detail: "Signals Beneath the Salt",
    result: {
      title: "Signals Beneath the Salt",
      format: "md",
      outputPath: "/preview/article.md",
    },
    error: null,
  },
  "done-pdf": {
    status: "done",
    stage: "Extraction complete",
    detail: "Signals Beneath the Salt",
    result: {
      title: "Signals Beneath the Salt",
      format: "pdf",
      outputPath: "/preview/article.pdf",
    },
    error: null,
  },
  error: {
    status: "error",
    stage: "Local bridge unavailable",
    detail:
      "The REE native host was not found. Run the setup command below, then reload the extension.",
    result: null,
    error: "Native host not found",
  },
};
const extensionRuntime = globalThis.chrome?.runtime || {
  sendMessage: async (message) =>
    message.type === "get-state"
      ? previewStates[previewState] || {
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
        }
      : { accepted: true },
  onMessage: { addListener: () => undefined },
};

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2200);
}

function render(state) {
  panels.forEach((id) =>
    document
      .querySelector(`#${id}`)
      .classList.toggle("hidden", id !== state.status),
  );
  if (state.status === "idle") {
    document.querySelector("#fast").checked = Boolean(state.fast);
    document.querySelector("#include-images").checked = Boolean(
      state.includeImages !== false,
    );
    document.querySelector("#model").value = state.model || DEFAULT_MODEL;
    const format = ["txt", "md", "pdf"].includes(state.format)
      ? state.format
      : "md";
    document.querySelector(`input[name="format"][value="${format}"]`).checked =
      true;
    renderFormat(format);
  }
  if (state.status === "working") {
    document.querySelector("#stage").textContent = state.stage;
    document.querySelector("#detail").textContent = state.detail;
    const progress = Math.max(0, Math.min(100, Number(state.progress) || 0));
    document.querySelector("#progress-fill").style.width = `${progress}%`;
    document.querySelector("#progress-value").textContent =
      `${Math.round(progress)}%`;
    const rail = document.querySelector("#progress-rail");
    rail.setAttribute("aria-valuenow", String(Math.round(progress)));
    rail.dataset.startedAt = state.startedAt || "";
  } else if (state.status === "done") {
    document.querySelector("#result-title").textContent =
      state.result?.title || "Extraction complete";
    renderResultActions(state.result);
  } else if (state.status === "error") {
    document.querySelector("#error-title").textContent =
      state.stage || "REE couldn’t finish";
    document.querySelector("#error-detail").textContent = state.detail;
    document
      .querySelector("#setup-command")
      .classList.toggle(
        "hidden",
        !/native host|bridge|not found|disconnected/i.test(state.detail || ""),
      );
  }
}

const formatDescriptions = {
  txt: "Plain body text without markup.",
  md: "Structured text with formatting.",
  pdf: "Formatted document with optional images.",
};

function renderFormat(format) {
  document.querySelector("#format-detail").textContent =
    formatDescriptions[format];
  document
    .querySelector("#image-options")
    .classList.toggle("hidden", format !== "pdf");
}

function renderResultActions(result = {}) {
  const format = result.format || "md";
  const isPdf = format === "pdf";
  const label =
    format === "txt" ? "TXT" : format === "pdf" ? "PDF" : "Markdown";
  const copy = document.querySelector('[data-action="copy"]');
  const open = document.querySelector('[data-action="open-output"]');
  copy.classList.toggle("hidden", isPdf);
  open.classList.toggle("hidden", !isPdf);
  copy.textContent = `Copy ${label}`;
  document.querySelector("#result-description").textContent = isPdf
    ? "Your PDF edition is saved and ready to open."
    : `Your ${label} edition is saved and ready to copy.`;
}

function updateElapsed() {
  const startedAt = Number(
    document.querySelector("#progress-rail").dataset.startedAt,
  );
  const seconds = startedAt
    ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    : 0;
  document.querySelector("#elapsed").textContent =
    `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function send(type, extra = {}) {
  const response = await extensionRuntime.sendMessage({
    type,
    ...extra,
    ...(Number.isInteger(currentTabId) ? { tabId: currentTabId } : {}),
  });
  if (response?.error) throw new Error(response.error);
  if (Number.isInteger(response?.tabId)) currentTabId = response.tabId;
  return response;
}

async function identifyActiveTab() {
  if (!isExtensionRuntime) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id))
    throw new Error("REE could not identify the current browser tab.");
  currentTabId = tab.id;
}

document.querySelector("#extract").addEventListener("click", async () => {
  const format = document.querySelector('input[name="format"]:checked').value;
  clearModelStream();
  render({
    status: "working",
    stage: "Preparing page",
    detail: "Establishing the explicit capture boundary…",
    startedAt: Date.now(),
  });
  await send("start-extraction", {
    format,
    fast: document.querySelector("#fast").checked,
    includeImages:
      format === "pdf" && document.querySelector("#include-images").checked,
    model: document.querySelector("#model").value,
    customInstructions: document.querySelector("#custom-instructions").value,
  });
});

document.querySelector("#cancel").addEventListener("click", async () => {
  try {
    const state = await send("cancel-extraction");
    clearModelStream();
    render(state);
    showToast("Extraction cancelled");
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#model").addEventListener("change", async (event) => {
  try {
    const state = await send("set-model", { model: event.target.value });
    event.target.value = state.model;
    showToast("Model preference saved");
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelectorAll('input[name="format"]').forEach((input) => {
  input.addEventListener("change", () => renderFormat(input.value));
});

document.querySelector("#open-folder").addEventListener("click", async () => {
  try {
    await send("open-output-folder");
    showToast("Extraction folder opened");
  } catch (error) {
    showToast(error.message);
  }
});

document.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.target.closest("button,input,textarea") &&
    !document.querySelector("#idle").classList.contains("hidden")
  )
    document.querySelector("#extract").click();
});

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    const action = button.dataset.action;
    try {
      if (action === "copy") {
        const result = await send("copy");
        await navigator.clipboard.writeText(result.content);
        showToast("Text copied");
      } else if (action === "reset") {
        render(await send("reset"));
        document.querySelector("#custom-instructions").value = "";
      } else {
        await send(action);
        if (action === "open-output") showToast("PDF opened");
        else showToast("Output folder opened");
      }
    } catch (error) {
      showToast(error.message);
    }
  });
});

extensionRuntime.onMessage.addListener((message) => {
  if (message.tabId !== currentTabId) return;
  if (message.type === "state-updated") render(message.state);
  else if (message.type === "model-delta")
    appendModelDelta(message.kind, message.delta);
});

await identifyActiveTab();
const initialState = await send("get-state");
if (
  isExtensionRuntime &&
  initialState?.runtimeProtocolVersion !== REQUIRED_RUNTIME_PROTOCOL_VERSION
) {
  chrome.runtime.reload();
} else {
  render(initialState);
}
updateElapsed();
setInterval(updateElapsed, 1_000);
