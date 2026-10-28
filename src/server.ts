import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { JWTVerifyGetKey } from "jose";
import { accessIdentity, vocabularyPushIdentity } from "./access.js";
import { adminMetrics } from "./admin.js";
import { adminBook, adminBooks, adminCategories, adminCitekeys, oneOf } from "./adminQueries.js";
import { type Config, loadConfig } from "./config.js";
import { JOB_KINDS, type JobCommands, type JobKind, type JobMode, JobRunner, systemCommands } from "./jobs.js";
import { openDataStore, queryChanges } from "./data.js";
import { openDatabase } from "./db.js";
import { BOOK_HTML } from "./web/book.js";
import { BOOKS_HTML } from "./web/books.js";
import { CATEGORIES_HTML, CITEKEYS_HTML, SHELVES_HTML } from "./web/catalog.js";
import { CHANGES_HTML } from "./web/changes.js";
import { DASHBOARD_HTML } from "./web/dashboard.js";
import { JOB_HTML, JOBS_HTML } from "./web/jobs.js";
import { PROPOSALS_HTML } from "./web/proposals.js";
import { QUOTE_HTML, QUOTES_HTML, READER_HTML } from "./web/quotes.js";
import { TAXONOMY_HTML } from "./web/taxonomy.js";
import { ZOTERO_HTML } from "./web/zotero.js";
import {
  getTagVocabulary, listProposals, normalizeProposalTags, proposeTags, reviewProposal, setBookCategories, tagPlan, taggingWorklist, vocabularyReport,
} from "./tagging.js";
import { VocabularySource } from "./vocabulary.js";
import { addTerm, changeTerm, installVocabulary, taxonomyOverview, type TermAction } from "./taxonomy/api.js";
import { Taxonomy } from "./taxonomy/taxonomy.js";
import { replicaStateFile, startDrain } from "./public/drain.js";
import { publishSnapshot } from "./public/snapshot.js";
import { FAVICON_PATHS, favicon } from "./web/favicon.js";
import { isPublicPath, renderPublic } from "./public/site.js";
import { type PublicStore, snapshotReader } from "./public/store.js";
import { ZoteroSync, linkZotero, zoteroCiteInfo, zoteroReport } from "./zotero.js";
import { citeQuote, deleteQuote, getQuote, quotesOnPages, saveQuote, searchQuotes, updateQuote } from "./quotes.js";
import {
  type Corpus, ToolError, citePassage, corpusStatus, getBookOutline, listBooks, listShelves, listTags, pinCitekey, readBook, renderPage,
  getBook, searchCorpus, tagCleanupPlan, unpinCitekey,
} from "./tools.js";

const VERSION = "0.2.0";

const INSTRUCTIONS = `Search, read, and cite books in the Calibre libraries (books that are not Zotero attachments; use the Zotero server for those).
Book ids look like "main:42"; any tool that takes a book id also takes the book's citekey (e.g. "nye2011future"). Pages are 1-based. For PDFs a page is a physical page and page_label is the printed number to cite. For EPUB and MOBI a page is a stable reading location, not a citable page number; cite those by chapter (the section path).
Typical flow: search_corpus → read_book around a hit → cite_passage for a CSL JSON item and locator. cite_passage also returns filing data for a reference manager (a BibTeX entry, a valid ISBN, or printed ISBN candidates); once the book is filed there, record the citekey it was given with pin_citekey.`;

const bookId = z.string().describe('Book id from search_corpus or list_books (e.g. "main:42"), or the book\'s citekey');
const page = z.number().int().min(1);

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Runs a tool body, turning ToolError into an isError result the agent can act on. */
function run(body: () => CallToolResult): CallToolResult {
  try {
    return body();
  } catch (error) {
    if (error instanceof ToolError) return { isError: true, content: [{ type: "text", text: error.message }] };
    throw error;
  }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Adds the Zotero mirror's view of the book to a citation: its item, or a warning before filing a copy. */
function withZotero<T extends { warnings: string[] }>(c: Corpus, bookId: string, cite: T) {
  const info = zoteroCiteInfo(c, getBook(c, bookId));
  if (!info) return cite;
  return { ...cite, zotero: info.zotero, zotero_synced_at: info.synced_at, warnings: info.note ? [...cite.warnings, info.note] : cite.warnings };
}

export function createServer(c: Corpus): McpServer {
  const server = new McpServer({ name: "corpus-mcp", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool("search_corpus", {
    title: "Search book text",
    description: "Full-text search over the text of every indexed book. Returns ranked passages with book id, page, page_kind (\"pdf_page\", or \"location\" for EPUB/MOBI, which is not a citable page number), printed page label (PDF), section, and a snippet with matches in «». Words are ANDed; put a phrase in double quotes; end a word with * for a prefix match.",
    inputSchema: {
      query: z.string().min(1).describe('Words or "quoted phrases" to find'),
      book_id: bookId.optional().describe("Search within one book"),
      library: z.string().optional().describe("Limit to one Calibre library"),
      shelf: z.string().optional().describe("Limit to one Calibre-Web shelf, by name (see list_shelves)"),
      tag: z.string().optional().describe('Limit to books with this Calibre tag or any tag below it, at any level; vocabulary titles work too ("psychology" or "Psychology" both find social-sciences.psychology.*; see list_tags)'),
      author: z.string().optional().describe("Limit to books whose author contains this text"),
      limit: z.number().int().min(1).max(50).optional().describe("Results to return (default 10)"),
      advanced: z.boolean().optional().describe("Pass query to SQLite FTS5 unchanged (OR, NOT, NEAR(), column filters)"),
    },
    annotations: { title: "Search book text", ...readOnly },
  }, (args) => run(() => json(searchCorpus(c, args))));

  server.registerTool("list_books", {
    title: "List books",
    description: "Look up books by title, author, tag, publisher, ISBN, id, or citekey, optionally on one shelf or under one tag. Returns metadata, shelves, tags, format, page count, citekey (pinned or set in Calibre) and proposed_citekey, and other ids that hold the same file.",
    inputSchema: {
      query: z.string().optional().describe("Text to match; omit to list everything"),
      library: z.string().optional(),
      shelf: z.string().optional().describe("Only books on this Calibre-Web shelf, by name (see list_shelves)"),
      tag: z.string().optional().describe("Only books with this Calibre tag or any tag below it (see list_tags)"),
      include_unindexed: z.boolean().optional().describe("Also list catalogue entries with no readable ebook file"),
      limit: z.number().int().min(1).max(200).optional().describe("Default 25"),
    },
    annotations: { title: "List books", ...readOnly },
  }, (args) => run(() => json(listBooks(c, args))));

  server.registerTool("list_shelves", {
    title: "List shelves",
    description: "Calibre-Web's public shelves (topic collections such as Misinformation), with how many indexed books each holds. Use a shelf name to filter search_corpus or list_books.",
    inputSchema: {},
    annotations: { title: "List shelves", ...readOnly },
  }, () => run(() => json(listShelves(c))));

  server.registerTool("list_tags", {
    title: "List tags",
    description: "Calibre tags (Calibre-Web's Categories) on indexed books, as a tree: \".\" nests tags, and each node counts books with that tag or any tag below it. Use a tag to filter search_corpus or list_books.",
    inputSchema: {
      under: z.string().optional().describe('Show only this tag and the tags below it, e.g. "Social Science"'),
      min_books: z.number().int().min(1).optional().describe("Hide tags on fewer books (default 1)"),
    },
    annotations: { title: "List tags", ...readOnly },
  }, (args) => run(() => json(listTags(c, args))));

  server.registerTool("get_tag_vocabulary", {
    title: "Get tag vocabulary",
    description: "The vocabulary's terms as Calibre tags: ids nested with \".\" (\"social-sciences.psychology.social-psychology\") with their title paths as labels. propose_tags accepts only these, in either form.",
    inputSchema: { under: z.string().optional().describe('Only tags at or below this one, e.g. "social-sciences.psychology" or "Psychology"') },
    annotations: { title: "Get tag vocabulary", ...readOnly },
  }, (args) => run(() => json(getTagVocabulary(c, args))));

  server.registerTool("vocabulary_report", {
    title: "Vocabulary report",
    description: "How Calibre's tags stand against the vocabulary: retired terms still in use (and whether the tags job replaces them automatically), tags shaped like terms that the vocabulary lacks, and books tagged only at a term with narrower terms below it, grouped by term. Use it after a taxonomy change, and to suggest where the taxonomy needs a narrower term; the vocabulary itself is edited only by its owner.",
    inputSchema: {},
    annotations: { title: "Vocabulary report", ...readOnly },
  }, () => run(() => json(vocabularyReport(c))));

  server.registerTool("add_provisional_term", {
    title: "Add a provisional term",
    description: "Coin a term for the vocabulary during research, when no existing term fits what the sources are about. It is usable at once with propose_tags (and as a tag filter), marked provisional until a person reviews it on /admin/taxonomy. It lives in corpus-mcp's overlay; if the vocabulary's owner later publishes a term at the same path, theirs takes over and books keep the tag. Prefer an existing term: check get_tag_vocabulary first.",
    inputSchema: {
      parent: z.string().describe('The term it goes under, as an id or title path, e.g. "social-sciences.psychology" or "Social Sciences › Psychology"'),
      label: z.string().min(1).max(80).describe('Its title, e.g. "Moral Injury"'),
      scope_note: z.string().min(1).max(600).describe("What belongs under the term and what doesn't, in a sentence or two"),
      slug: z.string().optional().describe("Its id segment (lowercase letters, digits, single hyphens); made from the label when omitted"),
      alt_labels: z.array(z.string()).optional().describe("Other names for the same subject"),
    },
    annotations: { title: "Add a provisional term", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, extra) => run(() => json(addTerm(c, args, accessEmail(extra) ?? "agent"))));

  server.registerTool("tagging_worklist", {
    title: "Get books to tag",
    description: "Indexed books that have no tag proposal yet (and, by default, no vocabulary tag), with title, authors, description, chapter titles, shelves, and existing tags, for choosing vocabulary tags with propose_tags.",
    inputSchema: {
      limit: z.number().int().min(1).max(25).optional().describe("Books to return (default 10)"),
      shelf: z.string().optional().describe("Only books on this Calibre-Web shelf"),
      include_tagged: z.boolean().optional().describe("Also include books that already carry a vocabulary tag"),
    },
    annotations: { title: "Get books to tag", ...readOnly },
  }, (args) => run(() => json(taggingWorklist(c, args))));

  server.registerTool("propose_tags", {
    title: "Propose tags for a book",
    description: "Propose 1-3 vocabulary tags for a book, with a one- or two-sentence rationale. Proposals wait for a person's review on the /review page; nothing is written to Calibre until approved tags are applied.",
    inputSchema: {
      book_id: bookId,
      tags: z.array(z.string()).min(1).max(3).describe("Tags from get_tag_vocabulary, as slugs or titles, most specific first"),
      rationale: z.string().min(1).max(600).describe("Why these tags fit the book"),
    },
    annotations: { title: "Propose tags for a book", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args, extra) => run(() => {
    const email = extra.requestInfo?.headers["cf-access-authenticated-user-email"];
    return json(proposeTags(c, args, typeof email === "string" ? email : undefined));
  }));

  const accessEmail = (extra: { requestInfo?: { headers: Record<string, unknown> } }) => {
    // Set by Cloudflare Access; informational only, because LAN requests bypass Access.
    const email = extra.requestInfo?.headers["cf-access-authenticated-user-email"];
    return typeof email === "string" ? email : undefined;
  };
  const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

  server.registerTool("save_quote", {
    title: "Save a quote",
    description: "Save a passage from a book as a quote. The text is checked against the book: quote marks, dashes, spacing, and case may differ, and the book's exact wording is what gets saved. If the passage is not in the book, nothing is saved and the closest passages are returned. Give the page where the passage starts (as search_corpus or read_book report it) to find it fastest.",
    inputSchema: {
      book_id: bookId,
      text: z.string().min(1).max(2000).describe("The passage, as close to the book's wording as possible"),
      page: page.optional().describe("Page or location where the passage starts"),
      note: z.string().max(2000).optional().describe("Why the passage matters"),
      labels: z.array(z.string()).max(20).optional().describe('Tags: themes ("compassion", "overwork"), forms ("parable", "epigraph"), or links to your own records ("project:item-id"). Quotes have no categories of their own; the book gives the subject, so tag what is finer. Reuse existing tags (search_quotes lists them).'),
    },
    annotations: { title: "Save a quote", ...writes },
  }, (args, extra) => run(() => json(saveQuote(c, args, accessEmail(extra), "agent"))));

  server.registerTool("search_quotes", {
    title: "Search quotes",
    description: "Find saved quotes by words in their text, note, or tags, and by book, author, their book's category (including subcategories), tag, or status. The result lists every tag in use with its count.",
    inputSchema: {
      query: z.string().optional(), book_id: bookId.optional(), author: z.string().optional(),
      category: z.string().optional().describe("The book's vocabulary category, slug or title; includes those below it"),
      label: z.string().optional().describe("A tag"), status: z.enum(["verified", "orphaned"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: { title: "Search quotes", ...readOnly },
  }, (args) => run(() => json(searchQuotes(c, {
    q: args.query, book: args.book_id, author: args.author, category: args.category, label: args.label, status: args.status, limit: args.limit,
  }))));

  server.registerTool("get_quote", {
    title: "Get a quote",
    description: "One saved quote with the text around it, its locator, and its citation.",
    inputSchema: { id: z.number().int() },
    annotations: { title: "Get a quote", ...readOnly },
  }, ({ id }) => run(() => json(getQuote(c, id))));

  server.registerTool("update_quote", {
    title: "Update a quote",
    description: "Change a quote's note or tags. The quoted text cannot change; save a new quote instead.",
    inputSchema: {
      id: z.number().int(), note: z.string().max(2000).nullable().optional(),
      labels: z.array(z.string()).max(20).optional().describe("Replaces the quote's tags"),
    },
    annotations: { title: "Update a quote", ...writes, idempotentHint: true },
  }, (args, extra) => run(() => json(updateQuote(c, args, accessEmail(extra), "agent"))));

  server.registerTool("delete_quote", {
    title: "Delete a quote",
    description: "Delete a saved quote.",
    inputSchema: { id: z.number().int() },
    annotations: { title: "Delete a quote", ...writes, destructiveHint: true, idempotentHint: true },
  }, ({ id }, extra) => run(() => json(deleteQuote(c, id, accessEmail(extra), "agent"))));

  server.registerTool("cite_quote", {
    title: "Cite a quote",
    description: "The quote's verified text, reflowed as prose (line breaks inside sentences become spaces), and a readable locator (quote_locator), with its citation as cite_passage returns it for the quote's pages: a CSL JSON item, a CSL locator, and filing data.",
    inputSchema: { id: z.number().int() },
    annotations: { title: "Cite a quote", ...readOnly },
  }, ({ id }) => run(() => {
    const cite = citeQuote(c, id);
    return json(withZotero(c, cite.citekey ?? getQuote(c, id).current_book_id!, cite));
  }));

  server.registerTool("get_book_outline", {
    title: "Get book outline",
    description: "Metadata and table of contents with the page where each section starts. Read this before reading a long book.",
    inputSchema: { book_id: bookId },
    annotations: { title: "Get book outline", ...readOnly },
  }, ({ book_id }) => run(() => json(getBookOutline(c, book_id))));

  server.registerTool("read_book", {
    title: "Read book text",
    description: "Contiguous text for a page range or one outline section, with a header per page. Stops at max_chars on a page boundary and says where to continue.",
    inputSchema: {
      book_id: bookId,
      start_page: page.optional().describe("First page (default 1)"),
      end_page: page.optional().describe("Last page, inclusive (default start_page)"),
      section: z.string().optional().describe("Outline section title to read instead of a page range"),
      max_chars: z.number().int().min(500).max(40000).optional().describe("Default 12000"),
    },
    annotations: { title: "Read book text", ...readOnly },
  }, (args) => run(() => ({ content: [{ type: "text", text: readBook(c, args) }] })));

  server.registerTool("render_page", {
    title: "Render PDF page",
    description: "A PNG image of one PDF page, for figures, tables, and equations that text extraction garbles. PDF only.",
    inputSchema: {
      book_id: bookId,
      page: page.describe("Physical page number"),
      scale: z.number().min(0.5).max(3).optional().describe("Zoom factor (default 1.5)"),
    },
    annotations: { title: "Render PDF page", ...readOnly },
  }, (args) => run(() => {
    const image = renderPage(c, args);
    return {
      content: [
        { type: "image", data: image.png, mimeType: "image/png" },
        { type: "text", text: `${args.book_id} page ${args.page} (${image.width}×${image.height})` },
      ],
    };
  }));

  server.registerTool("cite_passage", {
    title: "Cite a book",
    description: "A book's citation as a CSL JSON item (csl), with a CSL locator ({ label: \"page\", locator }) for an optional page range and the reading position. PDF locators use printed page labels; EPUB and MOBI locations are not pages, so their locator is null (position.section names the chapter). Also returns the citekey and plain filing data: a BibTeX entry built from Calibre's metadata (bibtex), a check-digit-valid ISBN (isbn), and ISBNs printed in the book (isbn_candidates) when Calibre has none, plus warnings about missing metadata. The legacy citation and zotero_filing fields remain for one release.",
    inputSchema: {
      book_id: bookId,
      page: page.optional().describe("Page of the cited passage"),
      end_page: page.optional().describe("Last page, if the passage spans pages"),
    },
    annotations: { title: "Cite a book", ...readOnly },
  }, (args) => run(() => json(withZotero(c, args.book_id, citePassage(c, args)))));

  server.registerTool("pin_citekey", {
    title: "Pin a book's citekey",
    description: "Record a citekey assigned elsewhere, such as by the reference manager the book was filed in. Pinned keys are stored by Calibre UUID, never change on their own, and are then accepted anywhere a book id is. Any BibTeX-safe key is accepted; a key that doesn't follow this server's rule gets a warning.",
    inputSchema: {
      book_id: bookId,
      citekey: z.string().min(1).describe("The citekey the book was given"),
      replace: z.boolean().optional().describe("Replace a different key already pinned to this book"),
    },
    annotations: { title: "Pin a book's citekey", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args, extra) => run(() => {
    // Set by Cloudflare Access; informational only, because LAN requests bypass Access.
    const email = extra.requestInfo?.headers["cf-access-authenticated-user-email"];
    return json(pinCitekey(c, args, typeof email === "string" ? email : undefined));
  }));

  server.registerTool("corpus_status", {
    title: "Corpus status",
    description: "Index freshness, book counts by library and format, books that failed, have no text layer, or have no outline, and citekey readiness: pinned keys and books blocked from filing by missing Calibre metadata.",
    inputSchema: {},
    annotations: { title: "Corpus status", ...readOnly },
  }, () => run(() => json(corpusStatus(c))));

  return server;
}

export function openCorpus(config: Config): Corpus {
  const db = openDatabase(config.dbPath, { readonly: true });
  const data = openDataStore(config.dataDbPath);
  const source = new VocabularySource(config.vocabularyPath);
  // Each new merged vocabulary rewrites stored proposals into its terms (titles to ids, retired ids to their replacement).
  const taxonomy = new Taxonomy(data, source, (vocabulary) => {
    const normalized = normalizeProposalTags({ db, data, booksRoot: config.booksRoot, vocabulary });
    if (normalized) console.error(`rewrote ${normalized} tag proposal(s) into the vocabulary's terms`);
  });
  return {
    db, data, booksRoot: config.booksRoot, citekeyPreset: config.citekeyPreset, vocabularySource: source, taxonomy,
    get vocabulary() { return taxonomy.current(); },
  };
}

export async function serveStdio(config: Config): Promise<void> {
  await createServer(openCorpus(config)).connect(new StdioServerTransport());
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ToolError("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new ToolError("Request body is not JSON.");
  }
}

export interface WebOptions {
  /** Access signing keys (tests); production fetches the team's keys. */
  accessKeys?: JWTVerifyGetKey;
  /** Job processes (tests); production runs systemctl and ssh. */
  jobCommands?: JobCommands;
  /** false: no background Zotero sync (tests run it through the job). */
  zoteroTimer?: boolean;
  /** false: no background rebuild of the public snapshot (tests build it themselves). */
  publishTimer?: boolean;
}

interface Web { c: Corpus; config: Config; runner: JobRunner; options: WebOptions }

/**
 * The tag review page, the admin dashboard, and their JSON API. Reads are open on the LAN; every
 * write needs a verified Cloudflare Access identity. These routes send no CORS headers, so another
 * site cannot read them, and writes require a JSON body, which a cross-site form cannot send.
 */
async function serveWeb(web: Web, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const { c, config, runner } = web;
  const admin = config.admin!;
  const writer = async () => {
    const result = await accessIdentity(req, admin.access, web.options.accessKeys);
    if ("error" in result) {
      sendJson(res, result.status, { error: result.error });
      return null;
    }
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      sendJson(res, 400, { error: "Send JSON." });
      return null;
    }
    return result.identity.email ?? result.identity.subject;
  };
  const html = (body: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
  try {
    const path = url.pathname;
    const pages: Record<string, string> = {
      "/admin": DASHBOARD_HTML, "/admin/books": BOOKS_HTML, "/admin/categories": CATEGORIES_HTML, "/admin/citekeys": CITEKEYS_HTML,
      "/admin/proposals": PROPOSALS_HTML, "/admin/shelves": SHELVES_HTML, "/admin/jobs": JOBS_HTML, "/admin/changes": CHANGES_HTML,
      "/admin/quotes": QUOTES_HTML, "/admin/zotero": ZOTERO_HTML, "/admin/taxonomy": TAXONOMY_HTML,
    };
    const termPath = path.match(/^\/api\/taxonomy\/terms(?:\/([^/]+))?$/);
    const bookPath = path.match(/^\/api\/books\/([^/]+)(\/categories|\/citekey|\/pages)?$/);
    const quotePath = path.match(/^\/api\/quotes\/(\d+)(\/delete)?$/);
    if (req.method === "POST" && path === "/api/intake/vocabulary") {
      // The vocabulary's owner pushes it here with its own service token, which unlocks nothing else.
      const result = await vocabularyPushIdentity(req, admin.access, web.options.accessKeys);
      if ("error" in result) return sendJson(res, result.status, { error: result.error });
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return sendJson(res, 400, { error: "Send JSON." });
      const installed = installVocabulary(c, await readJson(req, 2 * 1024 * 1024), result.identity.subject);
      sendJson(res, installed.status, installed.body);
    }
    else if (req.method === "GET" && path === "/review") res.writeHead(302, { location: "/admin/proposals" }).end();
    else if (req.method === "GET" && pages[path]) html(pages[path]);
    else if (req.method === "GET" && /^\/admin\/books\/[^/]+$/.test(path)) html(BOOK_HTML);
    else if (req.method === "GET" && /^\/admin\/books\/[^/]+\/read$/.test(path)) html(READER_HTML);
    else if (req.method === "GET" && /^\/admin\/quotes\/\d+$/.test(path)) html(QUOTE_HTML);
    else if (req.method === "GET" && bookPath?.[2] === "/pages") {
      const book = getBook(c, decodeURIComponent(bookPath[1]));
      if (book.status !== "indexed" || !book.page_count) throw new ToolError(`${book.id} has no indexed text.`);
      const start = Math.min(Math.max(Number(url.searchParams.get("start")) || 1, 1), book.page_count);
      const count = Math.min(Math.max(Number(url.searchParams.get("count")) || 4, 1), 12);
      const end = Math.min(start + count - 1, book.page_count);
      const pages = c.db.prepare("SELECT page_index, label, section_path, text FROM pages WHERE book_id = ? AND page_index BETWEEN ? AND ? ORDER BY page_index")
        .all(book.id, start - 1, end - 1) as { page_index: number; label: string | null; section_path: string | null; text: string }[];
      sendJson(res, 200, {
        book_id: book.id, title: book.title, authors: JSON.parse(book.authors), page_count: book.page_count, page_kind: book.reflowable ? "location" : "pdf_page",
        // A new quote inherits these unless it is given its own.
        categories: (JSON.parse(book.tags) as string[]).filter((t) => c.vocabulary.has(t)),
        outline: c.db.prepare("SELECT level, title, start_page FROM outline WHERE book_id = ? AND level <= 1 AND start_page IS NOT NULL ORDER BY ord").all(book.id)
          .map((o) => ({ ...(o as { level: number; title: string; start_page: number }), page: (o as { start_page: number }).start_page + 1 })),
        start, end,
        pages: pages.map((p) => ({ page: p.page_index + 1, label: p.label, section: p.section_path, text: p.text })),
        quotes: quotesOnPages(c, book, start - 1, end - 1),
      });
    }
    else if (req.method === "GET" && path === "/api/quotes") {
      const p = url.searchParams;
      const text = (name: string) => p.get(name)?.trim() || undefined;
      sendJson(res, 200, searchQuotes(c, {
        q: text("q"), book: text("book"), author: text("author"), category: text("category"), label: text("label"),
        status: oneOf(p.get("status"), ["verified", "orphaned"] as const), by: text("by"), since: text("since"),
        limit: p.has("limit") ? Number(p.get("limit")) : undefined, offset: p.has("offset") ? Number(p.get("offset")) : undefined,
      }));
    } else if (req.method === "GET" && quotePath && !quotePath[2]) sendJson(res, 200, getQuote(c, Number(quotePath[1])));
    else if (req.method === "POST" && path === "/api/quotes") {
      const by = await writer();
      if (by === null) return;
      const body = (await readJson(req)) as { book_id?: string; text?: string; page?: number; note?: string; labels?: unknown };
      if (!body.book_id || !body.text) throw new ToolError("Send book_id and text.");
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
      sendJson(res, 200, saveQuote(c, {
        book_id: body.book_id, text: body.text, page: body.page, note: body.note, labels: list(body.labels),
      }, by, "admin"));
    } else if (req.method === "POST" && quotePath) {
      const by = await writer();
      if (by === null) return;
      const id = Number(quotePath[1]);
      if (quotePath[2]) sendJson(res, 200, deleteQuote(c, id, by, "admin"));
      else {
        const body = (await readJson(req)) as { note?: string | null; labels?: unknown };
        const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
        sendJson(res, 200, updateQuote(c, { id, note: body.note, labels: list(body.labels) }, by, "admin"));
      }
    }
    else if (req.method === "GET" && /^\/admin\/jobs\/\d+$/.test(path)) html(JOB_HTML);
    else if (req.method === "GET" && path === "/api/books") {
      const p = url.searchParams;
      const text = (name: string) => p.get(name)?.trim() || undefined;
      sendJson(res, 200, adminBooks(c, {
        q: text("q"), library: text("library"), format: text("format"), status: text("status"), shelf: text("shelf"), tag: text("tag"),
        category: oneOf(p.get("category"), ["uncategorized", "categorized", "pending", "not_applied"] as const),
        citekey: oneOf(p.get("citekey"), ["calibre", "pinned", "ready", "blocked"] as const),
        isbn: oneOf(p.get("isbn"), ["valid", "invalid", "printed", "none"] as const),
        problem: oneOf(p.get("problem"), ["failed", "no_file", "no_text", "no_outline"] as const),
        sort: oneOf(p.get("sort"), ["title", "year", "id"] as const),
        limit: p.has("limit") ? Number(p.get("limit")) : undefined, offset: p.has("offset") ? Number(p.get("offset")) : undefined,
      }));
    } else if (req.method === "GET" && bookPath && !bookPath[2]) sendJson(res, 200, adminBook(c, config, decodeURIComponent(bookPath[1])));
    else if (req.method === "POST" && bookPath?.[2] === "/categories") {
      const by = await writer();
      if (by === null) return;
      const body = (await readJson(req)) as { tags?: unknown; note?: string };
      if (!Array.isArray(body.tags)) throw new ToolError("Send the book's complete set of categories as tags: [].");
      sendJson(res, 200, setBookCategories(c, { book_id: decodeURIComponent(bookPath[1]), tags: body.tags.map(String), note: body.note }, by));
    } else if (req.method === "POST" && bookPath?.[2] === "/citekey") {
      const by = await writer();
      if (by === null) return;
      const body = (await readJson(req)) as { citekey?: string | null; replace?: boolean };
      const bookId = decodeURIComponent(bookPath[1]);
      sendJson(res, 200, body.citekey ? pinCitekey(c, { book_id: bookId, citekey: body.citekey, replace: body.replace }, by, "admin") : unpinCitekey(c, bookId, by));
    } else if (req.method === "GET" && path === "/api/categories") sendJson(res, 200, adminCategories(c));
    else if (req.method === "GET" && path === "/api/vocabulary/report") sendJson(res, 200, vocabularyReport(c));
    else if (req.method === "GET" && path === "/api/citekeys") sendJson(res, 200, adminCitekeys(c));
    else if (req.method === "GET" && path === "/api/zotero") sendJson(res, 200, zoteroReport(c, config.zotero));
    else if (req.method === "POST" && path === "/api/zotero/link") {
      const by = await writer();
      if (by === null) return;
      const body = (await readJson(req)) as { book_id?: string; key?: string; action?: string };
      if (!body.book_id || !body.key) throw new ToolError("Send book_id, key, and action.");
      sendJson(res, 200, linkZotero(c, { book_id: body.book_id, key: body.key, action: oneOf(body.action ?? "", ["confirm", "reject", "clear"] as const) ?? "confirm" }, by));
    }
    else if (req.method === "GET" && path === "/api/shelves") sendJson(res, 200, listShelves(c));
    else if (req.method === "GET" && path === "/api/changes") {
      const p = url.searchParams;
      const text = (name: string) => p.get(name)?.trim() || undefined;
      sendJson(res, 200, queryChanges(c.data, {
        since: text("since"), until: text("until"), kinds: p.getAll("kind"), sources: p.getAll("source"), q: text("q"), tag: text("tag"),
        job: p.has("job") ? Number(p.get("job")) || undefined : undefined, actor: text("actor"),
        limit: p.has("limit") ? Number(p.get("limit")) : undefined, offset: p.has("offset") ? Number(p.get("offset")) : undefined,
      }));
    }
    else if (req.method === "GET" && path === "/api/whoami") {
      const result = await accessIdentity(req, admin.access, web.options.accessKeys);
      sendJson(res, 200, "error" in result ? { can_write: false, reason: result.error } : { can_write: true, identity: result.identity });
    } else if (req.method === "GET" && path === "/api/vocabulary") sendJson(res, 200, getTagVocabulary(c));
    else if (req.method === "GET" && path === "/api/taxonomy") sendJson(res, 200, taxonomyOverview(c));
    else if (req.method === "POST" && termPath) {
      const by = await writer();
      if (by === null) return;
      const body = (await readJson(req)) as Record<string, unknown>;
      const text = (v: unknown) => (typeof v === "string" ? v : undefined);
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
      if (!termPath[1]) {
        if (!text(body.label)) throw new ToolError("Send label (and parent, scope_note).");
        sendJson(res, 200, addTerm(c, {
          parent: text(body.parent) ?? null, label: text(body.label)!, slug: text(body.slug), scope_note: text(body.scope_note),
          alt_labels: list(body.alt_labels), status: body.status === "confirmed" ? "confirmed" : "provisional",
        }, by));
      } else sendJson(res, 200, changeTerm(c, decodeURIComponent(termPath[1]), body as unknown as TermAction, by));
    }
    else if (req.method === "GET" && path === "/api/tag-proposals") {
      const number = (name: string) => (url.searchParams.has(name) ? Number(url.searchParams.get(name)) : undefined);
      sendJson(res, 200, listProposals(c, { status: url.searchParams.get("status") ?? undefined, limit: number("limit"), offset: number("offset") }));
    } else if (req.method === "POST" && path.startsWith("/api/tag-proposals/")) {
      const by = await writer();
      if (by === null) return;
      const body = (await readJson(req)) as { action?: string; tags?: unknown };
      const tags = Array.isArray(body.tags) ? body.tags.map(String) : undefined;
      sendJson(res, 200, reviewProposal(c, decodeURIComponent(path.slice("/api/tag-proposals/".length)), { action: body.action as "approve", tags }, by));
    } else if (req.method === "GET" && path === "/api/tag-plan") {
      sendJson(res, 200, tagPlan(c, url.searchParams.get("library") ?? config.shelvesLibrary));
    } else if (req.method === "GET" && path === "/api/tag-cleanup-plan") {
      // ?also=<tag> (repeatable) removes further tags the hygiene rules do not flag.
      sendJson(res, 200, tagCleanupPlan(c, url.searchParams.get("library") ?? config.shelvesLibrary, url.searchParams.getAll("also")));
    } else if (req.method === "GET" && path === "/api/admin/metrics") {
      sendJson(res, 200, await adminMetrics(c, config, VERSION));
    } else if (req.method === "GET" && path === "/api/admin/jobs") {
      sendJson(res, 200, { kinds: JOB_KINDS, ...runner.list(Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 500)) });
    } else if (req.method === "GET" && /^\/api\/admin\/jobs\/\d+$/.test(path)) {
      sendJson(res, 200, runner.get(Number(path.split("/").at(-1))));
    } else if (req.method === "POST" && path === "/api/admin/jobs") {
      const by = await writer();
      if (by === null) return;
      const body = (await readJson(req)) as { kind?: string; mode?: string; preview_of?: number; also?: unknown; books?: unknown };
      const also = Array.isArray(body.also) ? body.also.map(String).filter(Boolean) : undefined;
      const books = Array.isArray(body.books) ? body.books.map(String) : undefined;
      const id = runner.start(body.kind as JobKind, (body.mode ?? "apply") as JobMode, { previewOf: body.preview_of, also, books }, by);
      sendJson(res, 202, { id });
    } else sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    if (error instanceof ToolError) sendJson(res, 400, { error: error.message });
    else {
      console.error("web request failed", error);
      sendJson(res, 500, { error: "Internal error." });
    }
  }
}

/** What tools/deploy.mjs last installed (branch, pull request, commit), written beside data.db after the restart, so read per request. */
function readDeployed(config: Config): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(config.dataDbPath), "deployed.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * A public page from the snapshot, for GET and HEAD. With no snapshot yet, a page that says how to build
 * one. Public pages may be cached, unlike the admin pages.
 */
async function servePublic(read: () => PublicStore | null, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const store = read();
  if (!store) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
      .end("The public catalogue hasn't been built yet. Run \"corpus-mcp publish\", or wait for the server's next rebuild.");
    return;
  }
  try {
    const out = await renderPublic(store, url.pathname, url.searchParams);
    if (!out) {
      res.writeHead(404).end();
      return;
    }
    const headers: Record<string, string> = { "content-type": out.type, "cache-control": "public, max-age=300" };
    if (out.etag) {
      headers.etag = out.etag;
      if (req.headers["if-none-match"] === out.etag) {
        res.writeHead(304, headers).end();
        return;
      }
    }
    res.writeHead(out.status, headers).end(req.method === "HEAD" ? undefined : out.body);
  } catch (error) {
    console.error("public page failed", error);
    if (!res.headersSent) res.writeHead(500).end();
  }
}

/** The request's URL, or null after answering 400 when it can't be parsed (a target such as "//"). */
function requestUrl(req: http.IncomingMessage, res: http.ServerResponse): URL | null {
  try {
    return new URL(req.url ?? "/", "http://localhost");
  } catch {
    res.writeHead(400).end();
    return null;
  }
}

/** Answers a request for the site's icon, on either listener; false for any other path. */
function serveFavicon(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (!FAVICON_PATHS.has(url.pathname)) return false;
  res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }).end(req.method === "HEAD" ? undefined : favicon());
  return true;
}

/** Rebuilds the public snapshot now and then on a timer; an unchanged catalogue leaves the file alone. */
function startPublishing(c: Corpus, config: Config): () => void {
  const p = config.public!;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const s = await publishSnapshot(c, config, (line) => console.error(line));
      if (s.changed) console.error(`public snapshot rebuilt: ${s.books} books, ${s.subjects} subjects, ${s.shelves} shelves, ${s.links} links`);
    } catch (error) {
      console.error("public snapshot failed", error);
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(run, p.intervalMinutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "86400",
};

/** Stateless Streamable HTTP: a fresh server and transport per request, sharing the database handles. */
export async function serveHttp(config: Config, options: WebOptions = {}): Promise<http.Server & { publicServer: http.Server | null }> {
  const corpus = openCorpus(config);
  const { db } = corpus;
  const fullConfig: Config = { ...config, admin: config.admin ?? loadConfig({}).admin };
  // The mirror syncs in the background on its own timer; the dashboard's job shares the same sync.
  const zotero = fullConfig.zotero ? new ZoteroSync(corpus, fullConfig.zotero) : null;
  const commands = options.jobCommands ?? systemCommands(fullConfig.admin!);
  const web: Web = {
    c: corpus, config: fullConfig, options,
    runner: new JobRunner(corpus, fullConfig, {
      ...commands, ...(zotero && !commands.zotero ? { zotero: async (log: (text: string) => void) => { await zotero.run(log); } } : {}),
    }),
  };
  if (zotero && options.zoteroTimer !== false) zotero.start();
  const publicOn = fullConfig.public && fullConfig.public.level !== "none";
  const readPublic = publicOn ? snapshotReader(fullConfig.public!.file) : () => null;
  const stopPublishing = publicOn && options.publishTimer !== false ? startPublishing(corpus, fullConfig) : () => {};
  // Ships the snapshot's changes to its replica in D1, when the proxy (or the REST API) is configured.
  const replica = publicOn && options.publishTimer !== false ? startDrain(fullConfig.public!.file, replicaStateFile(fullConfig.public!.file)) : null;
  // The public-only listener serves the public pages and nothing else, whatever the proxy in front of it sends.
  const publicServer = publicOn && fullConfig.public!.port !== undefined
    ? http.createServer(async (req, res) => {
      const url = requestUrl(req, res);
      if (!url || serveFavicon(req, res, url)) return;
      if (isPublicPath(url.pathname)) await servePublic(readPublic, req, res, url);
      else res.writeHead(404).end();
    })
    : null;
  const httpServer = http.createServer(async (req, res) => {
    const url = requestUrl(req, res);
    if (!url || serveFavicon(req, res, url)) return;
    if (isPublicPath(url.pathname)) {
      // Without a public site, / is the dashboard's front door, as before.
      if (publicOn) await servePublic(readPublic, req, res, url);
      else if (url.pathname === "/") res.writeHead(302, { location: "/admin" }).end();
      else res.writeHead(404).end();
      return;
    }
    if (url.pathname === "/health") {
      const books = db.prepare("SELECT COUNT(*) FROM books WHERE status = 'indexed'").pluck().get();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION, books, deployed: readDeployed(fullConfig), ...(replica ? { replica: replica() } : {}) }));
      return;
    }
    if (url.pathname === "/review" || url.pathname === "/admin" || url.pathname.startsWith("/admin/") || url.pathname.startsWith("/api/")) {
      await serveWeb(web, req, res, url);
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    // Same CORS policy as zotero-mcp's `mcp-proxy --cors`, for browser-based clients and portals.
    for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    // Stateless: there is no server-initiated stream to GET and no session to DELETE.
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST, OPTIONS", "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. This stateless server accepts POST only." }, id: null,
      }));
      return;
    }
    const server = createServer(corpus);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("request failed", error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  httpServer.on("close", () => {
    stopPublishing();
    publicServer?.close();
  });
  if (publicServer) {
    await new Promise<void>((resolve) => publicServer.listen(fullConfig.public!.port, config.host, resolve));
    const at = publicServer.address();
    console.error(`public catalogue listening on ${typeof at === "object" && at ? `${at.address}:${at.port}` : fullConfig.public!.port}`);
  }
  await new Promise<void>((resolve) => httpServer.listen(config.port, config.host, resolve));
  const address = httpServer.address();
  console.error(`corpus-mcp ${VERSION} listening on ${typeof address === "object" && address ? `${address.address}:${address.port}` : config.port}/mcp`);
  return Object.assign(httpServer, { publicServer });
}
