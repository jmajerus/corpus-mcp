import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import * as mupdf from "mupdf";

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "corpus-mcp-test-"));
}

function pdfString(text: string): string {
  return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

export interface PdfSpec {
  /** Paragraphs per page; each paragraph is drawn as one line. */
  pages: string[][];
  /** Text drawn near the bottom edge of every page, like a folio. */
  footer?: (pageIndex: number) => string;
  outline?: { title: string; page: number; children?: { title: string; page: number }[] }[];
  /** [startIndex, style, firstNumber] ranges, e.g. [[0, "r", 1], [2, "D", 1]]. */
  labels?: [number, string, number][];
}

export function makePdf(spec: PdfSpec): Buffer {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Times-Roman"));
  const resources = doc.addObject({ Font: { F1: font } });
  spec.pages.forEach((paragraphs, index) => {
    let content = "BT /F1 12 Tf 72 720 Td 18 TL\n";
    for (const paragraph of paragraphs) content += `${pdfString(paragraph)} Tj T* T*\n`;
    content += "ET\n";
    if (spec.footer) content += `BT /F1 9 Tf 300 30 Td ${pdfString(spec.footer(index))} Tj ET\n`;
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, content));
  });
  for (const [start, style, first] of spec.labels ?? []) doc.setPageLabels(start, style, "", first);
  if (spec.outline) {
    const it = doc.outlineIterator();
    for (const entry of spec.outline) {
      it.insert({ title: entry.title, uri: `#page=${entry.page}`, open: true });
      if (entry.children) {
        it.prev();
        it.down();
        for (const child of entry.children) it.insert({ title: child.title, uri: `#page=${child.page}`, open: true });
        it.up();
        it.next();
      }
    }
  }
  const out = Buffer.from(doc.saveToBuffer("compress").asUint8Array());
  doc.destroy();
  return out;
}

/** A minimal zip writer (stored entries only), enough for an EPUB container. */
function zip(entries: [string, string][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function makeEpub(title: string, chapters: { title: string; paragraphs: string[] }[]): Buffer {
  const xhtml = (heading: string, body: string) =>
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${heading}</title></head><body>${body}</body></html>`;
  const files: [string, string][] = chapters.map((c, i) => [
    `OEBPS/ch${i + 1}.xhtml`,
    xhtml(c.title, `<h1>${c.title}</h1>${c.paragraphs.map((p) => `<p>${p}</p>`).join("")}`),
  ]);
  const nav = xhtml("Contents", `<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol>${chapters
    .map((c, i) => `<li><a href="ch${i + 1}.xhtml">${c.title}</a></li>`).join("")}</ol></nav>`);
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test</dc:identifier><dc:title>${title}</dc:title><dc:language>en</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters
    .map((_, i) => `<item id="c${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest>
<spine>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join("")}</spine></package>`;
  return zip([
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`],
    ["OEBPS/content.opf", opf],
    ["OEBPS/nav.xhtml", nav],
    ...files,
  ]);
}

export interface FixtureBook {
  id: number;
  title: string;
  authors?: string[];
  publisher?: string;
  pubdate?: string;
  isbn?: string;
  /** Calibre identifier "citekey". */
  citekey?: string;
  /** Author sort forms; by default "Last, First" for each author, as Calibre writes a person. */
  sorts?: string[];
  tags?: string[];
  /** Format to file contents. */
  files?: Record<string, Buffer>;
}

/** Writes a Calibre-shaped library: metadata.db with the tables the reader uses, and book folders. */
export function makeLibrary(root: string, library: string, books: FixtureBook[]): void {
  const libraryRoot = path.join(root, library);
  fs.mkdirSync(libraryRoot, { recursive: true });
  const db = new Database(path.join(libraryRoot, "metadata.db"));
  db.exec(`
    CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, uuid TEXT, pubdate TEXT);
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, sort TEXT);
    CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
    CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER, publisher INTEGER);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);
    CREATE TABLE languages (id INTEGER PRIMARY KEY, lang_code TEXT);
    CREATE TABLE books_languages_link (id INTEGER PRIMARY KEY, book INTEGER, lang_code INTEGER, item_order INTEGER);
    CREATE TABLE identifiers (id INTEGER PRIMARY KEY, book INTEGER, type TEXT, val TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);
    CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT);
    INSERT INTO languages (id, lang_code) VALUES (1, 'eng');
  `);
  const insertId = (sql: string, ...values: unknown[]) => Number(db.prepare(sql).run(...values).lastInsertRowid);
  for (const book of books) {
    const author = book.authors?.[0] ?? "Unknown";
    const folder = `${author}/${book.title} (${book.id})`;
    db.prepare("INSERT INTO books VALUES (?, ?, ?, ?, ?)").run(book.id, book.title, folder, `uuid-${book.id}`, book.pubdate ?? "0101-01-01 00:00:00+00:00");
    (book.authors ?? []).forEach((name, i) => {
      const words = name.split(" ");
      const sort = book.sorts?.[i] ?? (words.length > 1 ? `${words.at(-1)}, ${words.slice(0, -1).join(" ")}` : name);
      db.prepare("INSERT INTO books_authors_link (book, author) VALUES (?, ?)").run(book.id, insertId("INSERT INTO authors (name, sort) VALUES (?, ?)", name, sort));
    });
    if (book.publisher) {
      db.prepare("INSERT INTO books_publishers_link (book, publisher) VALUES (?, ?)").run(book.id, insertId("INSERT INTO publishers (name) VALUES (?)", book.publisher));
    }
    for (const tag of book.tags ?? []) {
      db.prepare("INSERT INTO books_tags_link (book, tag) VALUES (?, ?)").run(book.id, insertId("INSERT INTO tags (name) VALUES (?)", tag));
    }
    db.prepare("INSERT INTO books_languages_link (book, lang_code, item_order) VALUES (?, 1, 0)").run(book.id);
    if (book.isbn) db.prepare("INSERT INTO identifiers (book, type, val) VALUES (?, 'isbn', ?)").run(book.id, book.isbn);
    if (book.citekey) db.prepare("INSERT INTO identifiers (book, type, val) VALUES (?, 'citekey', ?)").run(book.id, book.citekey);
    fs.mkdirSync(path.join(libraryRoot, folder), { recursive: true });
    for (const [format, data] of Object.entries(book.files ?? {})) {
      const name = `${book.title} - ${author}`;
      db.prepare("INSERT INTO data (book, format, name) VALUES (?, ?, ?)").run(book.id, format.toUpperCase(), name);
      fs.writeFileSync(path.join(libraryRoot, folder, `${name}.${format}`), data);
    }
  }
  db.close();
}
