import type { CaptionCue } from "@vidscribe/shared";
import { formatTimestamp } from "./time.js";

export type TranscriptChunk = {
  index: number;
  start: number;
  end: number;
  text: string;
  cues: CaptionCue[];
};

type ChunkOptions = {
  targetTokens: number;
  overlapSeconds?: number;
};

const DEFAULT_OVERLAP_SECONDS = 15;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function formatTranscriptCue(cue: CaptionCue): string {
  return `[${formatTimestamp(cue.start)}] ${cue.text.trim()}`;
}

export function chunkCaptions(
  cues: CaptionCue[],
  options: ChunkOptions
): TranscriptChunk[] {
  const sorted = [...cues]
    .filter((cue) => cue.text.trim().length > 0)
    .sort((a, b) => a.start - b.start);

  const chunks: TranscriptChunk[] = [];
  const overlapSeconds = options.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS;
  let current: CaptionCue[] = [];
  let currentTokens = 0;

  function pushCurrent() {
    if (current.length === 0) return;

    const text = current.map(formatTranscriptCue).join("\n");
    chunks.push({
      index: chunks.length,
      start: current[0]?.start ?? 0,
      end: current.at(-1)?.end ?? current.at(-1)?.start ?? 0,
      text,
      cues: current
    });
  }

  for (const cue of sorted) {
    const tokenCount = estimateTokens(formatTranscriptCue(cue));
    const wouldOverflow =
      current.length > 0 && currentTokens + tokenCount > options.targetTokens;

    if (wouldOverflow) {
      pushCurrent();

      const previousEnd = current.at(-1)?.end ?? cue.start;
      current = current.filter((item) => item.end >= previousEnd - overlapSeconds);
      currentTokens = current.reduce(
        (sum, item) => sum + estimateTokens(formatTranscriptCue(item)),
        0
      );
    }

    current.push(cue);
    currentTokens += tokenCount;
  }

  pushCurrent();
  return chunks.map((chunk, index) => ({ ...chunk, index }));
}
