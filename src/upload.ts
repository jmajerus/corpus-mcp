import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import * as mupdf from "mupdf";
import { DEFAULT_PRESET, proposeCitekey } from "./citekey.js";
import type { Config } from "./config.js";
import { type BookContents, type ContentProfile, contentFindings, contentProfile, isPending } from "./duplicate-contents.js";
import { type DuplicateBook, GREYSCALE_COVER, candidateBooks, coverColour, doiKey, identifierKey, normal, normalAuthorsKey, sizeWarnings, unrelatedBooks } from "./duplicates.js";
import { findPrintedIsbns, isbn13, ownPrintedIsbns, validIsbn } from "./isbn.js";
import { mangledTitle, personName, scanTitlePage } from "./titlepage.js";
import { type Corpus, ToolError } from "./tools.js";
import { findPrintedYears, printedYear } from "./years.js";

export const UPLOAD_EXTENSIONS = ["kfx-zip", "epub", "pdf", "mobi", "azw", "azw3", "prc", "kfx"] as const;
export type UploadExtension = (typeof UPLOAD_EXTENSIONS)[number];
export type UploadAction = "skip" | "add_format" | "add_book";

export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
export const MAX_BATCH_BYTES = 250 * 1024 * 1024;

/** Says how far a selection is past the preview limit, in MB, so the extra files are easy to uncheck. */
export function batchLimitError(selectedBytes: number): string {
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  const over = selectedBytes - MAX_BATCH_BYTES;
  return `Selected files are ${mb(selectedBytes)} MB, ${mb(over)} MB over the ${mb(MAX_BATCH_BYTES)} MB preview limit. Uncheck about ${mb(over)} MB, then preview again.`;
}
export const MAX_STAGED_TOTAL_BYTES = 500 * 1024 * 1024;
export const MAX_STAGED_FILES = 100;
export const MAX_UNCOMPRESSED_ZIP_BYTES = 250 * 1024 * 1024;
export const MAX_ZIP_ENTRY_BYTES = 100 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 10_000;
const STAGED_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * Decompresses a ZIP-based archive (EPUB or KFX-ZIP) while enforcing strict bounds on entry count,
 * individual entry size, total uncompressed size across all central-directory entries, and compression ratio
 * before any entry is expanded. When `select` is provided, every entry in the archive is still checked against
 * the size/count bounds, while only selected entries are inflated.
 */
export function unzipBounded(
  data: Uint8Array,
  opts: {
    maxTotalBytes?: number;
    maxEntryBytes?: number;
    maxEntries?: number;
    select?: (file: { name: string; size: number; originalSize: number }) => boolean;
  } = {},
): Record<string, Uint8Array> {
  const maxTotal = opts.maxTotalBytes ?? MAX_UNCOMPRESSED_ZIP_BYTES;
  const maxEntry = opts.maxEntryBytes ?? MAX_ZIP_ENTRY_BYTES;
  const maxEntries = opts.maxEntries ?? MAX_ZIP_ENTRIES;
  let entries = 0;
  let totalUncompressed = 0;
  return unzipSync(data, {
    filter(file) {
      if (++entries > maxEntries) {
        throw new Error(`Archive contains more than ${maxEntries.toLocaleString("en")} entries.`);
      }
      if (file.originalSize < 0 || file.size < 0 || !Number.isFinite(file.originalSize) || !Number.isFinite(file.size)) {
        throw new Error("Archive has an invalid entry size.");
      }
      // An uncompressed size of 0 with a few compressed bytes is a normal empty directory entry
      // (META-INF/ and OEBPS/ in many EPUBs). fflate allocates the output to the declared size, so it cannot expand.
      if (file.originalSize > maxEntry) {
        throw new Error(`Archive entry ${file.name} exceeds the ${Math.round(maxEntry / (1024 * 1024))} MB uncompressed limit.`);
      }
      if (file.originalSize > 1024 * 1024 && file.originalSize / Math.max(1, file.size) > 200) {
        throw new Error("Archive compression ratio exceeds safety limit.");
      }
      totalUncompressed += file.originalSize;
      if (totalUncompressed > maxTotal) {
        throw new Error(`Archive uncompressed size exceeds the ${Math.round(maxTotal / (1024 * 1024))} MB limit.`);
      }
      return opts.select ? opts.select(file) : true;
    },
  });
}

export interface ExtractedUploadMetadata {
  title: string;
  authors: string[];
  year: number | null;
  publisher: string | null;
  identifiers: Record<string, string>;
  printed_isbns: string[];
  metadata_source: "embedded" | "titlepage" | "filename";
  author_order_aligned?: boolean;
  /** The UPLOAD_METADATA_SCAN this was read with; older records are read again (evaluateStagedUpload). */
  metadata_scan?: number;
}

export interface StagedUploadDraft {
  title: string;
  authors: string[];
  year: number | null;
  tags: string[];
  action?: UploadAction;
  action_explicit?: boolean;
  target_book_id?: string | null;
}

export interface StagedUploadRecord {
  id: string;
  filename: string;
  ext: UploadExtension;
  format: string;
  target_formats: string[];
  primary_format: "EPUB" | "PDF";
  converts_to: "EPUB" | "PDF" | null;
  size: number;
  sha256: string;
  staged_at: string;
  /** Staging order, one more than the highest staged so far: staged_at can tie within a millisecond. Absent on older records. */
  seq?: number;
  /** The staged file of the same book this one was set to wait for, kept after that file is applied and leaves staging. */
  waiting_on?: string;
  staged_by: string | null;
  problem: string | null;
  extracted: ExtractedUploadMetadata;
  draft: StagedUploadDraft;
}

export function uploadDir(config: Pick<Config, "dataDbPath">): string {
  return path.join(path.dirname(config.dataDbPath), "uploads");
}

export function parseUploadExtension(filename: string): { cleanName: string; ext: UploadExtension; format: string } {
  const cleanName = path.basename(filename.trim()).replace(/[\x00-\x1f]/g, "");
  if (!cleanName) throw new ToolError("Provide a file name.");
  const lower = cleanName.toLowerCase();
  const ext = UPLOAD_EXTENSIONS.find(e => lower.endsWith(`.${e}`));
  if (!ext) {
    throw new ToolError("Upload an EPUB, PDF, MOBI, AZW, AZW3, PRC, KFX, or KFX-ZIP file.");
  }
  return { cleanName, ext, format: ext.toUpperCase() };
}

/** Sniffs the uploaded file bytes for format, DRM encryption, print-replica PDFs, and structural validity. */
export function sniffUpload(data: Buffer, ext: UploadExtension): {
  kind: string;
  problem: string | null;
  target_formats: string[];
  primary_format: "EPUB" | "PDF";
  converts_to: "EPUB" | "PDF" | null;
} {
  if (!data.length) {
    return { kind: ext, problem: "The uploaded file is empty.", target_formats: [ext.toUpperCase()], primary_format: "EPUB", converts_to: null };
  }
  const head = data.subarray(0, 128);
  if (head.subarray(0, 8).equals(Buffer.from("\xeaDRMION\xee", "latin1"))) {
    return {
      kind: "kfx",
      problem: "DRM-encrypted (KFX DRMION); download it again and add it through DeDRM.",
      target_formats: ["KFX", "EPUB"],
      primary_format: "EPUB",
      converts_to: "EPUB",
    };
  }
  if (head.subarray(0, 4).toString("latin1") === "CONT") {
    const replica = data.includes(Buffer.from("%PDF-", "latin1")) && (data.includes(Buffer.from("yj_textbook", "latin1")) || data.includes(Buffer.from("yj_fixed_layout", "latin1")));
    const conv = replica ? "PDF" : "EPUB";
    return { kind: replica ? "kfx-replica" : "kfx", problem: null, target_formats: ["KFX", conv], primary_format: conv, converts_to: conv };
  }
  if (head.length >= 82 && (head.subarray(60, 68).toString("latin1") === "BOOKMOBI" || head.subarray(60, 68).toString("latin1") === "TEXtREAd")) {
    const rec0 = head.readUInt32BE(78);
    const encrypted = data.length >= rec0 + 14 && data.readUInt16BE(rec0 + 12) !== 0;
    const fmt = ext === "epub" || ext === "pdf" ? "MOBI" : ext.toUpperCase();
    return {
      kind: "mobi",
      problem: encrypted ? "DRM-encrypted (MOBI/AZW); download it again and add it through DeDRM." : null,
      target_formats: [fmt, "EPUB"],
      primary_format: "EPUB",
      converts_to: "EPUB",
    };
  }
  if (ext === "epub") {
    try {
      const files = unzipBounded(new Uint8Array(data), {
        select: f => f.name === "META-INF/container.xml" || f.name === "META-INF/encryption.xml",
      });
      if (!files["META-INF/container.xml"]) {
        return { kind: "epub", problem: "Damaged EPUB: META-INF/container.xml is missing.", target_formats: ["EPUB"], primary_format: "EPUB", converts_to: null };
      }
      if (files["META-INF/encryption.xml"]) {
        const enc = strFromU8(files["META-INF/encryption.xml"]);
        // Font obfuscation is standard in EPUBs; encrypted content documents are DRM.
        if (/<EncryptedData\b/i.test(enc) && /\.(x?html?|xml|ncx|opf)\b/i.test(enc)) {
          return { kind: "epub", problem: "DRM-encrypted EPUB; remove DRM before uploading.", target_formats: ["EPUB"], primary_format: "EPUB", converts_to: null };
        }
      }
      return { kind: "epub", problem: null, target_formats: ["EPUB"], primary_format: "EPUB", converts_to: null };
    } catch (error) {
      return { kind: "epub", problem: `Damaged EPUB archive: ${(error as Error).message}`, target_formats: ["EPUB"], primary_format: "EPUB", converts_to: null };
    }
  }
  if (ext === "pdf") {
    const header = data.subarray(0, 1024).toString("latin1");
    if (!header.includes("%PDF-")) {
      return { kind: "pdf", problem: "Damaged PDF: missing %PDF- header.", target_formats: ["PDF"], primary_format: "PDF", converts_to: null };
    }
    return { kind: "pdf", problem: null, target_formats: ["PDF"], primary_format: "PDF", converts_to: null };
  }
  if (ext === "kfx-zip") {
    try {
      const files = unzipBounded(new Uint8Array(data));
      const names = Object.keys(files);
      if (!names.length) {
        return { kind: "kfx-zip", problem: "Empty KFX-ZIP archive.", target_formats: ["KFX", "EPUB"], primary_format: "EPUB", converts_to: "EPUB" };
      }
      const buffers = Object.values(files).map(b => Buffer.from(b));
      if (buffers.some(buf => buf.subarray(0, 8).equals(Buffer.from("\xeaDRMION\xee", "latin1")))) {
        return {
          kind: "kfx-zip",
          problem: "DRM-encrypted (KFX DRMION); download it again and add it through DeDRM.",
          target_formats: ["KFX", "EPUB"],
          primary_format: "EPUB",
          converts_to: "EPUB",
        };
      }
      const replica = buffers.some(buf =>
        buf.includes(Buffer.from("%PDF-", "latin1")) && (buf.includes(Buffer.from("yj_textbook", "latin1")) || buf.includes(Buffer.from("yj_fixed_layout", "latin1"))),
      );
      const conv = replica ? "PDF" : "EPUB";
      return { kind: "kfx-zip", problem: null, target_formats: ["KFX", conv], primary_format: conv, converts_to: conv };
    } catch (error) {
      return { kind: "kfx-zip", problem: `Damaged KFX-ZIP archive: ${(error as Error).message}`, target_formats: ["KFX", "EPUB"], primary_format: "EPUB", converts_to: "EPUB" };
    }
  }
  return {
    kind: "unrecognized",
    problem: `Unrecognized ${ext.toUpperCase()} file.`,
    target_formats: [ext.toUpperCase(), "EPUB"],
    primary_format: "EPUB",
    converts_to: "EPUB",
  };
}

/** Words a title keeps in lower case, but for its first. */
const MINOR_WORDS = /^(?:a|an|the|and|or|nor|but|of|for|in|on|at|to|by|from|with|as|vs)$/i;

function fallbackFromFilename(filename: string, ext: UploadExtension): { title: string; authors: string[]; year: number | null } {
  let stem = filename.slice(0, filename.length - ext.length - 1).replace(/_/g, " ").replace(/\s+/g, " ").trim();
  // A publisher's download name, "9781789954050-DEPLOYMENT_OF_MICROSOFT_AZURE_CLOUD_SOLUTIONS": the
  // ISBN is no part of the title (the pages print it), and capitals throughout are no title's casing.
  const isbnPrefix = /^(97[89]\d{10}|\d{9}[\dX])[-\s]+(?=\S)/i.exec(stem);
  if (isbnPrefix && validIsbn(isbnPrefix[1])) stem = stem.slice(isbnPrefix[0].length);
  if (/\p{Lu}/u.test(stem) && !/\p{Ll}/u.test(stem)) {
    stem = stem.toLowerCase().split(" ").map((w, i) => (i > 0 && MINOR_WORDS.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
  }
  let year: number | null = null;
  const yearMatch = stem.match(/\((1[4-9]\d\d|20\d\d)\)\s*$/);
  if (yearMatch) {
    year = Number(yearMatch[1]);
    stem = stem.slice(0, yearMatch.index).trim();
  }
  const parts = stem.split(/\s+-\s+/);
  if (parts.length >= 2) {
    const first = parts[0].trim();
    const last = parts.at(-1)!.trim();
    // "Title - Author" (Calibre's export convention) or "Author - Title".
    if (personName(last) && !personName(first)) {
      return { title: parts.slice(0, -1).join(" - ").trim() || stem, authors: [last], year };
    }
    if (personName(first) && !personName(last)) {
      return { title: parts.slice(1).join(" - ").trim() || stem, authors: [first], year };
    }
    return { title: parts.slice(0, -1).join(" - ").trim() || stem, authors: [last], year };
  }
  return { title: stem || filename, authors: [], year };
}

function cleanAuthorList(raw: string[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    const parts = item.includes(";") || item.includes("|") || item.includes("&")
      ? item.split(/\s*(?:;|\||&)\s*/)
      : [item];
    for (const part of parts) {
      let trimmed = part.replace(/\s+/g, " ").trim();
      // Flip "Last, First" to "First Last" when there is a single comma and it isn't a suffix or organization.
      const comma = /^([^,]+),\s*([^,]+)$/.exec(trimmed);
      if (comma && !/^(?:jr|sr|ii|iii|iv|inc|llc|ltd|co|corp|plc|gmbh|ag|s\.?a|pty|limited|incorporated)\.?$/i.test(comma[2].trim())) {
        const flipped = `${comma[2].trim()} ${comma[1].trim()}`;
        if (personName(flipped)) trimmed = flipped;
      }
      if (trimmed && trimmed.toLowerCase() !== "unknown" && !out.some(a => a.toLowerCase() === trimmed.toLowerCase())) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

function parseYear(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1001 && raw <= 9999) return raw;
  if (typeof raw !== "string") return null;
  const m = raw.match(/\b(1[4-9]\d\d|20\d\d)\b/);
  return m ? Number(m[1]) : null;
}

/** Extracts title, authors, publication year, publisher, and ISBN/ASIN identifiers from a PalmDOC/MOBI/AZW3 EXTH header. */
function extractMobiMetadata(data: Buffer): Partial<ExtractedUploadMetadata> {
  if (data.length < 86) return {};
  const numRecords = data.readUInt16BE(76);
  const rec0 = data.readUInt32BE(78);
  const rec0End = numRecords > 1 && data.length >= 90 ? data.readUInt32BE(86) : data.length;
  if (rec0 >= data.length || rec0 + 16 >= rec0End) return {};
  const record = data.subarray(rec0, Math.min(rec0End, data.length));
  if (record.length < 132 || record.subarray(16, 20).toString("latin1") !== "MOBI") return {};
  const mobiLen = record.readUInt32BE(20);
  const encoding = record.readUInt32BE(28) === 65001 ? "utf8" : "latin1";
  const fullNameOffset = record.readUInt32BE(84);
  const fullNameLen = record.readUInt32BE(88);
  const exthFlags = record.readUInt32BE(128);
  let title = "";
  if (fullNameOffset && fullNameLen && fullNameOffset + fullNameLen <= record.length) {
    title = record.subarray(fullNameOffset, fullNameOffset + fullNameLen).toString(encoding).trim();
  }
  const authors: string[] = [];
  let publisher: string | null = null;
  let year: number | null = null;
  const identifiers: Record<string, string> = {};
  const exthStart = 16 + mobiLen;
  if ((exthFlags & 0x40) !== 0 && exthStart + 12 <= record.length && record.subarray(exthStart, exthStart + 4).toString("latin1") === "EXTH") {
    const count = record.readUInt32BE(exthStart + 8);
    let offset = exthStart + 12;
    for (let i = 0; i < count && offset + 8 <= record.length; i++) {
      const type = record.readUInt32BE(offset);
      const len = record.readUInt32BE(offset + 4);
      if (len < 8 || offset + len > record.length) break;
      const val = record.subarray(offset + 8, offset + len).toString(encoding).trim();
      offset += len;
      if (!val) continue;
      if (type === 100) authors.push(val);
      else if (type === 101 && !publisher) publisher = val;
      else if (type === 104) {
        const clean = validIsbn(val);
        if (clean) identifiers.isbn = isbn13(clean);
      } else if (type === 106 && !year) year = parseYear(val);
      else if ((type === 113 || type === 504) && !identifiers.asin) identifiers.asin = val;
      else if (type === 503) title = val;
    }
  }
  return {
    ...(title ? { title } : {}),
    ...(authors.length ? { authors: cleanAuthorList(authors) } : {}),
    ...(year ? { year } : {}),
    ...(publisher ? { publisher } : {}),
    identifiers,
  };
}

function textValue(node: unknown): string {
  if (typeof node === "string") return node.trim();
  if (typeof node === "number") return String(node);
  if (node && typeof node === "object" && "#text" in node) return String((node as { "#text": unknown })["#text"] ?? "").trim();
  return "";
}

function recordIdentifier(identifiers: Record<string, string>, scheme: string, rawValue: string): void {
  const val = rawValue.trim();
  if (!val) return;
  const doi = doiKey(scheme, val);
  if (doi) {
    identifiers.doi = doi;
    return;
  }
  const urn = /^urn:(asin|isbn):(.+)$/i.exec(val);
  const s = (urn ? urn[1] : scheme).toLowerCase();
  const body = (urn ? urn[2] : val).trim();
  const isbn = validIsbn(body);
  if (isbn && (s.includes("isbn") || (isbn.length === 13 && /^97[89]/.test(isbn)))) {
    identifiers.isbn = isbn13(isbn);
    return;
  }
  if (s === "asin" || s === "mobi-asin" || s === "amazon") {
    identifiers.asin = body;
  }
}

/**
 * Bump when reading a file's metadata improves, so staged files are read again: 1, printed ISBNs without
 * adverts (ownPrintedIsbns); 2, 20 front pages of a PDF and names under the title (scanTitlePage); 3, the
 * printed title for one from a file name, and "About the author" names only where a paragraph starts.
 */
const UPLOAD_METADATA_SCAN = 3;

/** The front pages of a PDF read for its metadata, as many as the indexer reads for a library book. */
const PDF_FRONT_PAGES = 20;

/** The most text an EPUB spine file can hold and still be read as front or back matter, not a chapter. */
const FRONT_MATTER_CHARS = 6000;

export function extractUploadMetadata(data: Buffer, ext: UploadExtension, filename: string, problem: string | null): ExtractedUploadMetadata {
  const fallback = fallbackFromFilename(filename, ext);
  const out: ExtractedUploadMetadata = {
    title: fallback.title,
    authors: fallback.authors,
    year: fallback.year,
    publisher: null,
    identifiers: {},
    printed_isbns: [],
    metadata_source: "filename",
    metadata_scan: UPLOAD_METADATA_SCAN,
  };
  if (problem) return out;

  if (ext === "epub") {
    try {
      const u8 = new Uint8Array(data);
      const containerFiles = unzipBounded(u8, {
        select: f => f.name === "META-INF/container.xml" || f.name.toLowerCase().endsWith(".opf"),
      });
      const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false });
      const roots = [xml.parse(strFromU8(containerFiles["META-INF/container.xml"])).container?.rootfiles?.rootfile].flat().filter(Boolean);
      const opfPath = (roots.find(r => r["@_media-type"] === "application/oebps-package+xml") ?? roots[0])?.["@_full-path"];
      if (opfPath && !containerFiles[opfPath]) {
        Object.assign(containerFiles, unzipBounded(u8, { select: f => f.name === opfPath }));
      }
      const pkg = opfPath && containerFiles[opfPath] ? xml.parse(strFromU8(containerFiles[opfPath])).package : null;
      const meta = pkg?.metadata;
      if (meta) {
        const titles = [meta.title].flat().map(textValue).filter(Boolean);
        if (titles.length && !mangledTitle(titles[0])) {
          out.title = titles[0];
          out.metadata_source = "embedded";
        }
        const creators = cleanAuthorList([meta.creator].flat().map(textValue).filter(Boolean));
        if (creators.length) {
          out.authors = creators;
          out.metadata_source = "embedded";
        }
        const dates = [meta.date].flat().map(textValue).map(parseYear).filter((y): y is number => y !== null);
        if (dates.length) out.year = dates[0];
        const pubs = [meta.publisher].flat().map(textValue).filter(Boolean);
        if (pubs.length) out.publisher = pubs[0];
        for (const idNode of [meta.identifier].flat().filter(Boolean)) {
          const scheme = String(idNode?.["@_scheme"] ?? idNode?.["@_id"] ?? "");
          recordIdentifier(out.identifiers, scheme, textValue(idNode));
        }
      }
      // Scan front/back XHTML spine items for printed ISBNs and copyright years when OPF lacks them.
      const items = new Map([pkg?.manifest?.item].flat().filter(Boolean).map(i => [i["@_id"], i["@_href"]]));
      const spinePaths = [pkg?.spine?.itemref].flat().filter(Boolean).flatMap(r => {
        const href = items.get(r["@_idref"]);
        return href ? [decodeURIComponent(new URL(href, `https://epub.invalid/${opfPath}`).pathname.slice(1))] : [];
      });
      const wantedSample = [...new Set([...spinePaths.slice(0, 6), ...spinePaths.slice(-2)])];
      const wantedSet = new Set(wantedSample);
      const files = wantedSet.size ? unzipBounded(u8, { select: f => wantedSet.has(f.name) }) : {};
      const samplePaths = wantedSample.filter(p => files[p]);
      const pages = samplePaths.map((p, idx) => ({
        page_index: idx,
        label: null,
        section_path: null,
        position: (idx < 6 ? "front" : "back") as "front" | "back",
        text: strFromU8(files[p]).replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ").replace(/<\/?(p|div|h[1-6]|li|br|tr)\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, " "),
      }));
      const printed = ownPrintedIsbns(findPrintedIsbns(pages, pages.length, 2));
      out.printed_isbns = printed.map(p => p.isbn13);
      if (!out.identifiers.isbn && printed.length) out.identifiers.isbn = printed[0].isbn13;
      // A sampled spine item is a whole file, which in a book without front matter is a chapter: its
      // headings aren't names on a title page, and its "published in 1911" is no publication year. Years
      // and title-page names come only from files short enough to be front or back matter.
      const matter = pages.filter(p => p.text.replace(/\s+/g, " ").trim().length <= FRONT_MATTER_CHARS);
      if (!out.year) {
        const py = printedYear(findPrintedYears(matter, matter.length, 2));
        if (py) out.year = py.year;
      }
      // A title from the file name is a guess: the printed one replaces it when the pages show it.
      const guessed = out.metadata_source === "filename" || mangledTitle(out.title);
      if (!out.authors.length || guessed) {
        const tp = scanTitlePage(matter, out.title, { findTitle: guessed });
        if (!out.authors.length && tp.authors.length) {
          out.authors = tp.authors.map(a => a.name);
          if (out.metadata_source === "filename") out.metadata_source = "titlepage";
        }
        if (guessed && tp.title) {
          out.title = tp.title.title;
          if (out.metadata_source === "filename") out.metadata_source = "titlepage";
        }
      }
    } catch { /* fallback stands */ }
    return out;
  }

  if (ext === "pdf") {
    try {
      const doc = mupdf.Document.openDocument(data, "book.pdf");
      try {
        const infoTitle = (doc.getMetaData("info:Title") ?? "").trim();
        const infoAuthor = (doc.getMetaData("info:Author") ?? "").trim();
        const infoDate = (doc.getMetaData("info:CreationDate") ?? "").trim();
        if (infoTitle && !mangledTitle(infoTitle)) {
          out.title = infoTitle;
          out.metadata_source = "embedded";
        }
        const authors = cleanAuthorList(infoAuthor ? [infoAuthor] : []);
        if (authors.length) {
          out.authors = authors;
          out.metadata_source = "embedded";
        }
        const total = doc.countPages();
        const indices = [...new Set([...Array.from({ length: Math.min(PDF_FRONT_PAGES, total) }, (_, i) => i), ...Array.from({ length: Math.min(2, total) }, (_, i) => total - 2 + i).filter(i => i >= 0)])];
        const pages = indices.map(i => {
          const page = doc.loadPage(i);
          try {
            const stext = page.toStructuredText("preserve-whitespace,dehyphenate");
            try {
              return { page_index: i, label: page.getLabel() || null, section_path: null, position: (i < PDF_FRONT_PAGES ? "front" : "back") as "front" | "back", text: stext.asText() };
            } finally { stext.destroy(); }
          } finally { page.destroy(); }
        });
        const printed = ownPrintedIsbns(findPrintedIsbns(pages, total, 2));
        out.printed_isbns = printed.map(p => p.isbn13);
        if (printed.length) out.identifiers.isbn = printed[0].isbn13;
        const py = printedYear(findPrintedYears(pages, total, 2));
        if (py) out.year = py.year;
        else if (!out.year) out.year = parseYear(infoDate);
        const guessed = out.metadata_source === "filename" || mangledTitle(out.title);
        if (!out.authors.length || guessed) {
          const tp = scanTitlePage(pages, out.title, { findTitle: guessed });
          if (!out.authors.length && tp.authors.length) {
            out.authors = tp.authors.map(a => a.name);
            if (out.metadata_source === "filename") out.metadata_source = "titlepage";
          }
          if (guessed && tp.title) {
            out.title = tp.title.title;
            if (out.metadata_source === "filename") out.metadata_source = "titlepage";
          }
        }
      } finally { doc.destroy(); }
    } catch { /* fallback stands */ }
    return out;
  }

  if (ext === "mobi" || ext === "azw" || ext === "azw3" || ext === "prc") {
    const mobi = extractMobiMetadata(data);
    if (mobi.title && !mangledTitle(mobi.title)) {
      out.title = mobi.title;
      out.metadata_source = "embedded";
    }
    if (mobi.authors?.length) {
      out.authors = mobi.authors;
      out.metadata_source = "embedded";
    }
    if (mobi.year) out.year = mobi.year;
    if (mobi.publisher) out.publisher = mobi.publisher;
    if (mobi.identifiers) Object.assign(out.identifiers, mobi.identifiers);
  }

  return out;
}

/** Cache of SHA-256 digests for non-indexed format files in the local mirror, keyed by file|size|mtimeMs. */
const mirroredFileHashes = new Map<string, string>();
function mirroredFileHash(filePath: string, expectedSize: number): string | null {
  try {
    const st = fs.statSync(filePath);
    if (st.size !== expectedSize) return null;
    const stamp = `${filePath}|${st.size}|${st.mtimeMs}`;
    let h = mirroredFileHashes.get(stamp);
    if (!h) {
      h = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
      mirroredFileHashes.set(stamp, h);
    }
    return h;
  } catch {
    return null;
  }
}

function estimateAuthorSorts(authors: string[]): { sorts: string[]; provisional: boolean } {
  let provisional = false;
  const sorts = authors.map(name => {
    provisional = true;
    if (!personName(name)) return name;
    const suffix = name.match(/,\s*(?:Jr\.?|Sr\.?|II|III|IV)$/i)?.[0] ?? "";
    const words = name.slice(0, suffix ? -suffix.length : undefined).trim().split(/\s+/);
    let start = words.length - 1;
    while (start > 0 && /^(?:de|da|di|del|della|der|den|van|von|la|le|du|dos|das|bin|ibn|al|el)$/i.test(words[start - 1])) start--;
    return `${words.slice(start).join(" ")}, ${words.slice(0, start).join(" ")}${suffix}`;
  });
  return { sorts, provisional };
}

function readStagedRecords(dir: string): StagedUploadRecord[] {
  if (!fs.existsSync(dir)) return [];
  const now = Date.now();
  const entries = fs.readdirSync(dir).sort();
  const records: StagedUploadRecord[] = [];
  const validFiles = new Set<string>();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const jsonPath = path.join(dir, entry);
    try {
      const rec = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as StagedUploadRecord;
      const binName = `${rec.id}.${rec.ext}`;
      const binPath = path.join(dir, binName);
      if (!fs.existsSync(binPath) || now - Date.parse(rec.staged_at) > STAGED_TTL_MS) {
        fs.rmSync(jsonPath, { force: true });
        fs.rmSync(binPath, { force: true });
        continue;
      }
      validFiles.add(entry);
      validFiles.add(binName);
      records.push(rec);
    } catch {
      fs.rmSync(jsonPath, { force: true });
    }
  }
  for (const entry of entries) {
    if (!validFiles.has(entry)) {
      fs.rmSync(path.join(dir, entry), { force: true });
    }
  }
  return records.sort((a, b) => a.staged_at.localeCompare(b.staged_at) || (a.seq ?? -1) - (b.seq ?? -1) || a.id.localeCompare(b.id));
}

function saveStagedRecord(dir: string, rec: StagedUploadRecord): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${rec.id}.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, `${rec.id}.json`));
}

export function stageUpload(c: Corpus, config: Config, filename: string, data: Buffer, actor?: string) {
  const { cleanName, ext, format } = parseUploadExtension(filename);
  if (!data.length) throw new ToolError("The uploaded file is empty.");
  if (data.length > MAX_UPLOAD_BYTES) throw new ToolError("The uploaded file exceeds the 250 MB limit.");
  const dir = uploadDir(config);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sha256 = createHash("sha256").update(data).digest("hex");
  const allStaged = readStagedRecords(dir);
  const existing = allStaged.find(r => r.sha256 === sha256);
  const others = allStaged.filter(r => r.id !== existing?.id);
  if (others.length + 1 > MAX_STAGED_FILES) {
    throw new ToolError(`At most ${MAX_STAGED_FILES} files may be staged at once. Apply or clear staged files first.`);
  }
  const otherBytes = others.reduce((sum, r) => sum + r.size, 0);
  if (otherBytes + data.length > MAX_STAGED_TOTAL_BYTES) {
    throw new ToolError("Staged uploads exceed the 500 MB staging storage limit. Apply or clear staged files first.");
  }
  const id = existing?.id ?? `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const binPath = path.join(dir, `${id}.${ext}`);
  if (existing && existing.ext !== ext) {
    fs.rmSync(path.join(dir, `${id}.${existing.ext}`), { force: true });
  }
  if (!existing || existing.ext !== ext || !fs.existsSync(binPath)) {
    fs.writeFileSync(binPath, data, { mode: 0o600 });
  }

  const sniff = sniffUpload(data, ext);
  const extracted = extractUploadMetadata(data, ext, cleanName, sniff.problem);
  const record: StagedUploadRecord = {
    id,
    filename: cleanName,
    ext,
    format,
    target_formats: sniff.target_formats,
    primary_format: sniff.primary_format,
    converts_to: sniff.converts_to,
    size: data.length,
    sha256,
    staged_at: existing?.staged_at ?? new Date().toISOString(),
    seq: existing?.seq ?? Math.max(0, ...allStaged.map(r => r.seq ?? 0)) + 1,
    staged_by: actor ?? existing?.staged_by ?? null,
    problem: sniff.problem,
    extracted,
    draft: existing?.draft ?? {
      title: extracted.title,
      authors: extracted.authors,
      year: extracted.year,
      tags: [],
    },
  };
  saveStagedRecord(dir, record);
  return evaluateStagedUpload(c, config, record, candidateBooks(c), readStagedRecords(dir));
}

export function updateStagedUpload(c: Corpus, config: Config, id: string, patch: {
  title?: unknown;
  authors?: unknown;
  year?: unknown;
  tags?: unknown;
  action?: unknown;
  target_book_id?: unknown;
}) {
  const dir = uploadDir(config);
  const rec = readStagedRecords(dir).find(r => r.id === id);
  if (!rec) throw new ToolError("Staged upload not found.");
  if (patch.title !== undefined) {
    if (typeof patch.title !== "string" || !patch.title.trim() || patch.title.length > 1000 || /[\x00-\x1f]/.test(patch.title)) {
      throw new ToolError("Enter a title.");
    }
    rec.draft.title = patch.title.trim();
  }
  if (patch.authors !== undefined) {
    if (!Array.isArray(patch.authors) || patch.authors.length > 100 || patch.authors.some(a => typeof a !== "string" || a.length > 300 || /[\x00-\x1f|]/.test(a))) {
      throw new ToolError("Enter each author separately.");
    }
    const cleaned = patch.authors.map(a => (a as string).trim()).filter(Boolean);
    if (cleaned.some(a => a.includes("&"))) {
      throw new ToolError("Enter each author separately; within one name, use ‘and’ instead of Calibre’s reserved & separator.");
    }
    rec.draft.authors = cleaned;
  }
  if (patch.year !== undefined) {
    if (patch.year !== null && (!Number.isInteger(patch.year) || (patch.year as number) < 1001 || (patch.year as number) > 9999)) {
      throw new ToolError("Enter a publication year from 1001 to 9999, or leave it blank.");
    }
    rec.draft.year = patch.year as number | null;
  }
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags) || patch.tags.some(t => typeof t !== "string" || /[\x00-\x1f]/.test(t))) {
      throw new ToolError("Send tags as an array of strings.");
    }
    rec.draft.tags = [...new Set(patch.tags.map(t => (t as string).trim()).filter(Boolean))];
  }
  if (patch.action !== undefined) {
    if (patch.action !== "skip" && patch.action !== "add_format" && patch.action !== "add_book") {
      throw new ToolError("Choose skip, add_format, or add_book.");
    }
    rec.draft.action = patch.action;
    rec.draft.action_explicit = true;
  }
  if (patch.target_book_id !== undefined) {
    if (patch.target_book_id !== null && typeof patch.target_book_id !== "string") {
      throw new ToolError("Invalid target book id.");
    }
    rec.draft.target_book_id = patch.target_book_id;
  }
  saveStagedRecord(dir, rec);
  return evaluateStagedUpload(c, config, rec, candidateBooks(c), readStagedRecords(dir));
}

/**
 * Removes one staged file. Unless it left because it was applied, a file waiting on it no longer is: its
 * pair never reached the library, so clearing staging won't send it back to intake as a format of that book.
 */
export function removeStagedUpload(config: Config, id: string, opts: { applied?: boolean } = {}): { removed: boolean } {
  const dir = uploadDir(config);
  const records = readStagedRecords(dir);
  const rec = records.find(r => r.id === id);
  if (!rec) return { removed: false };
  fs.rmSync(path.join(dir, `${rec.id}.json`), { force: true });
  fs.rmSync(path.join(dir, `${rec.id}.${rec.ext}`), { force: true });
  if (!opts.applied) {
    for (const other of records) {
      if (other.waiting_on !== id) continue;
      delete other.waiting_on;
      saveStagedRecord(dir, other);
    }
  }
  return { removed: true };
}

/**
 * Whether clearing staging should hand this file back to intake rather than mark it left on the NAS: it
 * was waiting for the other file of its pair, that file has left staging (normally by being applied), and
 * nobody chose Skip for it. Next time it's staged it's matched to the book the other file became.
 */
function returnsToIntake(rec: StagedUploadRecord, staged: StagedUploadRecord[]): boolean {
  if (!rec.waiting_on || staged.some(r => r.id === rec.waiting_on)) return false;
  return !(rec.draft.action_explicit && rec.draft.action === "skip");
}

/** Removes every staged file. `returned` lists the ones waiting on an applied pair, for intake to offer again. */
export function clearStagedUploads(config: Config): { cleared: number; returned: string[] } {
  const dir = uploadDir(config);
  const records = readStagedRecords(dir);
  const returned = records.filter(r => returnsToIntake(r, records)).map(r => r.id);
  for (const rec of records) {
    fs.rmSync(path.join(dir, `${rec.id}.json`), { force: true });
    fs.rmSync(path.join(dir, `${rec.id}.${rec.ext}`), { force: true });
  }
  return { cleared: records.length, returned };
}

function stripSketch(contents: BookContents): BookContents {
  return Object.fromEntries(
    Object.entries(contents).map(([f, p]) => [f, p && "sketch" in p ? (({ sketch: _sketch, ...rest }) => rest)(p) : p]),
  );
}

/**
 * What a staged file is matched by: its identifiers (and printed ISBNs), titles, and author lists, from
 * the file and the draft; `named` keeps the titles and authors as written, for unrelatedBooks.
 */
function matchKeys(rec: StagedUploadRecord): { ids: Set<string>; titles: Set<string>; authors: Set<string>; named: { titles: string[]; authors: string[] } } {
  const ids = new Set<string>();
  for (const [type, val] of Object.entries(rec.extracted.identifiers)) {
    const k = identifierKey(type, val);
    if (k) ids.add(JSON.stringify(k));
  }
  for (const isbn of rec.extracted.printed_isbns) {
    const k = identifierKey("isbn", isbn);
    if (k) ids.add(JSON.stringify(k));
  }
  const titles = new Set([normal(rec.extracted.title), normal(rec.draft.title)].filter(Boolean));
  const authors = new Set([rec.extracted.authors, rec.draft.authors].map(normalAuthorsKey).filter(Boolean));
  const named = { titles: [rec.extracted.title, rec.draft.title], authors: [...rec.extracted.authors, ...rec.draft.authors] };
  return { ids, titles, authors, named };
}

/** Why two staged files look like the same book, by the same evidence a library match uses; empty when they don't. */
function stagedEvidence(a: ReturnType<typeof matchKeys>, b: ReturnType<typeof matchKeys>): string[] {
  const evidence: string[] = [];
  if ([...a.ids].some(k => b.ids.has(k)) && !unrelatedBooks(a.named, b.named)) evidence.push("Matching identifier");
  const title = [...a.titles].find(t => b.titles.has(t));
  if (title) {
    if ([...a.authors].some(x => b.authors.has(x))) evidence.push("Matching title and authors");
    else if ((!a.authors.size || !b.authors.size) && title.length >= 8 && title.includes(" ")) evidence.push("Matching title");
  }
  return evidence;
}

export interface StagedMatch {
  id: string;
  filename: string;
  format: string;
  /** The formats the other file adds, and the readable one: whether one can become a new format of the other's book. */
  target_formats: string[];
  primary_format: "EPUB" | "PDF";
  evidence: string[];
  /** True when the other file was staged first, so it is the one to add as the new book. */
  earlier: boolean;
}

/**
 * The other staged files that look like the same book as this one (an EPUB and a PDF of one title, or two
 * copies with different bytes). `staged` is every staged record, in staging order.
 */
function stagedMatches(rec: StagedUploadRecord, staged: StagedUploadRecord[]): StagedMatch[] {
  const mine = matchKeys(rec);
  const at = staged.findIndex(r => r.id === rec.id);
  const out: StagedMatch[] = [];
  staged.forEach((other, i) => {
    if (other.id === rec.id || other.sha256 === rec.sha256) return;
    const evidence = stagedEvidence(mine, matchKeys(other));
    if (evidence.length) out.push({
      id: other.id, filename: other.filename, format: other.format, target_formats: other.target_formats,
      primary_format: other.primary_format, evidence, earlier: at < 0 || i < at,
    });
  });
  return out;
}

export function evaluateStagedUpload(c: Corpus, config: Config, rec: StagedUploadRecord, books: DuplicateBook[], staged: StagedUploadRecord[] = []) {
  const dir = uploadDir(config);
  const binPath = path.join(dir, `${rec.id}.${rec.ext}`);

  // Normalize "Last, First" authors from earlier staged records so existing staged uploads benefit immediately.
  if (!rec.extracted.author_order_aligned) {
    rec.extracted.authors = cleanAuthorList(rec.extracted.authors);
    rec.draft.authors = cleanAuthorList(rec.draft.authors);
    rec.extracted.author_order_aligned = true;
    saveStagedRecord(dir, rec);
  }
  // A file staged before reading improved (UPLOAD_METADATA_SCAN) is read again. Its identifiers and
  // printed ISBNs are replaced; its title, authors and year are too, where the draft still holds what was
  // read before, so nothing a person typed is overwritten.
  if ((rec.extracted.metadata_scan ?? 0) < UPLOAD_METADATA_SCAN) {
    const fresh = extractUploadMetadata(fs.readFileSync(binPath), rec.ext, rec.filename, rec.problem);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (same(rec.draft.title, rec.extracted.title)) rec.draft.title = fresh.title;
    if (same(rec.draft.authors, rec.extracted.authors)) rec.draft.authors = fresh.authors;
    if (same(rec.draft.year, rec.extracted.year)) rec.draft.year = fresh.year;
    rec.extracted = { ...fresh, author_order_aligned: true };
    saveStagedRecord(dir, rec);
  }

  // Keys for identifier and title/author matching (from both extracted and draft metadata).
  const { ids: uploadIdKeys, titles: titleSet, authors: authorSignatures, named } = matchKeys(rec);
  // Identifiers shared with a book whose title and authors have nothing in common with this one's: one
  // of the two carries a wrong ISBN, which is worth fixing, but it is no evidence they are one book.
  const identifierNotes: string[] = [];
  const unrelatedMatches: DuplicateBook[] = [];

  const exactMatches: { id: string; title: string; authors: string[]; year: number | null; formats: string[]; library: string; calibre_id: number; matched_format: string }[] = [];
  const candidateMap = new Map<string, { book: DuplicateBook; evidence: Set<string> }>();
  const addEvidence = (book: DuplicateBook, reason: string) => {
    const entry = candidateMap.get(book.id) ?? { book, evidence: new Set<string>() };
    entry.evidence.add(reason);
    candidateMap.set(book.id, entry);
  };

  for (const b of books) {
    // 1. Exact SHA-256 match against indexed file or any mirrored format file of the same byte size.
    let matchedFormat: string | null = null;
    if (b.sha256 && b.sha256 === rec.sha256) {
      matchedFormat = (b.format ?? rec.format).toUpperCase();
    } else {
      for (const [fmt, relName] of Object.entries(b.files)) {
        if (b.sizes[fmt] !== undefined && b.sizes[fmt] !== rec.size) continue;
        const full = path.join(c.booksRoot, b.folder, relName);
        if (mirroredFileHash(full, rec.size) === rec.sha256) {
          matchedFormat = fmt.toUpperCase();
          break;
        }
      }
    }
    if (matchedFormat) {
      exactMatches.push({
        id: b.id, title: b.title, authors: b.authors, year: b.year,
        formats: b.formats, library: b.library, calibre_id: b.calibre_id, matched_format: matchedFormat,
      });
      addEvidence(b, "Identical file");
    }

    // 2. Identifier match (ISBN-10/13, ASIN, etc., plus printed ISBNs in the book's text).
    const shared = [
      ...Object.entries(b.identifiers).map(([type, val]) => identifierKey(type, val)),
      ...(b.printed_isbns ?? []).map(isbn => identifierKey("isbn", isbn)),
    ].filter((k): k is string[] => !!k && uploadIdKeys.has(JSON.stringify(k)));
    if (shared.length) {
      if (!unrelatedBooks(named, { titles: [b.title], authors: b.authors })) addEvidence(b, "Matching identifier");
      else {
        unrelatedMatches.push(b);
        identifierNotes.push(`${b.id} (${b.title}${b.authors.length ? `, ${b.authors.join(", ")}` : ""}) has this file's ${shared[0][1].toUpperCase()} ${shared[0][2]}, but its title and authors have nothing in common with this one's, so it isn't counted as a match. One of them probably carries the wrong ${shared[0][1].toUpperCase()}.`);
      }
    }

    // 3. Normalized title + authors match (or title match when one side lacks authors).
    const bTitle = normal(b.title);
    const bAuthors = normalAuthorsKey(b.authors);
    if (bTitle && titleSet.has(bTitle)) {
      if (bAuthors && authorSignatures.has(bAuthors)) {
        addEvidence(b, "Matching title and authors");
      } else if ((!bAuthors || !authorSignatures.size) && bTitle.length >= 8 && bTitle.includes(" ")) {
        addEvidence(b, "Matching title");
      }
    }
  }

  // Only profile EPUB/PDF contents when there are candidate matches to compare against (just like
  // duplicateGroups in src/duplicates.ts), so unmatched new uploads are ready immediately and never
  // queue full-library PDF profiling on the background worker.
  const uploadContents: BookContents = {};
  if (!rec.problem && candidateMap.size > 0 && (rec.ext === "epub" || rec.ext === "pdf")) {
    uploadContents[rec.ext.toUpperCase() as "EPUB" | "PDF"] = contentProfile(binPath, rec.ext.toUpperCase() as "EPUB" | "PDF", c.data);
  }
  const uploadProfile = uploadContents[rec.ext.toUpperCase() as "EPUB" | "PDF"];

  // Load cover colour and content profiles for every matched book so we can compare contents and rank targets.
  for (const { book } of candidateMap.values()) {
    book.cover_colour = coverColour(path.join(c.booksRoot, book.folder, "cover.jpg"));
    for (const fmt of ["EPUB", "PDF"] as const) {
      if (book.files[fmt] && !book.contents[fmt]) {
        book.contents[fmt] = contentProfile(path.join(c.booksRoot, book.folder, book.files[fmt]), fmt, c.data);
      }
    }
  }

  const matchedBooks = [...candidateMap.values()].map(m => m.book);
  const uploadSizeRecord: Record<string, number> = {};
  if (rec.ext === "epub" || rec.ext === "pdf") uploadSizeRecord[rec.ext.toUpperCase()] = rec.size;
  const comparisonBooks = [
    { id: "upload", contents: uploadContents, sizes: uploadSizeRecord },
    ...matchedBooks.map(b => ({ id: b.id, contents: b.contents, sizes: b.sizes })),
  ];
  const findings = matchedBooks.length
    ? contentFindings(comparisonBooks, sizeWarnings(comparisonBooks))
    : {
        content_warnings: [],
        content_notes: [],
        content_overlap: {},
        contents_pending: [],
        size_warnings: [],
      };

  const referenced = (b: DuplicateBook) => Object.values(b.references).some(n => n > 0);
  const colour = (b: DuplicateBook) => b.cover_colour !== null && b.cover_colour >= GREYSCALE_COVER;
  const rankBook = (a: DuplicateBook, b: DuplicateBook) => {
    if (referenced(a) !== referenced(b)) return referenced(a) ? -1 : 1;
    if (colour(a) !== colour(b)) return colour(a) ? -1 : 1;
    if ((a.shelves.length > 0) !== (b.shelves.length > 0)) return a.shelves.length ? -1 : 1;
    if ((a.status === "indexed") !== (b.status === "indexed")) return a.status === "indexed" ? -1 : 1;
    return a.calibre_id - b.calibre_id;
  };

  const matches = [...candidateMap.values()]
    .sort((a, b) => rankBook(a.book, b.book))
    .map(({ book, evidence }) => {
      const existingFormats = new Set(book.formats.map(f => f.toUpperCase()));
      const missing_formats = rec.target_formats.filter(f => !existingFormats.has(f));
      const conflicting_formats = rec.target_formats.filter(f => existingFormats.has(f));
      const writable = book.library === config.shelvesLibrary && book.uuid !== null;
      // Only offer add_format when the existing book lacks the primary readable format (or uploaded format).
      const can_add_format = writable && exactMatches.length === 0 && !rec.problem && missing_formats.includes(rec.primary_format);
      const uploadYear = rec.draft.year ?? rec.extracted.year;
      return {
        book: { ...book, contents: stripSketch(book.contents) },
        evidence: [...evidence],
        edition_warning: uploadYear && book.year && uploadYear !== book.year ? "Publication years differ; these may be different editions." : null,
        writable,
        missing_formats,
        conflicting_formats,
        can_add_format,
      };
    });

  const blockers: string[] = [];
  if (rec.problem) blockers.push(rec.problem);
  if (uploadProfile && !isPending(uploadProfile) && "error" in uploadProfile) blockers.push(uploadProfile.error);
  if (exactMatches.length) {
    blockers.push(`Identical file is already in Calibre: ${exactMatches.map(m => `${m.id} (${m.title}, ${m.matched_format})`).join(", ")}.`);
  }

  const addFormatMatch = matches.find(m => m.can_add_format);
  // A file whose book is staged earlier waits: once that one is added, this one is matched to it and
  // offered as a new format (or, if it's another edition, it can be added on its own in a later preview).
  const staged_matches = stagedMatches(rec, staged);
  const waitsFor = staged_matches.find(m => m.earlier);
  // The marker follows the current earlier match. Once its file has left staging the marker stays, since
  // that file was applied (a removal clears it, in removeStagedUpload). A marker naming a file that is
  // still staged but no longer matches goes too; drafts can't cause that today (a file's own title and
  // authors stay match keys), but nothing then depends on it.
  const waitingOn = waitsFor?.id
    ?? (rec.waiting_on && staged.some(r => r.id === rec.waiting_on) ? undefined : rec.waiting_on);
  if (waitingOn !== rec.waiting_on) {
    if (waitingOn) rec.waiting_on = waitingOn;
    else delete rec.waiting_on;
    saveStagedRecord(dir, rec);
  }
  const suggested_action: UploadAction = blockers.length
    ? "skip"
    : addFormatMatch
    ? "add_format"
    : matches.length || waitsFor
    ? "skip"
    : "add_book";
  const suggested_target = addFormatMatch?.book.id ?? null;

  const allowed_actions: UploadAction[] = ["skip"];
  if (!blockers.length) {
    if (addFormatMatch) allowed_actions.push("add_format");
    allowed_actions.push("add_book");
  }

  const chosenAction: UploadAction = rec.draft.action_explicit && rec.draft.action && allowed_actions.includes(rec.draft.action)
    ? rec.draft.action
    : suggested_action;
  const chosenTarget = chosenAction === "add_format"
    ? (matches.find(m => m.can_add_format && m.book.id === rec.draft.target_book_id)?.book.id ?? suggested_target)
    : null;

  const { sorts, provisional } = estimateAuthorSorts(rec.draft.authors);
  const citekey = proposeCitekey(
    { title: rec.draft.title, authors: rec.draft.authors, authorSorts: sorts, publisher: rec.extracted.publisher, year: rec.draft.year },
    c.citekeyPreset ?? DEFAULT_PRESET,
  );

  return {
    id: rec.id,
    filename: rec.filename,
    ext: rec.ext,
    format: rec.format,
    target_formats: rec.target_formats,
    primary_format: rec.primary_format,
    converts_to: rec.converts_to,
    size: rec.size,
    sha256: rec.sha256,
    staged_at: rec.staged_at,
    staged_by: rec.staged_by,
    problem: rec.problem,
    extracted: rec.extracted,
    draft: {
      title: rec.draft.title,
      authors: rec.draft.authors,
      year: rec.draft.year,
      tags: rec.draft.tags,
      action: chosenAction,
      target_book_id: chosenTarget,
    },
    proposed_citekey: { key: citekey.key, blockers: citekey.blockers, provisional },
    contents: stripSketch(uploadContents),
    ...findings,
    content_notes: [...identifierNotes, ...findings.content_notes],
    exact_matches: exactMatches,
    matches,
    /** Books that share an identifier but nothing else (see content_notes): shown, so not news when applying. */
    unrelated_matches: unrelatedMatches.map(b => ({ id: b.id, library: b.library, calibre_id: b.calibre_id, uuid: b.uuid })),
    staged_matches,
    returns_to_intake: returnsToIntake(rec, staged),
    blockers,
    suggested_action,
    suggested_target,
    allowed_actions,
  };
}

/** How much of the staging quota is already used, and which hashes are already staged. */
export function stagedUploadState(config: Config): { files: number; bytes: number; ids: Set<string>; hashes: Map<string, string> } {
  const records = readStagedRecords(uploadDir(config));
  return {
    files: records.length,
    bytes: records.reduce((sum, rec) => sum + rec.size, 0),
    ids: new Set(records.map(rec => rec.id)),
    hashes: new Map(records.map(rec => [rec.sha256, rec.id])),
  };
}

export function listStagedUploads(c: Corpus, config: Config) {
  const records = readStagedRecords(uploadDir(config));
  const books = records.length ? candidateBooks(c) : [];
  const items = records.map(r => evaluateStagedUpload(c, config, r, books, records));
  return {
    items,
    last_scan: c.db.prepare("SELECT value FROM meta WHERE key='last_scan'").pluck().get() ?? null,
    calibre_web_url: config.admin?.calibreWebUrl ?? null,
    writable_library: config.shelvesLibrary,
    max_batch_bytes: MAX_BATCH_BYTES,
  };
}

export interface UploadSelection {
  id: string;
  sha256: string;
  action: "add_book" | "add_format";
  target_book_id?: string | null;
  title?: string;
  authors?: string[];
  year?: number | null;
  tags?: string[];
}

export interface UploadItemPlan {
  id: string;
  filename: string;
  ext: UploadExtension;
  format: string;
  target_formats: string[];
  primary_format: "EPUB" | "PDF";
  converts_to: "EPUB" | "PDF" | null;
  sha256: string;
  size: number;
  action: "add_book" | "add_format";
  target: { id: number; uuid: string; title: string } | null;
  title: string;
  authors: string[];
  year: number | null;
  tags: string[];
  identifiers?: Record<string, string>;
  printed_isbns?: string[];
  known_matches: { id: number; uuid: string }[];
  reviewed?: string;
}

export interface UploadBatchPlan {
  library: string;
  items: UploadItemPlan[];
}

export function uploadBatchPlan(c: Corpus, config: Config, selections: UploadSelection[]): UploadBatchPlan {
  if (!selections.length) throw new ToolError("Select at least one staged file to upload.");
  const dir = uploadDir(config);
  const stagedList = readStagedRecords(dir);
  const staged = new Map(stagedList.map(r => [r.id, r]));
  const newBooks: { id: string; filename: string }[] = [];
  const books = candidateBooks(c);
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  const seenTargetFormats = new Set<string>();
  let batchBytes = 0;

  const items: UploadItemPlan[] = selections.map(sel => {
    if (!sel || typeof sel.id !== "string" || typeof sel.sha256 !== "string") {
      throw new ToolError("Invalid upload selection.");
    }
    if (sel.action !== "add_book" && sel.action !== "add_format") {
      throw new ToolError("Choose add_book or add_format for each selected file.");
    }
    if (seenIds.has(sel.id)) throw new ToolError(`File ${sel.id} appears more than once in this batch.`);
    seenIds.add(sel.id);
    const rec = staged.get(sel.id);
    if (!rec || rec.sha256 !== sel.sha256) {
      throw new ToolError("A staged file changed or was removed. Reload and review again.");
    }
    if (seenHashes.has(rec.sha256)) {
      throw new ToolError(`Duplicate file ${rec.filename} appears more than once in this batch.`);
    }
    seenHashes.add(rec.sha256);
    batchBytes += rec.size;
    if (batchBytes > MAX_BATCH_BYTES) throw new ToolError(batchLimitError(batchBytes));

    if (sel.title !== undefined) rec.draft.title = String(sel.title).trim();
    if (Array.isArray(sel.authors)) rec.draft.authors = sel.authors.map(a => String(a).trim()).filter(Boolean);
    if (sel.year !== undefined) rec.draft.year = sel.year;
    if (Array.isArray(sel.tags)) rec.draft.tags = [...new Set(sel.tags.map(t => String(t).trim()).filter(Boolean))];
    if (sel.target_book_id !== undefined) rec.draft.target_book_id = sel.target_book_id;
    saveStagedRecord(dir, rec);

    const evaluated = evaluateStagedUpload(c, config, rec, books, stagedList);
    if (evaluated.contents_pending.length) {
      throw new ToolError(`The ${evaluated.contents_pending.join(" and ")} contents of ${rec.filename} are still being checked. Wait until the upload page shows them, then preview again.`);
    }
    if (evaluated.blockers.length) {
      throw new ToolError(`${rec.filename}: ${evaluated.blockers.join(" ")}`);
    }

    if (sel.action === "add_format") {
      const targetId = rec.draft.target_book_id ?? evaluated.suggested_target;
      const match = evaluated.matches.find(m => m.book.id === targetId);
      if (!match) {
        throw new ToolError(`${rec.filename}: choose a matching book in ${config.shelvesLibrary} to add the format to.`);
      }
      if (!match.writable) {
        throw new ToolError(`${rec.filename}: ${match.book.id} is not in the writable Calibre library.`);
      }
      if (!match.can_add_format) {
        throw new ToolError(`${rec.filename}: ${match.book.id} already has ${rec.primary_format}.`);
      }
      for (const fmt of match.missing_formats) {
        const key = `${match.book.id}:${fmt}`;
        if (seenTargetFormats.has(key)) {
          throw new ToolError(`More than one uploaded file adds ${fmt} to ${match.book.id}. Choose one.`);
        }
        seenTargetFormats.add(key);
      }
      return {
        id: rec.id,
        filename: rec.filename,
        ext: rec.ext,
        format: rec.format,
        target_formats: rec.target_formats,
        primary_format: rec.primary_format,
        converts_to: rec.converts_to,
        sha256: rec.sha256,
        size: rec.size,
        action: "add_format",
        target: { id: match.book.calibre_id, uuid: match.book.uuid!, title: match.book.title },
        title: match.book.title,
        authors: match.book.authors,
        year: match.book.year,
        tags: [],
        known_matches: [],
      };
    }

    // action === "add_book"
    const title = rec.draft.title.trim();
    if (!title || title.length > 1000 || /[\x00-\x1f]/.test(title)) {
      throw new ToolError(`${rec.filename}: enter a title.`);
    }
    const authors = rec.draft.authors.map(a => a.trim()).filter(Boolean);
    if (!authors.length || authors.length > 100 || authors.some(a => a.length > 300 || /[\x00-\x1f|]/.test(a))) {
      throw new ToolError(`${rec.filename}: enter at least one author.`);
    }
    if (authors.some(a => a.includes("&"))) {
      throw new ToolError(`${rec.filename}: enter each author separately; within one name, use ‘and’ instead of Calibre’s reserved & separator.`);
    }
    if (new Set(authors.map(a => a.toLowerCase())).size !== authors.length) {
      throw new ToolError(`${rec.filename}: an author is listed more than once.`);
    }
    const year = rec.draft.year;
    if (year !== null && (!Number.isInteger(year) || year < 1001 || year > 9999)) {
      throw new ToolError(`${rec.filename}: enter a publication year from 1001 to 9999, or leave it blank.`);
    }
    const tags = rec.draft.tags.filter(Boolean);
    // Two files of one book would become two Calibre records. Add one now; the next preview offers the
    // other as a format of it, or as another edition.
    const twin = newBooks.find(b => evaluated.staged_matches.some(m => m.id === b.id));
    if (twin) {
      throw new ToolError(`${twin.filename} and ${rec.filename} look like the same book, and both would be added as new books. Add one now; after it's applied, the other is offered as a format of it (or add it then as another edition).`);
    }
    newBooks.push({ id: rec.id, filename: rec.filename });
    return {
      id: rec.id,
      filename: rec.filename,
      ext: rec.ext,
      format: rec.format,
      target_formats: rec.target_formats,
      primary_format: rec.primary_format,
      converts_to: rec.converts_to,
      sha256: rec.sha256,
      size: rec.size,
      action: "add_book",
      target: null,
      title,
      authors,
      year,
      tags,
      identifiers: rec.extracted.identifiers,
      printed_isbns: rec.extracted.printed_isbns,
      known_matches: [...evaluated.matches.map(m => m.book), ...evaluated.unrelated_matches]
        .filter(b => b.library === config.shelvesLibrary && b.uuid !== null)
        .map(b => ({ id: b.calibre_id, uuid: b.uuid! })),
    };
  });

  return { library: config.shelvesLibrary, items };
}

/** Attaches the binary payload of each staged file to the plan sent over SSH stdin (never stored in data.db). */
export function attachUploadPayloads(config: Config, plan: UploadBatchPlan) {
  const dir = uploadDir(config);
  let totalBytes = 0;
  return {
    library: plan.library,
    items: plan.items.map(item => {
      const binPath = path.join(dir, `${item.id}.${item.ext}`);
      if (!fs.existsSync(binPath)) {
        throw new ToolError(`Staged file ${item.filename} is no longer available. Upload it again.`);
      }
      const st = fs.statSync(binPath);
      if (st.size !== item.size || st.size > MAX_UPLOAD_BYTES) {
        throw new ToolError(`Staged file ${item.filename} changed since preview. Preview again.`);
      }
      totalBytes += st.size;
      if (totalBytes > MAX_BATCH_BYTES) throw new ToolError(batchLimitError(totalBytes));
      const data = fs.readFileSync(binPath);
      const actualHash = createHash("sha256").update(data).digest("hex");
      if (actualHash !== item.sha256) {
        throw new ToolError(`Staged file ${item.filename} changed since preview. Preview again.`);
      }
      return { ...item, data_base64: data.toString("base64") };
    }),
  };
}

export function removeAppliedUploads(config: Config, appliedIds: string[]): void {
  for (const id of appliedIds) removeStagedUpload(config, id, { applied: true });
}
