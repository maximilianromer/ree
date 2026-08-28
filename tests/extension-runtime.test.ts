import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface NativePortMock {
  messages: Array<Record<string, unknown>>;
  disconnected: boolean;
  onMessageListeners: Array<(message: Record<string, unknown>) => void>;
  onDisconnectListeners: Array<() => void>;
  postMessage: (message: Record<string, unknown>) => void;
  disconnect: () => void;
  onMessage: {
    addListener: (
      listener: NativePortMock["onMessageListeners"][number],
    ) => void;
  };
  onDisconnect: {
    addListener: (
      listener: NativePortMock["onDisconnectListeners"][number],
    ) => void;
  };
}

async function waitFor(
  condition: () => boolean,
  timeoutMilliseconds = 3_000,
): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMilliseconds)
      throw new Error("Timed out waiting for extension state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("extension service-worker runtime", () => {
  it("uploads only the selected edition with correlated semantic images", async () => {
    const storage: Record<string, unknown> = {};
    const ports: NativePortMock[] = [];
    const workingProgress: number[] = [];
    const runtimeMessages: Array<Record<string, unknown>> = [];
    const badgeCalls: Array<{
      method: string;
      value: Record<string, unknown>;
    }> = [];
    const scriptArguments: unknown[][] = [];
    let returnPdfViewerShell = false;
    let fetchCalls = 0;
    let autoComplete = true;
    let runtimeListener:
      | ((
          message: Record<string, unknown>,
          sender: unknown,
          respond: (response: unknown) => void,
        ) => boolean)
      | undefined;
    const tab = {
      id: 7,
      windowId: 9,
      url: "https://subscriber.example/article",
      title: "Subscriber Article",
    };
    const secondTab = {
      id: 8,
      windowId: 9,
      url: "https://magazine.example/second-article",
      title: "Second Article",
    };
    let selectedTab = tab;

    const emit = (port: NativePortMock, message: Record<string, unknown>) => {
      for (const listener of port.onMessageListeners) listener(message);
    };
    const createPort = (): NativePortMock => {
      let selectedFormat = "md";
      const port: NativePortMock = {
        messages: [],
        disconnected: false,
        onMessageListeners: [],
        onDisconnectListeners: [],
        postMessage(message) {
          this.messages.push(message);
          if (
            message.type === "extract-begin" ||
            message.type === "extract-pdf-begin"
          ) {
            selectedFormat = String(
              (message.options as Record<string, unknown>).format,
            );
          }
          if (message.type === "extract-commit" && autoComplete) {
            queueMicrotask(() => {
              emit(this, {
                id: message.id,
                type: "model-delta",
                kind: "reasoning",
                delta: "Locating the article body.",
              });
              emit(this, {
                id: message.id,
                type: "model-delta",
                kind: "output",
                delta: "Subscriber article body",
              });
              emit(this, {
                id: message.id,
                type: "progress",
                stage: "extracting",
                message: "Reading with Luna",
                current: 1,
                total: 1,
              });
              emit(this, {
                id: message.id,
                type: "complete",
                format: selectedFormat,
                outputPath: `/outputs/article.${selectedFormat}`,
                title: "Subscriber Article",
              });
            });
          } else if (message.type === "read-output") {
            queueMicrotask(() =>
              emit(this, {
                id: message.id,
                type: "output-chunk",
                data: "Subscriber article body\n",
                offset: 0,
                nextOffset: 24,
                done: true,
              }),
            );
          } else if (
            message.type === "open-output" ||
            message.type === "open-output-folder" ||
            message.type === "open-folder"
          ) {
            queueMicrotask(() =>
              emit(this, { id: message.id, type: "opened" }),
            );
          }
        },
        disconnect() {
          if (this.disconnected) return;
          this.disconnected = true;
          for (const listener of this.onDisconnectListeners) listener();
        },
        onMessage: {
          addListener(listener) {
            port.onMessageListeners.push(listener);
          },
        },
        onDisconnect: {
          addListener(listener) {
            port.onDisconnectListeners.push(listener);
          },
        },
      };
      ports.push(port);
      return port;
    };

    const chromeMock = {
      storage: {
        local: {
          async get(keys: string | string[]) {
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(
              requested.map((key) => [key, storage[key]]),
            );
          },
          async set(values: Record<string, unknown>) {
            Object.assign(storage, values);
            const state = Object.entries(values).find(([key]) =>
              key.startsWith("reeTabState:"),
            )?.[1] as { status?: string; progress?: number } | undefined;
            if (state?.status === "working" && state.progress !== undefined)
              workingProgress.push(state.progress);
          },
        },
      },
      runtime: {
        lastError: undefined,
        connectNative: createPort,
        sendMessage: async (message: Record<string, unknown>) => {
          runtimeMessages.push(message);
        },
        onMessage: {
          addListener(listener: typeof runtimeListener) {
            runtimeListener = listener;
          },
        },
      },
      action: {
        async setBadgeText(value: Record<string, unknown>) {
          badgeCalls.push({ method: "text", value });
        },
        async setBadgeBackgroundColor(value: Record<string, unknown>) {
          badgeCalls.push({ method: "color", value });
        },
        async setTitle(value: Record<string, unknown>) {
          badgeCalls.push({ method: "title", value });
        },
      },
      tabs: {
        query: async () => [selectedTab],
        get: async (tabId: number) => {
          if (tabId === tab.id) return tab;
          if (tabId === secondTab.id) return secondTab;
          throw new Error("Unknown tab");
        },
      },
      scripting: {
        async executeScript({ args }: { args: unknown[] }) {
          scriptArguments.push(args);
          if (typeof args[0] === "boolean") {
            if (returnPdfViewerShell)
              return [
                {
                  result: {
                    html: "<html><body><edge-pdf-viewer></edge-pdf-viewer></body></html>",
                    title: "Protected PDF viewer",
                    url: "https://edge.example/internal-viewer",
                    pdfViewer: true,
                    pdfUrl: "file:///Users/reader/Documents/archive.pdf",
                    assetCandidates: [],
                  },
                },
              ];
            const collectImages = args[0];
            return [
              {
                result: {
                  html: `<html><body><main><h1>Subscriber Article</h1><figure data-ree-image-id="image-001"><img alt="Chart"></figure><p>${"é".repeat(760_000)}</p></main></body></html>`,
                  title: "Subscriber Article",
                  url: tab.url,
                  assetCandidates: collectImages
                    ? [
                        {
                          id: "image-001",
                          selectorIndex: 0,
                          label: "Article chart",
                          alt: "Chart",
                        },
                      ]
                    : [],
                },
              },
            ];
          }
          return [
            {
              result: [
                {
                  id: "image-001",
                  dataUrl: "data:image/png;base64,aW1hZ2U=",
                  label: "Article chart",
                  alt: "Chart",
                },
              ],
            },
          ];
        },
      },
    };
    const dispatch = (message: Record<string, unknown>) =>
      new Promise<unknown>((resolve) => {
        runtimeListener?.(message, {}, resolve);
      });
    const extractionPorts = () =>
      ports.filter((port) =>
        port.messages.some((message) =>
          ["extract-begin", "extract-pdf-begin"].includes(String(message.type)),
        ),
      );
    const globals = globalThis as unknown as Record<string, unknown>;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(new TextEncoder().encode("%PDF-browser-payload"), {
        headers: { "content-type": "application/pdf" },
      });
    };
    globals.chrome = chromeMock;

    try {
      await import("../extension/background.js");
      expect(runtimeListener).toBeTypeOf("function");

      await expect(
        dispatch({
          type: "set-model",
          model: "openai/gpt-7.2-preview",
        }),
      ).resolves.toMatchObject({
        status: "idle",
        error: null,
        model: "openai/gpt-7.2-preview",
      });
      await expect(
        dispatch({
          type: "start-extraction",
          format: "pdf",
          fast: true,
          customInstructions: "Keep the methods appendix.",
        }),
      ).resolves.toEqual({ accepted: true });
      await waitFor(
        () =>
          (storage["reeTabState:7"] as { status?: string } | undefined)
            ?.status === "done",
      );

      const pdfPort = extractionPorts()[0]!;
      const begin = pdfPort.messages.find(
        (message) => message.type === "extract-begin",
      )!;
      const chunks = pdfPort.messages.filter(
        (message) => message.type === "extract-chunk",
      );
      const commit = pdfPort.messages.find(
        (message) => message.type === "extract-commit",
      )!;
      expect(begin).toMatchObject({
        options: {
          format: "pdf",
          fast: true,
          includeImages: true,
          model: "openai/gpt-7.2-preview",
          customInstructions: "Keep the methods appendix.",
        },
      });
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.map((message) => message.index)).toEqual(
        chunks.map((_, index) => index),
      );
      expect(commit.id).toBe(begin.id);

      const payloadText = chunks.map((message) => message.data).join("");
      const payload = JSON.parse(payloadText) as {
        html: string;
        images: Array<{ id: string; dataUrl: string }>;
      };
      expect(Buffer.byteLength(payloadText, "utf8")).toBe(begin.totalBytes);
      expect(payload.html).toContain('data-ree-image-id="image-001"');
      expect(payload.images).toEqual([
        expect.objectContaining({
          id: "image-001",
          dataUrl: "data:image/png;base64,aW1hZ2U=",
        }),
      ]);
      expect(scriptArguments).toEqual([
        [true],
        [
          [
            expect.objectContaining({
              id: "image-001",
              selectorIndex: 0,
            }),
          ],
        ],
      ]);
      expect(storage["reeTabState:7"]).toMatchObject({
        status: "done",
        format: "pdf",
        fast: true,
        includeImages: true,
        model: "openai/gpt-7.2-preview",
        result: {
          format: "pdf",
          outputPath: "/outputs/article.pdf",
          title: "Subscriber Article",
        },
      });

      await expect(dispatch({ type: "copy" })).resolves.toMatchObject({
        error: "PDF output cannot be copied as text.",
      });
      await expect(dispatch({ type: "open-output" })).resolves.toMatchObject({
        type: "opened",
      });
      expect(
        ports
          .flatMap((port) => port.messages)
          .some((message) => message.type === "read-output"),
      ).toBe(false);

      await dispatch({ type: "reset" });
      await expect(
        dispatch({
          type: "start-extraction",
          format: "txt",
          fast: false,
          includeImages: true,
        }),
      ).resolves.toEqual({ accepted: true });
      await waitFor(
        () =>
          extractionPorts().length === 2 &&
          (
            storage["reeTabState:7"] as
              { result?: { format?: string } } | undefined
          )?.result?.format === "txt",
      );

      const txtBegin = extractionPorts()[1]!.messages.find(
        (message) => message.type === "extract-begin",
      );
      expect(txtBegin).toMatchObject({
        options: {
          format: "txt",
          fast: false,
          includeImages: false,
          model: "openai/gpt-7.2-preview",
        },
      });
      expect(scriptArguments.at(-1)).toEqual([false]);
      await expect(dispatch({ type: "copy" })).resolves.toEqual({
        content: "Subscriber article body\n",
      });
      expect(
        ports
          .flatMap((port) => port.messages)
          .filter((message) => message.type === "read-output"),
      ).toEqual([expect.objectContaining({ path: "/outputs/article.txt" })]);

      await dispatch({ type: "reset" });
      tab.url = "https://documents.example/research-paper.pdf?edition=final";
      tab.title = "Research Paper.pdf";
      const scriptCallCount = scriptArguments.length;
      await expect(
        dispatch({
          type: "start-extraction",
          format: "txt",
          fast: false,
          includeImages: false,
        }),
      ).resolves.toEqual({ accepted: true });
      await waitFor(
        () =>
          extractionPorts().length === 3 &&
          (
            storage["reeTabState:7"] as
              { result?: { format?: string } } | undefined
          )?.result?.format === "txt",
      );

      const browserPdfPort = extractionPorts()[2]!;
      expect(
        browserPdfPort.messages.find(
          (message) => message.type === "extract-pdf-begin",
        ),
      ).toMatchObject({
        totalBytes: 20,
        url: "https://documents.example/research-paper.pdf?edition=final",
        title: "Research Paper.pdf",
      });
      const browserPdfBytes = Buffer.concat(
        browserPdfPort.messages
          .filter((message) => message.type === "extract-pdf-chunk")
          .map((message) => Buffer.from(String(message.data), "base64")),
      );
      expect(browserPdfBytes.toString()).toBe("%PDF-browser-payload");
      expect(fetchCalls).toBe(1);
      expect(scriptArguments).toHaveLength(scriptCallCount);

      await dispatch({ type: "reset" });
      tab.url = "https://edge.example/internal-viewer";
      tab.title = "Protected PDF viewer";
      returnPdfViewerShell = true;
      await expect(
        dispatch({
          type: "start-extraction",
          format: "md",
          fast: false,
          includeImages: false,
        }),
      ).resolves.toEqual({ accepted: true });
      await waitFor(
        () =>
          extractionPorts().length === 4 &&
          (
            storage["reeTabState:7"] as
              { result?: { format?: string } } | undefined
          )?.result?.format === "md",
      );

      const protectedViewerPort = extractionPorts()[3]!;
      const protectedViewerPayload = JSON.parse(
        protectedViewerPort.messages
          .filter((message) => message.type === "extract-chunk")
          .map((message) => message.data)
          .join(""),
      );
      expect(protectedViewerPayload).toEqual({
        kind: "pdf",
        url: "file:///Users/reader/Documents/archive.pdf",
        title: "Protected PDF viewer",
      });
      expect(fetchCalls).toBe(1);
      expect(workingProgress).toEqual([
        6, 18, 22, 90, 6, 18, 22, 90, 18, 22, 90, 6, 18, 22, 90,
      ]);
      expect(
        runtimeMessages.filter((message) => message.type === "model-delta"),
      ).toEqual([
        {
          type: "model-delta",
          tabId: 7,
          kind: "reasoning",
          delta: "Locating the article body.",
          current: undefined,
          total: undefined,
        },
        {
          type: "model-delta",
          tabId: 7,
          kind: "output",
          delta: "Subscriber article body",
          current: undefined,
          total: undefined,
        },
        {
          type: "model-delta",
          tabId: 7,
          kind: "reasoning",
          delta: "Locating the article body.",
          current: undefined,
          total: undefined,
        },
        {
          type: "model-delta",
          tabId: 7,
          kind: "output",
          delta: "Subscriber article body",
          current: undefined,
          total: undefined,
        },
        {
          type: "model-delta",
          tabId: 7,
          kind: "reasoning",
          delta: "Locating the article body.",
          current: undefined,
          total: undefined,
        },
        {
          type: "model-delta",
          tabId: 7,
          kind: "output",
          delta: "Subscriber article body",
          current: undefined,
          total: undefined,
        },
        {
          type: "model-delta",
          tabId: 7,
          kind: "reasoning",
          delta: "Locating the article body.",
          current: undefined,
          total: undefined,
        },
        {
          type: "model-delta",
          tabId: 7,
          kind: "output",
          delta: "Subscriber article body",
          current: undefined,
          total: undefined,
        },
      ]);

      const latestBadge = (method: string) =>
        badgeCalls.filter((call) => call.method === method).at(-1)?.value;
      autoComplete = false;
      returnPdfViewerShell = false;
      tab.url = "https://subscriber.example/article";
      tab.title = "Subscriber Article";
      selectedTab = tab;
      await dispatch({ type: "reset", tabId: 7 });
      await dispatch({ type: "start-extraction", tabId: 7, format: "md" });
      await waitFor(
        () =>
          extractionPorts().length === 5 &&
          (storage["reeTabState:7"] as { status?: string }).status ===
            "working",
      );

      await expect(
        dispatch({ type: "get-state", tabId: 8 }),
      ).resolves.toMatchObject({
        tabId: 8,
        status: "idle",
        runtimeProtocolVersion: 1,
      });
      await dispatch({ type: "start-extraction", tabId: 8, format: "txt" });
      await waitFor(
        () =>
          extractionPorts().length === 6 &&
          (storage["reeTabState:8"] as { status?: string }).status ===
            "working",
      );
      expect(latestBadge("text")).toEqual({ text: "2" });
      expect(latestBadge("color")).toEqual({ color: "#e2b93b" });
      expect(storage["reeTabState:7"]).toMatchObject({
        tabId: 7,
        status: "working",
        format: "md",
      });
      expect(storage["reeTabState:8"]).toMatchObject({
        tabId: 8,
        status: "working",
        format: "txt",
      });

      const secondJobPort = extractionPorts()[5]!;
      await expect(
        dispatch({ type: "cancel-extraction", tabId: 8 }),
      ).resolves.toMatchObject({ tabId: 8, status: "idle" });
      expect(secondJobPort.disconnected).toBe(true);
      expect(latestBadge("text")).toEqual({ text: "1" });
      expect(storage["reeTabState:7"]).toMatchObject({ status: "working" });

      const firstJobPort = extractionPorts()[4]!;
      const firstJobId = String(
        firstJobPort.messages.find(
          (message) => message.type === "extract-begin",
        )?.id,
      );
      emit(firstJobPort, {
        id: firstJobId,
        type: "complete",
        format: "md",
        outputPath: "/outputs/concurrent-article.md",
        title: "Concurrent Article",
      });
      await waitFor(
        () =>
          (storage["reeTabState:7"] as { status?: string }).status === "done",
      );
      expect(latestBadge("text")).toEqual({ text: "\u2713" });
      expect(latestBadge("color")).toEqual({ color: "#57a468" });

      await dispatch({ type: "get-state", tabId: 8 });
      await dispatch({ type: "start-extraction", tabId: 8, format: "md" });
      await waitFor(() => extractionPorts().length === 7);
      const failedJobPort = extractionPorts()[6]!;
      const failedJobId = String(
        failedJobPort.messages.find(
          (message) => message.type === "extract-begin",
        )?.id,
      );
      emit(failedJobPort, {
        id: failedJobId,
        type: "error",
        message: "Model unavailable",
      });
      await waitFor(
        () =>
          (storage["reeTabState:8"] as { status?: string }).status === "error",
      );
      expect(latestBadge("text")).toEqual({ text: "!" });
      expect(latestBadge("color")).toEqual({ color: "#c84e3f" });
      await dispatch({ type: "get-state", tabId: 8 });
      expect(latestBadge("text")).toEqual({ text: "" });
    } finally {
      globalThis.fetch = originalFetch;
      delete globals.chrome;
    }
  });

  it("ships segmented formats and selected-output actions as plain JavaScript", async () => {
    const background = await readFile("extension/background.js", "utf8");
    const popup = await readFile("extension/popup.html", "utf8");
    const popupRuntime = await readFile("extension/popup.js", "utf8");
    const popupStyles = await readFile("extension/popup.css", "utf8");

    expect(background).toContain('const DEFAULT_MODEL = "gpt-5.6-luna"');
    expect(background).toContain('format === "pdf" && includeImages');
    expect(background).toContain('type: "extract-begin"');
    expect(background).toContain('type: "extract-chunk"');
    expect(background).toContain('type: "extract-commit"');
    expect(background).toContain('type: "read-output"');
    expect(background).toContain('type: "model-delta"');
    expect(background).toContain("const jobs = new Map()");
    expect(background).toContain("chrome.action.setBadgeText");
    expect(background).toContain('message.type === "cancel-extraction"');
    expect(background).toContain("chrome.tabs.get(message.tabId)");
    expect(background).toContain("runtimeProtocolVersion:");
    expect(background).not.toContain("captureVisibleTab");
    expect(background).not.toContain("document.cookie");

    expect(popup.match(/name="format"/g)).toHaveLength(3);
    expect(popup).toContain('name="format" value="txt"');
    expect(popup).toContain('name="format" value="md" checked');
    expect(popup).toContain('name="format" value="pdf"');
    expect(popup).toMatch(
      /id="image-options"[^>]*hidden[\s\S]*id="include-images"[^>]*checked/,
    );
    expect(popup).toMatch(
      /<div class="generation-options">[\s\S]*id="fast"[\s\S]*id="model"[\s\S]*gpt-5\.6-luna/,
    );
    expect(popup).not.toContain("<details");
    expect(popup).not.toContain("<summary");
    expect(popup).toContain('maxlength="200"');
    expect(popup).toContain('id="custom-instructions"');
    expect(popup).toContain('maxlength="4000"');
    expect(popup).toContain('id="model-stream"');
    expect(popup).toContain('id="cancel"');
    expect(popupStyles).not.toContain("cursor-blink");
    expect(popupStyles).not.toContain(".model-stream:empty::after");
    expect(popup).not.toContain("Live output");
    expect(popup).toContain('data-action="copy"');
    expect(popup).toContain('data-action="open-output"');
    expect(popup).toContain('data-action="open-folder" class="secondary"');
    expect(popup).toContain('data-action="reset" class="secondary again"');
    expect(popupStyles).not.toContain(".quiet");
    expect(popup.indexOf('data-action="open-output"')).toBeLessThan(
      popup.indexOf('data-action="copy"'),
    );

    expect(popupRuntime).toContain('format !== "pdf"');
    expect(popupRuntime).toContain('copy.classList.toggle("hidden", isPdf)');
    expect(popupRuntime).toContain('open.classList.toggle("hidden", !isPdf)');
    expect(popupRuntime).toContain(
      "Your PDF edition is saved and ready to open.",
    );
    expect(popupRuntime).toContain("edition is saved and ready to copy.");
    expect(popupRuntime).toContain(
      'format === "pdf" && document.querySelector("#include-images").checked',
    );
    expect(popupRuntime).toContain('send("set-model"');
    expect(popupRuntime).toContain("customInstructions:");
    expect(popupRuntime).toContain(
      'event.target.closest("button,input,textarea")',
    );
    expect(popupRuntime).toContain("appendModelDelta(message.kind");
    expect(popupRuntime).toContain('send("cancel-extraction")');
    expect(popupRuntime).toContain("message.tabId !== currentTabId");
    expect(popupRuntime).toContain("chrome.tabs.query");
    expect(popupRuntime).toContain("chrome.runtime.reload()");
    expect(popupRuntime).toContain('kind === "reasoning" ? "i" : "span"');
  });
});
