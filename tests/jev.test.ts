import { describe, it, expect } from "vitest";
import { cleanAndParseJson, evaluateScrapedDocument, evaluateRagGroundedness } from "../src/services/jev";

describe("TypeSafe JEV-1.14.0 Service", () => {
  describe("cleanAndParseJson", () => {
    it("should parse clean JSON strings", () => {
      const input = '{"isValidContent": true, "category": "article"}';
      const result = cleanAndParseJson<{ isValidContent: boolean }>(input);
      expect(result).not.toBeNull();
      expect(result?.isValidContent).toBe(true);
    });

    it("should strip markdown json fences", () => {
      const input = '```json\n{"isValidContent": true, "category": "documentation"}\n```';
      const result = cleanAndParseJson<{ category: string }>(input);
      expect(result).not.toBeNull();
      expect(result?.category).toBe("documentation");
    });

    it("should handle object responses with response property", () => {
      const input = { response: '{"isGrounded": true, "confidenceScore": 0.95}' };
      const result = cleanAndParseJson<{ isGrounded: boolean }>(input);
      expect(result?.isGrounded).toBe(true);
    });

    it("should return null on invalid JSON", () => {
      const result = cleanAndParseJson("not a json string");
      expect(result).toBeNull();
    });
  });

  describe("evaluateScrapedDocument", () => {
    it("should parse structured evaluation from JEV model mock", async () => {
      const mockAi = {
        run: async () => ({
          isValidContent: true,
          category: "tutorial",
          informationDensityScore: 0.92,
          autoTags: ["cloudflare-workers", "d1-database", "workflows"],
          tldrBullets: [
            "Cloudflare Workers execute globally with zero cold starts.",
            "Workflows provide multi-step durable state execution.",
            "D1 provides native distributed relational SQLite."
          ],
        }),
      };

      const result = await evaluateScrapedDocument(
        { AI: mockAi },
        "# Tutorial Content\n\nLearn how to use Cloudflare Workers.",
        "https://developers.cloudflare.com/workers"
      );

      expect(result.isValidContent).toBe(true);
      expect(result.category).toBe("tutorial");
      expect(result.informationDensityScore).toBe(0.92);
      expect(result.autoTags).toContain("cloudflare-workers");
      expect(result.tldrBullets).toHaveLength(3);
    });

    it("should identify access-blocked or empty pages with fallback", async () => {
      const result = await evaluateScrapedDocument(
        {},
        "403 Forbidden - Access Denied. Please verify you are human.",
        "https://blocked.com"
      );

      expect(result.isValidContent).toBe(false);
      expect(result.rejectionReason).toBeDefined();
    });
  });

  describe("evaluateRagGroundedness", () => {
    it("should return grounded status with confidence score", async () => {
      const mockAi = {
        run: async () => ({
          isGrounded: true,
          confidenceScore: 0.96,
          supportedChunkIndices: [0],
          hallucinationWarning: null,
        }),
      };

      const result = await evaluateRagGroundedness(
        { AI: mockAi },
        "What is Cloudflare D1?",
        ["Cloudflare D1 is a serverless relational database built on SQLite."],
        "Cloudflare D1 is a serverless relational SQLite database running on Cloudflare's network."
      );

      expect(result.isGrounded).toBe(true);
      expect(result.confidenceScore).toBe(0.96);
      expect(result.supportedChunkIndices).toContain(0);
      expect(result.hallucinationWarning).toBeNull();
    });
  });
});
