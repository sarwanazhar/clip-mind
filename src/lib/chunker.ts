export interface Chunk {
  chunkIndex: number;
  content: string;
  wordCount: number;
  tokenCount: number;
}

/**
 * Splits text into sliding windows with overlap.
 * Default: 400-word sliding windows with a 40-word overlap as specified.
 */
export function splitIntoSlidingWindows(
  text: string,
  windowSize = 400,
  overlap = 40
): Chunk[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  // Normalize whitespace while preserving paragraphs
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length === 0) {
    return [];
  }

  if (words.length <= windowSize) {
    return [
      {
        chunkIndex: 0,
        content: words.join(" "),
        wordCount: words.length,
        tokenCount: Math.ceil(words.length * 1.3),
      },
    ];
  }

  const step = Math.max(1, windowSize - overlap);
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (let i = 0; i < words.length; i += step) {
    const chunkWords = words.slice(i, i + windowSize);
    if (chunkWords.length === 0) break;

    const content = chunkWords.join(" ");
    chunks.push({
      chunkIndex,
      content,
      wordCount: chunkWords.length,
      tokenCount: Math.ceil(chunkWords.length * 1.3),
    });
    chunkIndex++;

    // If the slice reached the end of the text, stop
    if (i + windowSize >= words.length) {
      break;
    }
  }

  return chunks;
}
