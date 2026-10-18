import { describe, it, expect } from "vitest";
import { splitIntoSlidingWindows } from "../src/lib/chunker";

describe("Sliding Window Chunker", () => {
  it("should return empty array for empty or whitespace text", () => {
    expect(splitIntoSlidingWindows("")).toEqual([]);
    expect(splitIntoSlidingWindows("   \n\t  ")).toEqual([]);
  });

  it("should return single chunk if word count is under windowSize", () => {
    const text = Array(150).fill("word").join(" ");
    const chunks = splitIntoSlidingWindows(text, 400, 40);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].wordCount).toBe(150);
    expect(chunks[0].content).toBe(text);
  });

  it("should split into overlapping windows of 400 words with 40 words overlap", () => {
    // 760 words:
    // Window 1: words 0 to 400 (400 words)
    // Step: 400 - 40 = 360 words
    // Window 2: words 360 to 760 (400 words)
    const words = Array.from({ length: 760 }, (_, i) => `word${i}`);
    const text = words.join(" ");

    const chunks = splitIntoSlidingWindows(text, 400, 40);
    expect(chunks).toHaveLength(2);

    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].wordCount).toBe(400);
    expect(chunks[0].content.startsWith("word0")).toBe(true);
    expect(chunks[0].content.endsWith("word399")).toBe(true);

    expect(chunks[1].chunkIndex).toBe(1);
    expect(chunks[1].wordCount).toBe(400);
    expect(chunks[1].content.startsWith("word360")).toBe(true);
    expect(chunks[1].content.endsWith("word759")).toBe(true);
  });

  it("should handle large documents correctly with multiple sliding steps", () => {
    const words = Array.from({ length: 1200 }, (_, i) => `term_${i}`);
    const text = words.join(" ");

    // step = 360
    // chunk 0: 0..400
    // chunk 1: 360..760
    // chunk 2: 720..1120
    // chunk 3: 1080..1200 (120 words)
    const chunks = splitIntoSlidingWindows(text, 400, 40);
    expect(chunks.length).toBe(4);
    expect(chunks[3].wordCount).toBe(120);
    expect(chunks[3].content.endsWith("term_1199")).toBe(true);
  });
});
