import { describe, expect, it } from "vitest";
import type { GenerateNotesRequest, NoteJob } from "@vidscribe/shared";
import { buildApp } from "../app.js";
import {
  parseJson3Captions,
  parseVttCaptions,
  parseXmlCaptions,
  parseYouTubeVideoId
} from "../youtube.js";

describe("parseYouTubeVideoId", () => {
  it("supports common YouTube URL shapes", () => {
    expect(parseYouTubeVideoId("https://www.youtube.com/watch?v=abc123")).toBe(
      "abc123"
    );
    expect(parseYouTubeVideoId("https://youtu.be/abc123?t=10")).toBe("abc123");
    expect(parseYouTubeVideoId("https://www.youtube.com/shorts/abc123")).toBe(
      "abc123"
    );
  });

  it("rejects non-YouTube URLs", () => {
    expect(() => parseYouTubeVideoId("https://example.com/watch?v=abc123")).toThrow(
      "Only YouTube URLs are supported"
    );
  });
});

describe("caption parsers", () => {
  it("parses json3 captions", () => {
    const cues = parseJson3Captions({
      events: [
        {
          tStartMs: 1000,
          dDurationMs: 2500,
          segs: [{ utf8: "Hello " }, { utf8: "world" }]
        }
      ]
    });

    expect(cues).toEqual([{ start: 1, end: 3.5, text: "Hello world" }]);
  });

  it("parses legacy XML captions", () => {
    const cues = parseXmlCaptions(
      '<transcript><text start="1.2" dur="2.4">Hello XML</text></transcript>'
    );

    expect(cues[0]?.start).toBe(1.2);
    expect(cues[0]?.end).toBeCloseTo(3.6);
    expect(cues[0]?.text).toBe("Hello XML");
  });

  it("parses modern XML captions", () => {
    const cues = parseXmlCaptions(
      '<timedtext><body><p t="1500" d="2000"><s>Modern</s><s>XML</s></p></body></timedtext>'
    );

    expect(cues).toEqual([{ start: 1.5, end: 3.5, text: "Modern XML" }]);
  });

  it("parses VTT captions", () => {
    const cues = parseVttCaptions(
      "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello VTT\n"
    );

    expect(cues).toEqual([{ start: 1, end: 3, text: "Hello VTT" }]);
  });
});

describe("youtube notes route", () => {
  it("creates a notes job from a mocked extractor response", async () => {
    const noteJob: NoteJob = {
      jobId: "job_test",
      status: "queued",
      progress: {
        completedChunks: 0,
        totalChunks: 0,
        currentMessage: "Queued"
      },
      errors: []
    };
    const createdRequests: GenerateNotesRequest[] = [];
    const app = await buildApp({
      jobs: {
        create(request) {
          createdRequests.push(request);
          return noteJob;
        },
        get() {
          return noteJob;
        }
      },
      async extractYouTube() {
        return {
          video: {
            id: "abc123",
            title: "Mock video",
            duration: 10,
            url: "https://www.youtube.com/watch?v=abc123"
          },
          captions: [{ start: 0, end: 5, text: "Mock caption" }],
          frames: []
        };
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/notes/youtube/jobs",
      payload: {
        url: "https://www.youtube.com/watch?v=abc123"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ jobId: "job_test" });
    expect(createdRequests).toHaveLength(1);
    expect(createdRequests[0]?.captions[0]?.text).toBe("Mock caption");
    await app.close();
  });
});
