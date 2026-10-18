import { Hono } from "hono";
import type { WorkflowEnv } from "../../workflows/clip-pipeline";

export const rawApi = new Hono<{ Bindings: WorkflowEnv }>();

rawApi.get("/:type/:id", async (c) => {
  const type = c.req.param("type");
  const id = c.req.param("id");

  let key: string;
  let contentType: string;

  if (type === "snapshot") {
    key = `snapshots/${id}.md`;
    contentType = "text/markdown; charset=utf-8";
  } else if (type === "screenshot") {
    key = `screenshots/${id}.webp`;
    contentType = "image/webp";
  } else {
    return c.text("Invalid asset type", 400);
  }

  const object = await c.env.BUCKET.get(key);
  if (!object) {
    return c.text("Asset not found", 404);
  }

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", object.httpEtag);

  return new Response(object.body, { headers });
});
