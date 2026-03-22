/**
 * Persistent translation cache backed by a JSON file in the Zotero profile
 * directory. Translations are keyed by attachment item ID and page index so
 * they survive across Zotero restarts without hitting the API again.
 */

import { SentenceInfo } from "./sentences";

export interface CachedPage {
  sentences: Array<{ sentence: SentenceInfo; translation: string }>;
}

type CacheStore = Record<string, CachedPage>; // key = "<itemId>_<pageIndex>"

let _cacheFilePath: string | null = null;
let _store: CacheStore = {};
let _dirty = false;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise the cache by loading the JSON file from disk.
 * Must be called once at plugin startup before any get/set operations.
 */
export async function initCache(): Promise<void> {
  _cacheFilePath = getCacheFilePath();
  _store = await loadFromDisk(_cacheFilePath);
}

/**
 * Look up cached translations for a specific page of an attachment.
 *
 * @param itemId    Zotero attachment item ID
 * @param pageIndex 0-based page index
 * @returns Cached sentences+translations, or null if not cached
 */
export function getCachedPage(
  itemId: number,
  pageIndex: number,
): CachedPage | null {
  const key = makeKey(itemId, pageIndex);
  return _store[key] ?? null;
}

/**
 * Store translations for a page so subsequent opens skip the API call.
 * Writes are debounced and flushed to disk asynchronously.
 *
 * @param itemId    Zotero attachment item ID
 * @param pageIndex 0-based page index
 * @param entries   Sentences and their translations
 */
export function setCachedPage(
  itemId: number,
  pageIndex: number,
  entries: Array<{ sentence: SentenceInfo; translation: string }>,
): void {
  const key = makeKey(itemId, pageIndex);
  _store[key] = { sentences: entries };
  scheduleSave();
}

/**
 * Remove all cached translations for all items.
 */
export function clearAllCache(): void {
  for (const key of Object.keys(_store)) {
    delete _store[key];
  }
  scheduleSave();
}

/**
 * Remove all cached translations for a given attachment item.
 */
export function clearCacheForItem(itemId: number): void {
  const prefix = `${itemId}_`;
  for (const key of Object.keys(_store)) {
    if (key.startsWith(prefix)) delete _store[key];
  }
  scheduleSave();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeKey(itemId: number, pageIndex: number): string {
  return `${itemId}_${pageIndex}`;
}

function getCacheFilePath(): string {
  // Zotero.DataDirectory.dir is the profile data directory (e.g. ~/Zotero)
  const dir: string = (Zotero.DataDirectory as any).dir;
  return PathUtils.join(dir, "hover-translation-cache.json");
}

async function loadFromDisk(path: string): Promise<CacheStore> {
  try {
    const exists = await IOUtils.exists(path);
    if (!exists) return {};
    const raw = await IOUtils.readUTF8(path);
    return JSON.parse(raw) as CacheStore;
  } catch (_e) {
    // Corrupt or missing file — start fresh
    return {};
  }
}

function scheduleSave(): void {
  _dirty = true;
  if (_saveTimer) return;
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    if (!_dirty || !_cacheFilePath) return;
    _dirty = false;
    try {
      await IOUtils.writeUTF8(_cacheFilePath, JSON.stringify(_store));
    } catch (_e) {
      // Non-fatal: next save attempt will retry
    }
  }, 2000);
}