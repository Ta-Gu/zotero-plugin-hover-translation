/**
 * Extract sentences with percentage-based bounding boxes from a PDF page.
 *
 * Strategy:
 *  1. Inject a <script> into the pdf.js iframe so that pdf.js APIs are called
 *     in their native context (bypassing Zotero's proxy wrappers).
 *  2. The injected script calls getTextContent() and convertToViewportPoint()
 *     inside the iframe, then stores plain-object results on window.__ht_*.
 *  3. The parent process polls until the result is ready, then runs the
 *     sentence-detection and bounding-box logic on the serialised items.
 */

export interface LineRect {
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
}

export interface SentenceInfo {
  /** The sentence text. */
  text: string;
  /** Overall bounding box (union of all line rects). */
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  /** Per-line bounding boxes for tight per-line highlighting. */
  lineRects: LineRect[];
  /** 0-based page index. */
  pageIndex: number;
}

/** A text item with viewport-space bounding box (Y increases downward). */
interface ProjectedItem {
  str: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Line {
  items: ProjectedItem[];
  top: number;
  bottom: number;
}

interface IframePageData {
  items: ProjectedItem[];
  vpWidth: number;
  vpHeight: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract sentences from a single PDF page by injecting a script into the
 * pdf.js iframe. This is the correct approach for Zotero 7/8, where direct
 * access to pdf.js objects from the parent process goes through proxy wrappers
 * that strip out methods like `getTextContent`.
 *
 * @param iframeWin - The window of the pdf.js reader iframe
 * @param pageIndex - 0-based page index
 * @returns Sentences with percentage-based bounding boxes, or [] on failure
 */
export async function extractPageSentencesViaIframe(
  iframeWin: Window,
  pageIndex: number,
): Promise<SentenceInfo[]> {
  const dataKey = `__ht_data_${pageIndex}`;
  const doneKey = `__ht_done_${pageIndex}`;

  // Reset any previous result
  (iframeWin as any)[dataKey] = undefined;
  (iframeWin as any)[doneKey] = false;

  // Build the script that runs inside the iframe with native pdf.js access
  const scriptCode = `
(async function() {
  try {
    var pdfDoc = PDFViewerApplication.pdfDocument;
    var page = await pdfDoc.getPage(${pageIndex + 1});
    var vp = page.getViewport({ scale: 1.0 });
    var tc = await page.getTextContent();
    var items = [];
    for (var i = 0; i < tc.items.length; i++) {
      var it = tc.items[i];
      if (!it.str || !it.str.trim()) continue;
      var t = it.transform;
      var w = it.width || 0;
      var h = Math.abs(it.height) || 10;
      var tl = vp.convertToViewportPoint(t[4], t[5] + h);
      var br = vp.convertToViewportPoint(t[4] + w, t[5]);
      items.push({
        str: it.str,
        left:   Math.min(tl[0], br[0]),
        top:    Math.min(tl[1], br[1]),
        right:  Math.max(tl[0], br[0]),
        bottom: Math.max(tl[1], br[1])
      });
    }
    window['${dataKey}'] = { items: items, vpWidth: vp.width, vpHeight: vp.height };
  } catch(e) {
    window['${dataKey}'] = { items: [], vpWidth: 0, vpHeight: 0, error: String(e) };
  }
  window['${doneKey}'] = true;
})();
`;

  // Inject and immediately remove the script element
  const scriptEl = iframeWin.document.createElement("script");
  scriptEl.textContent = scriptCode;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  (iframeWin.document.head ?? iframeWin.document.documentElement!).appendChild(
    scriptEl,
  );
  scriptEl.remove();

  // Poll until the async script sets the done flag (max 15 s)
  const deadline = Date.now() + 15_000;
  while (!(iframeWin as any)[doneKey] && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  // Read the result — try direct access first, then wrappedJSObject fallback
  const raw: IframePageData | undefined =
    (iframeWin as any)[dataKey] ??
    (iframeWin as any).wrappedJSObject?.[dataKey];

  if (!raw) return [];
  if (raw.error) {
    // Surface the error so it shows up in the diagnostic log
    throw new Error(`iframe getTextContent: ${raw.error}`);
  }
  if (!raw.items.length || raw.vpWidth === 0) return [];

  return processProjectedItems(raw.items, pageIndex, raw.vpWidth, raw.vpHeight);
}

// ---------------------------------------------------------------------------
// Sentence processing (pure functions, no pdf.js dependency)
// ---------------------------------------------------------------------------

/**
 * Convert an array of pre-projected text items into SentenceInfo objects.
 *
 * @param items    Items with viewport-space bounding boxes
 * @param pageIndex 0-based page index
 * @param vpWidth  Viewport width in pixels (at scale 1.0)
 * @param vpHeight Viewport height in pixels (at scale 1.0)
 */
function processProjectedItems(
  items: ProjectedItem[],
  pageIndex: number,
  vpWidth: number,
  vpHeight: number,
): SentenceInfo[] {
  const lines = groupIntoLines(items);
  const blocks = groupIntoBlocks(lines);
  const sentences: SentenceInfo[] = [];
  for (const block of blocks) {
    sentences.push(...splitBlockIntoSentences(block, pageIndex, vpWidth, vpHeight));
  }
  return sentences;
}

/**
 * Group items into horizontal lines based on their vertical midpoint.
 * Items whose midpoints are within Y_TOLERANCE pixels belong to the same line.
 */
function groupIntoLines(items: ProjectedItem[]): Line[] {
  const Y_TOLERANCE = 5; // viewport pixels
  const lines: Line[] = [];

  for (const item of items) {
    const midY = (item.top + item.bottom) / 2;
    const existing = lines.find(
      (l) => Math.abs((l.top + l.bottom) / 2 - midY) <= Y_TOLERANCE,
    );
    if (existing) {
      existing.items.push(item);
      existing.top = Math.min(existing.top, item.top);
      existing.bottom = Math.max(existing.bottom, item.bottom);
    } else {
      lines.push({ items: [item], top: item.top, bottom: item.bottom });
    }
  }

  // Sort lines top-to-bottom, items within each line left-to-right
  lines.sort((a, b) => a.top - b.top);
  for (const line of lines) {
    line.items.sort((a, b) => a.left - b.left);
  }
  return lines;
}

/**
 * Merge consecutive lines into paragraph blocks.
 * A block boundary is signalled by:
 *  - A vertical gap > 1.5× the previous line height, OR
 *  - A significant font-size change between lines (e.g. heading → body), OR
 *  - The current or previous line looks like a section heading
 *    (first item starts with a hierarchical number such as "2.3" or "2.3.1").
 */
function groupIntoBlocks(lines: Line[]): Line[][] {
  if (lines.length === 0) return [];
  const blocks: Line[][] = [];
  let current: Line[] = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const curr = lines[i];
    const prevH = prev.bottom - prev.top || 10;
    const currH = curr.bottom - curr.top || 10;
    const gap = curr.top - prev.bottom;
    const sizeRatio = Math.max(prevH, currH) / Math.min(prevH, currH);
    const splitOnHeading = isLikelyHeadingLine(curr) || isLikelyHeadingLine(prev);
    if (gap > prevH * 1.5 || sizeRatio > 1.3 || splitOnHeading) {
      blocks.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  blocks.push(current);
  return blocks;
}

/**
 * Return true if the line looks like a section heading.
 * Covers numbered sections, all-caps titles, Roman numerals, and short
 * unpunctuated lines that are unlikely to be mid-paragraph fragments.
 */
function isLikelyHeadingLine(line: Line): boolean {
  const firstStr = (line.items[0]?.str ?? "").trimStart();
  const fullStr = line.items.map((i) => i.str).join("").trim();

  // "2.3 …", "2.3.1 …", "A.1 …"
  if (/^\d+\.\d+|^[A-Z]\.\d+/.test(firstStr)) return true;

  // "3 Results", "1 Introduction"
  if (/^\d+\s+[A-Z]/.test(firstStr)) return true;

  // Roman numeral heading: "I. Intro", "II. Background"
  if (/^(?:I{1,3}|IV|V?I{0,3}|IX|X{1,2}I{0,3})\.\s+[A-Z]/i.test(firstStr)) return true;

  // All-caps short line: "ABSTRACT", "INTRODUCTION", "RELATED WORK"
  if (fullStr.length <= 50 && /^[A-Z][A-Z\s\-]{2,}$/.test(fullStr)) return true;

  // Short line (≤ 60 chars), starts uppercase, no trailing sentence punctuation,
  // and has very few items — characteristic of a heading in academic PDFs.
  if (
    fullStr.length > 0 &&
    fullStr.length <= 60 &&
    line.items.length <= 4 &&
    /^[A-Z]/.test(fullStr) &&
    !/[.!?:,;]$/.test(fullStr)
  ) return true;

  // Footnote / endnote markers: "[1]", "[12]", "1.", "†", "‡", "§", "*"
  if (/^(\[\d+\]|\d+\.|[†‡§∗*])/.test(firstStr)) return true;

  // Reference list entries: "Smith, J. (2020)..." or "[1] Author..."
  if (/^\[\d+\]\s/.test(firstStr)) return true;

  // Author affiliation lines: short lines with mixed institutional keywords
  if (
    fullStr.length <= 80 &&
    /University|Institute|Department|School|Laboratory|Lab|College|Center|Centre/i.test(fullStr)
  ) return true;

  // Email address lines (common in paper headers)
  if (/\S+@\S+\.\S+/.test(fullStr)) return true;

  return false;
}

/** Common abbreviations that should not be treated as sentence endings. */
const ABBREVS = new Set([
  "Dr", "Mr", "Mrs", "Ms", "Prof", "Sr", "Jr", "St", "Mt", "Rd", "Ave",
  "Fig", "Figs", "Eq", "Eqs", "Tab", "Ref", "Refs", "Sec", "Secs", "Ch",
  "Vol", "No", "pp", "p", "et", "al", "vs", "approx", "dept", "est", "etc",
  "govt", "max", "min", "avg", "std", "var", "Def", "Prop", "Thm", "Cor",
  "Lem", "Alg", "App", "Univ", "Dept", "Inc", "Ltd", "Corp", "Co",
  "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  "e.g", "i.e", "cf", "resp", "approx", "etal",
]);

/**
 * Split a block into sentences using punctuation detection, then compute
 * percentage-based bounding boxes for each sentence.
 *
 * Each PDF text item (token) is assigned to exactly one sentence based on
 * which sentence range contains the midpoint of the token in the full text.
 * This prevents items from appearing in two adjacent sentences at once,
 * which used to cause highlight bleed across sentence boundaries.
 */
function splitBlockIntoSentences(
  block: Line[],
  pageIndex: number,
  vpWidth: number,
  vpHeight: number,
): SentenceInfo[] {
  interface Token { str: string; item: ProjectedItem; start: number }
  const tokens: Token[] = [];
  let charPos = 0;

  for (const line of block) {
    for (const item of line.items) {
      tokens.push({ str: item.str, item, start: charPos });
      charPos += item.str.length;
    }
    // Ensure words from adjacent lines don't run together
    const last = tokens[tokens.length - 1];
    if (last && !last.str.endsWith(" ")) {
      tokens[tokens.length - 1] = { ...last, str: last.str + " " };
      charPos += 1; // account for the appended space
    }
  }

  if (tokens.length === 0) return [];

  const fullText = tokens.map((t) => t.str).join("");

  // Detect candidate sentence boundaries: .!? followed by whitespace + uppercase
  const rawEnds: number[] = [];
  const endPattern = /[.!?][)\]"']?\s+[A-Z]/g;
  let m: RegExpExecArray | null;
  while ((m = endPattern.exec(fullText)) !== null) {
    rawEnds.push(m.index + 1); // position just after the punctuation
  }

  // Filter out false positives from common abbreviations and single letters
  const sentenceEnds = rawEnds.filter((pos) => {
    // The word immediately before the punctuation
    const before = fullText.slice(0, pos - 1);
    const wordMatch = before.match(/(\S+)$/);
    const prevWord = wordMatch ? wordMatch[1] : "";
    // Single uppercase letter → likely "A. Smith" style abbreviation
    if (/^[A-Z]$/.test(prevWord)) return false;
    // Pure number → list item "1. First item"
    if (/^\d+$/.test(prevWord)) return false;
    // Known abbreviation
    if (ABBREVS.has(prevWord) || ABBREVS.has(prevWord.replace(/\.$/, ""))) return false;
    return true;
  });

  // Build sentence ranges
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const end of sentenceEnds) {
    if (end > start) ranges.push({ start, end });
    start = end;
  }
  if (start < fullText.length) ranges.push({ start, end: fullText.length });

  const results: SentenceInfo[] = [];
  for (const range of ranges) {
    const text = fullText.slice(range.start, range.end).trim();
    if (text.length < 3) continue;

    // Assign each token to this sentence using the token's midpoint character
    // position. This ensures every token belongs to exactly one sentence and
    // prevents highlight bleed at sentence boundaries.
    const sentenceItems: ProjectedItem[] = [];
    for (const tok of tokens) {
      const mid = tok.start + tok.str.length / 2;
      if (mid >= range.start && mid < range.end) {
        sentenceItems.push(tok.item);
      }
    }

    const rect = mergedRectPct(sentenceItems, vpWidth, vpHeight);
    if (!rect) continue;

    const lineRects = computeLineRects(sentenceItems, vpWidth, vpHeight);
    results.push({ text, pageIndex, ...rect, lineRects });
  }

  return results;
}

/**
 * Group items by line and return one bounding rect per line.
 * This produces tight per-line highlights instead of one big rectangle.
 */
function computeLineRects(
  items: ProjectedItem[],
  vpWidth: number,
  vpHeight: number,
): LineRect[] {
  const Y_TOLERANCE = 10; // generous tolerance to handle baseline drift within a line
  const lines: ProjectedItem[][] = [];
  const lineMidY: number[] = []; // running average midY per group

  for (const item of items) {
    const midY = (item.top + item.bottom) / 2;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < lineMidY.length; i++) {
      const dist = Math.abs(lineMidY[i] - midY);
      if (dist <= Y_TOLERANCE && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      lines[bestIdx].push(item);
      // Update running average midY so the group center tracks all items
      const grp = lines[bestIdx];
      lineMidY[bestIdx] = grp.reduce((s, it) => s + (it.top + it.bottom) / 2, 0) / grp.length;
    } else {
      lines.push([item]);
      lineMidY.push(midY);
    }
  }

  lines.sort((a, b) => a[0].top - b[0].top);

  return lines
    .map((lineItems) => mergedRectPct(lineItems, vpWidth, vpHeight))
    .filter((r): r is LineRect => r !== null);
}

/** Compute the union bounding box of items as viewport percentages. */
function mergedRectPct(
  items: ProjectedItem[],
  vpWidth: number,
  vpHeight: number,
): { xPct: number; yPct: number; widthPct: number; heightPct: number } | null {
  if (!items.length) return null;
  const left = Math.min(...items.map((i) => i.left));
  const top = Math.min(...items.map((i) => i.top));
  const right = Math.max(...items.map((i) => i.right));
  const bottom = Math.max(...items.map((i) => i.bottom));
  return {
    xPct: (left / vpWidth) * 100,
    yPct: (top / vpHeight) * 100,
    widthPct: ((right - left) / vpWidth) * 100,
    heightPct: ((bottom - top) / vpHeight) * 100,
  };
}
