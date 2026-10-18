# ClipMind: Complete System Architecture, Design Decisions & Technical Deep Dive

This document explains every single concept, component, design decision, and line of architecture that makes up **ClipMind**. It covers what the system does, how it was built, why each Cloudflare primitive was chosen, and how every part interacts under the hood.

---

## 1. Executive Summary & Vision

**ClipMind** is a serverless, personal knowledge vault, web clipper, and Edge RAG (Retrieval-Augmented Generation) agent. 

### Core Requirements & Constraints
- **100% Free Tier ($0/month)**: Operates entirely within the free quotas of Cloudflare primitives.
- **Zero External SDKs**: Strictly prohibits OpenAI, LangChain, Pinecone, or AWS S3 SDKs. All operations utilize native Cloudflare bindings (`env.AI`, `env.VECTORIZE`, `env.BUCKET`, `env.DB`).
- **Domainless Remote Ingestion**: Since personal developers often do not have custom email domains for clipping via email, ClipMind routes remote link sharing through a **Discord Bot Webhook** (`/clip [url]`).
- **Durable Processing**: Scraping, rendering, screenshotting, chunking, and embedding can take 5–15 seconds—far too long for standard synchronous HTTP requests. It uses **Cloudflare Workflows** to guarantee execution without HTTP timeouts.
- **Real-Time UI without Billable Idle Costs**: Utilizes Cloudflare's **WebSocket Hibernation API** inside Durable Objects to provide instantaneous progress bars in the browser while consuming **0 CPU billable seconds** when idle.

---

## 2. Cloudflare Primitives & Zero-Cost Safeguards

ClipMind combines 8 different Cloudflare edge services. Here is what each does and how we prevent quota overages:

| Cloudflare Service | Role in ClipMind | Free Quota | Zero-Cost Enforcement Tactic |
| :--- | :--- | :--- | :--- |
| **Workers & Hono** | Edge HTTP routing, SSR UI, API controllers | 100,000 req/day | Lightweight edge execution with zero cold-starts; static UI rendered directly from Worker memory. |
| **Browser Rendering (`@cloudflare/puppeteer`)** | Headless Chrome running at the edge to load SPAs, extract DOM text, and take 1280x720 screenshots | 10 CPU mins/day | **KV Cache Check**: Prior to launching headless Chrome, ClipMind checks KV. If a URL was scraped recently, it skips Chrome entirely to protect CPU minutes. |
| **Cloudflare Workflows** | Durable multi-step state machine orchestrating the ingestion pipeline | Included in Free Tier | Asynchronous execution decoupled from client HTTP request lifecycles. Automatically handles retries and step checkpointing. |
| **R2 Object Storage** | S3-compatible bucket storing raw Markdown and WebP screenshots | 10 GB storage, zero egress fees | Screenshots are saved as compressed WebP and text as UTF-8 Markdown. Zero egress fees ensure reading/downloading clips never costs anything. |
| **Workers AI** | Embedding generation (`bge-small-en-v1.5`) & Edge LLM synthesis (`llama-3.2-3b-instruct`) | 10,000 Neurons/day | Uses `bge-small-en-v1.5` (384-dimension vectors, <1 neuron per chunk) and strict chunking boundaries to minimize token usage. |
| **Cloudflare Vectorize** | Native vector similarity database | 5M vectors stored, 30M queries/mo | Index dimension strictly locked to 384 dimensions with `cosine` metric, perfectly aligning with BGE embeddings without transformation. |
| **Cloudflare D1** | Serverless relational SQLite database | 5 GB storage, 5M reads/day | Relational tables with indexed foreign keys, status checks, and cascade deletions to prevent unindexed table scans. |
| **Durable Objects (`PROGRESS_DO`)** | WebSocket broadcast hub for live progress bars | 100k requests/month | **WebSocket Hibernation API**: Connections are offloaded to Cloudflare's edge infrastructure. When no messages are being sent, the Worker process sleeps (0 active GB-seconds). |

---

## 3. End-to-End Data Flow & Ingestion Lifecycle

```
[Ingestion Trigger]
Web Dashboard  |  Browser Bookmarklet  |  Discord Slash Command (/clip)
                       │
                       ▼
            [Hono HTTP Controller]
   Validates URL & Ed25519 Signatures -> Inserts 'pending' into D1
                       │
                       ▼
       [Cloudflare Workflows Orchestrator]
       (ClipPipelineWorkflow - Durable 4 Steps)
                       │
       ┌───────────────┴───────────────┐
       ▼                               ▼
[Step 1: Scrape & Shot]       [Step 2: Immutable R2 Vault]
- Check KV Cache              - snapshots/{id}.md
- Launch Headless Chrome      - screenshots/{id}.webp
- Readability text extract    - Zero egress public edge links
- 1280x720 WebP screenshot
       │
       ▼
[Step 3: Chunk & Embed]
- 400-word sliding windows (40-word overlap)
- Workers AI: @cf/baai/bge-small-en-v1.5 (384-dim)
- Upsert to Vectorize index
- Insert chunk records into D1
       │
       ▼
[Step 4: Finalize & Broadcast]
- Update D1 status: 'indexed'
- Push completion payload to Durable Object WebSocket
- (If Discord) Asynchronous Webhook Patch with reading time & title
```

### Detailed Breakdown of the 4 Workflow Steps

#### Step 1: KV Deduplication & Headless DOM Extraction
1. When a URL is submitted, the workflow checks `url_cache:<url>` in Cloudflare KV. If found within the 7-day TTL, scraping is skipped entirely.
2. If uncached, the workflow calls `puppeteer.launch(env.BROWSER)`.
3. Headless Chrome navigates to the URL with a 1280x720 viewport and waits for `networkidle0` to let client-side React/Vue/Angular SPAs hydrate.
4. Clean text extraction is performed by cloning the DOM, stripping junk elements (`script`, `style`, `nav`, `footer`, `iframe`, `svg`), and extracting title, author, and description metadata.
5. A high-resolution screenshot buffer is captured directly from the page.

#### Step 2: Immutable R2 Archiving
1. A structured Markdown file is generated:
   ```markdown
   # Article Title
   **Author:** Author Name
   **Source URL:** https://...
   **Clipped Date:** 2026-10-18T...
   ---
   > Article description/summary
   Article body text...
   ```
2. The raw Markdown is written to `env.BUCKET.put("snapshots/{docId}.md")`.
3. The screenshot buffer is saved to `env.BUCKET.put("screenshots/{docId}.webp")`.
4. R2 has **zero egress fees**, allowing users to read and view archived snapshots without bandwidth charges.

#### Step 3: Sliding Chunking & Workers AI Embeddings
1. To enable accurate semantic vector search, long documents cannot be embedded as a single giant string.
2. The text is split using a **400-word sliding window with a 40-word overlap**:
   - Words 0 to 400 (Chunk 0)
   - Words 360 to 760 (Chunk 1)
   - Words 720 to 1120 (Chunk 2)
   - The 40-word overlap prevents semantic concepts from being cut in half at chunk boundaries.
3. Each chunk is passed to `env.AI.run("@cf/baai/bge-small-en-v1.5", { text: [chunk] })`.
4. The output is a **384-dimension floating-point vector**.
5. The vector is upserted into Cloudflare Vectorize with metadata (`document_id`, `chunk_index`, `title`, `url`).
6. The chunk text and vector ID are recorded in D1 with foreign keys referencing the master document.

#### Step 4: Real-Time Broadcast & Notification
1. Document status in D1 is updated to `'indexed'`, alongside calculated word counts and reading times (~200 words/min).
2. The workflow sends an internal broadcast request to the `ProgressRoomDO` Durable Object.
3. The Durable Object pushes a `{ type: "complete", percent: 100, status: "indexed" }` frame over all subscribed WebSockets.
4. If the ingestion was triggered from Discord, the workflow issues an asynchronous HTTP `PATCH` to the original Discord interaction token, updating the message:
   `✅ ClipMind Vault Updated! Title: ... (~3 min read, 5 chunks indexed)`.

---

## 4. The Edge RAG (Retrieval-Augmented Generation) Engine

When you ask a question in the search bar:

1. **Query Embedding**: The user query (e.g. `"What are Cloudflare Workflows?"`) is embedded using `@cf/baai/bge-small-en-v1.5` to produce a 384-dimension vector.
2. **Vector Similarity Query**:
   ```ts
   const results = await env.VECTORIZE.query(queryEmbedding, {
     topK: 5,
     returnMetadata: "all"
   });
   ```
   Vectorize calculates cosine similarity across millions of vectors in single-digit milliseconds.
3. **Relational Context Hydration**: Using the matching `vector_id`s, ClipMind executes a single indexed SQL query against D1 to retrieve the exact chunk text, document title, and URL.
4. **Guardrailed Prompt Construction**:
   A prompt is built with strict anti-hallucination guardrails:
   ```text
   System: You are ClipMind Vault Assistant. Answer the question accurately using ONLY 
   the provided vault passages. Always cite sources with document titles and URLs. 
   If context is insufficient, state that clearly.
   
   Context:
   [Source 1]: "Understanding Cloudflare Workflows" (https://blog.cloudflare.com/...)
   Passage: ...
   ```
5. **Edge LLM Inference**: The prompt is processed by `@cf/meta/llama-3.2-3b-instruct` running on Cloudflare GPUs at the edge. The result is returned with direct source citations and similarity scores.

---

## 5. WebSocket Hibernation API: How It Saves 100% of Idle Costs

In traditional architectures (Node.js/Express/EC2), maintaining 500 open WebSocket connections requires dedicated server memory and continuous CPU polling.

Cloudflare Durable Objects introduce the **WebSocket Hibernation API**:
1. When a browser connects to `/ws`, the worker creates a `WebSocketPair`.
2. The server end is passed to `this.ctx.acceptWebSocket(server)`.
3. Cloudflare's edge networking layer takes over the TCP connection.
4. **The Durable Object immediately goes to sleep.**
5. If the client sends a message or the workflow pushes an update, the Durable Object wakes up for only a few milliseconds to process `webSocketMessage()` or `broadcast()`, and then goes back to sleep.
6. Result: **0 billable CPU seconds while waiting for user interaction.**

---

## 6. Domainless Discord Ingestion & Cryptography

Rather than configuring custom MX records and email parsing servers, ClipMind provides instant mobile clipping via Discord:

1. **Security**: Discord requires all webhook endpoints to cryptographically verify incoming requests using **Ed25519**.
2. ClipMind implements `verifyDiscordSignature` using TweetNaCl:
   - Concatenates `X-Signature-Timestamp` + raw HTTP request body.
   - Verifies against `X-Signature-Ed25519` hex signature using the application's `DISCORD_PUBLIC_KEY`.
   - Any request with an invalid signature is immediately rejected with HTTP 401.
3. **Heartbeat Protocol**: When Discord registers the webhook, it sends `{ "type": 1 }` (PING). ClipMind immediately returns `{ "type": 1 }` (PONG).
4. **Instant Response**: Discord has a strict 3-second webhook timeout. When a user sends `/clip [url]`, ClipMind inserts the document as `pending`, dispatches the background workflow, and replies within 100ms with a deferred message: `"Clipping page to your vault..."`.
5. **Background Patch**: When the workflow completes 5–10 seconds later, it sends a `PATCH` request to Discord to update the message with the final title, reading time, and link preview.

---

## 7. Deep Dive: Every Code File & Its Purpose

### 1. [`wrangler.jsonc`](file:///home/sarwan/Code/cloudflare/ClipMind/wrangler.jsonc)
The declarative edge manifest:
- Binds D1 (`DB`), Vectorize (`VECTORIZE`), R2 (`BUCKET`), KV (`KV`), AI (`AI`), and Browser (`BROWSER`).
- Declares the `clip-pipeline-workflow` workflow class.
- Declares the `ProgressRoomDO` SQLite Durable Object class and migration tag `v1`.

### 2. [`migrations/0001_init.sql`](file:///home/sarwan/Code/cloudflare/ClipMind/migrations/0001_init.sql)
Relational database schema:
- `documents`: Primary record tracking URL, title, author, summary, R2 keys, word count, status (`pending`, `processing`, `indexed`, `failed`), and source (`web`, `discord`, `bookmarklet`).
- `chunks`: Stores chunk content, token counts, and unique `vector_id`s with `FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE`.
- `tags` & `document_tags`: Many-to-many tag relations.
- `idx_docs_status`, `idx_chunks_doc`, `idx_chunks_vector`: Prevents sequential table scans.

### 3. [`src/lib/chunker.ts`](file:///home/sarwan/Code/cloudflare/ClipMind/src/lib/chunker.ts)
- Implements `splitIntoSlidingWindows(text, 400, 40)`.
- Normalizes whitespace, calculates steps (`windowSize - overlap = 360 words`), and returns structured chunks with estimated token counts.

### 4. [`src/lib/discord-verify.ts`](file:///home/sarwan/Code/cloudflare/ClipMind/src/lib/discord-verify.ts)
- `hexToUint8Array`: Converts hexadecimal public keys and signatures to byte arrays.
- `verifyDiscordSignature`: Uses `nacl.sign.detached.verify` to validate Discord webhook payloads.

### 5. [`src/durable-objects/progress-room.ts`](file:///home/sarwan/Code/cloudflare/ClipMind/src/durable-objects/progress-room.ts)
- Extends Cloudflare's `DurableObject`.
- Accepts WebSocket upgrades via `this.ctx.acceptWebSocket(server)`.
- Implements `broadcast(payload)` to iterate through connected sockets.
- Stores subscriptions via `ws.serializeAttachment({ docId })`.

### 6. [`src/workflows/clip-pipeline.ts`](file:///home/sarwan/Code/cloudflare/ClipMind/src/workflows/clip-pipeline.ts)
- Extends Cloudflare's `WorkflowEntrypoint`.
- Organizes the 4 resilient steps (`step.do("extract-dom-and-capture")`, `step.do("archive-to-r2")`, `step.do("chunk-and-embed")`, `step.do("finalize-and-notify")`).
- Includes graceful fallback for environments where headless Chrome is unavailable.

### 7. [`src/routes/api/clip.ts`](file:///home/sarwan/Code/cloudflare/ClipMind/src/routes/api/clip.ts)
- `POST /api/clip`: Receives URLs from the Web Dashboard.
- `GET /api/clip?url=...`: Handles 1-click Browser Bookmarklet clicks and redirects back to the dashboard.

### 8. [`src/routes/api/discord.ts`](file:///home/sarwan/Code/cloudflare/ClipMind/src/routes/api/discord.ts)
- Handles incoming Discord interaction webhooks, verifies Ed25519 signatures, answers PINGs, parses `/clip` slash commands, and triggers the workflow.

### 9. [`src/routes/api/search.ts`](file:///home/sarwan/Code/cloudflare/ClipMind/src/routes/api/search.ts)
- Vector embedding + Vectorize search + D1 chunk join + Llama 3.2 3B Instruct RAG synthesis.

### 10. [`src/routes/api/raw.ts`](file:///home/sarwan/Code/cloudflare/ClipMind/src/routes/api/raw.ts)
- Streams Markdown snapshots (`/api/raw/snapshot/:id`) and WebP screenshots (`/api/raw/screenshot/:id`) directly from R2 with `Cache-Control: public, max-age=31536000, immutable`.

### 11. [`src/routes/ws.ts`](file:///home/sarwan/Code/cloudflare/ClipMind/src/routes/ws.ts)
- Routes incoming client WebSocket upgrade requests directly to the `ProgressRoomDO` singleton stub.

### 12. [`src/routes/index.tsx`](file:///home/sarwan/Code/cloudflare/ClipMind/src/routes/index.tsx)
- Server-Side Rendered (SSR) HTML dashboard.
- Includes quick-clip form, drag-and-drop bookmarklet link generator, RAG chat box, and responsive cards for every indexed document.

### 13. [`src/index.ts`](file:///home/sarwan/Code/cloudflare/ClipMind/src/index.ts)
- Hono root application mounting all routes.
- Exports `ProgressRoomDO` and `ClipPipelineWorkflow` so the Cloudflare runtime can discover and instantiate them.

---

## 8. Verification & Test Suite

The project includes 14 automated unit and integration tests executed with Vitest:
- [`tests/chunker.test.ts`](file:///home/sarwan/Code/cloudflare/ClipMind/tests/chunker.test.ts): Verifies 400-word sliding windows, overlap boundaries, and token estimates.
- [`tests/discord-verify.test.ts`](file:///home/sarwan/Code/cloudflare/ClipMind/tests/discord-verify.test.ts): Tests TweetNaCl cryptographic signing and rejection of tampered payloads.
- [`tests/routes.test.ts`](file:///home/sarwan/Code/cloudflare/ClipMind/tests/routes.test.ts): Mocks edge bindings and tests `/health`, `/api/discord`, `/api/clip`, and `/api/search`.

All tests pass cleanly:
```bash
pnpm test
# 14 passed (14)
```

And Wrangler dry-run compilation verifies zero bundling or binding errors:
```bash
pnpm build
# Total Upload: ~763 KiB, all 8 Cloudflare bindings attached
```
