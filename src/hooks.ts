import { config } from "../package.json";
import { getString, initLocale } from "./utils/locale";
import { getPref, setPref } from "./utils/prefs";
import { createZToolkit } from "./utils/ztoolkit";
import {
  getTranslationConfig,
  translateText,
} from "./modules/api";
import {
  extractPDFText,
  getPDFAttachment,
  splitIntoParagraphs,
} from "./modules/pdfExtract";
import { extractPageSentencesViaIframe, SentenceInfo } from "./modules/sentences";
import { injectPageOverlay, clearAllOverlays } from "./modules/overlay";
import { initCache, getCachedPage, setCachedPage, clearAllCache } from "./modules/cache";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  await initCache();

  await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: config.addonName,
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
  });

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // Add a chrome toolbar button to zotero-tabs-toolbar (the top bar with the
  // sync button). This lives entirely in the chrome document — no iframe
  // boundary — so click handlers work with a normal addEventListener.
  // Zotero's switchMenuType() automatically shows/hides elements with the
  // "menu-type-reader pdf" class based on the active tab type, so the button
  // only appears when a PDF reader tab is selected.
  const htBtnId = `${config.addonRef}-tabs-btn`;
  win.document.getElementById(htBtnId)?.remove(); // clean up if re-loading

  const htBtn = (win.document as any).createXULElement("toolbarbutton");
  htBtn.id = htBtnId;
  htBtn.setAttribute("label", "⚡ " + getString("toolbar-prepare"));
  htBtn.setAttribute("tooltiptext", getString("toolbar-prepare"));
  htBtn.setAttribute("class", "zotero-tb-button menu-type-reader pdf");
  htBtn.setAttribute("hidden", "true"); // shown by switchMenuType when PDF tab active
  htBtn.addEventListener("command", () => {
    addon.hooks.onMenuEvent("prepareOverlay");
  });

  const tabsToolbar = win.document.getElementById("zotero-tabs-toolbar");
  const syncError = win.document.getElementById("zotero-tb-sync-error");
  if (tabsToolbar) {
    tabsToolbar.insertBefore(htBtn, syncError ?? null);
  }

  new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: 3000,
  })
    .createLine({
      text: getString("startup-finish"),
      type: "success",
      progress: 100,
    })
    .show();
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  win.document.getElementById(`${config.addonRef}-tabs-btn`)?.remove();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: unknown },
) {
  ztoolkit.log("notify", event, type, ids, extraData);
}

/**
 * Handle preference pane lifecycle events.
 * On "load": populate the form inputs from stored prefs and attach change
 * listeners so edits are persisted immediately.
 */
async function onPrefsEvent(
  type: string,
  data: { window: Window },
) {
  if (type !== "load") return;

  const doc = data.window.document;
  const addonRef = config.addonRef;

  const fields: Array<{
    id: string;
    pref: keyof _ZoteroTypes.Prefs["PluginPrefsMap"];
  }> = [
    { id: `zotero-prefpane-${addonRef}-api-key`, pref: "apiKey" },
    { id: `zotero-prefpane-${addonRef}-api-base-url`, pref: "apiBaseUrl" },
    { id: `zotero-prefpane-${addonRef}-api-model`, pref: "apiModel" },
    {
      id: `zotero-prefpane-${addonRef}-target-language`,
      pref: "targetLanguage",
    },
  ];

  for (const { id, pref } of fields) {
    const input = doc.getElementById(id) as HTMLInputElement | null;
    if (!input) continue;
    input.value = getPref(pref);
    input.addEventListener("change", () => {
      setPref(pref, input.value);
    });
  }

  const clearBtn = doc.getElementById(`zotero-prefpane-${addonRef}-clear-cache`);
  const clearStatus = doc.getElementById(`zotero-prefpane-${addonRef}-clear-cache-status`);
  clearBtn?.addEventListener("command", () => {
    clearAllCache();
    if (clearStatus) clearStatus.setAttribute("value", "Cache cleared.");
    setTimeout(() => clearStatus?.setAttribute("value", ""), 3000);
  });
}

function onShortcuts(_type: string) {}

/**
 * Dispatch named menu/command events to the appropriate handler.
 */
async function onMenuEvent(type: string) {
  try {
    if (type === "translatePDF") {
      await runTranslatePDF();
    } else if (type === "prepareOverlay") {
      await runPrepareOverlayFromMenu();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ztoolkit.log("onMenuEvent error:", msg);
    showError(msg);
  }
}

/**
 * Triggered from the right-click item menu OR the reader toolbar button.
 *
 * Strategy:
 *  1. If a library item is selected and has an open reader, use that reader.
 *  2. Otherwise fall back to the first open reader (covers the case where the
 *     user clicks the toolbar button from inside the reader with no item
 *     selected in the library pane).
 */
async function runPrepareOverlayFromMenu(): Promise<void> {
  const readers = (Zotero.Reader as any)._readers as any[] | undefined;
  ztoolkit.log("open readers:", readers?.length, readers?.map((r: any) => r._item?.id));

  let reader: any = undefined;

  // Try to match by the currently selected library item
  // getActiveZoteroPane() may return null when the PDF reader tab is focused
  const selectedItems = Zotero.getActiveZoteroPane()?.getSelectedItems() ?? [];
  if (selectedItems.length) {
    const pdfItem = getPDFAttachment(selectedItems[0]);
    if (pdfItem) {
      reader = readers?.find((r: any) => r._item?.id === pdfItem.id);
    }
  }

  // Fall back to the first open reader (toolbar button case)
  if (!reader) {
    reader = readers?.[0];
  }

  if (!reader) {
    showError(getString("error-reader-not-open"));
    return;
  }

  await runPrepareTranslations(reader);
}

/**
 * Handle clicks on the "Prepare Translations" toolbar button inside a reader.
 *
 * @param reader - The Zotero Reader instance whose toolbar was clicked
 */
async function onReaderToolbarClick(reader: any): Promise<void> {
  await runPrepareTranslations(reader);
}

// ---------------------------------------------------------------------------
// Hover overlay pipeline (Milestone 3)
// ---------------------------------------------------------------------------

/**
 * Main pipeline for preparing hover translations on a PDF open in the reader.
 *
 * Steps:
 *  1. Validate API config and retrieve the pdf.js window
 *  2. Get the full pdf.js PDFDocument
 *  3. For each page (prioritising the currently visible page):
 *     a. Extract sentences with bounding boxes
 *     b. Translate sentences via the API
 *     c. Inject the overlay so hovering shows translations immediately
 */
async function runPrepareTranslations(reader: any): Promise<void> {
  ztoolkit.log("runPrepareTranslations called, reader:", reader);

  const apiConfig = getTranslationConfig();
  if (!apiConfig.apiKey) {
    showError(getString("error-no-api-key"));
    return;
  }

  // Show the progress window immediately so the user gets feedback
  const progress = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: false,
    closeTime: -1,
  })
    .createLine({
      text: getString("progress-preparing"),
      type: "default",
      progress: 5,
    })
    .show();

  // --- Retrieve the pdf.js application from the reader ---
  // Try several internal paths across Zotero versions
  const iframeWin: Window | undefined =
    reader._internalReader?._primaryView?._iframeWindow ??
    reader._primaryView?._iframeWindow ??
    (reader._iframeWindow as Window | undefined);

  ztoolkit.log("iframeWin:", iframeWin);

  if (!iframeWin) {
    progress.changeLine({
      text: getString("error-reader-not-ready"),
      type: "fail",
      progress: 0,
    });
    progress.startCloseTimer(4000);
    return;
  }

  const pdfApp = (iframeWin as any).PDFViewerApplication;
  ztoolkit.log("PDFViewerApplication:", pdfApp, "pdfDocument:", pdfApp?.pdfDocument);

  if (!pdfApp?.pdfDocument) {
    progress.changeLine({
      text: getString("error-reader-not-ready"),
      type: "fail",
      progress: 0,
    });
    progress.startCloseTimer(4000);
    return;
  }

  const pdfDoc = pdfApp.pdfDocument;
  const totalPages: number = pdfDoc.numPages; // 1-based count
  const currentPage: number = pdfApp.page ?? 1; // 1-based
  const itemId: number = reader._item?.id as number;

  ztoolkit.log("totalPages:", totalPages, "currentPage:", currentPage, "itemId:", itemId);

  // Clear any existing overlays before starting fresh
  clearAllOverlays(iframeWin);

  // Only process the current page and the next 2 pages to control API costs.
  // The user can trigger again after scrolling to process more pages.
  const PAGES_PER_RUN = 3;
  const pageOrder = buildPageOrder(currentPage - 1, totalPages).slice(0, PAGES_PER_RUN);

  for (let i = 0; i < pageOrder.length; i++) {
    const pageIndex = pageOrder[i]; // 0-based
    const pctDone = Math.round(((i + 1) / pageOrder.length) * 90) + 5;

    // Check cache first — skip API call if we already have translations
    const cached = itemId ? getCachedPage(itemId, pageIndex) : null;
    if (cached) {
      injectPageOverlay(iframeWin, pageIndex, cached.sentences);
      ztoolkit.log(`Page ${pageIndex + 1}: loaded from cache (${cached.sentences.length} sentences)`);
      progress.changeLine({
        text: `${getString("progress-preparing")} (${i + 1}/${pageOrder.length})`,
        type: "default",
        progress: pctDone,
      });
      continue;
    }

    progress.changeLine({
      text: `${getString("progress-preparing")} (${i + 1}/${pageOrder.length})`,
      type: "default",
      progress: pctDone,
    });

    try {
      // Use iframe injection so pdf.js APIs are called in their native context
      const sentences = await extractPageSentencesViaIframe(iframeWin, pageIndex);
      ztoolkit.log(`Page ${pageIndex + 1}: ${sentences.length} sentences found`);
      if (sentences.length === 0) continue;

      const translations = await translateSentences(sentences, apiConfig);

      const entries = sentences.map((s, idx) => ({
        sentence: s,
        translation: translations[idx] ?? "",
      }));

      injectPageOverlay(iframeWin, pageIndex, entries);
      ztoolkit.log(`Page ${pageIndex + 1}: overlay injected for ${entries.length} sentences`);

      // Persist to cache so this page doesn't need re-translating
      if (itemId) setCachedPage(itemId, pageIndex, entries);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ztoolkit.log(`Page ${pageIndex + 1} failed:`, msg);
      // Continue with remaining pages rather than aborting
    }
  }

  progress.changeLine({
    text: getString("progress-overlay-ready"),
    type: "success",
    progress: 100,
  });
  progress.startCloseTimer(3000);
}

/**
 * Inject a script into the pdf.js iframe to report the real DOM structure of
/**
 * Translate an array of sentences using individual API calls.
 * Returns translations in the same order as the input sentences.
 */
async function translateSentences(
  sentences: SentenceInfo[],
  apiConfig: ReturnType<typeof getTranslationConfig>,
): Promise<string[]> {
  const results: string[] = new Array(sentences.length).fill("");
  for (let i = 0; i < sentences.length; i++) {
    try {
      results[i] = await translateText(sentences[i].text, apiConfig);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ztoolkit.log(`Sentence translation failed (${i}):`, msg);
      results[i] = `(${getString("error-translate-failed")})`;
    }
  }
  return results;
}

/**
 * Build the order in which to process pages, starting at `startIndex`
 * and wrapping around to cover all pages.
 *
 * @param startIndex - 0-based page index to start from
 * @param totalPages - Total number of pages (1-based count)
 */
function buildPageOrder(startIndex: number, totalPages: number): number[] {
  const order: number[] = [];
  for (let i = 0; i < totalPages; i++) {
    order.push((startIndex + i) % totalPages);
  }
  return order;
}

// ---------------------------------------------------------------------------
// Legacy pipeline: right-click menu translation (Milestone 2, kept for reference)
// ---------------------------------------------------------------------------

/**
 * Orchestrate the full translation pipeline for the currently selected item:
 * 1. Validate selection and API configuration
 * 2. Extract text via PDFWorker
 * 3. Translate the first N paragraphs via the configured API
 * 4. Show the result in a dialog
 */
async function runTranslatePDF() {
  // --- 1. Validate selection ---
  const selectedItems = Zotero.getActiveZoteroPane().getSelectedItems();
  if (!selectedItems.length) {
    showError(getString("error-no-item-selected"));
    return;
  }

  const pdfItem = getPDFAttachment(selectedItems[0]);
  if (!pdfItem) {
    showError(getString("error-no-pdf"));
    return;
  }

  const apiConfig = getTranslationConfig();
  if (!apiConfig.apiKey) {
    showError(getString("error-no-api-key"));
    return;
  }

  // --- 2. Extract text ---
  const progress = new ztoolkit.ProgressWindow(
    addon.data.config.addonName,
    { closeOnClick: false, closeTime: -1 },
  )
    .createLine({
      text: getString("progress-extracting"),
      type: "default",
      progress: 10,
    })
    .show();

  const rawText = await extractPDFText(pdfItem);

  if (!rawText) {
    progress.changeLine({
      text: getString("error-extract-failed"),
      type: "fail",
      progress: 0,
    });
    progress.startCloseTimer(4000);
    return;
  }

  // Limit to first 10 paragraphs for the demo
  const paragraphs = splitIntoParagraphs(rawText).slice(0, 10);

  // --- 3. Translate paragraph by paragraph ---
  const translated: string[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    progress.changeLine({
      text: `${getString("progress-translating")} (${i + 1} / ${paragraphs.length})`,
      type: "default",
      progress: 30 + Math.round((i / paragraphs.length) * 60),
    });
    try {
      const result = await translateText(paragraphs[i], apiConfig);
      translated.push(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      progress.changeLine({
        text: `${getString("error-translate-failed")}: ${msg}`,
        type: "fail",
        progress: 0,
      });
      progress.startCloseTimer(6000);
      return;
    }
  }

  progress.changeLine({
    text: getString("progress-done"),
    type: "success",
    progress: 100,
  });
  progress.startCloseTimer(2000);

  // --- 4. Show result dialog ---
  const lines: string[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    lines.push(`── ${i + 1} / ${paragraphs.length} ──`);
    lines.push(`[EN] ${paragraphs[i]}`);
    lines.push(`[${apiConfig.targetLanguage}] ${translated[i] || "(no result)"}`);
    lines.push("");
  }
  const resultText = lines.join("\n");

  addon.data.dialog = new ztoolkit.Dialog(1, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      styles: {
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "440px",
        padding: "8px",
        boxSizing: "border-box",
      },
      children: [
        {
          tag: "pre",
          namespace: "html",
          styles: {
            flex: "1",
            margin: "0",
            padding: "8px",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: "13px",
            fontFamily: "monospace",
            borderRadius: "4px",
          },
          properties: { textContent: resultText },
        },
      ],
    })
    .addButton(getString("dialog-close"), "close");

  addon.data.dialog.open(getString("dialog-title"), {
    width: 720,
    height: 520,
  });
}

function showError(message: string) {
  new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: 4000,
  })
    .createLine({ text: message, type: "fail", progress: 0 })
    .show();
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onMenuEvent,
  onReaderToolbarClick,
};
