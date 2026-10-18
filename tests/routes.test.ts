import { describe, it, expect } from "vitest";
import app from "../src/index";

describe("ClipMind Hono Route Handlers", () => {
  const mockEnv: any = {
    DB: {
      prepare: () => ({
        bind: () => ({
          run: async () => ({ success: true }),
          all: async () => ({ results: [] }),
        }),
        all: async () => ({ results: [] }),
      }),
    },
    CLIP_WORKFLOW: {
      create: async () => ({ id: "mock-workflow-instance-123" }),
    },
    PROGRESS_DO: {
      idFromName: () => "mock-do-id",
      get: () => ({
        fetch: async () => new Response(null, { status: 101 }),
      }),
    },
  };

  it("GET /health should return 200 with service metadata", async () => {
    const res = await app.fetch(new Request("http://localhost/health"), mockEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; tier: string };
    expect(body.status).toBe("healthy");
    expect(body.tier).toBe("100% Free Tier");
  });

  it("GET / should render SSR Dashboard HTML", async () => {
    const res = await app.fetch(new Request("http://localhost/"), mockEnv);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("ClipMind");
    expect(text).toContain("Cloudflare-Native Edge Web Clipper & Knowledge Vault");
    expect(text).toContain("Browser Bookmarklet");
  });

  it("POST /api/discord should return type: 1 for Discord heartbeat ping", async () => {
    const req = new Request("http://localhost/api/discord", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: 1 }),
    });

    const res = await app.fetch(req, mockEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: number };
    expect(body.type).toBe(1);
  });

  it("POST /api/clip should reject requests without a URL", async () => {
    const req = new Request("http://localhost/api/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await app.fetch(req, mockEnv);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Missing required 'url' parameter");
  });

  it("POST /api/clip should accept valid HTTP/HTTPS URLs and dispatch workflow", async () => {
    const req = new Request("http://localhost/api/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://blog.cloudflare.com/workers-ai", source: "web" }),
    });

    const res = await app.fetch(req, mockEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; docId: string; workflowId: string };
    expect(body.success).toBe(true);
    expect(body.docId).toBeDefined();
    expect(body.workflowId).toBe("mock-workflow-instance-123");
  });

  it("POST /api/search should reject missing query", async () => {
    const req = new Request("http://localhost/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await app.fetch(req, mockEnv);
    expect(res.status).toBe(400);
  });

  it("DELETE /api/clip/:id should delete document and return 200", async () => {
    const deleteEnv: any = {
      ...mockEnv,
      DB: {
        prepare: (query: string) => ({
          bind: () => ({
            first: async () => ({
              id: "test-doc-123",
              url: "https://example.com",
              r2_snapshot_key: "snapshots/test-doc-123.md",
              r2_screenshot_key: "screenshots/test-doc-123.webp",
            }),
            all: async () => ({ results: [{ vector_id: "test-doc-123_chunk_0" }] }),
            run: async () => ({ success: true }),
          }),
        }),
      },
      VECTORIZE: {
        deleteByIds: async () => ({ count: 1 }),
      },
      BUCKET: {
        delete: async () => {},
      },
      KV: {
        delete: async () => {},
      },
    };

    const req = new Request("http://localhost/api/clip/test-doc-123", {
      method: "DELETE",
    });

    const res = await app.fetch(req, deleteEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; id: string };
    expect(body.success).toBe(true);
    expect(body.id).toBe("test-doc-123");
  });
});

