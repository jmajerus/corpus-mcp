import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { planAnchorMigration, relocatedAnchorPlanner, type AnchorMigration } from "./anchor-migration.js";
import { type Anchor, storeAnchor } from "./anchors.js";
import { chunkPage } from "./chunk.js";
import { type DB, openDatabase } from "./db.js";
import { type DataStore, openDataStore, recordChanges } from "./data.js";
import { extractBook, sectionPaths } from "./extract.js";
import { PANDOC_EXTRACTOR_VERSION } from "./pandoc.js";
import { pagesOf, type QuoteAnchor } from "./quotes.js";
import type { BookRow, Corpus } from "./tools.js";

interface SavedAnchor extends QuoteAnchor {
  id: number; quote_id: number; status: string; sha256: string | null;
}
export interface StagedBook {
  book: string; status: "staged" | "refused"; reason?: string; changedPages?: number;
  anchors?: { kind: "quote" | "anchor"; id: number; status: string; reason?: string }[];
  oldLocations?: number; newLocations?: number; pandocVersion?: string;
  pandocWarnings?: string;
}

interface SnapshotPair { index: string; data: string; output: string }

async function copyPair(options: SnapshotPair): Promise<string> {
  const output = path.resolve(options.output);
  if (fs.existsSync(output)) throw new Error("The staging output must be a new directory.");
  const sourceIndex = new Database(options.index, { readonly: true, fileMustExist: true });
  let sourceData: Database.Database | undefined;
  try { sourceData = new Database(options.data, { readonly: true, fileMustExist: true }); }
  catch (error) { sourceIndex.close(); throw error; }
  try {
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    await sourceIndex.backup(path.join(output, "corpus.db"));
    await sourceData.backup(path.join(output, "data.db"));
  } finally { sourceIndex.close(); sourceData.close(); }
  return output;
}

/** Prepare an inspection-only rollback pair. Rotate the feed generation so consumers replay old anchors. */
export async function prepareEpubRollback(options: SnapshotPair) {
  const output = await copyPair(options);
  const db = openDatabase(path.join(output, "corpus.db"));
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
  const data = openDataStore(path.join(output, "data.db"));
  try {
    data.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('anchor_log',?)").run(randomUUID());
    data.pragma("wal_checkpoint(TRUNCATE)");
  } finally { data.close(); }
  const report = { directory: output, promotionReady: false, rollback: true, anchorLogRotated: true, requiresQuiescedWrites: true } as const;
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

/**
 * Build a candidate index/data pair, never modify inputs. Refuse an entire book if any verified
 * anchor cannot be mapped without guessing. The pair is for inspection, not automatic promotion.
 */
export async function stageEpubReextraction(options: SnapshotPair & {
  booksRoot: string; books: string[];
  /** Explicit mirror-path overrides; every file still has to match the indexed SHA-256. */
  files?: Record<string, string>;
  /** Pandoc is the preferred candidate. Source exists only for version-2 compatibility rehearsals. */
  backend?: "pandoc" | "source";
}): Promise<{ directory: string; books: StagedBook[]; promotionReady: false }> {
  if (!options.books.length) throw new Error("Select at least one book explicitly.");
  const output = await copyPair(options);
  const db = openDatabase(path.join(output, "corpus.db"));
  const data = openDataStore(path.join(output, "data.db"));
  const results: StagedBook[] = [];
  try {
    db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('epub_source_preview','inspection-only')").run();
    for (const id of new Set(options.books)) results.push(stageBook(db, data, options.booksRoot, id, options.files?.[id], options.backend ?? "pandoc"));
    db.pragma("wal_checkpoint(TRUNCATE)");
    data.pragma("wal_checkpoint(TRUNCATE)");
    const report = { directory: output, books: results, promotionReady: false as const };
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    return report;
  } catch (error) {
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ promotionReady: false, failed: true, error: (error as Error).message }, null, 2) + "\n");
    throw error;
  } finally { db.close(); data.close(); }
}

function stageBook(db: DB, data: DataStore, booksRoot: string, id: string, sourceFile: string | undefined, backend: "pandoc" | "source"): StagedBook {
  const refused = (reason: string, anchors?: StagedBook["anchors"]): StagedBook => ({ book: id, status: "refused", reason, ...(anchors ? { anchors } : {}) });
  const book = db.prepare<[string], BookRow>("SELECT * FROM books WHERE id = ?").get(id);
  if (!book || book.format !== "epub" || book.status !== "indexed" || !book.file_path) return refused("Book must have indexed EPUB text.");
  let writesStarted = false;
  try {
    const bytes = fs.readFileSync(sourceFile ?? path.join(booksRoot, book.file_path));
    if (createHash("sha256").update(bytes).digest("hex") !== book.sha256) return refused("Book file changed since the source index was built.");
    const next = extractBook(bytes, "epub", { epubParagraphs: backend });
    const oldPages = pagesOf(db, id, 0, book.page_count ?? 0);
    if (backend === "source" && (oldPages.length !== next.pages.length || oldPages.some((p, i) => p.page_index !== next.pages[i].index))) return refused("Reading locations changed.");
    const outline = db.prepare("SELECT ord, level, title, path, start_page FROM outline WHERE book_id = ? ORDER BY ord").all(id);
    const newOutline = next.outline.map(({ startPage, ...entry }) => ({ ...entry, start_page: startPage }));
    if (backend === "source" && JSON.stringify(outline) !== JSON.stringify(newOutline)) return refused("Outline mapping changed.");
    const sections = sectionPaths(next.outline, next.pages.length);
    const newPages = next.pages.map((p) => ({ page_index: p.index, label: p.label, section_path: sections[p.index], text: p.paragraphs.join("\n\n"), separator_before: p.separatorBefore ?? "" }));
    const migrate = backend === "pandoc" ? relocatedAnchorPlanner(oldPages, newPages)
      : (anchor: QuoteAnchor) => planAnchorMigration(oldPages, newPages, anchor);
    const planned: { kind: "quote" | "anchor"; id: number; result: AnchorMigration }[] = [];
    for (const [kind, table, key] of [["quote", "quotes", "id"], ["anchor", "anchors", "quote_id"]] as const) {
      const saved = data.prepare(`SELECT * FROM ${table} WHERE calibre_uuid = ?`).all(book.uuid) as SavedAnchor[];
      for (const row of saved) {
        if (row.status !== "verified") continue; // Preserve existing orphaned records and their flags.
        const result = row.sha256 !== book.sha256 ? { status: "review" as const, reason: "anchor-file-mismatch" }
          : migrate(row);
        planned.push({ kind, id: row[key], result });
      }
    }
    const summaries = planned.map(({ kind, id, result }) => ({ kind, id, status: result.status, ...(result.status === "review" ? { reason: result.reason } : {}) }));
    if (planned.some((p) => p.result.status === "review")) return refused("One or more anchors require review; the book was kept unchanged.", summaries);
    if (planned.length && db.prepare("SELECT count(*) FROM books WHERE uuid = ? AND status = 'indexed'").pluck().get(book.uuid) !== 1) {
      return refused("Calibre UUID names multiple indexed copies; anchors require review.", summaries);
    }
    const stamp = new Date().toISOString();
    // Both databases are disposable staging copies. A failed write aborts the candidate operation;
    // promotionReady remains false, and inputs are never touched.
    writesStarted = true;
    db.transaction(() => {
      db.prepare("DELETE FROM passages WHERE book_id = ?").run(id);
      db.prepare("DELETE FROM pages WHERE book_id = ?").run(id);
      db.prepare("DELETE FROM outline WHERE book_id = ?").run(id);
      const insertOutline = db.prepare("INSERT INTO outline(book_id,ord,level,title,path,start_page) VALUES (?,?,?,?,?,?)");
      for (const e of next.outline) insertOutline.run(id, e.ord, e.level, e.title, e.path, e.startPage);
      const page = db.prepare("INSERT INTO pages(book_id,page_index,label,section_path,text,separator_before) VALUES (?,?,?,?,?,?)");
      const passage = db.prepare("INSERT INTO passages (book_id,page_index,ord,text) VALUES (?,?,?,?)");
      for (const p of next.pages) {
        page.run(id, p.index, p.label, sections[p.index], newPages[p.index].text, newPages[p.index].separator_before);
        chunkPage(p.paragraphs).forEach((text, ord) => passage.run(id, p.index, ord, text));
      }
      if (next.pandocVersion) db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run(`pandoc:${id}`, next.pandocVersion);
      db.prepare(`UPDATE books SET extractor_version = ?, page_count = ?, text_chars = ?, indexed_at = ?,
        printed_isbns_version = NULL, printed_years_version = NULL, title_page_version = NULL WHERE id = ?`)
        .run(backend === "pandoc" ? PANDOC_EXTRACTOR_VERSION : 2, next.pages.length,
          db.prepare("SELECT COALESCE(SUM(LENGTH(text)),0) FROM pages WHERE book_id = ?").pluck().get(id), stamp, id);
    })();
    data.transaction(() => {
      for (const p of planned) {
        if (p.result.status === "review" || (p.result.status === "unchanged" && backend === "source")) continue;
        const a = p.result.anchor;
        if (p.kind === "anchor") {
          const anchor: Anchor = { ...a, calibre_uuid: book.uuid!, sha256: book.sha256,
            page_label: newPages[a.start_page].label, end_page_label: newPages[a.end_page].label, section: newPages[a.start_page].section_path };
          const response = storeAnchor({ db, data } as Corpus, { excludeTags: [] }, { quote_id: p.id, anchor });
          if (response.status !== 200) throw new Error(`Staged anchor #${p.id} failed verification.`);
        } else {
          data.prepare(`UPDATE quotes SET text = ?, start_page = ?, start_offset = ?, end_page = ?, end_offset = ?,
            page_label = ?, end_page_label = ?, section_path = ?,
            prefix = ?, suffix = ?, updated_at = ? WHERE id = ?`)
            .run(a.text, a.start_page, a.start_offset, a.end_page, a.end_offset,
              newPages[a.start_page].label, newPages[a.end_page].label, newPages[a.start_page].section_path,
              a.prefix, a.suffix, stamp, p.id);
          recordChanges(data, [{ kind: "quote_reanchored", source: "calibre", book_id: id, calibre_uuid: book.uuid, title: book.title, detail: `#${p.id} (EPUB source extraction)` }]);
        }
      }
    })();
    return { book: id, status: "staged", changedPages: oldPages.filter((p, i) => p.text !== newPages[i]?.text).length,
      oldLocations: oldPages.length, newLocations: newPages.length, pandocVersion: next.pandocVersion,
      ...(next.pandocWarnings ? { pandocWarnings: next.pandocWarnings } : {}), anchors: summaries };
  } catch (error) {
    // Extraction refusals occur before writes. Write failures must invalidate the entire candidate.
    if (writesStarted) throw error;
    return refused((error as Error).message);
  }
}
