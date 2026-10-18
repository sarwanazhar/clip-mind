import { Hono } from "hono";
import { dashboardRoute } from "./routes/index";
import { clipApi } from "./routes/api/clip";
import { discordApi } from "./routes/api/discord";
import { searchApi } from "./routes/api/search";
import { rawApi } from "./routes/api/raw";
import { wsRoute } from "./routes/ws";
import type { WorkflowEnv } from "./workflows/clip-pipeline";

// Re-export Durable Objects & Workflows as required by Cloudflare Worker runtime
export { ProgressRoomDO } from "./durable-objects/progress-room";
export { ClipPipelineWorkflow } from "./workflows/clip-pipeline";

const app = new Hono<{ Bindings: WorkflowEnv }>();

// Mount routes
app.route("/", dashboardRoute);
app.route("/api/clip", clipApi);
app.route("/api/discord", discordApi);
app.route("/api/search", searchApi);
app.route("/api/raw", rawApi);
app.route("/ws", wsRoute);

// Global healthcheck
app.get("/health", (c) => {
  return c.json({
    status: "healthy",
    service: "ClipMind",
    version: "1.0.0",
    tier: "100% Free Tier",
    time: new Date().toISOString(),
  });
});

export default app;
