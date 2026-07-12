import { XMLParser } from "fast-xml-parser";
import type {
  CaptionCue,
  CaptionTrack,
  GenerateNotesRequest,
  YouTubeExtractionErrorCode
} from "@vidscribe/shared";

type FetchLike = typeof fetch;

type ExtractOptions = {
  fetchImpl?: FetchLike;
  preferredLanguage?: string;
};

type YtClientConfig = {
  apiKey?: string;
  clientVersion?: string;
  clientName?: string;
  visitorData?: string;
  sessionIndex?: string;
  hl?: string;
  gl?: string;
};

type RawCaptionTrack = {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  name?: unknown;
};

const WATCH_HEADERS = {
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
};

const FALLBACK_CLIENT_VERSION = "2.20260626.01.00";
const CAPTION_FORMATS = ["provided", "json3", "srv3", "srv1", "vtt"] as const;

export class YouTubeExtractionError extends Error {
  constructor(
    readonly code: YouTubeExtractionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "YouTubeExtractionError";
  }
}

export function parseYouTubeVideoId(inputUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(inputUrl);
  } catch {
    throw new YouTubeExtractionError("INVALID_URL", "Enter a valid YouTube URL.");
  }

  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "youtu.be") {
    const id = parsed.pathname.split("/").filter(Boolean)[0];
    if (id) return id;
  }

  if (host !== "youtube.com" && host !== "m.youtube.com") {
    throw new YouTubeExtractionError("INVALID_URL", "Only YouTube URLs are supported.");
  }

  if (parsed.pathname === "/watch") {
    const id = parsed.searchParams.get("v");
    if (id) return id;
  }

  const pathMatch = /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(parsed.pathname);
  if (pathMatch?.[1]) {
    return pathMatch[1];
  }

  throw new YouTubeExtractionError(
    "INVALID_URL",
    "Could not find a YouTube video id in that URL."
  );
}

function safeJsonString(raw: string | undefined): string | undefined {
  if (!raw) return undefined;

  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function extractBalancedJson(source: string, startIndex: number): string | undefined {
  const firstBrace = source.indexOf("{", startIndex);
  if (firstBrace === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = firstBrace; index < source.length; index += 1) {
    const char = source[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return source.slice(firstBrace, index + 1);
    }
  }

  return undefined;
}

function extractInitialJson(html: string, marker: string): any | undefined {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return undefined;

  const jsonText = extractBalancedJson(html, markerIndex);
  if (!jsonText) return undefined;

  try {
    return JSON.parse(jsonText);
  } catch {
    return undefined;
  }
}

function extractClientConfig(html: string): YtClientConfig {
  return {
    apiKey: safeJsonString(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/.exec(html)?.[1]),
    clientVersion: safeJsonString(
      /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/.exec(html)?.[1]
    ),
    clientName: safeJsonString(
      /"INNERTUBE_CONTEXT_CLIENT_NAME"\s*:\s*(?:"([^"]+)"|(\d+))/.exec(html)?.[1] ??
        /"INNERTUBE_CONTEXT_CLIENT_NAME"\s*:\s*(?:"([^"]+)"|(\d+))/.exec(html)?.[2]
    ),
    visitorData: safeJsonString(/"VISITOR_DATA"\s*:\s*"([^"]+)"/.exec(html)?.[1]),
    sessionIndex: safeJsonString(/"SESSION_INDEX"\s*:\s*"([^"]+)"/.exec(html)?.[1]),
    hl: safeJsonString(/"HL"\s*:\s*"([^"]+)"/.exec(html)?.[1]),
    gl: safeJsonString(/"GL"\s*:\s*"([^"]+)"/.exec(html)?.[1])
  };
}

function getInnertubeHeaders(clientConfig: YtClientConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-YouTube-Client-Name": clientConfig.clientName ?? "1",
    "X-YouTube-Client-Version":
      clientConfig.clientVersion ?? FALLBACK_CLIENT_VERSION
  };

  if (clientConfig.visitorData) {
    headers["X-Goog-Visitor-Id"] = clientConfig.visitorData;
  }

  if (clientConfig.sessionIndex) {
    headers["X-Goog-AuthUser"] = clientConfig.sessionIndex;
  }

  return headers;
}

function getInnertubeContext(clientConfig: YtClientConfig) {
  return {
    client: {
      clientName: "WEB",
      clientVersion: clientConfig.clientVersion ?? FALLBACK_CLIENT_VERSION,
      hl: clientConfig.hl ?? "en",
      gl: clientConfig.gl ?? "US",
      visitorData: clientConfig.visitorData
    },
    user: {
      lockedSafetyMode: false
    },
    request: {
      useSsl: true,
      internalExperimentFlags: [],
      consistencyTokenJars: []
    }
  };
}

function getCaptionTracks(playerResponse: any): RawCaptionTrack[] {
  return (
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
  );
}

function readTextRenderer(renderer: any): string | undefined {
  if (!renderer) return undefined;
  if (typeof renderer.simpleText === "string") return renderer.simpleText;
  if (Array.isArray(renderer.runs)) {
    return renderer.runs.map((run: any) => run.text).filter(Boolean).join("");
  }
  return undefined;
}

function normalizeTrack(track: RawCaptionTrack): CaptionTrack {
  return {
    languageCode: track.languageCode,
    name: readTextRenderer(track.name),
    kind: track.kind,
    isAutoGenerated: track.kind === "asr",
    url: track.baseUrl
  };
}

function chooseCaptionTrack(
  tracks: RawCaptionTrack[],
  preferredLanguage = "en"
): RawCaptionTrack | undefined {
  const languageTracks = tracks.filter((track) =>
    track.languageCode?.toLowerCase().startsWith(preferredLanguage.toLowerCase())
  );
  const manual = languageTracks.find((track) => track.kind !== "asr" && track.baseUrl);
  if (manual) return manual;

  const auto = languageTracks.find((track) => track.kind === "asr" && track.baseUrl);
  if (auto) return auto;

  return tracks.find((track) => Boolean(track.baseUrl));
}

function orderedCaptionTracks(
  tracks: RawCaptionTrack[],
  preferredLanguage?: string
): RawCaptionTrack[] {
  const preferred = chooseCaptionTrack(tracks, preferredLanguage);
  const seen = new Set<string>();
  const ordered = preferred ? [preferred, ...tracks] : tracks;

  return ordered.filter((track) => {
    if (!track.baseUrl || seen.has(track.baseUrl)) return false;
    seen.add(track.baseUrl);
    return true;
  });
}

function normalizeCaptionText(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function parseJson3Captions(payload: any): CaptionCue[] {
  const cues: CaptionCue[] = [];

  for (const event of payload.events ?? []) {
    const text = (event.segs ?? [])
      .map((segment: any) => segment.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) continue;

    const start = Number(event.tStartMs ?? 0) / 1000;
    const duration = Number(event.dDurationMs ?? 2000) / 1000;
    cues.push({
      start,
      end: start + Math.max(0.25, duration),
      text
    });
  }

  return cues;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function textFromXmlNode(node: any): string {
  if (typeof node === "string") return node;
  if (typeof node?.["#text"] === "string") return node["#text"];
  const segments = asArray(node?.s)
    .map((segment) =>
      typeof segment === "string" ? segment : String(segment?.["#text"] ?? "")
    )
    .filter((segment) => segment.trim().length > 0);

  return segments.length > 0 ? segments.join(" ") : "";
}

export function parseXmlCaptions(xmlText: string): CaptionCue[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    textNodeName: "#text"
  });
  const parsed = parser.parse(xmlText);
  const transcript = parsed.transcript ?? parsed.timedtext?.body;
  const legacyTextNodes = asArray(transcript?.text);

  const legacyCues = legacyTextNodes
    .map((node: any) => {
      const start = Number(node.start ?? 0);
      const duration = Number(node.dur ?? 2);
      return {
        start,
        end: start + Math.max(0.25, duration),
        text: normalizeCaptionText(textFromXmlNode(node))
      };
    })
    .filter((cue) => cue.text.length > 0);

  if (legacyCues.length > 0) return legacyCues;

  return asArray(transcript?.p)
    .map((node: any) => {
      const start = Number(node.t ?? 0) / 1000;
      const duration = Number(node.d ?? 2000) / 1000;
      return {
        start,
        end: start + Math.max(0.25, duration),
        text: normalizeCaptionText(textFromXmlNode(node))
      };
    })
    .filter((cue) => cue.text.length > 0);
}

function parseVttTimestamp(timestamp: string): number {
  const parts = timestamp.trim().split(":");
  const secondsPart = parts.pop() ?? "0";
  const minutesPart = parts.pop() ?? "0";
  const hoursPart = parts.pop() ?? "0";

  return (
    Number(hoursPart) * 3600 +
    Number(minutesPart) * 60 +
    Number(secondsPart.replace(",", "."))
  );
}

export function parseVttCaptions(vttText: string): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const blocks = vttText.replace(/^WEBVTT.*$/m, "").split(/\n\s*\n/g);

  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) continue;

    const timingLine = lines[timingIndex];
    if (!timingLine) continue;

    const [startRaw, endRaw] = timingLine.split("-->").map((part) => part.trim());
    if (!startRaw || !endRaw) continue;

    const cueText = normalizeCaptionText(lines.slice(timingIndex + 1).join(" "));
    if (!cueText) continue;

    cues.push({
      start: parseVttTimestamp(startRaw.split(/\s+/)[0] ?? "0"),
      end: parseVttTimestamp(endRaw.split(/\s+/)[0] ?? "0"),
      text: cueText
    });
  }

  return cues;
}

function parseCaptionBody(body: string, format: string): CaptionCue[] {
  const trimmed = body.trim();
  if (!trimmed) throw new Error(`Caption ${format} response was empty`);

  if (format === "json3") return parseJson3Captions(JSON.parse(trimmed));
  if (format === "vtt") return parseVttCaptions(trimmed);
  if (format === "provided" && trimmed.startsWith("{")) {
    return parseJson3Captions(JSON.parse(trimmed));
  }
  if (format === "provided" && trimmed.startsWith("WEBVTT")) {
    return parseVttCaptions(trimmed);
  }

  return parseXmlCaptions(trimmed);
}

async function fetchCaptionText(
  fetchImpl: FetchLike,
  track: RawCaptionTrack,
  format: string
): Promise<string> {
  if (!track.baseUrl) return "";

  const url = new URL(track.baseUrl);
  url.searchParams.delete("fmt");
  if (format !== "provided") {
    url.searchParams.set("fmt", format);
  }

  const response = await fetchImpl(url.toString(), {
    headers: WATCH_HEADERS
  });
  if (!response.ok) return "";
  return response.text();
}

async function fetchCaptionsForTracks(
  fetchImpl: FetchLike,
  tracks: RawCaptionTrack[],
  preferredLanguage?: string
): Promise<{ captions: CaptionCue[]; track: RawCaptionTrack }> {
  const errors: string[] = [];

  for (const track of orderedCaptionTracks(tracks, preferredLanguage)) {
    for (const format of CAPTION_FORMATS) {
      try {
        const body = await fetchCaptionText(fetchImpl, track, format);
        const captions = parseCaptionBody(body, format);
        if (captions.length > 0) {
          return { captions, track };
        }
        errors.push(`${track.languageCode ?? "unknown"}/${format}: empty`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${track.languageCode ?? "unknown"}/${format}: ${message}`);
      }
    }
  }

  throw new YouTubeExtractionError(
    "CAPTION_FETCH_FAILED",
    `Could not fetch usable caption text. ${errors.slice(0, 4).join(" | ")}`
  );
}

async function fetchInnertubePlayerResponse(
  fetchImpl: FetchLike,
  videoId: string,
  clientConfig: YtClientConfig
): Promise<any | undefined> {
  if (!clientConfig.apiKey) return undefined;

  const endpoint = new URL("https://www.youtube.com/youtubei/v1/player");
  endpoint.searchParams.set("key", clientConfig.apiKey);
  endpoint.searchParams.set("prettyPrint", "false");

  const response = await fetchImpl(endpoint.toString(), {
    method: "POST",
    headers: getInnertubeHeaders(clientConfig),
    body: JSON.stringify({
      context: getInnertubeContext(clientConfig),
      videoId,
      contentCheckOk: true,
      racyCheckOk: true
    })
  });

  if (!response.ok) return undefined;
  return response.json();
}

function getTitleFromHtml(html: string): string | undefined {
  const rawTitle =
    /<meta\s+property="og:title"\s+content="([^"]+)"/i.exec(html)?.[1] ??
    /<title>([^<]+)<\/title>/i.exec(html)?.[1];

  return rawTitle
    ?.replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/\s+-\s+YouTube$/, "")
    .trim();
}

export async function extractYouTubeNotesInput(
  inputUrl: string,
  options: ExtractOptions = {}
): Promise<GenerateNotesRequest> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const videoId = parseYouTubeVideoId(inputUrl);
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const watchResponse = await fetchImpl(watchUrl, {
    headers: WATCH_HEADERS
  });

  if (!watchResponse.ok) {
    throw new YouTubeExtractionError(
      "VIDEO_UNAVAILABLE",
      `Could not load YouTube video page (${watchResponse.status}).`
    );
  }

  const html = await watchResponse.text();
  const clientConfig = extractClientConfig(html);
  const scriptedPlayerResponse = extractInitialJson(html, "ytInitialPlayerResponse");
  const innertubePlayerResponse =
    getCaptionTracks(scriptedPlayerResponse).length > 0
      ? undefined
      : await fetchInnertubePlayerResponse(fetchImpl, videoId, clientConfig);
  const playerResponse = innertubePlayerResponse ?? scriptedPlayerResponse;
  const tracks = getCaptionTracks(playerResponse);

  if (tracks.length === 0) {
    throw new YouTubeExtractionError(
      "NO_CAPTIONS",
      "This video does not expose captions that VidScribe can read."
    );
  }

  const { captions, track } = await fetchCaptionsForTracks(
    fetchImpl,
    tracks,
    options.preferredLanguage
  );

  const videoDetails = playerResponse?.videoDetails ?? {};
  const duration =
    Number(videoDetails.lengthSeconds) ||
    captions.at(-1)?.end ||
    captions.at(-1)?.start ||
    0;

  return {
    video: {
      id: videoId,
      title: videoDetails.title ?? getTitleFromHtml(html) ?? "YouTube video",
      duration,
      url: watchUrl,
      channelName: videoDetails.author
    },
    captions,
    captionTrack: normalizeTrack(track),
    frames: []
  };
}
