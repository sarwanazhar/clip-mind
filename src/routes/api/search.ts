import { Hono } from "hono";
import { evaluateRagGroundedness } from "../../services/jev";
import type { WorkflowEnv } from "../../workflows/clip-pipeline";

export const searchApi = new Hono<{ Bindings: WorkflowEnv }>();

// Candidate synthesis models prioritizing strict adherence models
const SYNTHESIS_MODEL_CANDIDATES = [
  "@cf/meta/llama-3.1-8b-instruct-fast",
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.2-3b-instruct",
];

/**
 * Calculates word-level Jaccard similarity between two chunk strings.
 */
function calculateJaccardSimilarity(str1: string, str2: string): number {
  const words1 = new Set(str1.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const words2 = new Set(str2.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (words1.size === 0 || words2.size === 0) return 0;

  let intersection = 0;
  for (const w of words1) {
    if (words2.has(w)) intersection++;
  }
  const union = words1.size + words2.size - intersection;
  return intersection / union;
}

searchApi.post("/", async (c) => {
  try {
    const { query, topK = 5 } = await c.req.json<{ query: string; topK?: number }>();

    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return c.json({ error: "Missing required 'query' parameter" }, 400);
    }

    const normalizedQuery = query.trim().toLowerCase();
    const kvCacheKey = `rag_cache:${normalizedQuery}`;

    // Zero-Cost KV Exact Prompt/Query Cache Check
    if (c.env.KV) {
      try {
        const cached = await c.env.KV.get<{
          query: string;
          answer: string;
          autoCorrected: boolean;
          citations: any[];
          jevEvaluation: any;
        }>(kvCacheKey, "json");

        if (cached) {
          return c.json({ ...cached, cached: true });
        }
      } catch (kvErr) {
        console.warn("KV query cache lookup warning:", kvErr);
      }
    }

    // 1. Generate 384-dim Query Embedding using @cf/baai/bge-small-en-v1.5
    let queryEmbedding: number[] = [];
    try {
      const aiResponse = (await c.env.AI.run("@cf/baai/bge-small-en-v1.5", {
        text: [query.trim()],
      })) as { shape?: number[]; data: number[][] };

      if (aiResponse && aiResponse.data && aiResponse.data[0]) {
        queryEmbedding = aiResponse.data[0];
      }
    } catch (aiErr) {
      console.warn("AI query embedding error:", aiErr);
      // Fallback 384-dim array in mock/dev environments without active AI binding
      queryEmbedding = new Array(384).fill(0.001);
    }

    if (queryEmbedding.length !== 384) {
      return c.json({ error: "Failed to generate 384-dimension embedding for query" }, 500);
    }

    // 2. Vector Similarity Search against Cloudflare Vectorize
    let vectorMatches: any[] = [];
    try {
      const results = await c.env.VECTORIZE.query(queryEmbedding, {
        topK: Math.min(topK * 2, 12), // Fetch extra candidate chunks for deduplication
        returnMetadata: "all",
      });
      vectorMatches = results.matches || [];
    } catch (vecErr) {
      console.warn("Vectorize query warning:", vecErr);
    }

    if (vectorMatches.length === 0) {
      return c.json({
        query,
        answer: "No relevant documents found in your ClipMind knowledge vault for this query.",
        autoCorrected: false,
        citations: [],
        jevEvaluation: {
          isGrounded: false,
          confidenceScore: 0.0,
          supportedChunkIndices: [],
          hallucinationWarning: "No documents found in knowledge vault.",
        },
      });
    }

    // 3. Retrieve text chunks and document metadata from D1
    const vectorIds = vectorMatches.map((m) => m.id);
    const placeholders = vectorIds.map(() => "?").join(",");

    const { results: rawChunks } = await c.env.DB.prepare(
      `SELECT c.id as chunk_id, c.chunk_index, c.content, c.vector_id,
              d.id as doc_id, d.title, d.url, d.author, d.word_count
       FROM chunks c
       JOIN documents d ON c.document_id = d.id
       WHERE c.vector_id IN (${placeholders})`
    )
      .bind(...vectorIds)
      .all<{
        chunk_id: string;
        chunk_index: number;
        content: string;
        vector_id: string;
        doc_id: string;
        title: string;
        url: string;
        author: string | null;
        word_count: number;
      }>();

    // Map chunk details with similarity scores
    const rawCitations = (rawChunks || []).map((chunk) => {
      const match = vectorMatches.find((m) => m.id === chunk.vector_id);
      return {
        docId: chunk.doc_id,
        title: chunk.title || "Untitled",
        url: chunk.url,
        score: match ? match.score : 0,
        content: chunk.content,
        chunkIndex: chunk.chunk_index,
      };
    });

    // 4. Retrieval Deduplication: filter out identical or >80% overlapping chunks
    const deduplicatedCitations: typeof rawCitations = [];
    for (const candidate of rawCitations) {
      const isDuplicate = deduplicatedCitations.some((existing) => {
        if (candidate.content.trim() === existing.content.trim()) return true;
        const sim = calculateJaccardSimilarity(candidate.content, existing.content);
        return sim > 0.8;
      });

      if (!isDuplicate) {
        deduplicatedCitations.push(candidate);
        if (deduplicatedCitations.length >= topK) break;
      }
    }

    // 5. Construct Clean XML Context for Closed-Book Extractive Synthesis
    const xmlSources = deduplicatedCitations
      .map(
        (c, idx) =>
          `  <source id="${idx + 1}" title="${c.title}" url="${c.url}">\n${c.content}\n  </source>`
      )
      .join("\n\n");

    const systemPrompt = `You are a strict, closed-book extractive research assistant.
CRITICAL RULES:
1. FORGET ALL PRIOR KNOWLEDGE. You know NOTHING about the world, people, dates, or software outside of the verbatim text inside <sources>.
2. Every single claim, name, or date you state MUST literally appear word-for-word inside the specific <source id="X"> you cite.
3. NEVER state a fact from your own memory and attach a quote that does not contain that exact fact. Before writing "According to Source X: [quote]", verify that the quote itself literally contains the answer!
4. If a piece of information (such as an author name or release date) is NOT explicitly written in the <sources>, you MUST explicitly write: "The provided sources do not mention [X]."`;

    const userPrompt = `<sources>\n${xmlSources}\n</sources>\n\nQuestion: ${query}\n\nProvide a concise, factual answer strictly citing the sources above (e.g. [Source 1]):`;

    // 6. Query Synthesis Model with Deterministic Sampling (temperature: 0.0, top_p: 0.1)
    let synthesis = "";
    for (const model of SYNTHESIS_MODEL_CANDIDATES) {
      try {
        const completion = (await c.env.AI.run(model as any, {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 512,
          temperature: 0.0,
          top_p: 0.1,
        })) as { response?: string };

        if (completion && typeof completion.response === "string") {
          synthesis = completion.response.trim();
          break;
        }
      } catch (err) {
        console.warn(`Model ${model} synthesis failed, trying next candidate:`, err);
        continue;
      }
    }

    if (!synthesis) {
      synthesis = `Found ${deduplicatedCitations.length} relevant excerpts from your vault. (LLM synthesis unavailable).`;
    }

    // 7. Active Self-Correction Gate via TypeSafe JEV-1.14.0
    const chunkContents = deduplicatedCitations.map((c) => c.content);
    const jevEvaluation = await evaluateRagGroundedness(
      c.env,
      query,
      chunkContents,
      synthesis
    );

    // If JEV identifies false attribution or low groundedness, auto-replace with the corrected answer!
    let finalAnswer = synthesis;
    let autoCorrected = false;

    if (!jevEvaluation.isGrounded && jevEvaluation.rewrittenAnswer && jevEvaluation.rewrittenAnswer !== synthesis) {
      finalAnswer = jevEvaluation.rewrittenAnswer;
      autoCorrected = true;
    }

    const responsePayload = {
      query,
      answer: finalAnswer,
      autoCorrected,
      citations: deduplicatedCitations.map((c) => ({
        docId: c.docId,
        title: c.title,
        url: c.url,
        score: c.score,
        snippet: c.content.slice(0, 240) + "...",
      })),
      jevEvaluation,
    };

    // Cache verified response in KV for 24 hours (0 Neurons on repeat queries)
    if (c.env.KV) {
      try {
        await c.env.KV.put(kvCacheKey, JSON.stringify(responsePayload), {
          expirationTtl: 86400,
        });
      } catch (cachePutErr) {
        console.warn("Failed to store RAG answer in KV cache:", cachePutErr);
      }
    }

    return c.json(responsePayload);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Search API error:", err);
    return c.json({ error: errorMsg }, 500);
  }
});
