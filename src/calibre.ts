import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/** Bibliographic metadata for one book in a Calibre library. */
export interface BookMetadata {
  calibreId: number;
  uuid: string | null;
  title: string;
  authors: string[];
  /** Calibre's sort form per author: "Gough, James" for a person, unchanged for an organization. */
  authorSorts: string[];
  publisher: string | null;
  /** null when Calibre has no date (it stores year 0101 for "undefined"). */
  year: number | null;
  language: string | null;
  isbn: string | null;
  /** A citekey set by hand as Calibre identifier "citekey:<key>"; it overrides a pinned key. */
  citekey: string | null;
  tags: string[];
  description: string | null;
}

export interface CatalogueEntry {
  metadata: BookMetadata;
  /** Book folder relative to the library root. */
  folder: string;
  /** Format (lower case) to file path relative to the library root. */
  files: Record<string, string>;
}

interface BookRow { id: number; title: string; path: string; uuid: string | null; pubdate: string | null }

/**
 * Reads a library's metadata.db, the catalogue authority. The metadata.opf files in book
 * folders are backups that go stale (orphaned folders, reused ids), so they are not used.
 * The database is read from an in-memory copy, so Calibre's file is never locked or opened for writing.
 */
export function readCatalogue(libraryRoot: string): CatalogueEntry[] {
  const db = new Database(fs.readFileSync(path.join(libraryRoot, "metadata.db")), { readonly: true });
  try {
    const listOf = (sql: string) => {
      const map = new Map<number, string[]>();
      for (const { book, value } of db.prepare(sql).all() as { book: number; value: string }[]) {
        if (!map.has(book)) map.set(book, []);
        map.get(book)!.push(value);
      }
      return map;
    };
    const authors = listOf("SELECT l.book, a.name AS value FROM books_authors_link l JOIN authors a ON a.id = l.author ORDER BY l.id");
    const authorSorts = listOf("SELECT l.book, COALESCE(a.sort, a.name) AS value FROM books_authors_link l JOIN authors a ON a.id = l.author ORDER BY l.id");
    const publishers = listOf("SELECT l.book, p.name AS value FROM books_publishers_link l JOIN publishers p ON p.id = l.publisher");
    const tags = listOf("SELECT l.book, t.name AS value FROM books_tags_link l JOIN tags t ON t.id = l.tag ORDER BY t.name");
    const languages = listOf("SELECT l.book, g.lang_code AS value FROM books_languages_link l JOIN languages g ON g.id = l.lang_code ORDER BY l.item_order");
    const isbns = listOf("SELECT book, val AS value FROM identifiers WHERE type = 'isbn'");
    const citekeys = listOf("SELECT book, val AS value FROM identifiers WHERE type = 'citekey'");
    const comments = listOf("SELECT book, text AS value FROM comments");
    const formats = new Map<number, { format: string; name: string }[]>();
    for (const row of db.prepare("SELECT book, format, name FROM data").all() as { book: number; format: string; name: string }[]) {
      if (!formats.has(row.book)) formats.set(row.book, []);
      formats.get(row.book)!.push(row);
    }

    const books = db.prepare("SELECT id, title, path, uuid, pubdate FROM books ORDER BY id").all() as BookRow[];
    return books.map((b) => {
      const year = Number(b.pubdate?.slice(0, 4));
      const files: Record<string, string> = {};
      for (const f of formats.get(b.id) ?? []) {
        const format = f.format.toLowerCase();
        files[format] = path.join(b.path, `${f.name}.${format}`);
      }
      return {
        metadata: {
          calibreId: b.id,
          uuid: b.uuid,
          title: b.title,
          authors: authors.get(b.id) ?? [],
          authorSorts: authorSorts.get(b.id) ?? [],
          publisher: publishers.get(b.id)?.[0] ?? null,
          year: year > 1000 ? year : null,
          language: languages.get(b.id)?.[0] ?? null,
          isbn: isbns.get(b.id)?.[0] ?? null,
          citekey: citekeys.get(b.id)?.[0]?.trim().toLowerCase() || null,
          tags: tags.get(b.id) ?? [],
          description: comments.get(b.id)?.[0] ?? null,
        },
        folder: b.path,
        files,
      };
    });
  } finally {
    db.close();
  }
}
