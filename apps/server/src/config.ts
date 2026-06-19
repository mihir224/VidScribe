import dotenv from "dotenv";

dotenv.config();

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: numberFromEnv("PORT", 8787),
  host: process.env.HOST ?? "127.0.0.1",
  awsRegion: process.env.AWS_REGION ?? "ap-south-1",
  bedrockModelId:
    process.env.BEDROCK_MODEL_ID ?? "global.anthropic.claude-sonnet-4-6",
  bedrockMock: process.env.BEDROCK_MOCK === "true",
  maxVideoSeconds: numberFromEnv("MAX_VIDEO_SECONDS", 3600),
  maxChunks: numberFromEnv("MAX_CHUNKS", 60),
  maxFramesPerVideo: numberFromEnv("MAX_FRAMES_PER_VIDEO", 10),
  chunkTargetTokens: numberFromEnv("CHUNK_TARGET_TOKENS", 850),
  chunkConcurrency: numberFromEnv("CHUNK_CONCURRENCY", 2)
};
