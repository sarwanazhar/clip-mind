import { Hono } from "hono";
import type { WorkflowEnv } from "../../workflows/clip-pipeline";

export const clipApi = new Hono<{ Bindings: WorkflowEnv }>();

clipApi.post("/", async (c) => {
  try {
    let url: string | undefined;
    let source: "web" | "bookmarklet" = "web";

    const contentType = c.req.header("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await c.req.json();
      url = body.url;
      if (body.source === "bookmarklet") source = "bookmarklet";
    } else {
      const body = await c.req.parseBody();
      url = body.url as string;
      if (body.source === "bookmarklet") source = "bookmarklet";
    }

    if (!url || typeof url !== "string") {
      return c.json({ error: "Missing required 'url' parameter" }, 400);
    }

    // Validate URL protocol
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return c.json({ error: "Only HTTP and HTTPS URLs are supported" }, 400);
      }
    } catch {
      return c.json({ error: "Invalid URL string provided" }, 400);
    }

    const docId = crypto.randomUUID();
    const createdAt = Date.now();

    // Insert pending document record in D1
    await c.env.DB.prepare(
      `INSERT INTO documents (id, url, source, created_at, status)
       VALUES (?, ?, ?, ?, 'pending')`
    )
      .bind(docId, parsedUrl.toString(), source, createdAt)
      .run();

    // Dispatch durable scrape-and-embed workflow
    const instance = await c.env.CLIP_WORKFLOW.create({
      params: {
        docId,
        url: parsedUrl.toString(),
        source,
      },
    });

    return c.json({
      success: true,
      docId,
      status: "pending",
      workflowId: instance.id,
      wsRoom: "global",
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Clip API error:", err);
    return c.json({ error: errorMsg }, 500);
  }
});

// Bookmarklet GET trigger support (e.g. window.open(/api/clip?url=...))
clipApi.get("/", async (c) => {
  const url = c.req.query("url");
  if (!url) {
    return c.text("Missing 'url' query parameter", 400);
  }

  try {
    new URL(url);
  } catch {
    return c.text("Invalid URL parameter", 400);
  }

  const docId = crypto.randomUUID();
  const createdAt = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO documents (id, url, source, created_at, status)
     VALUES (?, ?, 'bookmarklet', ?, 'pending')`
  )
    .bind(docId, url, createdAt)
    .run();

  await c.env.CLIP_WORKFLOW.create({
    params: {
      docId,
      url,
      source: "bookmarklet",
    },
  });

  return c.redirect(`/?clipped=${docId}`);
});

// Delete document across D1, Vectorize, R2, and KV
clipApi.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "Missing document id" }, 400);
  }

  try {
    // 1. Fetch document metadata
    const doc = await c.env.DB.prepare(
      "SELECT id, url, r2_snapshot_key, r2_screenshot_key FROM documents WHERE id = ?"
    )
      .bind(id)
      .first<{ id: string; url: string; r2_snapshot_key: string | null; r2_screenshot_key: string | null }>();

    if (!doc) {
      return c.json({ error: "Document not found" }, 404);
    }

    // 2. Fetch associated vector IDs
    const { results: chunkRows } = await c.env.DB.prepare(
      "SELECT vector_id FROM chunks WHERE document_id = ?"
    )
      .bind(id)
      .all<{ vector_id: string }>();

    const vectorIds = (chunkRows || []).map((r) => r.vector_id).filter(Boolean);

    // 3. Purge vectors from Cloudflare Vectorize
    if (vectorIds.length > 0 && c.env.VECTORIZE) {
      try {
        await c.env.VECTORIZE.deleteByIds(vectorIds);
      } catch (vErr) {
        console.warn("Vectorize delete warning:", vErr);
      }
    }

    // 4. Purge Markdown snapshot and WebP screenshot from R2 Bucket
    if (c.env.BUCKET) {
      try {
        if (doc.r2_snapshot_key) await c.env.BUCKET.delete(doc.r2_snapshot_key);
        if (doc.r2_screenshot_key) await c.env.BUCKET.delete(doc.r2_screenshot_key);
        await c.env.BUCKET.delete(`snapshots/${id}.md`);
        await c.env.BUCKET.delete(`screenshots/${id}.webp`);
      } catch (r2Err) {
        console.warn("R2 delete warning:", r2Err);
      }
    }

    // 5. Invalidate KV URL cache
    if (c.env.KV && doc.url) {
      try {
        await c.env.KV.delete(`url_cache:${doc.url}`);
      } catch (kvErr) {
        console.warn("KV delete warning:", kvErr);
      }
    }

    // 6. Delete master document row (foreign key cascading cleans chunks & document_tags)
    await c.env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();

    return c.json({
      success: true,
      id,
      purgedVectors: vectorIds.length,
      message: "Document, chunks, embeddings, and R2 assets successfully purged from vault.",
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Delete document error:", err);
    return c.json({ error: errorMsg }, 500);
  }
});

