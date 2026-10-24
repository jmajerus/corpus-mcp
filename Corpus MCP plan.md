If your existing Zotero MCP server handles citations, collections, and metadata index searches, your secondary native backend should focus strictly on **document manipulation, deep text extraction, and granular content streaming**. [[1](https://github.com/cookjohn/zotero-mcp)]

Since Zotero excels at managing the *catalog wrapper*, your specialized content backend should act as the *file-level operating engine*.

Here is the exact blueprint for a custom TypeScript/Node or Go MCP server designed to complement Zotero by exposing tools that read your raw file systems, parse complex books/articles on the fly, and interface with your local database—all run natively via `systemd` inside your Proxmox LXC.

------

The Advanced Content-Aware MCP Toolset

You can code these four specific tools into your custom backend service. They use Zotero's unique `itemKey` or a file hash as the bridging parameter to locate the actual book file on your shared volume:

1. `get_document_outline`

- **Purpose:** Before an LLM digests a massive 600-page book or a 40-page journal article, it needs to see the structural architecture without burning through its token window.

- **Functionality:** Your native code reads the PDF file or EPUB table of contents (using lightweight libraries like `pdf-parse` or a native Go PDF reader), extracting the internal bookmark tree, chapter headers, and page mappings.

- **Input Schema:**

  

  json

  ```
  {
    "name": "get_document_outline",
    "description": "Extracts the internal table of contents, bookmarks, and structural outline of a book or article using its Zotero itemKey.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zotero_key": { "type": "string", "description": "The unique alphanumeric Zotero item key" }
      },
      "required": ["zotero_key"]
    }
  }
  ```

  Use code with caution.

  

- `stream_document_chunks`

- **Purpose:** Streaming chunks allows an AI agent to "peruse" long-form data without exceeding model token limits.

- **Functionality:** Your backend targets the physical file path, reads an explicit range (by page numbers, chapters, or character offsets), strips out raw layout noise, and streams the pure plaintext back to the client via the MCP JSON-RPC protocol.

- **Input Schema:**

  

  json

  ```
  {
    "name": "stream_document_chunks",
    "description": "Reads and extracts a precise, contiguous sequence of text from a specific document for granular analysis.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zotero_key": { "type": "string" },
        "start_page": { "type": "integer", "description": "1-indexed starting page" },
        "end_page": { "type": "integer", "description": "Ending page (inclusive)" }
      },
      "required": ["zotero_key", "start_page", "end_page"]
    }
  }
  ```

  Use code with caution.

  

- `hybrid_semantic_search`

- **Purpose:** Zotero's full-text search is strictly keyword/Boolean-based. It fails when an agent asks a conceptual question like *"Find where this author implies a failure in structural abstraction boundaries."* [[1](https://contextbolt.com/blog/zotero-mcp/)]

- **Functionality:** Your backend runs text extraction on all newly added files, breaks them into dense blocks, generates vector embeddings using a fast local embedding engine (like an ONNX model or an Ollama container), and drops them into your native **PostgreSQL (`pgvector`)** instance. This tool queries that table using cosine similarity alongside standard metadata keyword filters.

- **Input Schema:**

  

  json

  ```
  {
    "name": "hybrid_semantic_search",
    "description": "Executes a deep vector-similarity or conceptual search across the extracted contents of all books and articles.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "conceptual_query": { "type": "string", "description": "The abstract concept, question, or thought you are searching for" },
        "limit": { "type": "integer", "default": 5 }
      },
      "required": ["conceptual_query"]
    }
  }
  ```

  Use code with caution.

  

- `extract_document_figures`

- **Purpose:** Academic articles hide massive context in tables, charts, graphs, and images that standard text scrapers completely miss.

- **Functionality:** Your backend uses native system tools inside the LXC (like `pdftoppm` or `MuPDF` bindings) to extract an image file of a requested page or crop a bounding box of a specific diagram, converting it into a base64 Data URL so a vision-capable LLM client (like Claude) can inspect the visual proof directly.

- **Input Schema:**

  

  json

  ```
  {
    "name": "extract_document_figures",
    "description": "Extracts charts, figures, or full-page visual layouts from a document for multi-modal vision analysis.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zotero_key": { "type": "string" },
        "page_number": { "type": "integer" }
      },
      "required": ["zotero_key", "page_number"]
    }
  }
  ```

  Use code with caution.

  

------

Co-existence Config (Claude Desktop Example)

Because the Model Context Protocol allows a client to orchestrate **multiple independent servers simultaneously**, your client will cleanly query both tools in tandem. You simply register both servers natively in your `claude_desktop_config.json`:

json

```
{
  "mcpServers": {
    "zotero-metadata-server": {
      "command": "npx",
      "args": ["-y", "zotero-mcp-plugin-command"]
    },
    "my-native-content-server": {
      "command": "/usr/local/bin/my-content-backend",
      "args": ["--config=/etc/content-server/config.json"]
    }
  }
}
```

Use code with caution.

To build a forward-looking, machine-perusable **AI Knowledge Graph** while cleanly decoupling from Calibre, your backend storage architecture must treat Calibre as a **legacy asset provider** rather than a database runtime dependecy. [[1](https://github.com/sguzman/caliberate/blob/main/ARCHITECTURE.md)]

For your exact architecture—running natively inside a Proxmox LXC, connecting to PostgreSQL, exposing custom MCP tools, and synchronizing with an external Calibre instance—you should fork ***\*Audiobookshelf\**** as your functional code structure blueprint, but configure a **Managed-Folder Event Stream Storage Architecture**.

Here is why this architecture is the best approach for forkability and how it handles your specific migration and synchronization requirements:

------

The Recommended Architecture: Managed-Folder Event Stream

Instead of forking a project that attempts to mimic Calibre's complex table joins, you want a codebase that treats storage as a **Read-Only managed file system with an external relational state engine (PostgreSQL + pgvector)**.

Why Audiobookshelf is the absolute best codebase to fork:

1. **The Ingestion Watcher:** Audiobookshelf has a mature, highly optimized, non-blocking file scanner built natively in TypeScript/Node. It watches a directory, reads changes without file-locking crashes, handles errors gracefully, and extracts metadata seamlessly. You can easily fork this scanner to run inside your native `systemd` service.
2. **True Structural Decoupling:** It decouples file processing from database interactions. You can strip out its internal SQLite database layer and pipe the incoming stream directly into your native **PostgreSQL instance** using an ORM like Prisma or Kysely.
3. **Deep Content-Streaming Hooks:** Its codebase already contains advanced token-streaming and byte-range video/audio/text segmentation logic. This makes it incredibly straightforward to append your custom MCP tools (`stream_document_chunks`, `get_document_outline`) right into the existing file-reading utility classes.

------

Phase 1: Importing Your Calibre Library (The Clean Migration)

Do not try to translate Calibre's `metadata.db` schema directly into your new PostgreSQL database. It is heavily fragmented with old relational lookup tables (`books_tags_link`, etc.). Instead, run a structured structural ingestion:

1. **The Data Drop:** Copy your physical Calibre library directory over to the network volume or ZFS dataset accessible by your Proxmox LXC.
2. **Metadata Preservation:** Calibre natively backs up every single book's metadata into a standard **`metadata.opf`** XML file and a **`cover.jpg`** inside each book's specific subfolder. [[1](https://manual.calibre-ebook.com/generated/en/calibredb.html), [2](https://manual.calibre-ebook.com/gui.html)]
3. **The Ingestion Fork:** Modify your backend's folder scanner to look for these `metadata.opf` files during the initial pass. Your server will read the clean, standardized XML metadata (Author, Title, Tags, ISBN, Publisher) and insert it cleanly into your new **PostgreSQL schema** as a single flat `works` row, while passing the raw text chapters to your embedding pipeline.

------

Phase 2: The Two-Way Sync Mechanics (Without SQLite Locks)

If you plan to keep Calibre active on your desktop workstation (for processing new raw files, stripping DRM, or manual edits) but want your headless LXC backend to stay perfectly updated, you have two synchronization choices depending on which application owns the files:

Approach A: The Automated Ingestion Sync (Calibre as the Master)

If Calibre Desktop is where you add new books, use **Syncthing** to replicate your local workstation Calibre Library folder over to the LXC directory watched by your backend.

- **How it handles sync:** Your backend scanner leverages native Linux file events (`inotify`). The second Syncthing drops a new book folder or updates a `metadata.opf` file, your backend detects the change, parses the modified XML metadata, updates the corresponding PostgreSQL record, and chunks the text for your vector memory database. It is entirely non-invasive and bypasses Calibre completely.

Approach B: Headless Ingestion via `calibredb` (The API Master)

If your custom backend wants to push modifications back into Calibre dynamically, you utilize Calibre's native headless command-line client, **`calibredb`**, over the network. [[1](https://manual.calibre-ebook.com/generated/en/calibredb.html), [2](https://www.mobileread.com/forums/showthread.php?t=349992)]

- **How it handles sync:** If an MCP tool or a user action inside Zotero modifies a tag or file state, your backend service triggers a remote SSH execution block or HTTP request pointing to your workstation's running instance:

  bash

  ```
  calibredb set_metadata <book_id> /path/to/updated_metadata.opf --with-library http://workstation_ip:8080
  ```

  Use code with caution.

  This forces Calibre to execute the change safely through its *own* system thread handlers, completely eliminating SQLite corruption risk.

   [[1](https://www.mobileread.com/forums/showthread.php?t=349992)]

  

------

Summary Recommendation for Your Codebase Foundation

1. **Clone Audiobookshelf** to strip away the client UI and leverage its powerful, highly concurrent Node/TypeScript background file processing.
2. **Point the data layer to PostgreSQL**, mapping a primary text table that stores Zotero's `itemKey` as a foreign key next to your `pgvector` embedding columns.
3. **Drop your custom MCP tool server logic** directly onto this API tier, allowing an external LLM agent to interact directly with the extracted plaintext.

This database schema provides a clean relational foundation for your headless MCP content server. It uses a **PostgreSQL schema utilizing the `pgvector` extension** [1.4] to link Zotero's `item_key` directly to your physical file layout and granular vector chunks.

This layout ensures that an LLM client can run fast relational filters (by date, author, or tags) and semantic chunk queries within a single query execution.

The Unified Relational & Vector Schema

You can apply this SQL initialization script directly to your native PostgreSQL service running in the LXC:

sql

```
-- 1. Enable the vector extension for semantic search capabilities
CREATE EXTENSION IF NOT EXISTS pgvector;

-- 2. Master Table: Core works mapped to Zotero
CREATE TABLE works (
    zotero_key VARCHAR(50) PRIMARY KEY,      -- Unique identifier from Zotero (e.g., 'ABCD1234')
    calibre_id INT UNIQUE,                   -- Tracks the origin ID if imported from Calibre
    title TEXT NOT NULL,
    author TEXT,
    publication_year INT,
    file_path TEXT NOT NULL,                 -- Absolute path on your LXC shared volume
    file_hash VARCHAR(64) NOT NULL,          -- SHA-256 to track structural modifications/versions
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Document Structure Table: For Outline Tool
CREATE TABLE document_outlines (
    id SERIAL PRIMARY KEY,
    zotero_key VARCHAR(50) REFERENCES works(zotero_key) ON DELETE CASCADE,
    title TEXT NOT NULL,                     -- Chapter or Section heading text
    start_page INT NOT NULL,                 -- Starting page context
    end_page INT,                            -- Ending page context
    hierarchy_level INT DEFAULT 0            -- Nesting level (0 for H1, 1 for H2, etc.)
);

-- 4. Text Content & Embeddings Table: For Chunking and Semantic Tools
CREATE TABLE document_chunks (
    id BIGSERIAL PRIMARY KEY,
    zotero_key VARCHAR(50) REFERENCES works(zotero_key) ON DELETE CASCADE,
    chunk_index INT NOT NULL,                -- Sequential index within this specific document
    page_number INT NOT NULL,                -- Maps the text segment directly back to physical page
    raw_text TEXT NOT NULL,                  -- The pure plaintext string used for LLM digestion
    
    -- 1536 is standard for OpenAI / text-embedding-3-small
    -- Switch to 384 if using lightweight local models like bge-small-en-v1.5
    embedding vector(1536)                   
);

-- 5. Indexes for High-Performance Concurrent Ingest & Query Execution
CREATE INDEX idx_works_calibre ON works(calibre_id);
CREATE INDEX idx_chunks_zotero ON document_chunks(zotero_key);
CREATE INDEX idx_outline_zotero ON document_outlines(zotero_key);

-- 6. HNSW Vector Index for Instant Semantic Searches
-- (Note: 'vector_cosine_ops' optimizes the distance calculations for abstract matching)
CREATE INDEX idx_chunks_embedding ON document_chunks USING hnsw (embedding vector_cosine_ops);
```

Use code with caution.

------

How Your MCP Tools Leverage This Schema Natively

By separating your database into these distinct tables, your custom MCP tools can communicate with PostgreSQL through simple SQL queries, eliminating the need for a convoluted ORM layer.

For `get_document_outline`:

Your backend pulls from the structured outline tree to hand the LLM a fast bird's-eye view:

sql

```
SELECT title, start_page, hierarchy_level 
FROM document_outlines 
WHERE zotero_key = $1 
ORDER BY start_page ASC;
```

Use code with caution.

For `stream_document_chunks`:

When the LLM requests precise text layers for a reading block, the service hits a sequential page boundary index instantly:

sql

```
SELECT page_number, raw_text 
FROM document_chunks 
WHERE zotero_key = $1 AND page_number BETWEEN $2 AND $3 
ORDER BY chunk_index ASC;
```

Use code with caution.

For `hybrid_semantic_search`:

Your backend generates a vector on the fly from the user's conceptual prompt, and pipes it directly into the `HNSW` index [1.4]:

sql

```
SELECT works.title, works.author, chunks.page_number, chunks.raw_text,
       (chunks.embedding <=> $1) AS cosine_distance
FROM document_chunks chunks
JOIN works ON chunks.zotero_key = works.zotero_key
ORDER BY cosine_distance ASC
LIMIT $2;
```

Use code with caution.

### calibre_parser_service.js

The TypeScript/Node.js script serves as the background ingestion system daemon for your Proxmox LXC. It reads Calibre's native metadata architecture (`metadata.opf`) [1.1], extracts the core bibliographic values, performs a SHA-256 fingerprint verify on the actual ebook container file [1.1], and securely processes an idempotent `UPSERT` onto your local **PostgreSQL** relational tables.

Key Architectural Advantages of this Implementation

- **Zero Calibre Locks:** By extracting native metadata straight from the generated structural XML files (`.opf`), this ingestion process avoids connecting to Calibre's active `metadata.db` SQLite engine, allowing your Syncthing sync scripts to update your files dynamically without causing file-lock collisions.
- **Pure Version Tracking:** Computing raw SHA-256 file hashes ensures your background process will immediately flag when an ebook has been updated on your desktop workstation (e.g., if you run an updated metadata sync, crop a new custom cover, or re-run a conversion format), opening a pipeline to re-run your `pgvector` text chunking algorithms.
- **Idempotent Ingestion Execution:** Utilizing the database level `ON CONFLICT` pattern means you can clear out, restart, or sweep through your entire synchronized folder repeatedly over multiple sync passes without bloating the tables or duplicating entries.

### document_chunking_service.ts

Moving on to looking at the **text-extraction layer logic (PDF-to-plaintext chunking)** that strips layout noise out of the files and maps them directly to the `document_chunks` table for your semantic search MCP tools, the  document_chunking_service.ts file was created.

This TypeScript module implements a layout-aware PDF text extraction and sliding-window chunking engine. It leverages the pure-JavaScript/TypeScript library **`pdf-parse`** to ensure it runs with maximum execution speed natively in your Proxmox LXC without breaking under external platform binary dependencies. [[1](https://strapi.io/blog/7-best-javascript-pdf-parsing-libraries-nodejs-2025), [2](https://medium.com/@roppoycissy2jc2/engineering-a-document-savvy-ai-assistant-a-python-guide-to-pdf-chunking-for-chatgpt-processing-f7eddfeb4937)]

The engine uses a deterministic layout cleanup filter to strip header/footer pagination noises and automatically performs localized batch inserts into your **PostgreSQL `document_chunks` table**. [[1](https://medium.com/@roppoycissy2jc2/engineering-a-document-savvy-ai-assistant-a-python-guide-to-pdf-chunking-for-chatgpt-processing-f7eddfeb4937)]

Key Engineering Features of this Ingestion Layer

- **Layout Isolation Preservation:** Standard PDF extractors smash all lines into a singular string mass. This implementation hooks into the page transform coordinate vector mapping matrix (`item.transform[5]`), identifying vertical layout modifications and enforcing paragraph line-breaks dynamically before the text hits the chunking block.

- **Context Overlap Protection:** Setting an explicit sliding word boundary window (`overlapWords: 50`) guarantees that if an academic thesis details a vital equation or thought across a chunk limit line, the context is duplicated at the start of the following index rather than being severed mid-sentence.

- **Granular Target Mapping:** By passing individual `pageIndex + 1` mappings natively to the `document_chunks` table, your downstream **MCP clients and LLM agents** retain the specific physical reference parameters required to execute your multi-modal vision extraction calls (`extract_document_figures`) flawlessly.

  

### mcp_server.ts

Next, we create the **Model Context Protocol server wiring script** that bundles these exact PostgreSQL schema calls together so LLM clients can natively invoke these tools over `stdio` channels. 

The mcp_server.ts script implements the **Model Context Protocol (MCP)** specification natively in TypeScript. It wires your **PostgreSQL** schema directly to standard JSON-RPC communication channels over **Standard Input/Output (`stdio`)**.

When run under a native `systemd` supervisor daemon inside your Proxmox LXC, any MCP-compliant client (like Claude Desktop or Cline) can instantly discover and invoke these tools to traverse your database.