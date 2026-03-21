/**
 * Extract the full text of a PDF attachment using Zotero's built-in PDFWorker.
 *
 * @param attachmentItem - A Zotero item of type "attachment" with a PDF file
 * @returns The raw extracted text, or null if extraction fails
 * @throws If the item is not a PDF attachment
 */
export async function extractPDFText(
  attachmentItem: Zotero.Item,
): Promise<string | null> {
  if (!attachmentItem.isAttachment()) {
    throw new Error("Item is not an attachment");
  }

  const contentType = attachmentItem.attachmentContentType;
  if (contentType !== "application/pdf") {
    throw new Error(`Expected PDF attachment, got: ${contentType}`);
  }

  try {
    // Zotero.PDFWorker is typed as `any` in zotero-types — it is a stable
    // internal API used by Zotero's own full-text indexing pipeline.
    // getFullText(itemID, maxPages) -> Promise<{text: string, pages: number}>
    const result = await (Zotero.PDFWorker as any).getFullText(
      attachmentItem.id,
      9999,
    );
    return (result?.text as string) ?? null;
  } catch (e) {
    ztoolkit.log("PDFWorker.getFullText failed:", e);
    return null;
  }
}

/**
 * Split raw PDF text into non-empty paragraph strings.
 *
 * Two or more consecutive newlines are treated as paragraph boundaries.
 * Short runs (≤20 characters) such as page numbers and section headers are
 * filtered out so the translation API receives only real body text.
 *
 * @param text - Raw text returned by PDFWorker
 * @returns Array of trimmed, non-trivial paragraph strings
 */
export function splitIntoParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter((p) => p.length > 20);
}

/**
 * Find the first PDF attachment for a given library item.
 *
 * If the item itself is a PDF attachment, it is returned directly.
 * If it is a regular (parent) item, its attachment list is searched.
 *
 * @param item - A Zotero library item (parent or attachment)
 * @returns The first PDF attachment found, or null if none exists
 */
export function getPDFAttachment(item: Zotero.Item): Zotero.Item | null {
  if (
    item.isAttachment() &&
    item.attachmentContentType === "application/pdf"
  ) {
    return item;
  }

  if (item.isRegularItem()) {
    const attachmentIDs = item.getAttachments();
    for (const id of attachmentIDs) {
      const att = Zotero.Items.get(id);
      if (att && att.attachmentContentType === "application/pdf") {
        return att;
      }
    }
  }

  return null;
}
