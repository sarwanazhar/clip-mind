import { DurableObject } from "cloudflare:workers";

export interface ProgressPayload {
  type: "progress" | "complete" | "error";
  docId: string;
  stage?: string;
  percent?: number;
  status?: string;
  error?: string;
  step?: string;
  message?: string;
  data?: unknown;
}

/**
 * ProgressRoomDO provides a zero-cost WebSocket hibernation broadcast hub.
 * Using this.ctx.acceptWebSocket(ws) and the webSocketMessage handlers guarantees
 * 0 active CPU billable seconds when no messages are in-flight.
 */
export class ProgressRoomDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 1. WebSocket Upgrade handling
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Cloudflare WebSocket Hibernation API
      this.ctx.acceptWebSocket(server);

      // Return client side of the pair
      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    // 2. Internal HTTP Broadcast endpoint called by Workflow
    if (request.method === "POST" && url.pathname === "/broadcast") {
      const payload = (await request.json()) as ProgressPayload;
      this.broadcast(payload);
      return new Response(JSON.stringify({ success: true, clients: this.ctx.getWebSockets().length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  /**
   * Hibernation API message handler
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      const data = JSON.parse(text);

      if (data.type === "subscribe" && data.docId) {
        ws.serializeAttachment({ docId: data.docId });
        ws.send(JSON.stringify({ type: "subscribed", docId: data.docId }));
      } else if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", time: Date.now() }));
      }
    } catch (e) {
      console.error("Error in DO webSocketMessage:", e);
    }
  }

  /**
   * Hibernation API close handler
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    try {
      ws.close(code, reason);
    } catch {
      // socket might already be closed
    }
  }

  /**
   * Hibernation API error handler
   */
  async webSocketError(ws: WebSocket, error: unknown) {
    console.error("WebSocket Hibernation error:", error);
  }

  /**
   * Broadcasts payload to all currently connected hibernation sockets
   */
  broadcast(payload: ProgressPayload) {
    const message = JSON.stringify(payload);
    const sockets = this.ctx.getWebSockets();

    for (const ws of sockets) {
      try {
        const attachment = ws.deserializeAttachment() as { docId?: string } | null;
        // If client is subscribed to a specific docId, only send if matched or broadcast-all
        if (!attachment || !attachment.docId || attachment.docId === payload.docId) {
          ws.send(message);
        }
      } catch (err) {
        console.error("Error sending to websocket client:", err);
      }
    }
  }
}
