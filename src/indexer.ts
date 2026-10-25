import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type BookMetadata, type CatalogueEntry, readCatalogue } from "./calibre.js";
import { chunkPage } from "./chunk.js";
import { proposeCitekey } from "./citekey.js";
import { ISBN_SCAN_VERSION, findPrintedIsbns } from "./isbn.js";
import type { Config } from "./config.js";
import { type DB, setMeta } from "./db.js";
import { type BookFormat, EXTRACTOR_VERSION, FORMAT_PREFERENCE, extractBook, sectionPaths } from "./extract.js";

export interface ScanSummary {
  scanned: number;
  extracted: number;
  unchanged: number;
  noFile: number;
  failed: number;
  removed: number;
  excluded: number;
  unreadableLibraries: string[];
  /** Shelves loaded from the export, or why they were left as they were. */
  shelves: number | string;
}

interface ExistingRow {
  file_path: string | null;
  file_size: number | null;
  file_mtime: number | null;
  sha256: string | null;
  extractor_version: number | null;
  status: string;
}

type Log = (message: string) => void;

/** The preferred ebook file that exists on disk, or null when the book has none. */
export function chooseBookFile(libraryRoot: string, files: Record<string, string>): { file: string; format: BookFormat } | null {
  for (const format of FORMAT_PREFERENCE) {
    const rel = files[format];
    if (rel && fs.existsSync(path.join(libraryRoot, rel))) return { file: path.join(libraryRoot, rel), format };
  }
  return null;
}

function sha256(data: Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function scanLibraries(config: Config, db: DB, { force = false, log = (() => {}) as Log } = {}): ScanSummary {
  const summary: ScanSummary = { scanned: 0, extracted: 0, unchanged: 0, noFile: 0, failed: 0, removed: 0, excluded: 0, unreadableLibraries: [], shelves: "no export" };
  const seen = new Set<string>();

  const getExisting = db.prepare<[string], ExistingRow>(
    "SELECT file_path, file_size, file_mtime, sha256, extractor_version, status FROM books WHERE id = ?",
  );

  for (const library of config.libraries) {
    const libraryRoot = path.join(config.booksRoot, library);
    if (!fs.existsSync(libraryRoot)) {
      log(`library "${library}" not found at ${libraryRoot}`);
      continue;
    }
    let catalogue: CatalogueEntry[];
    try {
      catalogue = readCatalogue(libraryRoot);
    } catch (error) {
      // Keep this library's existing rows: a sync may have caught metadata.db mid-write.
      log(`library "${library}": cannot read metadata.db (${(error as Error).message}); keeping its previous index`);
      summary.unreadableLibraries.push(library);
      for (const id of db.prepare("SELECT id FROM books WHERE library = ?").pluck().all(library) as string[]) seen.add(id);
      continue;
    }
    for (const { metadata, folder, files } of catalogue) {
      if (metadata.tags.some((tag) => config.excludeTags.includes(tag.toLowerCase()))) {
        summary.excluded++;
        continue;
      }
      const relFolder = path.join(library, folder);
      const id = `${library}:${metadata.calibreId}`;
      seen.add(id);
      summary.scanned++;

      const choice = chooseBookFile(libraryRoot, files);
      if (!choice) {
        db.transaction(() => {
          clearContent(db, id);
          writeBook(db, id, library, relFolder, metadata, { status: "no_file" });
        })();
        summary.noFile++;
        continue;
      }

      const relFile = path.relative(config.booksRoot, choice.file);
      const stat = fs.statSync(choice.file);
      const mtime = Math.floor(stat.mtimeMs);
      const existing = getExisting.get(id);
      const sameVersion = existing?.extractor_version === EXTRACTOR_VERSION && existing.status === "indexed";
      const file = { format: choice.format, file_path: relFile, file_size: stat.size, file_mtime: mtime };

      if (!force && sameVersion && existing.file_path === relFile && existing.file_size === stat.size && existing.file_mtime === mtime) {
        updateMetadata(db, id, metadata, relFolder);
        summary.unchanged++;
        continue;
      }

      const data = fs.readFileSync(choice.file);
      const hash = sha256(data);
      if (!force && sameVersion && existing.file_path === relFile && existing.sha256 === hash) {
        updateMetadata(db, id, metadata, relFolder);
        db.prepare("UPDATE books SET file_size = ?, file_mtime = ? WHERE id = ?").run(stat.size, mtime, id);
        summary.unchanged++;
        continue;
      }

      try {
        const book = extractBook(data, choice.format);
        const sections = sectionPaths(book.outline, book.pages.length);
        db.transaction(() => {
          clearContent(db, id);
          writeBook(db, id, library, relFolder, metadata, {
            ...file, sha256: hash, status: "indexed", reflowable: book.reflowable ? 1 : 0, page_count: book.pages.length,
          });
          const insertOutline = db.prepare(
            "INSERT INTO outline (book_id, ord, level, title, path, start_page) VALUES (?, ?, ?, ?, ?, ?)",
          );
          for (const e of book.outline) insertOutline.run(id, e.ord, e.level, e.title, e.path, e.startPage);
          const insertPage = db.prepare(
            "INSERT INTO pages (book_id, page_index, label, section_path, text) VALUES (?, ?, ?, ?, ?)",
          );
          const insertPassage = db.prepare("INSERT INTO passages (book_id, page_index, ord, text) VALUES (?, ?, ?, ?)");
          for (const page of book.pages) {
            insertPage.run(id, page.index, page.label, sections[page.index], page.paragraphs.join("\n\n"));
            chunkPage(page.paragraphs).forEach((text, ord) => insertPassage.run(id, page.index, ord, text));
          }
        })();
        summary.extracted++;
        log(`indexed ${id} ${metadata.title} (${choice.format}, ${book.pages.length} pages)`);
      } catch (error) {
        db.transaction(() => {
          clearContent(db, id);
          writeBook(db, id, library, relFolder, metadata, { ...file, sha256: hash, status: "failed", error: String((error as Error).message ?? error) });
        })();
        summary.failed++;
        log(`failed ${id} ${metadata.title}: ${(error as Error).message}`);
      }
    }
  }

  summary.shelves = loadShelves(config, db);
  fillDerivedColumns(db);

  const stale = (db.prepare("SELECT id FROM books").pluck().all() as string[]).filter((id) => !seen.has(id));
  db.transaction(() => {
    for (const id of stale) {
      clearContent(db, id);
      db.prepare("DELETE FROM books WHERE id = ?").run(id);
    }
  })();
  summary.removed = stale.length;
  setMeta(db, "last_scan", new Date().toISOString());
  return summary;
}

interface ShelfExport { exported_at: string; shelves: { id: number; name: string; books: { book_id: number; order: number | null }[] }[] }

/**
 * Replaces the shelf tables from Calibre-Web's export (deploy/corpus-source.sh). Shelf book ids are
 * Calibre ids in the library Calibre-Web serves. A missing or malformed export leaves the tables as they were.
 */
function loadShelves(config: Config, db: DB): number | string {
  let data: ShelfExport;
  try {
    data = JSON.parse(fs.readFileSync(config.shelvesFile, "utf8")) as ShelfExport;
    if (!Array.isArray(data.shelves)) throw new Error("no shelves array");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "no export" : `unreadable export: ${(error as Error).message}`;
  }
  const insertShelf = db.prepare("INSERT INTO shelves (id, name) VALUES (?, ?)");
  const insertLink = db.prepare("INSERT OR IGNORE INTO book_shelves (book_id, shelf_id, ord) VALUES (?, ?, ?)");
  db.transaction(() => {
    db.prepare("DELETE FROM book_shelves").run();
    db.prepare("DELETE FROM shelves").run();
    for (const shelf of data.shelves) {
      insertShelf.run(shelf.id, shelf.name);
      for (const book of shelf.books) insertLink.run(`${config.shelvesLibrary}:${book.book_id}`, shelf.id, book.order);
    }
    setMeta(db, "shelves_exported_at", data.exported_at);
  })();
  return data.shelves.length;
}

/** Copyright pages sit in the front matter, or at the back of some ebooks. */
const FRONT_PAGES = 20;
const BACK_PAGES = 5;

/**
 * Columns computed from the stored page text, filled for books extracted since the last scan or
 * computed by older rules, so the server never scans page text to answer a status request.
 */
function fillDerivedColumns(db: DB): void {
  db.prepare(`
    UPDATE books SET text_chars = (SELECT COALESCE(SUM(LENGTH(text)), 0) FROM pages p WHERE p.book_id = books.id)
    WHERE status = 'indexed' AND text_chars IS NULL`).run();
  const books = db.prepare(`
    SELECT id, page_count FROM books
    WHERE status = 'indexed' AND (printed_isbns_version IS NULL OR printed_isbns_version != ?)`)
    .all(ISBN_SCAN_VERSION) as { id: string; page_count: number }[];
  const pages = db.prepare(`
    SELECT page_index, label, text FROM pages
    WHERE book_id = ? AND (page_index < ? OR page_index >= ?) ORDER BY page_index`);
  const update = db.prepare("UPDATE books SET printed_isbns = ?, printed_isbns_version = ? WHERE id = ?");
  db.transaction(() => {
    for (const book of books) {
      const text = pages.all(book.id, FRONT_PAGES, book.page_count - BACK_PAGES) as { page_index: number; label: string | null; text: string }[];
      update.run(JSON.stringify(findPrintedIsbns(text, book.page_count, BACK_PAGES)), ISBN_SCAN_VERSION, book.id);
    }
  })();
}

function clearContent(db: DB, id: string): void {
  db.prepare("DELETE FROM passages WHERE book_id = ?").run(id);
  db.prepare("DELETE FROM pages WHERE book_id = ?").run(id);
  db.prepare("DELETE FROM outline WHERE book_id = ?").run(id);
}

function metadataColumns(m: BookMetadata) {
  const proposal = proposeCitekey(m);
  return {
    calibre_id: m.calibreId, uuid: m.uuid, title: m.title, authors: JSON.stringify(m.authors),
    author_sorts: JSON.stringify(m.authorSorts), publisher: m.publisher, year: m.year, language: m.language,
    isbn: m.isbn, calibre_citekey: m.citekey, proposed_citekey: proposal.key,
    citekey_blockers: JSON.stringify(proposal.blockers), tags: JSON.stringify(m.tags), description: m.description,
  };
}

function writeBook(db: DB, id: string, library: string, folder: string, m: BookMetadata, fields: Record<string, unknown>): void {
  const row: Record<string, unknown> = {
    id, library, folder, ...metadataColumns(m),
    format: null, file_path: null, file_size: null, file_mtime: null, sha256: null,
    extractor_version: EXTRACTOR_VERSION, reflowable: null, page_count: null, error: null,
    printed_isbns: null, printed_isbns_version: null, text_chars: null,
    indexed_at: new Date().toISOString(), ...fields,
  };
  const columns = Object.keys(row);
  db.prepare(`INSERT OR REPLACE INTO books (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`).run(row);
}

function updateMetadata(db: DB, id: string, m: BookMetadata, folder: string): void {
  const row = { id, folder, ...metadataColumns(m) };
  const sets = Object.keys(row).filter((k) => k !== "id").map((k) => `${k} = @${k}`);
  db.prepare(`UPDATE books SET ${sets.join(", ")} WHERE id = @id`).run(row);
}
