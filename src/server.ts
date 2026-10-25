import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { JWTVerifyGetKey } from "jose";
import { accessIdentity } from "./access.js";
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
import {
  getTagVocabulary, listProposals, normalizeProposalTags, proposeTags, reviewProposal, setBookCategories, tagPlan, taggingWorklist,
} from "./tagging.js";
import { Vocabulary } from "./vocabulary.js";
import { citeQuote, deleteQuote, getQuote, quotesOnPages, saveQuote, searchQuotes, updateQuote } from "./quotes.js";
import {
  type Corpus, ToolError, citePassage, corpusStatus, getBookOutline, listBooks, listShelves, listTags, pinCitekey, readBook, renderPage,
  getBook, searchCorpus, tagCleanupPlan, unpinCitekey,
} from "./tools.js";

const VERSION = "0.2.0";

const INSTRUCTIONS = `Search, read, and cite books in the Calibre libraries (books that are not Zotero attachments; use the Zotero server for those).
Book ids look like "main:42"; any tool that takes a book id also takes the book's citekey (e.g. "nye2011future"). Pages are 1-based. For PDFs a page is a physical page and page_label is the printed number to cite. For EPUB and MOBI a page is a stable reading location, not a citable page number; cite those by chapter (the section path).
Typical flow: search_corpus → read_book around a hit → cite_passage for a Concept Clusters info.citations object. To file a cited book in Zotero, call the zotero_filing options cite_passage returns, in order, then pin_citekey with the citekey Concept Clusters assigned.`;

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
    description: "Concept Clusters' taxonomy as Calibre tags: slug paths (\"social-sciences.psychology.social-psychology\") with their titles as labels. propose_tags accepts only these, in either form.",
    inputSchema: { under: z.string().optional().describe('Only tags at or below this one, e.g. "social-sciences.psychology" or "Psychology"') },
    annotations: { title: "Get tag vocabulary", ...readOnly },
  }, (args) => run(() => json(getTagVocabulary(c, args))));

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
      categories: z.array(z.string()).max(5).optional().describe("Vocabulary categories (get_tag_vocabulary), slug or title"),
      labels: z.array(z.string()).max(20).optional().describe('Free-form labels, e.g. "cc:puzzle:<puzzle id>"'),
    },
    annotations: { title: "Save a quote", ...writes },
  }, (args, extra) => run(() => json(saveQuote(c, args, accessEmail(extra), "agent"))));

  server.registerTool("search_quotes", {
    title: "Search quotes",
    description: "Find saved quotes by words in their text, note, or labels, and by book, author, category (including subcategories), label, or status.",
    inputSchema: {
      query: z.string().optional(), book_id: bookId.optional(), author: z.string().optional(),
      category: z.string().optional().describe("A vocabulary category, slug or title; includes those below it"),
      label: z.string().optional(), status: z.enum(["verified", "orphaned"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: { title: "Search quotes", ...readOnly },
  }, (args) => run(() => json(searchQuotes(c, { q: args.query, book: args.book_id, author: args.author, category: args.category, label: args.label, status: args.status, limit: args.limit }))));

  server.registerTool("get_quote", {
    title: "Get a quote",
    description: "One saved quote with the text around it, its locator, and its citation.",
    inputSchema: { id: z.number().int() },
    annotations: { title: "Get a quote", ...readOnly },
  }, ({ id }) => run(() => json(getQuote(c, id))));

  server.registerTool("update_quote", {
    title: "Update a quote",
    description: "Change a quote's note, categories, or labels. The quoted text cannot change; save a new quote instead.",
    inputSchema: {
      id: z.number().int(), note: z.string().max(2000).nullable().optional(),
      categories: z.array(z.string()).max(5).optional().describe("Replaces the quote's categories"),
      labels: z.array(z.string()).max(20).optional().describe("Replaces the quote's labels"),
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
    description: "The quote's verified text and locator, with a Concept Clusters citation object for its book and pages (as cite_passage returns).",
    inputSchema: { id: z.number().int() },
    annotations: { title: "Cite a quote", ...readOnly },
  }, ({ id }) => run(() => json(citeQuote(c, id))));

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
    description: "A citation object in the Concept Clusters info.citations shape (title, author, publisher, year, pages) for a book and optional page range, plus the locator, citekey, and warnings about missing metadata. PDF citations use printed page labels; EPUB and MOBI citations have no pages. For a book not yet filed in Zotero, zotero_filing lists file_zotero_reference calls to try in order: a BibTeX entry built from Calibre's metadata, then an ISBN lookup.",
    inputSchema: {
      book_id: bookId,
      page: page.optional().describe("Page of the cited passage"),
      end_page: page.optional().describe("Last page, if the passage spans pages"),
    },
    annotations: { title: "Cite a book", ...readOnly },
  }, (args) => run(() => json(citePassage(c, args))));

  server.registerTool("pin_citekey", {
    title: "Pin a book's citekey",
    description: "Record the citekey Concept Clusters assigned when file_zotero_reference filed this book in Zotero. Pinned keys are stored by Calibre UUID, never change on their own, and are then accepted anywhere a book id is.",
    inputSchema: {
      book_id: bookId,
      citekey: z.string().min(1).describe("The citekey file_zotero_reference returned"),
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

function openCorpus(config: Config): Corpus {
  const corpus = {
    db: openDatabase(config.dbPath, { readonly: true }),
    data: openDataStore(config.dataDbPath),
    booksRoot: config.booksRoot,
    vocabulary: Vocabulary.load(config.vocabularyPath),
  };
  const normalized = normalizeProposalTags(corpus);
  if (normalized) console.error(`rewrote ${normalized} tag proposal(s) into the vocabulary's slug form`);
  return corpus;
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
      "/admin/quotes": QUOTES_HTML,
    };
    const bookPath = path.match(/^\/api\/books\/([^/]+)(\/categories|\/citekey|\/pages)?$/);
    const quotePath = path.match(/^\/api\/quotes\/(\d+)(\/delete)?$/);
    if (req.method === "GET" && path === "/review") res.writeHead(302, { location: "/admin/proposals" }).end();
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
      const body = (await readJson(req)) as { book_id?: string; text?: string; page?: number; note?: string; categories?: unknown; labels?: unknown };
      if (!body.book_id || !body.text) throw new ToolError("Send book_id and text.");
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
      sendJson(res, 200, saveQuote(c, { book_id: body.book_id, text: body.text, page: body.page, note: body.note, categories: list(body.categories), labels: list(body.labels) }, by, "admin"));
    } else if (req.method === "POST" && quotePath) {
      const by = await writer();
      if (by === null) return;
      const id = Number(quotePath[1]);
      if (quotePath[2]) sendJson(res, 200, deleteQuote(c, id, by, "admin"));
      else {
        const body = (await readJson(req)) as { note?: string | null; categories?: unknown; labels?: unknown };
        const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
        sendJson(res, 200, updateQuote(c, { id, note: body.note, categories: list(body.categories), labels: list(body.labels) }, by, "admin"));
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
    else if (req.method === "GET" && path === "/api/citekeys") sendJson(res, 200, adminCitekeys(c));
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

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "86400",
};

/** Stateless Streamable HTTP: a fresh server and transport per request, sharing the database handles. */
export async function serveHttp(config: Config, options: WebOptions = {}): Promise<http.Server> {
  const corpus = openCorpus(config);
  const { db } = corpus;
  const fullConfig: Config = { ...config, admin: config.admin ?? loadConfig({}).admin };
  const web: Web = {
    c: corpus, config: fullConfig, options,
    runner: new JobRunner(corpus, fullConfig, options.jobCommands ?? systemCommands(fullConfig.admin!)),
  };
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      const books = db.prepare("SELECT COUNT(*) FROM books WHERE status = 'indexed'").pluck().get();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION, books }));
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
  await new Promise<void>((resolve) => httpServer.listen(config.port, config.host, resolve));
  const address = httpServer.address();
  console.error(`corpus-mcp ${VERSION} listening on ${typeof address === "object" && address ? `${address.address}:${address.port}` : config.port}/mcp`);
  return httpServer;
}
