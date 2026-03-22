/**
 * Standalone test for sentence detection logic.
 * Mirrors the pure functions from src/modules/sentences.ts so they can be
 * run directly with:  node scripts/test-sentences.mjs
 */

// ---------------------------------------------------------------------------
// Helpers (mirrored from sentences.ts)
// ---------------------------------------------------------------------------

function groupIntoLines(items) {
  const Y_TOLERANCE = 8;
  const lines = [];

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

  lines.sort((a, b) => a.top - b.top);
  for (const line of lines) line.items.sort((a, b) => a.left - b.left);
  return lines;
}

function isLikelyHeadingLine(line) {
  const firstStr = (line.items[0]?.str ?? "").trimStart();
  const fullStr = line.items.map((i) => i.str).join("").trim();

  if (/^\d+\.\d+|^[A-Z]\.\d+/.test(firstStr)) return true;
  if (/^\d+\s+[A-Z]/.test(firstStr) || /^\d+\s+[A-Z]/.test(fullStr)) return true;
  if (/^(?:I{1,3}|IV|V?I{0,3}|IX|X{1,2}I{0,3})\.\s+[A-Z]/i.test(firstStr)) return true;
  if (fullStr.length <= 50 && /^[A-Z][A-Z\s\-]{2,}$/.test(fullStr)) return true;
  if (
    fullStr.length > 0 &&
    fullStr.length <= 60 &&
    line.items.length <= 2 &&
    /^[A-Z]/.test(fullStr) &&
    !/[.!?:,;]$/.test(fullStr)
  ) return true;
  if (/^[†‡§∗*]/.test(firstStr)) return true;
  if (/^\[\d+\]\s/.test(firstStr) && fullStr.length > 15) return true;
  if (
    fullStr.length <= 80 &&
    /University|Institute|Department|School|Laboratory|Lab|College|Center|Centre/i.test(fullStr)
  ) return true;
  if (/\S+@\S+\.\S+/.test(fullStr)) return true;

  return false;
}

function groupIntoBlocks(lines) {
  if (lines.length === 0) return [];
  const blocks = [];
  let current = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const curr = lines[i];
    const prevH = prev.bottom - prev.top || 10;
    const currH = curr.bottom - curr.top || 10;
    const gap = curr.top - prev.bottom;
    const sizeRatio = Math.max(prevH, currH) / Math.min(prevH, currH);
    const splitOnHeading = isLikelyHeadingLine(curr) || isLikelyHeadingLine(prev);
    if (gap > prevH * 1.5 || sizeRatio > 1.8 || splitOnHeading) {
      blocks.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  blocks.push(current);
  return blocks;
}

const ABBREVS = new Set([
  "Dr", "Mr", "Mrs", "Ms", "Prof", "Sr", "Jr", "St", "Mt", "Rd", "Ave",
  "Fig", "Figs", "Eq", "Eqs", "Tab", "Ref", "Refs", "Sec", "Secs", "Ch",
  "Vol", "No", "pp", "p", "et", "al", "vs", "approx", "dept", "est", "etc",
  "govt", "max", "min", "avg", "std", "var", "Def", "Prop", "Thm", "Cor",
  "Lem", "Alg", "App", "Univ", "Dept", "Inc", "Ltd", "Corp", "Co",
  "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  "e.g", "i.e", "cf", "resp", "approx", "etal",
]);

function mergedRectPct(items, vpWidth, vpHeight) {
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

function computeLineRects(items, vpWidth, vpHeight) {
  const Y_TOLERANCE = 5;
  const lines = [];

  for (const item of items) {
    const midY = (item.top + item.bottom) / 2;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < lines.length; i++) {
      for (const li of lines[i]) {
        const dist = Math.abs((li.top + li.bottom) / 2 - midY);
        if (dist <= Y_TOLERANCE && dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
    }
    if (bestIdx >= 0) {
      lines[bestIdx].push(item);
    } else {
      lines.push([item]);
    }
  }

  lines.sort((a, b) => a[0].top - b[0].top);
  return lines
    .map((lineItems) => mergedRectPct(lineItems, vpWidth, vpHeight))
    .filter((r) => r !== null);
}

function splitBlockIntoSentences(block, pageIndex, vpWidth, vpHeight) {
  const tokens = [];
  let charPos = 0;

  for (const line of block) {
    for (let j = 0; j < line.items.length; j++) {
      const item = line.items[j];
      tokens.push({ str: item.str, item, start: charPos });
      charPos += item.str.length;

      const nextItem = line.items[j + 1];
      const cur = tokens[tokens.length - 1];
      if (nextItem && !cur.str.endsWith(" ") && !nextItem.str.startsWith(" ")) {
        tokens[tokens.length - 1] = { ...cur, str: cur.str + " " };
        charPos += 1;
      }
    }
    const last = tokens[tokens.length - 1];
    if (last && !last.str.endsWith(" ")) {
      tokens[tokens.length - 1] = { ...last, str: last.str + " " };
      charPos += 1;
    }
  }

  if (tokens.length === 0) return [];

  const fullText = tokens.map((t) => t.str).join("");

  const rawEnds = [];
  const endPattern = /[.!?][)\]"']?\s+[A-Z]/g;
  let m;
  while ((m = endPattern.exec(fullText)) !== null) {
    rawEnds.push(m.index + 1);
  }

  const sentenceEnds = rawEnds.filter((pos) => {
    const before = fullText.slice(0, pos - 1);
    const wordMatch = before.match(/(\S+)$/);
    const prevWord = wordMatch ? wordMatch[1] : "";
    if (/^[A-Z]$/.test(prevWord)) return false;
    if (/^\d+$/.test(prevWord)) return false;
    if (ABBREVS.has(prevWord) || ABBREVS.has(prevWord.replace(/\.$/, ""))) return false;
    return true;
  });

  const ranges = [];
  let start = 0;
  for (const end of sentenceEnds) {
    if (end > start) ranges.push({ start, end });
    start = end;
  }
  if (start < fullText.length) ranges.push({ start, end: fullText.length });

  const results = [];
  for (const range of ranges) {
    const text = fullText.slice(range.start, range.end).trim();
    if (text.length < 3) continue;

    const sentenceItems = [];
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

function processProjectedItems(items, pageIndex, vpWidth, vpHeight) {
  const lines = groupIntoLines(items);
  const blocks = groupIntoBlocks(lines);
  const sentences = [];
  for (const block of blocks) {
    sentences.push(...splitBlockIntoSentences(block, pageIndex, vpWidth, vpHeight));
  }
  return sentences;
}

// ---------------------------------------------------------------------------
// Mock data builder
// ---------------------------------------------------------------------------

/** Build a fake ProjectedItem for a word at a given x/y position */
function item(str, left, top, right, bottom) {
  return { str, left, top, right, bottom };
}

/**
 * Build items for a line of words, given a starting x and y range.
 * Word widths are estimated from character count.
 */
function makeLine(words, lineTop, lineBottom, startX = 50, charWidth = 6) {
  const items = [];
  let x = startX;
  for (const word of words) {
    const w = word.length * charWidth;
    items.push(item(word, x, lineTop, x + w, lineBottom));
    x += w; // no gap — space must come from token str or intra-line logic
  }
  return items;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

const VP_W = 500;
const VP_H = 700;

function runTest(name, items, expected) {
  const sentences = processProjectedItems(items, 0, VP_W, VP_H);
  console.log(`\n=== ${name} ===`);
  sentences.forEach((s, i) => {
    console.log(`  [${i}] "${s.text.slice(0, 80)}${s.text.length > 80 ? "…" : ""}"`);
    console.log(`       lineRects: ${s.lineRects.length}`);
  });
  if (expected) {
    const ok = sentences.length === expected.length &&
      expected.every((exp, i) => sentences[i]?.text.includes(exp));
    console.log(ok ? "  ✅ PASS" : "  ❌ FAIL");
    if (!ok) {
      console.log("  Expected sentences containing:", expected);
    }
  }
}

// --- Test 1: "acquisition. Nevertheless" boundary ---
// Line 1: "The emergence ... natural language"
// Line 2: "processing (NLP), ... acquisition. Nevertheless, LLMs are prone to"
{
  const line1 = makeLine(
    ["The ", "emergence ", "of ", "large ", "language ", "models ", "(LLMs) ", "has ", "marked ", "a ", "significant ", "breakthrough ", "in ", "natural ", "language"],
    100, 112, 50
  );
  // Line 2: words without spaces — mimic PDF items that have no trailing space
  const line2Words = ["processing ", "(NLP), ", "fueling ", "a ", "paradigm ", "shift ", "in ", "information ", "acquisition.", "Nevertheless,", "LLMs ", "are ", "prone ", "to"];
  const line2 = makeLine(line2Words, 114, 126, 50);

  runTest(
    "acquisition. Nevertheless boundary",
    [...line1, ...line2],
    ["The emergence", "Nevertheless"]
  );
}

// --- Test 2: "sequences." on line 2 boundary ---
// Line 1: "Recurrent models ... output"
// Line 2: "sequences. Aligning ... hidden"
// Line 3: "states ht ... t."
{
  const line1 = makeLine(
    ["Recurrent ", "models ", "typically ", "factor ", "computation ", "along ", "the ", "symbol ", "positions ", "of ", "the ", "input ", "and ", "output"],
    200, 212, 50
  );
  const line2 = makeLine(
    ["sequences.", "Aligning ", "the ", "positions ", "to ", "steps ", "in ", "computation ", "time, ", "they ", "generate ", "a ", "sequence ", "of ", "hidden"],
    214, 226, 50
  );
  const line3 = makeLine(
    ["states ", "ht, ", "as ", "a ", "function ", "of ", "the ", "previous ", "hidden ", "state ", "ht−1 ", "and ", "the ", "input ", "for ", "position ", "t."],
    228, 240, 50
  );

  // Correct expectation: 2 sentences
  // S1 = "Recurrent models...sequences."  (2 lineRects: full line1 + "sequences." on line2)
  // S2 = "Aligning...t."                  (2 lineRects: rest of line2 + line3)
  const result2 = processProjectedItems([...line1, ...line2, ...line3], 0, VP_W, VP_H);
  console.log("\n=== sequences. at start of line 2 ===");
  result2.forEach((s, i) => {
    console.log(`  [${i}] "${s.text.slice(0, 100)}${s.text.length > 100 ? "…" : ""}"`);
    console.log(`       lineRects: ${s.lineRects.length} → ${JSON.stringify(s.lineRects.map(r => ({ xPct: r.xPct.toFixed(1), widthPct: r.widthPct.toFixed(1) })))}`);
  });
  const ok2 = result2.length === 2
    && result2[0].text.includes("sequences.")
    && result2[0].lineRects.length === 2  // line1 + partial line2
    && result2[1].text.startsWith("Aligning");
  console.log(ok2 ? "  ✅ PASS" : "  ❌ FAIL — expected 2 sentences, S1 includes 'sequences.' with 2 lineRects, S2 starts with 'Aligning'");
}

// --- Test 3: Section heading "1 Introduction" split from body ---
{
  const heading = makeLine(["1 ", "Introduction"], 300, 316, 50);
  const bodyLine1 = makeLine(
    ["Recurrent ", "neural ", "networks, ", "long ", "short-term ", "memory ", "[13] ", "and ", "gated ", "recurrent ", "[7] ", "neural ", "networks"],
    320, 332, 50
  );

  runTest(
    "section heading separation",
    [...heading, ...bodyLine1],
    ["1 Introduction", "Recurrent neural"]
  );
}

// --- Test 4: acquisition. Nevertheless — with trailing space already in PDF item ---
{
  // Some PDFs include trailing space in the item string itself
  const line1 = makeLine(
    ["The ", "emergence ", "of ", "large ", "language ", "models ", "(LLMs) ", "has ", "marked ", "a ", "significant ", "breakthrough ", "in ", "natural ", "language "],
    100, 112, 50
  );
  const line2 = makeLine(
    // "acquisition. " has trailing space already in item str
    ["processing ", "(NLP), ", "fueling ", "a ", "paradigm ", "shift ", "in ", "information ", "acquisition. ", "Nevertheless, ", "LLMs ", "are ", "prone ", "to"],
    114, 126, 50
  );
  runTest(
    "acquisition. Nevertheless (space in item str)",
    [...line1, ...line2],
    ["The emergence", "Nevertheless"]
  );
}

// --- Test 5: cross-line boundary — "acquisition." ends line, "Nevertheless" starts next ---
{
  const line1 = makeLine(
    ["The ", "emergence ", "of ", "large ", "language ", "models ", "(LLMs) ", "has ", "marked ", "a ", "significant ", "breakthrough ", "in ", "natural ", "language "],
    100, 112, 50
  );
  const line2 = makeLine(
    ["processing ", "(NLP), ", "fueling ", "a ", "paradigm ", "shift ", "in ", "information ", "acquisition."],
    114, 126, 50
  );
  const line3 = makeLine(
    ["Nevertheless, ", "LLMs ", "are ", "prone ", "to ", "generating ", "hallucinations."],
    128, 140, 50
  );
  runTest(
    "acquisition. ends line, Nevertheless starts next line",
    [...line1, ...line2, ...line3],
    ["The emergence", "Nevertheless"]
  );
}

// --- Test 6: "examples. Recent work has achieved" — two-column layout ---
// Simulates the exact failing case from "Attention Is All You Need", Introduction.
// Words are separate items with NO trailing spaces (raw PDF extraction style).
// Each line is ~40-50 chars wide (two-column academic paper).
{
  const col = (words, lineTop, lineBottom) =>
    makeLine(words, lineTop, lineBottom, 50, 6);

  // Sentence 1 spans multiple lines, ending with "examples."
  const L1 = col(["This", "inherently", "sequential", "nature", "precludes"], 100, 112);
  const L2 = col(["parallelization", "within", "training", "examples,", "which"], 114, 126);
  const L3 = col(["becomes", "critical", "at", "longer", "sequence", "lengths,"], 128, 140);
  const L4 = col(["as", "memory", "constraints", "limit", "batching", "across"], 142, 154);
  const L5 = col(["examples."], 156, 168); // sentence 1 ends here

  // Sentence 2 starts on the next line
  const L6 = col(["Recent", "work", "has", "achieved", "significant"], 170, 182);
  const L7 = col(["improvements", "through", "factorization", "tricks", "[21]"], 184, 196);
  const L8 = col(["and", "conditional", "computation", "[32],", "while"], 198, 210);
  const L9 = col(["also", "improving", "model", "quality", "in", "case"], 212, 224);
  const L10 = col(["of", "the", "latter."], 226, 238);

  const result6 = processProjectedItems(
    [...L1, ...L2, ...L3, ...L4, ...L5, ...L6, ...L7, ...L8, ...L9, ...L10],
    0, VP_W, VP_H
  );
  console.log("\n=== examples. Recent work has achieved (two-column layout) ===");
  result6.forEach((s, i) => {
    console.log(`  [${i}] "${s.text.slice(0, 100)}${s.text.length > 100 ? "…" : ""}"`);
    console.log(`       lineRects: ${s.lineRects.length}`);
  });
  const ok6 = result6.length === 2
    && result6[0].text.includes("examples.")
    && result6[1].text.startsWith("Recent");
  console.log(ok6 ? "  ✅ PASS" : "  ❌ FAIL — expected 2 sentences split at 'examples. Recent'");
}

// --- Test 7: "Recent work has achieved" — 4 items on its own short line ---
// In a two-column PDF, if "Recent work has achieved" is the only content on a
// visual line (e.g., it starts mid-paragraph at the beginning of a column line),
// the heading heuristic must NOT fire and cause a block split.
{
  const col = (words, lineTop, lineBottom) =>
    makeLine(words, lineTop, lineBottom, 50, 6);

  const L1 = col(["across", "examples."], 100, 112); // end of previous sentence (short last line)
  const L2 = col(["Recent", "work", "has", "achieved"], 114, 126); // ≤4 items — heading-like!
  const L3 = col(["significant", "improvements", "through"], 128, 140);
  const L4 = col(["factorization", "tricks", "and", "conditional"], 142, 154);
  const L5 = col(["computation,", "while", "improving", "quality."], 156, 168);

  const result7 = processProjectedItems(
    [...L1, ...L2, ...L3, ...L4, ...L5],
    0, VP_W, VP_H
  );
  console.log("\n=== 'Recent work has achieved' on its own 4-item line ===");
  result7.forEach((s, i) => {
    console.log(`  [${i}] "${s.text.slice(0, 100)}${s.text.length > 100 ? "…" : ""}"`);
    console.log(`       lineRects: ${s.lineRects.length}`);
  });
  const ok7 = result7.length === 2
    && result7[0].text.includes("examples.")
    && result7[1].text.startsWith("Recent");
  console.log(ok7 ? "  ✅ PASS" : "  ❌ FAIL — 'Recent work has achieved' was misidentified as a heading, causing wrong block split");
}

console.log("\nDone.");