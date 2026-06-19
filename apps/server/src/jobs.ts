import pLimit from "p-limit";
import type {
  GenerateNotesRequest,
  NoteDocument,
  NoteJob,
  NoteSection,
  VisualFrame
} from "@vidscribe/shared";
import { chunkCaptions, type TranscriptChunk } from "./chunker.js";
import { config } from "./config.js";
import { invokeChunkNotes, toNoteSections } from "./bedrock.js";
import { withRetry } from "./retry.js";
import { formatTimestamp } from "./time.js";

type MutableJob = NoteJob & {
  createdAt: number;
  updatedAt: number;
};

function createJobId(): string {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createInitialDocument(request: GenerateNotesRequest): NoteDocument {
  return {
    video: request.video,
    generatedAt: new Date().toISOString(),
    sections: [],
    failedChunkCount: 0,
    warnings: []
  };
}

function nearestFrameForChunk(
  chunk: TranscriptChunk,
  frames: VisualFrame[]
): VisualFrame | undefined {
  if (frames.length === 0) return undefined;

  const midpoint = (chunk.start + chunk.end) / 2;
  const nearest = frames
    .map((frame) => ({
      frame,
      distance: Math.abs(frame.timestamp - midpoint)
    }))
    .sort((a, b) => a.distance - b.distance)[0];

  if (!nearest) return undefined;
  return nearest.distance <= 60 ? nearest.frame : undefined;
}

function publicJob(job: MutableJob): NoteJob {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = job;
  return rest;
}

export class NotesJobStore {
  private readonly jobs = new Map<string, MutableJob>();

  create(request: GenerateNotesRequest): NoteJob {
    const jobId = createJobId();
    const job: MutableJob = {
      jobId,
      status: "queued",
      progress: {
        completedChunks: 0,
        totalChunks: 0,
        currentMessage: "Queued"
      },
      document: createInitialDocument(request),
      errors: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.jobs.set(jobId, job);
    void this.run(job, request).catch((error) => {
      job.status = "failed";
      job.errors.push(error instanceof Error ? error.message : String(error));
      job.progress.currentMessage = "Failed";
      job.updatedAt = Date.now();
    });

    return publicJob(job);
  }

  get(jobId: string): NoteJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? publicJob(job) : undefined;
  }

  private async run(job: MutableJob, request: GenerateNotesRequest) {
    if (request.video.duration > config.maxVideoSeconds) {
      throw new Error(
        `Video is longer than the configured ${formatTimestamp(config.maxVideoSeconds)} limit`
      );
    }

    const chunks = chunkCaptions(request.captions, {
      targetTokens: config.chunkTargetTokens
    });

    if (chunks.length === 0) {
      throw new Error("No usable caption text was found");
    }

    if (chunks.length > config.maxChunks) {
      throw new Error(
        `Video produced ${chunks.length} chunks, above the configured ${config.maxChunks} chunk limit`
      );
    }

    const frames = request.frames.slice(0, config.maxFramesPerVideo);
    const limit = pLimit(config.chunkConcurrency);
    const sections: NoteSection[] = [];
    const chunkFailures: string[] = [];

    job.status = "running";
    job.progress = {
      completedChunks: 0,
      totalChunks: chunks.length,
      currentMessage: `Processing section 1 of ${chunks.length}`
    };
    job.updatedAt = Date.now();

    await Promise.all(
      chunks.map((chunk) =>
        limit(async () => {
          job.progress.currentMessage = `Processing section ${chunk.index + 1} of ${chunks.length}`;
          job.updatedAt = Date.now();

          try {
            const result = await withRetry(
              () =>
                invokeChunkNotes({
                  video: request.video,
                  chunk,
                  frame: nearestFrameForChunk(chunk, frames)
                }),
              {
                attempts: 4,
                baseDelayMs: 2000,
                jitterMs: 2000,
                onRetry: (attempt) => {
                  job.progress.currentMessage = `Retrying section ${chunk.index + 1}, attempt ${attempt + 1}`;
                  job.updatedAt = Date.now();
                }
              }
            );

            sections.push(...toNoteSections(result.output, chunk));
            job.document?.warnings.push(...result.output.warnings);
            if (job.usage) {
              job.usage.inputTokens += result.usage.inputTokens;
              job.usage.outputTokens += result.usage.outputTokens;
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown Bedrock error";
            chunkFailures.push(`Chunk ${chunk.index + 1}: ${message}`);
          } finally {
            job.progress.completedChunks += 1;
            job.updatedAt = Date.now();
          }
        })
      )
    );

    const sortedSections = sections.sort(
      (a, b) => a.startSeconds - b.startSeconds || (a.sourceChunk ?? 0) - (b.sourceChunk ?? 0)
    );

    job.document = {
      ...createInitialDocument(request),
      sections: sortedSections,
      failedChunkCount: chunkFailures.length,
      warnings: [
        ...(job.document?.warnings ?? []),
        ...chunkFailures.map((failure) => `Failed to process ${failure}`)
      ]
    };
    job.errors = chunkFailures;
    job.status =
      chunkFailures.length === 0
        ? "completed"
        : sortedSections.length > 0
          ? "partial"
          : "failed";
    job.progress.currentMessage =
      job.status === "failed"
        ? "All sections failed"
        : job.status === "partial"
          ? "Completed with partial notes"
          : "Completed";
    job.updatedAt = Date.now();
  }
}
