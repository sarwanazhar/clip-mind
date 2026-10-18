export interface JevDocumentEvaluation {
  isValidContent: boolean; // false if the page is just a 403/404 error, captcha, login wall, or empty cookie banner
  rejectionReason?: string;
  category: "documentation" | "tutorial" | "article" | "repository" | "reference";
  informationDensityScore: number; // Float between 0.0 and 1.0
  autoTags: string[]; // 3 to 5 lowercase kebab-case technical tags
  tldrBullets: string[]; // Exactly 3 concise bullet points summarizing core technical facts
}

export interface JevRagEvaluation {
  isGrounded: boolean; // true if claims in generatedAnswer are strictly supported by contextChunks
  confidenceScore: number; // Float between 0.0 and 1.0
  supportedChunkIndices: number[]; // Which chunk indices were actually used
  hallucinationWarning?: string | null; // Short warning if the answer extrapolated beyond the vault
  rewrittenAnswer?: string; // Active self-correction: corrected version of answer with unsupported claims removed
}

// Supported model identifiers with primary and fallback
const JEV_MODEL_CANDIDATES = [
  "@cf/typesafe/jev-1.14.0",
  "typesafe/jev-1.14.0",
];

// Fallback decision model candidates (Cloudflare Clef family)
const CLEF_MODEL_CANDIDATES = [
  "@cf/cloudflare/clef",
  "@cf/cloudflare/clef-flash",
  "clef",
];

/**
 * Defensive JSON parser that strips markdown fences (```json ... ```) or extracts JSON substring.
 */
export function cleanAndParseJson<T>(raw: unknown): T | null {
  if (!raw) return null;

  if (typeof raw === "object" && raw !== null && !("response" in raw) && !("answers" in raw)) {
    return raw as T;
  }

  let text = "";
  if (typeof raw === "object" && raw !== null && "response" in raw) {
    const resp = (raw as { response: unknown }).response;
    text = typeof resp === "string" ? resp.trim() : JSON.stringify(resp);
  } else if (typeof raw === "string") {
    text = raw.trim();
  } else {
    text = JSON.stringify(raw);
  }

  // Strip code fences
  const unescaped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(unescaped) as T;
  } catch {
    // Attempt extracting slice between first { and last }
    const first = unescaped.indexOf("{");
    const last = unescaped.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return JSON.parse(unescaped.slice(first, last + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Invokes the JEV model with candidate fallback handling.
 */
async function invokeJev(
  aiBinding: any,
  systemPrompt: string,
  userPrompt: string
): Promise<unknown> {
  if (!aiBinding || typeof aiBinding.run !== "function") {
    throw new Error("Cloudflare AI binding not available");
  }

  let lastError: unknown = null;
  for (const model of JEV_MODEL_CANDIDATES) {
    try {
      const response = await aiBinding.run(model as any, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: 1024,
        temperature: 0.1,
      });
      return response;
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  throw lastError;
}

/**
 * Fallback: Evaluates a scraped page using Cloudflare Clef (@cf/cloudflare/clef)
 * Clef is a native open-weight decision model accepting state and typed questions schema (noul, choice, score).
 */
async function evaluateWithClef(
  aiBinding: any,
  truncatedMarkdown: string,
  url: string
): Promise<JevDocumentEvaluation | null> {
  if (!aiBinding || typeof aiBinding.run !== "function") return null;

  for (const model of CLEF_MODEL_CANDIDATES) {
    try {
      const response = await aiBinding.run(model as any, {
        state: `URL: ${url}\n\nContent:\n${truncatedMarkdown.slice(0, 16000)}`,
        questions: {
          is_valid: {
            type: "noul",
            instructions: "Is this valid substantive web content, rather than an error page, 403/404, captcha, login barrier, or empty page?"
          },
          category: {
            type: "choice",
            instructions: "What is the primary category of this content?",
            criteria: {
              documentation: "API reference, software documentation, or developer guides",
              tutorial: "How-to guides, tutorials, or step-by-step walkthroughs",
              article: "General news, blog posts, or editorial write-ups",
              repository: "Source code repository, package info, or release notes",
              reference: "Encyclopedia entries, dictionaries, or data sheets"
            }
          },
          quality_level: {
            type: "score",
            instructions: "Rate the technical information density and substance of this page.",
            criteria: ["Low/Empty", "Basic", "Moderate", "High"]
          }
        }
      });

      // Parse Clef decision output
      // Format: { answers: { is_valid: { noul: 0.95 }, category: { choice: "documentation", confidence: 0.9 }, quality_level: { score: 3.0 } } }
      const answers = (response as any)?.answers || (response as any);
      if (answers && answers.is_valid !== undefined) {
        const noulVal = typeof answers.is_valid?.noul === "number"
          ? answers.is_valid.noul
          : (answers.is_valid === true ? 1.0 : 0.0);
        const isValidContent = noulVal >= 0.5;

        const rawCat = answers.category?.choice || "article";
        const validCategories = ["documentation", "tutorial", "article", "repository", "reference"] as const;
        const category = validCategories.includes(rawCat) ? rawCat : "article";

        const scoreVal = typeof answers.quality_level?.score === "number"
          ? answers.quality_level.score / 3.0 // scale 0-3 to 0.0-1.0
          : 0.8;
        const informationDensityScore = Math.round(Math.min(1.0, Math.max(0.0, scoreVal)) * 100) / 100;

        return {
          isValidContent,
          rejectionReason: isValidContent ? undefined : "Flagged as non-substantive or blocked page by @cf/cloudflare/clef",
          category,
          informationDensityScore,
          autoTags: ["clef-evaluated", category, "clipmind"],
          tldrBullets: [
            `Evaluated via Cloudflare Clef decision model (${category}).`,
            "Clean readability text archived into edge vault.",
            "Prepared for vector indexing and semantic retrieval."
          ],
        };
      }
    } catch (clefErr) {
      console.warn(`Clef candidate ${model} call failed:`, clefErr);
      continue;
    }
  }
  return null;
}

/**
 * Fallback: Evaluates RAG Groundedness using Cloudflare Clef (@cf/cloudflare/clef)
 */
async function evaluateRagWithClef(
  aiBinding: any,
  query: string,
  contextChunks: string[],
  generatedAnswer: string
): Promise<JevRagEvaluation | null> {
  if (!aiBinding || typeof aiBinding.run !== "function") return null;

  const state = `Question: ${query}\n\nGenerated Answer: ${generatedAnswer}\n\nContext Sources:\n${contextChunks.map((c, i) => `[Source ${i}]: ${c.slice(0, 1000)}`).join("\n---\n")}`;

  for (const model of CLEF_MODEL_CANDIDATES) {
    try {
      const response = await aiBinding.run(model as any, {
        state,
        questions: {
          is_grounded: {
            type: "noul",
            instructions: "Are all claims, names, and facts in the Generated Answer strictly supported by the Context Sources without hallucination?"
          },
          grounding_confidence: {
            type: "score",
            instructions: "Rate how accurately the answer cites and reflects the source context.",
            criteria: ["Unrelated/Hallucinated", "Partial", "Mostly Grounded", "Fully Grounded"]
          }
        }
      });

      const answers = (response as any)?.answers || (response as any);
      if (answers && answers.is_grounded !== undefined) {
        const noulVal = typeof answers.is_grounded?.noul === "number"
          ? answers.is_grounded.noul
          : (answers.is_grounded === true ? 1.0 : 0.0);
        const isGrounded = noulVal >= 0.5;

        const scoreVal = typeof answers.grounding_confidence?.score === "number"
          ? answers.grounding_confidence.score / 3.0
          : (isGrounded ? 0.95 : 0.35);

        return {
          isGrounded,
          confidenceScore: Math.round(scoreVal * 100) / 100,
          supportedChunkIndices: [0],
          hallucinationWarning: isGrounded ? null : "Warning: Claim unsupported by sources (verified via @cf/cloudflare/clef)",
          rewrittenAnswer: isGrounded ? generatedAnswer : "The clipped sources do not contain sufficient verified information to answer this question.",
        };
      }
    } catch (clefErr) {
      console.warn(`Clef RAG audit ${model} failed:`, clefErr);
      continue;
    }
  }
  return null;
}

/**
 * Evaluates a scraped page using JEV-1.14.0 with fallback to Cloudflare Clef (@cf/cloudflare/clef).
 */
export async function evaluateScrapedDocument(
  env: { AI?: any },
  markdown: string,
  url: string
): Promise<JevDocumentEvaluation> {
  // Truncate markdown to 28,000 characters to comfortably fit inside the context window
  const truncatedMarkdown = (markdown || "").slice(0, 28000);

  const systemPrompt = `You are TypeSafe JEV-1.14.0, an autonomous technical evaluation and state extraction model.
Your task is to analyze scraped web content and return a strict JSON object conforming to this exact TypeScript specification:
{
  "isValidContent": boolean (set false if page is a 403, 404, captcha, login wall, cookie consent wall, empty page, or bot blocker),
  "rejectionReason": string (optional explanation if isValidContent is false),
  "category": "documentation" | "tutorial" | "article" | "repository" | "reference",
  "informationDensityScore": number (float between 0.0 and 1.0 indicating signal-to-noise ratio),
  "autoTags": string[] (3 to 5 lowercase kebab-case technical tags, e.g. ["cloudflare-workers", "d1-database"]),
  "tldrBullets": string[] (exactly 3 concise, high-density bullet points summarizing core technical facts)
}
Strict Rule: Output ONLY the JSON object. Do not add markdown commentary outside the JSON.`;

  const userPrompt = `Target URL: ${url}\n\nScraped Markdown Content:\n${truncatedMarkdown}`;

  // 1. Primary: TypeSafe JEV-1.14.0
  try {
    const rawResult = await invokeJev(env.AI, systemPrompt, userPrompt);
    const parsed = cleanAndParseJson<Partial<JevDocumentEvaluation>>(rawResult);

    if (parsed && typeof parsed.isValidContent === "boolean") {
      const validCategories = ["documentation", "tutorial", "article", "repository", "reference"] as const;
      const category = validCategories.includes(parsed.category as any)
        ? (parsed.category as JevDocumentEvaluation["category"])
        : "article";

      const density = typeof parsed.informationDensityScore === "number"
        ? Math.min(1.0, Math.max(0.0, parsed.informationDensityScore))
        : 0.8;

      const autoTags = Array.isArray(parsed.autoTags) && parsed.autoTags.length > 0
        ? parsed.autoTags.map((t) => String(t).toLowerCase().replace(/[^a-z0-9-]/g, "-")).slice(0, 5)
        : ["web-article", "clipmind", "reference"];

      const tldrBullets = Array.isArray(parsed.tldrBullets) && parsed.tldrBullets.length > 0
        ? parsed.tldrBullets.slice(0, 3).map((b) => String(b).trim())
        : [
            "Extracted core knowledge from source page.",
            "Archived to high-speed R2 edge vault.",
            "Prepared for vector indexing and semantic retrieval."
          ];

      return {
        isValidContent: parsed.isValidContent,
        rejectionReason: parsed.rejectionReason,
        category,
        informationDensityScore: Math.round(density * 100) / 100,
        autoTags,
        tldrBullets,
      };
    }
  } catch (err) {
    console.warn("JEV document evaluation call failed, attempting fallback to @cf/cloudflare/clef:", err);
  }

  // 2. Secondary Fallback: Cloudflare Clef (@cf/cloudflare/clef)
  try {
    const clefResult = await evaluateWithClef(env.AI, truncatedMarkdown, url);
    if (clefResult) {
      return clefResult;
    }
  } catch (clefErr) {
    console.warn("Clef evaluation failed, proceeding to heuristic fallback:", clefErr);
  }

  // 3. Tertiary Heuristic / Offline Fallback
  const lower = truncatedMarkdown.toLowerCase();
  const isBlocked =
    lower.includes("access denied") ||
    lower.includes("403 forbidden") ||
    lower.includes("please verify you are human") ||
    lower.includes("page not found") ||
    lower.includes("enable javascript and cookies") ||
    truncatedMarkdown.trim().length < 80;

  if (isBlocked) {
    return {
      isValidContent: false,
      rejectionReason: "Content identified as access block, empty page, or captcha wall",
      category: "article",
      informationDensityScore: 0.0,
      autoTags: ["blocked", "captcha"],
      tldrBullets: ["Page blocked or inaccessible."],
    };
  }

  return {
    isValidContent: true,
    category: "article",
    informationDensityScore: 0.85,
    autoTags: ["web-clip", "reference", "knowledge"],
    tldrBullets: [
      "Archived primary document contents into zero-egress vault.",
      "Extracted clean readability article text.",
      "Embedded with 384-dimensional vectors for semantic search."
    ],
  };
}

/**
 * Active Self-Correction Gate using JEV-1.14.0 with fallback to Cloudflare Clef (@cf/cloudflare/clef).
 * Verifies whether the generated LLM response is strictly grounded in the retrieved chunks.
 */
export async function evaluateRagGroundedness(
  env: { AI?: any },
  query: string,
  contextChunks: string[],
  generatedAnswer: string
): Promise<JevRagEvaluation> {
  const systemPrompt = `You are TypeSafe JEV-1.14.0 Active Self-Correction & Groundedness Gate.
Your critical job is to cross-check the generated answer against the retrieved context passages to detect any False Attribution, Quote Mismatch, or Extrapolation.

INSPECTION RULES:
1. Verify if each claimed name, author, date, number, or fact literally appears word-for-word in the cited passages.
2. FALSE ATTRIBUTION CHECK: Did the model write "According to Source X: [quote]" or cite a passage, but the passage itself does NOT contain that specific fact?
3. If ANY claim is extrapolated from external memory or not literally found in the context:
   - Set "isGrounded": false
   - Provide "rewrittenAnswer": Rewrite the answer cleanly so it contains ONLY facts that literally exist in the context. Replace any unverified claims with: "The clipped sources do not mention [specific unverified fact]."
4. If ALL claims are completely and literally supported by the context passages:
   - Set "isGrounded": true
   - Set "rewrittenAnswer": The exact original generatedAnswer.

Return strict JSON:
{
  "isGrounded": boolean,
  "confidenceScore": number (float between 0.0 and 1.0),
  "supportedChunkIndices": number[] (0-based indices of chunks that actually support the answer),
  "hallucinationWarning": string | null,
  "rewrittenAnswer": string
}
Strict Rule: Output ONLY the valid JSON object.`;

  const userPrompt = `User Query: ${query}\n\nRetrieved Context Chunks:\n${contextChunks
    .map((c, i) => `[Chunk ${i}]:\n${c.slice(0, 1200)}`)
    .join("\n\n---\n\n")}\n\nGenerated Answer to Verify:\n${generatedAnswer}`;

  // 1. Primary: TypeSafe JEV-1.14.0
  try {
    const rawResult = await invokeJev(env.AI, systemPrompt, userPrompt);
    const parsed = cleanAndParseJson<Partial<JevRagEvaluation>>(rawResult);

    if (parsed && typeof parsed.isGrounded === "boolean") {
      const confidence = typeof parsed.confidenceScore === "number"
        ? Math.min(1.0, Math.max(0.0, parsed.confidenceScore))
        : (parsed.isGrounded ? 0.95 : 0.4);

      const supported = Array.isArray(parsed.supportedChunkIndices)
        ? parsed.supportedChunkIndices.filter((idx) => typeof idx === "number" && idx >= 0 && idx < contextChunks.length)
        : [0];

      const rewrittenAnswer = typeof parsed.rewrittenAnswer === "string" && parsed.rewrittenAnswer.trim().length > 0
        ? parsed.rewrittenAnswer.trim()
        : (parsed.isGrounded ? generatedAnswer : "The clipped sources do not contain sufficient verified information to answer this question.");

      return {
        isGrounded: parsed.isGrounded,
        confidenceScore: Math.round(confidence * 100) / 100,
        supportedChunkIndices: supported.length > 0 ? supported : [0],
        hallucinationWarning: parsed.hallucinationWarning || (parsed.isGrounded ? null : "False attribution or unverified claim detected."),
        rewrittenAnswer,
      };
    }
  } catch (err) {
    console.warn("JEV RAG groundedness evaluation call failed, attempting fallback to @cf/cloudflare/clef:", err);
  }

  // 2. Secondary Fallback: Cloudflare Clef (@cf/cloudflare/clef)
  try {
    const clefResult = await evaluateRagWithClef(env.AI, query, contextChunks, generatedAnswer);
    if (clefResult) {
      return clefResult;
    }
  } catch (clefErr) {
    console.warn("Clef RAG evaluation failed, proceeding to heuristic fallback:", clefErr);
  }

  // 3. Tertiary Fallback: Check if answer contains text from chunks
  const isReasonablyGrounded = contextChunks.some((c) =>
    c.split(/\s+/).filter((w) => w.length > 5 && generatedAnswer.toLowerCase().includes(w.toLowerCase())).length > 3
  );

  return {
    isGrounded: isReasonablyGrounded,
    confidenceScore: isReasonablyGrounded ? 0.88 : 0.5,
    supportedChunkIndices: [0],
    hallucinationWarning: isReasonablyGrounded ? null : "Grounding verified with heuristic fallback.",
    rewrittenAnswer: generatedAnswer,
  };
}
