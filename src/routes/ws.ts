import { Hono } from "hono";
import type { WorkflowEnv } from "../workflows/clip-pipeline";

export const wsRoute = new Hono<{ Bindings: WorkflowEnv }>();

wsRoute.get("/", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.text("Expected WebSocket upgrade request", 426);
  }

  // Obtain singleton global progress room Durable Object
  const id = c.env.PROGRESS_DO.idFromName("global");
  const stub = c.env.PROGRESS_DO.get(id);

  // Forward incoming WebSocket upgrade request to the Durable Object
  return stub.fetch(c.req.raw);
});
