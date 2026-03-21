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

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

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

  // Register right-click menu item on library items
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `zotero-itemmenu-${config.addonRef}-translate`,
    label: getString("menu-translate"),
    commandListener: () => addon.hooks.onMenuEvent("translatePDF"),
  });

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

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
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
}

function onShortcuts(_type: string) {}

/**
 * Dispatch named menu/command events to the appropriate handler.
 */
async function onMenuEvent(type: string) {
  if (type === "translatePDF") {
    await runTranslatePDF();
  }
}

// ---------------------------------------------------------------------------
// Translation pipeline
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

  // Limit to first 10 paragraphs for the Milestone 2 demo
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
};
