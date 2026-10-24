import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { type DB, openDatabase } from "./db.js";
import {
  ToolError, citePassage, corpusStatus, getBookOutline, listBooks, readBook, renderPage, searchCorpus,
} from "./tools.js";

const VERSION = "0.1.0";

const INSTRUCTIONS = `Search, read, and cite books in the Calibre libraries (books that are not Zotero attachments; use the Zotero server for those).
Book ids look like "main:42". Pages are 1-based. For PDFs a page is a physical page and page_label is the printed number to cite. For EPUB and MOBI a page is a stable reading location, not a citable page number; cite those by chapter (the section path).
Typical flow: search_corpus → read_book around a hit → cite_passage for a Concept Clusters info.citations object.`;

const bookId = z.string().describe('Book id from search_corpus or list_books, e.g. "main:42"');
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

export function createServer(db: DB, config: Config): McpServer {
  const server = new McpServer({ name: "corpus-mcp", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool("search_corpus", {
    title: "Search book text",
    description: "Full-text search over the text of every indexed book. Returns ranked passages with book id, page, printed page label (PDF), section, and a snippet with matches in «». Words are ANDed; put a phrase in double quotes; end a word with * for a prefix match.",
    inputSchema: {
      query: z.string().min(1).describe('Words or "quoted phrases" to find'),
      book_id: bookId.optional().describe("Search within one book"),
      library: z.string().optional().describe("Limit to one Calibre library"),
      author: z.string().optional().describe("Limit to books whose author contains this text"),
      limit: z.number().int().min(1).max(50).optional().describe("Results to return (default 10)"),
      advanced: z.boolean().optional().describe("Pass query to SQLite FTS5 unchanged (OR, NOT, NEAR(), column filters)"),
    },
    annotations: { title: "Search book text", ...readOnly },
  }, (args) => run(() => json(searchCorpus(db, args))));

  server.registerTool("list_books", {
    title: "List books",
    description: "Look up books by title, author, tag, publisher, ISBN, or id. Returns metadata, format, page count, and other ids that hold the same file.",
    inputSchema: {
      query: z.string().optional().describe("Text to match; omit to list everything"),
      library: z.string().optional(),
      include_unindexed: z.boolean().optional().describe("Also list catalogue entries with no readable ebook file"),
      limit: z.number().int().min(1).max(200).optional().describe("Default 25"),
    },
    annotations: { title: "List books", ...readOnly },
  }, (args) => run(() => json(listBooks(db, args))));

  server.registerTool("get_book_outline", {
    title: "Get book outline",
    description: "Metadata and table of contents with the page where each section starts. Read this before reading a long book.",
    inputSchema: { book_id: bookId },
    annotations: { title: "Get book outline", ...readOnly },
  }, ({ book_id }) => run(() => json(getBookOutline(db, book_id))));

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
  }, (args) => run(() => ({ content: [{ type: "text", text: readBook(db, args) }] })));

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
    const image = renderPage(db, config.booksRoot, args);
    return {
      content: [
        { type: "image", data: image.png, mimeType: "image/png" },
        { type: "text", text: `${args.book_id} page ${args.page} (${image.width}×${image.height})` },
      ],
    };
  }));

  server.registerTool("cite_passage", {
    title: "Cite a book",
    description: "A citation object in the Concept Clusters info.citations shape (title, author, publisher, year, pages) for a book and optional page range, plus the locator, ISBN, warnings about missing metadata, and (when the ISBN is valid) the file_zotero_reference call that files the book in Zotero. PDF citations use printed page labels; EPUB and MOBI citations have no pages.",
    inputSchema: {
      book_id: bookId,
      page: page.optional().describe("Page of the cited passage"),
      end_page: page.optional().describe("Last page, if the passage spans pages"),
    },
    annotations: { title: "Cite a book", ...readOnly },
  }, (args) => run(() => json(citePassage(db, args))));

  server.registerTool("corpus_status", {
    title: "Corpus status",
    description: "Index freshness, book counts by library and format, and books that failed, have no text layer, or have no outline.",
    inputSchema: {},
    annotations: { title: "Corpus status", ...readOnly },
  }, () => run(() => json(corpusStatus(db))));

  return server;
}

export async function serveStdio(config: Config): Promise<void> {
  const db = openDatabase(config.dbPath, { readonly: true });
  await createServer(db, config).connect(new StdioServerTransport());
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "86400",
};

/** Stateless Streamable HTTP: a fresh server and transport per request, sharing one read-only database handle. */
export async function serveHttp(config: Config): Promise<http.Server> {
  const db = openDatabase(config.dbPath, { readonly: true });
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      const books = db.prepare("SELECT COUNT(*) FROM books WHERE status = 'indexed'").pluck().get();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION, books }));
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
    const server = createServer(db, config);
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
