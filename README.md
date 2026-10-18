# ClipMind

> **Cloudflare-Native Edge Web Clipper, RAG Vault & Discord Ingestion Agent**  
> Runtime: Hono + Cloudflare Workers | 100% Free Tier ($0/mo)

---

## Architecture Overview

ClipMind is an edge-native web clipper, document archiver, and semantic knowledge retrieval vault built completely on Cloudflare Free Tier primitives with zero external SDK dependencies (no OpenAI, LangChain, Pinecone, or AWS S3 clients).

- **Edge Routing & SSR UI**: [Hono](https://hono.dev) running on Cloudflare Workers with server-rendered dashboard, live progress bars, and RAG search.
- **Durable Scrape-and-Embed Pipeline**: [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) (`ClipPipelineWorkflow`) orchestrating 4-stage ingestion decoupled from HTTP timeouts.
- **Headless Chrome DOM Extraction**: `@cloudflare/puppeteer` bypassing client-side hydration, capturing 1280x720 viewport snapshots, and deduping via KV cache.
- **Immutable Storage**: Cloudflare R2 bucket (`clipmind-vault`) storing raw Markdown snapshots (`snapshots/{id}.md`) and WebP screenshots (`screenshots/{id}.webp`).
- **Sliding Chunking & Workers AI**: Text splitter into 400-word windows with 40-word overlap, embedded with `@cf/baai/bge-small-en-v1.5` into 384-dimension vectors.
- **Vector Database**: Cloudflare Vectorize (`clipmind-embeddings`) indexed with cosine similarity for sub-second retrieval.
- **Relational Storage**: Cloudflare D1 (`clipmind-db`) tracking documents, chunk mappings, cascade deletions, and index strategies.
- **Edge RAG Synthesis**: Matched chunks queried from D1 and synthesized via `@cf/meta/llama-3.2-3b-instruct` with strict citation guardrails.
- **Zero-Cost WebSocket Hub**: Durable Objects (`ProgressRoomDO`) utilizing the WebSocket Hibernation API (`this.ctx.acceptWebSocket`) for real-time progress broadcast with 0 GB-s idle cost.
- **Domainless Discord Ingestion**: `POST /api/discord` endpoint verifying Ed25519 signatures with TweetNaCl, handling PING-PONG heartbeats, and dispatching `/clip` workflows.

---

## Directory Structure

```
clipmind/
├── wrangler.jsonc                  # Edge bindings: D1, R2, Vectorize, KV, AI, Browser, Workflows, Durable Objects
├── package.json                    # Dependencies & pnpm configuration
├── tsconfig.json                   # TypeScript compiler configuration with DOM lib & Workers types
├── vitest.config.ts                # Unit and integration test runner
├── migrations/
│   └── 0001_init.sql               # D1 relational schema and indexes
├── src/
│   ├── index.ts                    # Hono app entrypoint, DO & Workflow exports
│   ├── routes/
│   │   ├── index.tsx               # SSR Vault Dashboard, Ingestion & Live Search UI
│   │   ├── ws.ts                   # WebSocket upgrade route forwarding to DO
│   │   └── api/
│   │       ├── clip.ts             # Web UI & Bookmarklet ingestion API
│   │       ├── discord.ts          # Discord Ed25519 webhook & slash command
│   │       ├── search.ts           # Semantic vector search & Edge RAG query
│   │       └── raw.ts              # R2 asset streaming
│   ├── workflows/
│   │   └── clip-pipeline.ts        # 4-stage durable workflow
│   ├── durable-objects/
│   │   └── progress-room.ts        # WebSocket Hibernation broadcast hub
│   └── lib/
│       ├── chunker.ts              # 400-word sliding window chunker
│       └── discord-verify.ts       # Ed25519 signature validator
└── tests/
    ├── chunker.test.ts             # Chunker unit tests
    ├── discord-verify.test.ts      # Discord Ed25519 verification tests
    └── routes.test.ts              # Hono route integration tests
```

---

## Getting Started

### 1. Installation

This project uses `pnpm` exclusively:

```bash
pnpm install
```

### 2. Local D1 Database Migration

Apply the SQLite relational schema and indexes to your local D1 state:

```bash
pnpm db:migrate:local
```

### 3. Run Tests

Execute the Vitest suite:

```bash
pnpm test
```

### 4. Local Development

Start the local Worker development server:

```bash
pnpm dev
```

Visit `http://localhost:8787` to access the ClipMind Vault Dashboard.

### 5. Deployment to Cloudflare

1. Create Cloudflare resources:
   ```bash
   pnpm wrangler d1 create clipmind-db
   pnpm wrangler r2 bucket create clipmind-vault
   pnpm wrangler vectorize create clipmind-embeddings --dimensions=384 --metric=cosine
   pnpm wrangler kv:namespace create KV
   ```
2. Update the resource IDs in `wrangler.jsonc`.
3. Apply migrations remotely:
   ```bash
   pnpm wrangler d1 execute clipmind-db --remote --file=./migrations/0001_init.sql
   ```
4. Deploy the Worker:
   ```bash
   pnpm deploy
   ```

---

## Discord Bot Integration

1. In the Discord Developer Portal, set **Interactions Endpoint URL** to:
   `https://<your-worker>.<your-subdomain>.workers.dev/api/discord`
2. Add your application's Public Key as a secret:
   ```bash
   pnpm wrangler secret put DISCORD_PUBLIC_KEY
   ```
3. Register the `/clip [url]` slash command in your Discord server.
