import { describe, expect, it } from "vitest";
import { chunkCaptions, estimateTokens } from "../chunker.js";
import type { CaptionCue } from "@vidscribe/shared";

describe("chunkCaptions", () => {
  it("chunks captions while preserving timestamps", () => {
    const cues: CaptionCue[] = Array.from({ length: 12 }, (_, index) => ({
      start: index * 10,
      end: index * 10 + 5,
      text: `This is caption cue number ${index} with enough text to count.`
    }));

    const chunks = chunkCaptions(cues, {
      targetTokens: 45,
      overlapSeconds: 10
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.text).toContain("[00:00]");
    expect(chunks.at(-1)?.end).toBe(115);
  });
});

describe("estimateTokens", () => {
  it("returns at least one token", () => {
    expect(estimateTokens("")).toBe(1);
  });
});
