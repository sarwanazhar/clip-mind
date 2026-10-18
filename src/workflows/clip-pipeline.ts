import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import { splitIntoSlidingWindows } from "../lib/chunker";
import { evaluateScrapedDocument, type JevDocumentEvaluation } from "../services/jev";
import type { ProgressPayload } from "../durable-objects/progress-room";

export interface ClipWorkflowParams {
  docId: string;
  url: string;
  source: "web" | "discord" | "bookmarklet";
  discordFollowupUrl?: string;
}

export interface WorkflowEnv {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  BUCKET: R2Bucket;
  KV: KVNamespace;
  AI: Ai;
  BROWSER: Fetcher;
  CLIP_WORKFLOW: Workflow;
  PROGRESS_DO: DurableObjectNamespace<import("../durable-objects/progress-room").ProgressRoomDO>;
  DISCORD_PUBLIC_KEY?: string;
}

/**
 * Cloudflare Workflow: Resilient Scrape, JEV-1.14.0 Evaluation, and Embedding Pipeline
 */
export class ClipPipelineWorkflow extends WorkflowEntrypoint<WorkflowEnv, ClipWorkflowParams> {
  async run(event: WorkflowEvent<ClipWorkflowParams>, step: WorkflowStep) {
    const { docId, url, source, discordFollowupUrl } = event.payload;

    // Helper to broadcast progress updates to Durable Object WebSocket hub
    const broadcastProgress = async (payload: ProgressPayload) => {
      try {
        const id = this.env.PROGRESS_DO.idFromName("global");
        const stub = this.env.PROGRESS_DO.get(id);
        await stub.fetch("http://do/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        console.warn("Progress DO broadcast notification failed:", err);
      }
    };

    // Step 1: KV Deduplication Check & DOM Extraction via Browser Rendering
    const extractedData = await step.do("extract-dom-and-capture", async () => {
      await broadcastProgress({
        type: "progress",
        docId,
        stage: "Scraping & DOM Extraction",
        percent: 15,
        status: "processing",
      });

      // Update document status in D1
      await this.env.DB.prepare("UPDATE documents SET status = 'processing' WHERE id = ?")
        .bind(docId)
        .run();

      // Check KV Cache to prevent redundant scraping of identical URLs
      const kvKey = `url_cache:${url}`;
      const cached = await this.env.KV.get<{
        title: string;
        author: string | null;
        summary: string | null;
        text: string;
        snapshotKey: string;
        screenshotKey: string;
      }>(kvKey, "json");

      if (cached) {
        return {
          title: cached.title,
          author: cached.author,
          summary: cached.summary,
          text: cached.text,
          snapshotKey: cached.snapshotKey,
          screenshotKey: cached.screenshotKey,
          isCached: true,
          screenshotBase64: null,
        };
      }

      let title = "";
      let author: string | null = null;
      let summary: string | null = null;
      let text = "";
      let screenshotBuffer: Uint8Array | null = null;

      // Launch headless Chrome via Puppeteer (or fallback if browser binding unavailable in test)
      try {
        if (this.env.BROWSER) {
          const browser = await puppeteer.launch(this.env.BROWSER);
          const page = await browser.newPage();
          await page.setViewport({ width: 1280, height: 720 });
          await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });

          // DOM Extraction: extract title, meta tags, and body text with infobox preservation
          const pageData = await page.evaluate(() => {
            const pageTitle = document.title || "";
            const pageAuthor =
              document.querySelector('meta[name="author"]')?.getAttribute("content") ||
              document.querySelector('meta[property="article:author"]')?.getAttribute("content") ||
              null;
            const pageSummary =
              document.querySelector('meta[name="description"]')?.getAttribute("content") ||
              document.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
              null;

            // 1. Extract Key Metadata Tables (Infoboxes, Quick Facts) before removing noise
            let infoboxMarkdown = "";
            const infoboxes = document.querySelectorAll(".infobox, .infobox_v2, table.metadata");
            const facts: string[] = [];
            infoboxes.forEach((box) => {
              const rows = box.querySelectorAll("tr");
              rows.forEach((tr) => {
                const th = tr.querySelector("th");
                const td = tr.querySelector("td");
                if (th && td) {
                  const key = (th.innerText || th.textContent || "").replace(/\s+/g, " ").trim();
                  const val = (td.innerText || td.textContent || "").replace(/\s+/g, " ").trim();
                  if (key && val && key.length < 60) {
                    facts.push(`- **${key}**: ${val}`);
                  }
                }
              });
            });

            if (facts.length > 0) {
              infoboxMarkdown = "## Quick Facts / Metadata\n" + facts.join("\n") + "\n\n";
            }

            // 2. Clone DOM and explicitly strip noisy boilerplate, navigation, sidebars & languages
            const clone = document.body.cloneNode(true) as HTMLElement;
            const noiseSelectors = [
              "nav", "header", "footer", "aside", "script", "style", "noscript",
              ".mw-jump-link", ".mw-editsection", "#mw-navigation", "#mw-panel",
              ".vector-header-container", ".vector-column-start", ".vector-column-end",
              ".vector-page-toolbar", ".p-lang-btn", ".interlanguage-link",
              '[role="navigation"]', ".sidebar", ".cookie-banner", "#catlinks", ".reflist",
              ".infobox", ".infobox_v2"
            ];
            noiseSelectors.forEach((sel) => {
              clone.querySelectorAll(sel).forEach((el: Element) => el.remove());
            });

            // 3. Clean text, strip Wikipedia citation brackets [1][2], and collapse whitespace
            const rawBody = clone.innerText || clone.textContent || "";
            const cleanBody = rawBody
              .replace(/\[\s*\d+\s*\]/g, "")
              .replace(/\s+/g, " ")
              .trim();

            const fullText = (infoboxMarkdown + cleanBody).trim();

            return {
              title: pageTitle.trim(),
              author: pageAuthor?.trim() || null,
              summary: pageSummary?.trim() || null,
              text: fullText,
            };
          });

          title = pageData.title || url;
          author = pageData.author;
          summary = pageData.summary;
          text = pageData.text;

          // Capture viewport screenshot buffer (1280x720)
          try {
            const shot = await page.screenshot({ type: "webp" });
            screenshotBuffer = new Uint8Array(shot);
          } catch {
            const shot = await page.screenshot({ type: "png" });
            screenshotBuffer = new Uint8Array(shot);
          }

          await browser.close();
        } else {
          throw new Error("env.BROWSER binding not present");
        }
      } catch (scrapeErr) {
        console.warn("Headless browser scrape failed, falling back to HTTP fetch:", scrapeErr);
        // Fallback HTTP extraction for dev / fallback environments
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; ClipMind/1.0; +https://clipmind.dev)" },
        });
        const html = await resp.text();

        // Simple regex-based meta and text extraction fallback
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        title = titleMatch ? titleMatch[1].trim() : url;
        const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
        summary = descMatch ? descMatch[1].trim() : null;
        text = html
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
          .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
          .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, "")
          .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
          .replace(/\[\s*\d+\s*\]/g, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      const snapshotKey = `snapshots/${docId}.md`;
      const screenshotKey = `screenshots/${docId}.webp`;

      return {
        title,
        author,
        summary,
        text,
        snapshotKey,
        screenshotKey,
        isCached: false,
        screenshotBase64: screenshotBuffer ? Buffer.from(screenshotBuffer).toString("base64") : null,
      };
    });

    // Step 2: Immutable R2 Archiving
    const markdownContent = `# ${extractedData.title}\n\n` +
      (extractedData.author ? `**Author:** ${extractedData.author}\n\n` : "") +
      `**Source URL:** ${url}\n` +
      `**Clipped Date:** ${new Date().toISOString()}\n\n` +
      `---\n\n` +
      (extractedData.summary ? `> ${extractedData.summary}\n\n` : "") +
      extractedData.text;

    await step.do("archive-to-r2", async () => {
      await broadcastProgress({
        type: "progress",
        docId,
        stage: "Archiving to R2 Storage",
        percent: 35,
        status: "processing",
      });

      if (!extractedData.isCached) {
        // Write raw markdown to snapshots/{id}.md
        await this.env.BUCKET.put(extractedData.snapshotKey, markdownContent, {
          httpMetadata: { contentType: "text/markdown; charset=utf-8" },
        });

        // Store screenshot if available
        if (extractedData.screenshotBase64) {
          const buf = Buffer.from(extractedData.screenshotBase64, "base64");
          await this.env.BUCKET.put(extractedData.screenshotKey, buf, {
            httpMetadata: { contentType: "image/webp" },
          });
        }
      }
    });

    // Step 2.5: TypeSafe JEV-1.14.0 Structured Evaluation & Quality Gatekeeper
    const jevEvaluationResult = await step.do("jev-structured-evaluation", async () => {
      await broadcastProgress({
        type: "progress",
        docId,
        step: "jev_eval",
        stage: "Running TypeSafe JEV-1.14.0 Evaluation",
        percent: 55,
        status: "processing",
        message: "Running TypeSafe JEV-1.14.0 structured state evaluation...",
      });

      const evaluation = await evaluateScrapedDocument(this.env, markdownContent, url);

      // Quality Gatekeeper: check if content is valid
      if (!evaluation.isValidContent) {
        const rejectionReason = evaluation.rejectionReason || "Page identified as an error page, captcha, or empty wall.";
        
        await this.env.DB.prepare(
          `UPDATE documents 
           SET status = 'rejected_by_jev', 
               rejection_reason = ?,
               category = ?,
               quality_score = 0.0,
               jev_verified = 0 
           WHERE id = ?`
        )
          .bind(rejectionReason, evaluation.category, docId)
          .run();

        // Broadcast rejection to ProgressRoomDO
        await broadcastProgress({
          type: "error",
          docId,
          step: "jev_eval",
          stage: "Rejected by JEV Quality Guardrail",
          percent: 100,
          status: "rejected_by_jev",
          error: rejectionReason,
        });

        // Post Discord rejection notification if applicable
        if (source === "discord" && discordFollowupUrl) {
          try {
            await fetch(discordFollowupUrl, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: `❌ **Clip Rejected by TypeSafe JEV-1.14.0 Quality Guardrail**\nReason: *${rejectionReason}*\n🔗 Source: <${url}>`,
              }),
            });
          } catch (discErr) {
            console.error("Failed to post Discord rejection followup:", discErr);
          }
        }

        return { rejected: true, evaluation };
      }

      // Auto-Enrichment: save category, quality_score, tldr_json, and jev_verified
      await this.env.DB.prepare(
        `UPDATE documents 
         SET category = ?,
             quality_score = ?,
             tldr_json = ?,
             jev_verified = 1
         WHERE id = ?`
      )
        .bind(
          evaluation.category,
          evaluation.informationDensityScore,
          JSON.stringify(evaluation.tldrBullets),
          docId
        )
        .run();

      // Automatically upsert evaluation.autoTags into tags and document_tags
      for (const tag of evaluation.autoTags) {
        const tagId = `tag_${tag}`;
        await this.env.DB.prepare("INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)")
          .bind(tagId, tag)
          .run();

        await this.env.DB.prepare("INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)")
          .bind(docId, tagId)
          .run();
      }

      return { rejected: false, evaluation };
    });

    // Abort pipeline if page was rejected by JEV
    if (jevEvaluationResult.rejected) {
      return;
    }

    const { evaluation } = jevEvaluationResult;

    // Step 3: Sliding Chunking & Workers AI Embeddings
    const chunkCount = await step.do("chunk-and-embed", async () => {
      await broadcastProgress({
        type: "progress",
        docId,
        stage: "Generating Vector Embeddings",
        percent: 75,
        status: "processing",
      });

      // Step 3.1: Ingestion Deduplication: Purge old chunks and vector IDs for this document
      const { results: oldChunks } = await this.env.DB.prepare(
        "SELECT vector_id FROM chunks WHERE document_id = ?"
      )
        .bind(docId)
        .all<{ vector_id: string }>();

      if (oldChunks && oldChunks.length > 0) {
        const oldVectorIds = oldChunks.map((r) => r.vector_id).filter(Boolean);
        if (oldVectorIds.length > 0) {
          try {
            await this.env.VECTORIZE.deleteByIds(oldVectorIds);
          } catch (delErr) {
            console.warn("Vectorize old vector deletion warning:", delErr);
          }
        }
        await this.env.DB.prepare("DELETE FROM chunks WHERE document_id = ?").bind(docId).run();
      }

      // Step 3.2: Split into 400-word sliding windows with 40-word overlap
      const chunks = splitIntoSlidingWindows(extractedData.text, 400, 40);

      // Embed each chunk with @cf/baai/bge-small-en-v1.5 and upsert to Vectorize
      for (const chunk of chunks) {
        const vectorId = `${docId}_chunk_${chunk.chunkIndex}`;
        const chunkDbId = `${docId}_c${chunk.chunkIndex}`;

        let embedding: number[] = [];
        try {
          const aiResponse = (await this.env.AI.run("@cf/baai/bge-small-en-v1.5", {
            text: [chunk.content],
          })) as { shape?: number[]; data: number[][] };

          if (aiResponse && aiResponse.data && aiResponse.data[0]) {
            embedding = aiResponse.data[0];
          }
        } catch (aiErr) {
          console.warn("AI embedding call fallback:", aiErr);
          // In mock environments or AI fallback, generate 384-dim array
          embedding = new Array(384).fill(0.001);
        }

        // Upsert vector into Vectorize index (384-dimensions)
        if (embedding.length === 384) {
          await this.env.VECTORIZE.upsert([
            {
              id: vectorId,
              values: embedding,
              metadata: {
                document_id: docId,
                chunk_index: chunk.chunkIndex,
                title: extractedData.title,
                url,
                category: evaluation.category,
              },
            },
          ]);
        }

        // Insert chunk into D1 relational table
        await this.env.DB.prepare(
          `INSERT OR REPLACE INTO chunks (id, document_id, chunk_index, content, token_count, vector_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
          .bind(chunkDbId, docId, chunk.chunkIndex, chunk.content, chunk.tokenCount, vectorId)
          .run();
      }

      return chunks.length;
    });

    // Step 4: Real-Time Broadcast & Finalize
    await step.do("finalize-and-notify", async () => {
      const words = extractedData.text.split(/\s+/).filter(Boolean).length;

      // Update D1 document state to 'indexed'
      await this.env.DB.prepare(
        `UPDATE documents 
         SET status = 'indexed',
             title = ?,
             author = ?,
             summary = ?,
             r2_snapshot_key = ?,
             r2_screenshot_key = ?,
             word_count = ?
         WHERE id = ?`
      )
        .bind(
          extractedData.title,
          extractedData.author,
          extractedData.summary,
          extractedData.snapshotKey,
          extractedData.screenshotKey,
          words,
          docId
        )
        .run();

      // Write to KV Cache for URL deduplication (TTL: 7 days)
      await this.env.KV.put(
        `url_cache:${url}`,
        JSON.stringify({
          title: extractedData.title,
          author: extractedData.author,
          summary: extractedData.summary,
          text: extractedData.text,
          snapshotKey: extractedData.snapshotKey,
          screenshotKey: extractedData.screenshotKey,
          category: evaluation.category,
          qualityScore: evaluation.informationDensityScore,
        }),
        { expirationTtl: 604800 }
      );

      // Real-time broadcast completion payload to Durable Object WebSocket hub
      await broadcastProgress({
        type: "complete",
        docId,
        stage: "Indexed & Ready",
        percent: 100,
        status: "indexed",
        data: {
          title: extractedData.title,
          wordCount: words,
          chunksIndexed: chunkCount,
          category: evaluation.category,
          qualityScore: evaluation.informationDensityScore,
          autoTags: evaluation.autoTags,
          tldrBullets: evaluation.tldrBullets,
        },
      });

      // Post Asynchronous Followup to Discord if applicable
      if (source === "discord" && discordFollowupUrl) {
        try {
          const readingTimeMin = Math.max(1, Math.ceil(words / 200));
          const tagsFormatted = evaluation.autoTags.map((t) => `#${t}`).join(" ");
          const bulletsFormatted = evaluation.tldrBullets.map((b) => `• ${b}`).join("\n");

          await fetch(discordFollowupUrl, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `✅ **ClipMind Vault Updated • TypeSafe JEV Verified**\n**${extractedData.title}**\n📁 Category: \`${evaluation.category}\` | ⚡ Density: \`${(evaluation.informationDensityScore * 100).toFixed(0)}%\`\n🏷️ Tags: ${tagsFormatted}\n📖 Reading Time: ~${readingTimeMin} min (${words} words, ${chunkCount} vector chunks)\n\n📌 **Key Takeaways (JEV-1.14.0):**\n${bulletsFormatted}\n\n🔗 Source: <${url}>`,
            }),
          });
        } catch (discErr) {
          console.error("Failed to post Discord webhook followup:", discErr);
        }
      }
    });
  }
}
