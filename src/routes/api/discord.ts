import { Hono } from "hono";
import { verifyDiscordSignature } from "../../lib/discord-verify";
import type { WorkflowEnv } from "../../workflows/clip-pipeline";

export const discordApi = new Hono<{ Bindings: WorkflowEnv }>();

discordApi.post("/", async (c) => {
  const signature = c.req.header("X-Signature-Ed25519");
  const timestamp = c.req.header("X-Signature-Timestamp");
  const rawBody = await c.req.text();

  // 1. Cryptographic Signature Verification
  // In production, DISCORD_PUBLIC_KEY must be configured
  const publicKey = c.env.DISCORD_PUBLIC_KEY;
  if (publicKey) {
    const isValid = verifyDiscordSignature(publicKey, signature || null, timestamp || null, rawBody);
    if (!isValid) {
      return c.text("Invalid request signature", 401);
    }
  }

  let payload: Record<string, any>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  // 2. Discord PING-PONG Heartbeat Check
  if (payload.type === 1) {
    return c.json({ type: 1 });
  }

  // 3. Extract Target URL from Slash Command or Message Body
  let targetUrl: string | null = null;

  // Slash command /clip [url]
  if (payload.type === 2 && payload.data?.options) {
    const urlOpt = payload.data.options.find((opt: { name: string; value: string }) =>
      ["url", "link", "target"].includes(opt.name)
    ) || payload.data.options[0];
    if (urlOpt?.value && typeof urlOpt.value === "string") {
      targetUrl = urlOpt.value.trim();
    }
  }

  // Fallback: extract first URL from content or raw body
  if (!targetUrl && payload.content) {
    const match = payload.content.match(/https?:\/\/[^\s>]+/);
    if (match) targetUrl = match[0];
  }

  if (!targetUrl) {
    return c.json({
      type: 4,
      data: {
        content: "⚠️ No valid URL detected. Use `/clip url:<link>` to clip an article into your vault.",
      },
    });
  }

  const docId = crypto.randomUUID();
  const createdAt = Date.now();

  // Insert pending record into D1
  await c.env.DB.prepare(
    `INSERT INTO documents (id, url, source, created_at, status)
     VALUES (?, ?, 'discord', ?, 'pending')`
  )
    .bind(docId, targetUrl, createdAt)
    .run();

  // Construct Discord Followup Patch URL if application_id and token exist
  let discordFollowupUrl: string | undefined;
  if (payload.application_id && payload.token) {
    discordFollowupUrl = `https://discord.com/api/v10/webhooks/${payload.application_id}/${payload.token}/messages/@original`;
  }

  // Dispatch durable workflow
  await c.env.CLIP_WORKFLOW.create({
    params: {
      docId,
      url: targetUrl,
      source: "discord",
      discordFollowupUrl,
    },
  });

  // Return immediate message as specified
  return c.json({
    type: 4,
    data: {
      content: `🔍 Clipping page to your vault: <${targetUrl}>...\nYou will receive a notification once indexed.`,
    },
  });
});
