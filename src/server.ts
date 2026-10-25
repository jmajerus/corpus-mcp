import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { openDataStore } from "./data.js";
import { openDatabase } from "./db.js";
import { REVIEW_HTML } from "./reviewPage.js";
import { getTagVocabulary, listProposals, normalizeProposalTags, proposeTags, reviewProposal, tagPlan, taggingWorklist } from "./tagging.js";
import { Vocabulary } from "./vocabulary.js";
import {
  type Corpus, ToolError, citePassage, corpusStatus, getBookOutline, listBooks, listShelves, listTags, pinCitekey, readBook, renderPage,
  searchCorpus, tagCleanupPlan,
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

/**
 * The tag review page and its JSON API. These routes send no CORS headers, so another site cannot
 * read them, and the POST requires a JSON body, which a cross-site form cannot send.
 */
async function serveReview(c: Corpus, config: Config, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const reviewer = req.headers["cf-access-authenticated-user-email"];
  try {
    if (req.method === "GET" && url.pathname === "/review") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(REVIEW_HTML);
    } else if (req.method === "GET" && url.pathname === "/api/vocabulary") {
      sendJson(res, 200, getTagVocabulary(c));
    } else if (req.method === "GET" && url.pathname === "/api/tag-proposals") {
      const number = (name: string) => (url.searchParams.has(name) ? Number(url.searchParams.get(name)) : undefined);
      sendJson(res, 200, listProposals(c, { status: url.searchParams.get("status") ?? undefined, limit: number("limit"), offset: number("offset") }));
    } else if (req.method === "POST" && url.pathname.startsWith("/api/tag-proposals/")) {
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new ToolError("Send JSON.");
      const body = (await readJson(req)) as { action?: string; tags?: unknown };
      const tags = Array.isArray(body.tags) ? body.tags.map(String) : undefined;
      const uuid = decodeURIComponent(url.pathname.slice("/api/tag-proposals/".length));
      sendJson(res, 200, reviewProposal(c, uuid, { action: body.action as "approve", tags }, typeof reviewer === "string" ? reviewer : undefined));
    } else if (req.method === "GET" && url.pathname === "/api/tag-plan") {
      sendJson(res, 200, tagPlan(c, url.searchParams.get("library") ?? config.shelvesLibrary));
    } else if (req.method === "GET" && url.pathname === "/api/tag-cleanup-plan") {
      // ?also=<tag> (repeatable) removes further tags the hygiene rules do not flag.
      sendJson(res, 200, tagCleanupPlan(c, url.searchParams.get("library") ?? config.shelvesLibrary, url.searchParams.getAll("also")));
    } else {
      sendJson(res, 404, { error: "Not found." });
    }
  } catch (error) {
    if (error instanceof ToolError) sendJson(res, 400, { error: error.message });
    else {
      console.error("review request failed", error);
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
export async function serveHttp(config: Config): Promise<http.Server> {
  const corpus = openCorpus(config);
  const { db } = corpus;
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      const books = db.prepare("SELECT COUNT(*) FROM books WHERE status = 'indexed'").pluck().get();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION, books }));
      return;
    }
    if (url.pathname === "/review" || url.pathname.startsWith("/api/")) {
      await serveReview(corpus, config, req, res, url);
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
