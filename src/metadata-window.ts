import type { DB } from "./db.js";
import { PANDOC_EXTRACTOR_VERSION } from "./pandoc.js";

export interface MetadataPage {
  page_index: number;
  label: string | null;
  section_path: string | null;
  text: string;
  position: "front" | "back";
}

// Bounded text samples, not synthetic page numbers. Include the whole boundary block so an
// identifier is never cut in half. Legacy extraction keeps its existing 20/5-page sample.
export const METADATA_FRONT_CHARS = 60_000;
export const METADATA_BACK_CHARS = 15_000;
export const PANDOC_METADATA_WINDOW_VERSION = "1";

export function metadataPages(db: DB, book: { id: string; page_count: number; extractor_version: number | null }, aboutAuthors = false): MetadataPage[] {
  if (book.extractor_version !== PANDOC_EXTRACTOR_VERSION) {
    return db.prepare(`SELECT page_index, label, section_path, text,
      CASE WHEN page_index >= ? - 5 THEN 'back' ELSE 'front' END AS position
      FROM pages WHERE book_id = ? AND (page_index < 20 OR page_index >= ? - 5
        OR (? AND lower(section_path) LIKE '%about the author%')) ORDER BY page_index`)
      .all(book.page_count, book.id, book.page_count, Number(aboutAuthors)) as MetadataPage[];
  }
  return db.prepare(`WITH sampled AS (
    SELECT page_index, label, section_path, text,
      COALESCE(SUM(LENGTH(text)) OVER (ORDER BY page_index ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS preceding_chars,
      COALESCE(SUM(LENGTH(text)) OVER (ORDER BY page_index ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING), 0) AS following_chars
    FROM pages WHERE book_id = ?
  ) SELECT page_index, label, section_path, text,
      CASE WHEN preceding_chars < ? THEN 'front' ELSE 'back' END AS position
    FROM sampled WHERE preceding_chars < ? OR following_chars < ?
      OR (? AND lower(section_path) LIKE '%about the author%') ORDER BY page_index`)
    .all(book.id, METADATA_FRONT_CHARS, METADATA_FRONT_CHARS, METADATA_BACK_CHARS, Number(aboutAuthors)) as MetadataPage[];
}
