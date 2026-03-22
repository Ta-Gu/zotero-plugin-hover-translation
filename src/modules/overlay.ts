/**
 * Inject a transparent hover-translation overlay into Zotero's PDF reader.
 *
 * Each sentence gets one highlight zone per line (tight per-line rect).
 * Hovering any zone shows a speech-bubble tooltip positioned above (or below)
 * the sentence, spanning the full width of the PDF page.
 */

import { SentenceInfo } from "./sentences";

export type TranslationMap = Map<
  number,
  Array<{ sentence: SentenceInfo; translation: string }>
>;

const OVERLAY_CLASS = "ht-overlay";
const ZONE_CLASS = "ht-zone";
const ZONE_ACTIVE_CLASS = "ht-zone--active";
const TOOLTIP_ID = "ht-tooltip";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inject per-line highlight zones and a speech-bubble tooltip for every
 * sentence on the given page.
 *
 * @param iframeWin  The window object of the pdf.js reader iframe
 * @param pageIndex  0-based page index
 * @param entries    Sentences and their translations for this page
 */
export function injectPageOverlay(
  iframeWin: Window,
  pageIndex: number,
  entries: Array<{ sentence: SentenceInfo; translation: string }>,
): void {
  const doc = iframeWin.document;

  ensureGlobalStyles(doc);
  ensureTooltip(doc);

  const pageDiv = doc.querySelector(
    `.page[data-page-number="${pageIndex + 1}"]`,
  ) as HTMLElement | null;
  if (!pageDiv) return;

  // Ensure page div is a positioning context
  if (iframeWin.getComputedStyle(pageDiv)?.position === "static") {
    pageDiv.style.position = "relative";
  }

  // Remove any existing overlay for this page
  pageDiv.querySelector(`.${OVERLAY_CLASS}`)?.remove();
  if (entries.length === 0) return;

  const overlay = doc.createElement("div");
  overlay.className = OVERLAY_CLASS;

  // Shared debounce timer across all zones on this page
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  for (let si = 0; si < entries.length; si++) {
    const { sentence, translation } = entries[si];
    // Use per-line rects for tight highlighting; fall back to overall rect
    const rects =
      sentence.lineRects.length > 0
        ? sentence.lineRects
        : [
            {
              xPct: sentence.xPct,
              yPct: sentence.yPct,
              widthPct: sentence.widthPct,
              heightPct: sentence.heightPct,
            },
          ];

    for (const rect of rects) {
      const zone = doc.createElement("div");
      zone.className = ZONE_CLASS;
      zone.dataset.si = String(si);
      zone.style.left = `${rect.xPct}%`;
      zone.style.top = `${rect.yPct}%`;
      zone.style.width = `${rect.widthPct}%`;
      zone.style.height = `${rect.heightPct}%`;

      zone.addEventListener("mouseenter", () => {
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
        // Deactivate any previously highlighted sentence first
        overlay.querySelectorAll(`.${ZONE_ACTIVE_CLASS}`).forEach((z: Element) => {
          (z as HTMLElement).classList.remove(ZONE_ACTIVE_CLASS);
        });
        // Activate ALL zones belonging to this sentence at once
        overlay.querySelectorAll(`[data-si="${si}"]`).forEach((z: Element) => {
          (z as HTMLElement).classList.add(ZONE_ACTIVE_CLASS);
        });
        const zoneRect = zone.getBoundingClientRect();
        const pageRect = overlay.parentElement?.getBoundingClientRect() ?? zoneRect;
        showTooltip(doc, translation, zoneRect, pageRect);
      });

      zone.addEventListener("mouseleave", () => {
        hideTimer = setTimeout(() => {
          overlay.querySelectorAll(`.${ZONE_ACTIVE_CLASS}`).forEach((z: Element) => {
            (z as HTMLElement).classList.remove(ZONE_ACTIVE_CLASS);
          });
          hideTooltip(doc);
          hideTimer = null;
        }, 80);
      });

      overlay.appendChild(zone);
    }
  }

  pageDiv.appendChild(overlay);
}

/**
 * Remove all overlays and the tooltip from the pdf.js document.
 */
export function clearAllOverlays(iframeWin: Window): void {
  const doc = iframeWin.document;
  doc
    .querySelectorAll(`.${OVERLAY_CLASS}`)
    .forEach((el: Element) => el.remove());
  doc.getElementById(TOOLTIP_ID)?.remove();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureTooltip(doc: Document): HTMLElement {
  let tooltip = doc.getElementById(TOOLTIP_ID) as HTMLElement | null;
  if (!tooltip) {
    tooltip = doc.createElement("div");
    tooltip.id = TOOLTIP_ID;
    tooltip.style.display = "none";
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    (doc.body ?? doc.documentElement!).appendChild(tooltip);
  }
  return tooltip;
}

function showTooltip(
  doc: Document,
  text: string,
  zoneRect: DOMRect,
  pageRect: DOMRect,
): void {
  const tooltip = ensureTooltip(doc);
  tooltip.textContent = text;

  // Match the page width
  tooltip.style.width = `${pageRect.width}px`;
  // Temporarily off-screen to measure height
  tooltip.style.top = "-9999px";
  tooltip.style.left = "-9999px";
  tooltip.style.display = "block";

  const ttH = tooltip.offsetHeight || 80;
  const arrowH = 10;
  const margin = 8;

  // Try above the zone; fall back to below
  let top = zoneRect.top - ttH - arrowH - 4;
  let arrowDown = true;
  if (top < margin) {
    top = zoneRect.bottom + arrowH + 4;
    arrowDown = false;
  }

  // Align left edge with the page
  const left = pageRect.left;

  // Arrow points at horizontal center of the hovered zone
  const arrowCenterX = zoneRect.left + zoneRect.width / 2 - left;
  const arrowPct = Math.max(
    5,
    Math.min(95, (arrowCenterX / pageRect.width) * 100),
  );

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  tooltip.style.setProperty("--ht-arrow-x", `${arrowPct.toFixed(1)}%`);
  tooltip.dataset.arrowDown = arrowDown ? "true" : "false";
}

function hideTooltip(doc: Document): void {
  const tooltip = doc.getElementById(TOOLTIP_ID) as HTMLElement | null;
  if (tooltip) tooltip.style.display = "none";
}

function ensureGlobalStyles(doc: Document): void {
  if (doc.getElementById("ht-styles")) return;

  const style = doc.createElement("style");
  style.id = "ht-styles";
  style.textContent = `
    .${OVERLAY_CLASS} {
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 10;
    }
    .${ZONE_CLASS} {
      position: absolute;
      pointer-events: all;
      cursor: default;
      border-radius: 1px;
      transition: background 0.1s;
    }
    .${ZONE_ACTIVE_CLASS} {
      background: rgba(100, 160, 255, 0.35);
    }
    #${TOOLTIP_ID} {
      position: fixed;
      z-index: 9999;
      padding: 12px 20px;
      font-size: 16px;
      line-height: 1.75;
      border-radius: 10px;
      pointer-events: none;
      white-space: pre-wrap;
      word-break: break-word;
      background: rgba(22, 22, 22, 0.95);
      color: #f0f0f0;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.45);
      box-sizing: border-box;
    }
    /* Arrow pointing downward (bubble is above the text) */
    #${TOOLTIP_ID}[data-arrow-down="true"]::after {
      content: '';
      position: absolute;
      bottom: -10px;
      left: var(--ht-arrow-x, 50%);
      transform: translateX(-50%);
      border: 10px solid transparent;
      border-bottom: none;
      border-top-color: rgba(22, 22, 22, 0.95);
    }
    /* Arrow pointing upward (bubble is below the text) */
    #${TOOLTIP_ID}[data-arrow-down="false"]::after {
      content: '';
      position: absolute;
      top: -10px;
      left: var(--ht-arrow-x, 50%);
      transform: translateX(-50%);
      border: 10px solid transparent;
      border-top: none;
      border-bottom-color: rgba(22, 22, 22, 0.95);
    }
  `;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  (doc.head ?? doc.documentElement!).appendChild(style);
}
