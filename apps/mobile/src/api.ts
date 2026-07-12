import type { NoteJob } from "@vidscribe/shared";

const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ??
  "http://127.0.0.1:8787";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function parseError(response: Response): Promise<ApiError> {
  try {
    const payload = (await response.json()) as {
      error?: string;
      code?: string;
    };
    return new ApiError(
      payload.error ?? `Request failed with ${response.status}`,
      response.status,
      payload.code
    );
  } catch {
    return new ApiError(`Request failed with ${response.status}`, response.status);
  }
}

export async function startYouTubeNotesJob(url: string): Promise<NoteJob> {
  const response = await fetch(`${API_BASE_URL}/api/notes/youtube/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ url })
  });

  if (!response.ok) {
    throw await parseError(response);
  }

  return (await response.json()) as NoteJob;
}

export async function getNotesJob(jobId: string): Promise<NoteJob> {
  const response = await fetch(`${API_BASE_URL}/api/notes/jobs/${jobId}`);
  if (!response.ok) {
    throw await parseError(response);
  }

  return (await response.json()) as NoteJob;
}
