import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  FileText,
  Loader2,
  RefreshCw
} from "lucide-react";
import type {
  GenerateNotesRequest,
  NoteDocument,
  NoteJob,
  NoteSection
} from "@vidscribe/shared";
import "./styles.css";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ??
  "http://127.0.0.1:8787";

type ActiveTab = {
  id: number;
  url?: string;
  title?: string;
};

type ExtractSuccess = GenerateNotesRequest & {
  ok: true;
  visualCandidateTimestamps: number[];
};

type ExtractFailure = {
  ok: false;
  reason: string;
  message: string;
};

type ExtractResult = ExtractSuccess | ExtractFailure;

type UiState =
  | "checking"
  | "not-youtube"
  | "idle"
  | "extracting"
  | "capturing"
  | "generating"
  | "success"
  | "partial"
  | "error";

function formatTimestamp(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function isYouTubeWatchUrl(url?: string): boolean {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === "www.youtube.com" || parsed.hostname === "youtube.com") &&
      parsed.pathname === "/watch"
    );
  } catch {
    return false;
  }
}

async function getActiveTab(): Promise<ActiveTab | undefined> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) return undefined;
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTabMessage<T>(tabId: number, message: unknown): Promise<T> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);

    if (messageText.includes("Receiving end does not exist")) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });
      await delay(250);
      return (await chrome.tabs.sendMessage(tabId, message)) as T;
    }

    throw error;
  }
}

async function startJob(payload: GenerateNotesRequest): Promise<NoteJob> {
  const response = await fetch(`${API_BASE_URL}/api/notes/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Server rejected the job request (${response.status})`);
  }

  return (await response.json()) as NoteJob;
}

async function pollJob(jobId: string, onUpdate: (job: NoteJob) => void) {
  while (true) {
    const response = await fetch(`${API_BASE_URL}/api/notes/jobs/${jobId}`);
    if (!response.ok) {
      throw new Error(`Could not load job status (${response.status})`);
    }

    const job = (await response.json()) as NoteJob;
    onUpdate(job);

    if (["completed", "partial", "failed"].includes(job.status)) {
      return job;
    }

    await delay(1200);
  }
}

function markdownForDocument(document: NoteDocument): string {
  const lines = [
    `# ${document.video.title}`,
    "",
    `Duration: ${formatTimestamp(document.video.duration)}`,
    `Generated: ${new Date(document.generatedAt).toLocaleString()}`,
    ""
  ];

  for (const section of document.sections) {
    lines.push(`## [${formatTimestamp(section.startSeconds)}] ${section.title}`);
    for (const bullet of section.bullets) {
      lines.push(`- ${bullet}`);
    }
    for (const definition of section.definitions) {
      lines.push(`- Definition: ${definition.term} - ${definition.explanation}`);
    }
    for (const example of section.examples) {
      lines.push(`- Example: ${example}`);
    }
    if (section.visual) {
      lines.push(`- [Visual] ${section.visual}`);
    }
    lines.push("");
  }

  if (document.warnings.length > 0) {
    lines.push("## Warnings");
    for (const warning of document.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join("\n");
}

function SectionView({
  section,
  onSeek
}: {
  section: NoteSection;
  onSeek: (timestamp: number) => void;
}) {
  return (
    <article className="note-section">
      <button
        className="timestamp-button"
        onClick={() => onSeek(section.startSeconds)}
        type="button"
      >
        {formatTimestamp(section.startSeconds)}
      </button>
      <div className="section-body">
        <h3>{section.title}</h3>
        <ul>
          {section.bullets.map((bullet, index) => (
            <li key={`bullet-${index}`}>{bullet}</li>
          ))}
          {section.definitions.map((definition, index) => (
            <li key={`definition-${index}`}>
              <strong>{definition.term}:</strong> {definition.explanation}
            </li>
          ))}
          {section.examples.map((example, index) => (
            <li key={`example-${index}`}>Example: {example}</li>
          ))}
          {section.visual ? <li className="visual-line">Visual: {section.visual}</li> : null}
        </ul>
      </div>
    </article>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>();
  const [uiState, setUiState] = useState<UiState>("checking");
  const [message, setMessage] = useState("Checking current tab");
  const [job, setJob] = useState<NoteJob>();
  const [document, setDocument] = useState<NoteDocument>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getActiveTab()
      .then((tab) => {
        setActiveTab(tab);
        if (!tab || !isYouTubeWatchUrl(tab.url)) {
          setUiState("not-youtube");
          setMessage("Open a YouTube video to get started.");
          return;
        }

        setUiState("idle");
        setMessage("Ready");
      })
      .catch((error) => {
        setUiState("error");
        setMessage(error instanceof Error ? error.message : "Could not inspect tab");
      });
  }, []);

  const progressLabel = useMemo(() => {
    if (!job) return message;
    const total = Math.max(1, job.progress.totalChunks);
    return `${job.progress.currentMessage} (${job.progress.completedChunks}/${total})`;
  }, [job, message]);

  async function generateNotes() {
    if (!activeTab?.id) return;

    setCopied(false);
    setDocument(undefined);
    setJob(undefined);

    try {
      setUiState("extracting");
      setMessage("Extracting captions");
      const extractResult = await sendTabMessage<ExtractResult>(activeTab.id, {
        type: "VIDSCRIBE_EXTRACT"
      });

      if (!extractResult.ok) {
        setUiState("error");
        setMessage(extractResult.message);
        return;
      }

      setUiState("capturing");
      setMessage("Sampling visuals");
      const captureResult = await sendTabMessage<{
        ok: boolean;
        frames?: GenerateNotesRequest["frames"];
        message?: string;
      }>(activeTab.id, {
        type: "VIDSCRIBE_CAPTURE_FRAMES",
        timestamps: extractResult.visualCandidateTimestamps
      });

      const payload: GenerateNotesRequest = {
        video: extractResult.video,
        captions: extractResult.captions,
        captionTrack: extractResult.captionTrack,
        frames: captureResult.ok ? captureResult.frames ?? [] : []
      };

      setUiState("generating");
      setMessage("Starting notes job");
      const createdJob = await startJob(payload);
      setJob(createdJob);

      const finalJob = await pollJob(createdJob.jobId, setJob);
      setDocument(finalJob.document);

      if (finalJob.status === "completed") {
        setUiState("success");
        setMessage("Notes ready");
      } else if (finalJob.status === "partial") {
        setUiState("partial");
        setMessage("Notes ready with warnings");
      } else {
        setUiState("error");
        setMessage(finalJob.errors[0] ?? "Notes generation failed");
      }
    } catch (error) {
      setUiState("error");
      setMessage(error instanceof Error ? error.message : "Notes generation failed");
    }
  }

  async function copyNotes() {
    if (!document) return;
    await navigator.clipboard.writeText(markdownForDocument(document));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function seek(timestamp: number) {
    if (!activeTab?.id) return;
    void sendTabMessage(activeTab.id, {
      type: "VIDSCRIBE_SEEK",
      timestamp
    });
  }

  const busy = ["checking", "extracting", "capturing", "generating"].includes(uiState);
  const hasNotes = Boolean(document?.sections.length);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">VidScribe</p>
          <h1>{document?.video.title ?? "YouTube Notes"}</h1>
        </div>
        {hasNotes ? (
          <button className="icon-button" onClick={copyNotes} type="button" title="Copy notes">
            {copied ? <CheckCircle2 size={18} /> : <Clipboard size={18} />}
          </button>
        ) : null}
      </header>

      <section className={`status-row status-${uiState}`}>
        {busy ? <Loader2 className="spin" size={18} /> : null}
        {uiState === "error" || uiState === "partial" ? <AlertTriangle size={18} /> : null}
        {uiState === "success" ? <CheckCircle2 size={18} /> : null}
        {uiState === "idle" || uiState === "not-youtube" ? <FileText size={18} /> : null}
        <span>{uiState === "generating" ? progressLabel : message}</span>
      </section>

      {document?.warnings.length ? (
        <section className="warning-list">
          {document.warnings.map((warning, index) => (
            <p key={`warning-${index}`}>{warning}</p>
          ))}
        </section>
      ) : null}

      {!hasNotes ? (
        <section className="empty-state">
          <button
            className="primary-button"
            disabled={busy || uiState === "not-youtube"}
            onClick={generateNotes}
            type="button"
          >
            {busy ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>Generate Notes</span>
          </button>
        </section>
      ) : (
        <>
          <div className="notes-toolbar">
            <button className="secondary-button" onClick={generateNotes} type="button">
              <RefreshCw size={16} />
              <span>Regenerate</span>
            </button>
          </div>
          <section className="notes-list">
            {document?.sections.map((section) => (
              <SectionView key={section.id} section={section} onSeek={seek} />
            ))}
          </section>
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
