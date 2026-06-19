import {
  BedrockRuntimeClient,
  ConverseCommand
} from "@aws-sdk/client-bedrock-runtime";
import type {
  NoteSection,
  VideoContext,
  VisualFrame
} from "@vidscribe/shared";
import { z } from "zod";
import sharp from "sharp";
import { config } from "./config.js";
import { formatTimestamp } from "./time.js";
import type { TranscriptChunk } from "./chunker.js";

const generatedDefinitionSchema = z.object({
  term: z.string(),
  explanation: z.string()
});

const generatedSectionSchema = z.object({
  title: z.string(),
  startSeconds: z.number(),
  endSeconds: z.number().optional(),
  bullets: z.array(z.string()),
  definitions: z.array(generatedDefinitionSchema),
  examples: z.array(z.string()),
  visual: z.string().optional()
});

const noteChunkOutputSchema = z.object({
  sections: z.array(generatedSectionSchema),
  warnings: z.array(z.string())
});

type NoteChunkOutput = z.infer<typeof noteChunkOutputSchema>;

type InvokeChunkOptions = {
  video: VideoContext;
  chunk: TranscriptChunk;
  frame?: VisualFrame;
};

type InvokeChunkResult = {
  output: NoteChunkOutput;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
};

const bedrock = new BedrockRuntimeClient({
  region: config.awsRegion
});

const outputJsonSchema = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          startSeconds: { type: "number" },
          endSeconds: { type: "number" },
          bullets: { type: "array", items: { type: "string" } },
          definitions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                term: { type: "string" },
                explanation: { type: "string" }
              },
              required: ["term", "explanation"],
              additionalProperties: false
            }
          },
          examples: { type: "array", items: { type: "string" } },
          visual: { type: "string" }
        },
        required: ["title", "startSeconds", "bullets", "definitions", "examples"],
        additionalProperties: false
      }
    },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["sections", "warnings"],
  additionalProperties: false
};

function buildPrompt({ video, chunk, frame }: InvokeChunkOptions): string {
  return [
    "Generate structured study notes for this transcript segment.",
    "Keep notes grounded only in the transcript and optional screenshot.",
    "Use timestamps from the transcript. Prefer concise, useful bullets over summary prose.",
    "If a screenshot is provided and it contains useful visible information, include one visual observation.",
    "",
    `Video title: ${video.title}`,
    `Video duration: ${formatTimestamp(video.duration)}`,
    `Chunk: ${chunk.index + 1}`,
    `Chunk time range: ${formatTimestamp(chunk.start)} - ${formatTimestamp(chunk.end)}`,
    frame ? `Screenshot timestamp: ${formatTimestamp(frame.timestamp)}` : "Screenshot: none",
    "",
    "Transcript:",
    chunk.text
  ].join("\n");
}

function parseDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i.exec(dataUrl);
  if (!match?.[1] || !match[2]) {
    throw new Error("Unsupported frame data URL");
  }

  return {
    mimeType: match[1].toLowerCase().replace("image/jpg", "image/jpeg"),
    bytes: Buffer.from(match[2], "base64")
  };
}

async function normalizeFrame(
  frame: VisualFrame
): Promise<{ format: "jpeg"; bytes: Uint8Array } | undefined> {
  try {
    const { bytes } = parseDataUrl(frame.dataUrl);
    const normalized = await sharp(bytes)
      .rotate()
      .resize({ width: 512, withoutEnlargement: true })
      .jpeg({ quality: 68, mozjpeg: true })
      .toBuffer();

    return {
      format: "jpeg",
      bytes: new Uint8Array(normalized)
    };
  } catch {
    return undefined;
  }
}

function extractResponseText(response: any): string {
  const content = response?.output?.message?.content;
  if (!Array.isArray(content)) {
    throw new Error("Bedrock response did not include message content");
  }

  const textBlock = content.find(
    (block: unknown): block is { text: string } =>
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof (block as { text?: unknown }).text === "string"
  );

  if (!textBlock?.text) {
    throw new Error("Bedrock response did not include text output");
  }

  return textBlock.text;
}

function parseJsonOutput(text: string): NoteChunkOutput {
  const trimmed = text.trim();
  const parsed = JSON.parse(trimmed);
  return noteChunkOutputSchema.parse(parsed);
}

function makeMockOutput({ chunk, frame }: InvokeChunkOptions): NoteChunkOutput {
  const firstCue = chunk.cues[0];
  const sampleText =
    firstCue?.text.split(/[.!?]/).find(Boolean)?.trim() || "Key topic";

  return {
    sections: [
      {
        title: `Topic at ${formatTimestamp(chunk.start)}`,
        startSeconds: chunk.start,
        endSeconds: chunk.end,
        bullets: [
          sampleText,
          "Mock Bedrock mode is enabled, so this section verifies the local flow without model cost."
        ],
        definitions: [],
        examples: [],
        visual: frame
          ? `Visual context was captured near ${formatTimestamp(frame.timestamp)}.`
          : undefined
      }
    ],
    warnings: []
  };
}

export function toNoteSections(
  output: NoteChunkOutput,
  chunk: TranscriptChunk
): NoteSection[] {
  return output.sections.map((section, sectionIndex) => ({
    id: `chunk-${chunk.index}-section-${sectionIndex}`,
    title: section.title,
    startSeconds: Math.max(0, section.startSeconds),
    endSeconds: section.endSeconds,
    bullets: section.bullets,
    definitions: section.definitions,
    examples: section.examples,
    visual: section.visual,
    sourceChunk: chunk.index
  }));
}

export async function invokeChunkNotes(
  options: InvokeChunkOptions
): Promise<InvokeChunkResult> {
  if (config.bedrockMock) {
    return {
      output: makeMockOutput(options),
      usage: { inputTokens: 0, outputTokens: 0 }
    };
  }

  const normalizedFrame = options.frame
    ? await normalizeFrame(options.frame)
    : undefined;
  const content: any[] = [];

  if (normalizedFrame) {
    content.push({
      image: {
        format: normalizedFrame.format,
        source: {
          bytes: normalizedFrame.bytes
        }
      }
    });
  }

  content.push({ text: buildPrompt(options) });

  const command = new ConverseCommand({
    modelId: config.bedrockModelId,
    messages: [
      {
        role: "user",
        content
      }
    ],
    system: [
      {
        text: "You are VidScribe, a study-note assistant that turns lecture transcripts and screenshots into timestamped, reviewable notes."
      }
    ],
    inferenceConfig: {
      maxTokens: 1800,
      temperature: 0.2
    },
    outputConfig: {
      textFormat: {
        type: "json_schema",
        structure: {
          jsonSchema: {
            name: "vidscribe_chunk_notes",
            description: "Timestamped study notes for a video transcript chunk",
            schema: JSON.stringify(outputJsonSchema)
          }
        }
      }
    }
  } as any);

  const response = await bedrock.send(command);
  const output = parseJsonOutput(extractResponseText(response));

  return {
    output,
    usage: {
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0
    }
  };
}
