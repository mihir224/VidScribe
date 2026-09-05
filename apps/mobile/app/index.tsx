import * as Clipboard from "expo-clipboard";
import { File, Paths } from "expo-file-system";
import * as Linking from "expo-linking";
import * as Sharing from "expo-sharing";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import type { NoteDocument, NoteJob, NoteSection } from "@vidscribe/shared";
import { getNotesJob, startYouTubeNotesJob, API_BASE_URL } from "../src/api";
import { formatTimestamp, markdownForDocument } from "../src/notes";
import {
  loadHistory,
  saveHistoryItem,
  type HistoryItem
} from "../src/storage";

type UiState = "idle" | "starting" | "generating" | "success" | "partial" | "error";

const TERMINAL_STATUSES = new Set(["completed", "partial", "failed"]);

function extractYouTubeUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
      return rawUrl;
    }

    const nestedUrl = parsed.searchParams.get("url");
    return nestedUrl ?? undefined;
  } catch {
    return undefined;
  }
}

function progressText(job?: NoteJob): string {
  if (!job) return "";
  const total = Math.max(1, job.progress.totalChunks);
  return `${job.progress.currentMessage} (${job.progress.completedChunks}/${total})`;
}

function SectionCard({ section }: { section: NoteSection }) {
  return (
    <View style={styles.sectionCard}>
      <Text style={styles.timestamp}>{formatTimestamp(section.startSeconds)}</Text>
      <Text style={styles.sectionTitle}>{section.title}</Text>
      {section.bullets.map((bullet, index) => (
        <Text key={`bullet-${index}`} style={styles.bullet}>
          {'\u2022'} {bullet}
        </Text>
      ))}
      {section.definitions.map((definition, index) => (
        <Text key={`definition-${index}`} style={styles.bullet}>
          {'\u2022'} {definition.term}: {definition.explanation}
        </Text>
      ))}
      {section.examples.map((example, index) => (
        <Text key={`example-${index}`} style={styles.bullet}>
          {'\u2022'} Example: {example}
        </Text>
      ))}
      {section.visual ? (
        <Text style={styles.bullet}>{'\u2022'} Visual: {section.visual}</Text>
      ) : null}
    </View>
  );
}

export default function HomeScreen() {
  const [url, setUrl] = useState("");
  const [uiState, setUiState] = useState<UiState>("idle");
  const [message, setMessage] = useState("Paste or share a YouTube URL.");
  const [debugInfo, setDebugInfo] = useState<string | null>(null);
  const [job, setJob] = useState<NoteJob>();
  const [document, setDocument] = useState<NoteDocument>();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const pollCancelledRef = useRef(false);

  useEffect(() => {
    loadHistory().then(setHistory).catch(() => setHistory([]));

    Linking.getInitialURL()
      .then((initialUrl) => {
        const extracted = initialUrl ? extractYouTubeUrl(initialUrl) : undefined;
        if (extracted) setUrl(extracted);
      })
      .catch(() => undefined);

    const subscription = Linking.addEventListener("url", (event) => {
      const extracted = extractYouTubeUrl(event.url);
      if (extracted) {
        setUrl(extracted);
        setMessage("URL ready from share sheet.");
      }
    });

    return () => {
      pollCancelledRef.current = true;
      subscription.remove();
    };
  }, []);

  const isBusy = uiState === "starting" || uiState === "generating";
  const canSubmit = url.trim().length > 0 && !isBusy;
  const statusLabel = useMemo(
    () => (uiState === "generating" ? progressText(job) : message),
    [job, message, uiState]
  );

  async function pasteFromClipboard() {
    const text = await Clipboard.getStringAsync();
    if (text.trim()) {
      setUrl(text.trim());
      setMessage("URL pasted.");
    }
  }

  async function pollJob(jobId: string): Promise<NoteJob> {
    while (!pollCancelledRef.current) {
      const latestJob = await getNotesJob(jobId);
      setJob(latestJob);

      if (TERMINAL_STATUSES.has(latestJob.status)) {
        return latestJob;
      }

      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    throw new Error("Polling was cancelled.");
  }

  async function generateNotes() {
    const cleanUrl = url.trim();
    if (!cleanUrl) return;

    pollCancelledRef.current = false;
    setDocument(undefined);
    setJob(undefined);
    setDebugInfo(null);
    setUiState("starting");
    setMessage("Starting notes job.");

    try {
      const createdJob = await startYouTubeNotesJob(cleanUrl);
      setJob(createdJob);
      setUiState("generating");
      setMessage("Generating notes.");

      const finalJob = await pollJob(createdJob.jobId);
      if (finalJob.document) {
        setDocument(finalJob.document);
        setHistory(await saveHistoryItem(finalJob.document));
      }

      if (finalJob.status === "completed") {
        setUiState("success");
        setMessage("Notes ready.");
      } else if (finalJob.status === "partial") {
        setUiState("partial");
        setMessage("Notes ready with warnings.");
      } else {
        setUiState("error");
        setMessage(finalJob.errors[0] ?? "Notes generation failed.");
      }
    } catch (error) {
      setUiState("error");
      const errMsg = error instanceof Error ? error.message : "Notes generation failed.";
      const errType = error instanceof Error ? error.constructor.name : typeof error;
      const errStack = error instanceof Error ? (error.stack ?? "") : "";
      setMessage(errMsg);
      setDebugInfo(
        `URL: ${API_BASE_URL}\nType: ${errType}\nMessage: ${errMsg}\n\n${errStack}`
      );
    }
  }

  async function copyNotes() {
    if (!document) return;
    await Clipboard.setStringAsync(markdownForDocument(document));
    Alert.alert("Copied", "Notes copied as Markdown.");
  }

  async function shareNotes() {
    if (!document) return;
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      await copyNotes();
      return;
    }

    const safeTitle = document.video.title
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60)
      .toLowerCase();
    const file = new File(Paths.cache, `${safeTitle || "vidscribe-notes"}.md`);
    file.write(markdownForDocument(document));
    await Sharing.shareAsync(file.uri, {
      mimeType: "text/markdown",
      dialogTitle: "Share VidScribe notes",
      UTI: "net.daringfireball.markdown"
    });
  }

  function loadHistoryDocument(item: HistoryItem) {
    setDocument(item.document);
    setUrl(item.document.video.url);
    setUiState(item.document.failedChunkCount > 0 ? "partial" : "success");
    setMessage("Loaded from history.");
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.root}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.eyebrow}>VidScribe Mobile</Text>
          <Text style={styles.title}>YouTube Notes</Text>
          <Text style={styles.subtitle}>
            Paste a video URL, then let the server fetch captions and generate notes.
          </Text>
        </View>

        <View style={styles.inputPanel}>
          <Text style={styles.label}>YouTube URL</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onChangeText={setUrl}
            placeholder="https://www.youtube.com/watch?v=..."
            placeholderTextColor="#8c8173"
            style={styles.input}
            value={url}
          />
          <View style={styles.actionRow}>
            <Pressable
              accessibilityRole="button"
              onPress={pasteFromClipboard}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryButtonText}>Paste</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={!canSubmit}
              onPress={generateNotes}
              style={({ pressed }) => [
                styles.primaryButton,
                (!canSubmit || pressed) && styles.primaryButtonMuted
              ]}
            >
              {isBusy ? <ActivityIndicator color="#fff" /> : null}
              <Text style={styles.primaryButtonText}>
                {isBusy ? "Generating" : "Generate Notes"}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={[styles.status, styles[`status_${uiState}`]]}>
          <Text style={styles.statusText}>{statusLabel}</Text>
        </View>

        {debugInfo ? (
          <View style={styles.debugPanel}>
            <Text style={styles.debugTitle}>Debug Info</Text>
            <Text style={styles.debugText} selectable>{debugInfo}</Text>
          </View>
        ) : null}

        {document ? (
          <View style={styles.notesPanel}>
            <View style={styles.notesHeader}>
              <View style={styles.notesTitleBlock}>
                <Text style={styles.notesTitle}>{document.video.title}</Text>
                <Text style={styles.notesMeta}>
                  {formatTimestamp(document.video.duration)} · {document.sections.length} sections
                </Text>
              </View>
              <View style={styles.notesActions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={copyNotes}
                  style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
                >
                  <Text style={styles.smallButtonText}>Copy</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={shareNotes}
                  style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
                >
                  <Text style={styles.smallButtonText}>Share</Text>
                </Pressable>
              </View>
            </View>

            {document.warnings.length > 0 ? (
              <View style={styles.warningBox}>
                {document.warnings.map((warning, index) => (
                  <Text key={`warning-${index}`} style={styles.warningText}>
                    {warning}
                  </Text>
                ))}
              </View>
            ) : null}

            {document.sections.map((section) => (
              <SectionCard key={section.id} section={section} />
            ))}
          </View>
        ) : null}

        {history.length > 0 ? (
          <View style={styles.historyPanel}>
            <Text style={styles.historyTitle}>Recent Notes</Text>
            <FlatList
              data={history}
              keyExtractor={(item) => item.id}
              scrollEnabled={false}
              renderItem={({ item }) => (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => loadHistoryDocument(item)}
                  style={({ pressed }) => [styles.historyItem, pressed && styles.pressed]}
                >
                  <Text style={styles.historyItemTitle} numberOfLines={2}>
                    {item.document.video.title}
                  </Text>
                  <Text style={styles.historyItemMeta}>
                    {new Date(item.savedAt).toLocaleDateString()} ·{" "}
                    {item.document.sections.length} sections
                  </Text>
                </Pressable>
              )}
            />
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#f7f4ed"
  },
  container: {
    gap: 18,
    padding: 20,
    paddingTop: 64
  },
  header: {
    gap: 6
  },
  eyebrow: {
    color: "#5f6f52",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0,
    textTransform: "uppercase"
  },
  title: {
    color: "#24211d",
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: 0
  },
  subtitle: {
    color: "#6d6256",
    fontSize: 16,
    lineHeight: 22
  },
  inputPanel: {
    backgroundColor: "#fffdf8",
    borderColor: "#e1d8ca",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 14
  },
  label: {
    color: "#4c453d",
    fontSize: 14,
    fontWeight: "700"
  },
  input: {
    backgroundColor: "#ffffff",
    borderColor: "#d6cbbb",
    borderRadius: 8,
    borderWidth: 1,
    color: "#24211d",
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12
  },
  actionRow: {
    flexDirection: "row",
    gap: 10
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#2f5d62",
    borderRadius: 8,
    flex: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 14
  },
  primaryButtonMuted: {
    opacity: 0.65
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800"
  },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: "#ece5d8",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 16
  },
  secondaryButtonText: {
    color: "#2d2924",
    fontSize: 15,
    fontWeight: "800"
  },
  pressed: {
    opacity: 0.72
  },
  status: {
    borderRadius: 8,
    padding: 12
  },
  status_idle: {
    backgroundColor: "#e8eee3"
  },
  status_starting: {
    backgroundColor: "#dfeaf0"
  },
  status_generating: {
    backgroundColor: "#dfeaf0"
  },
  status_success: {
    backgroundColor: "#dfeedd"
  },
  status_partial: {
    backgroundColor: "#fff0c7"
  },
  status_error: {
    backgroundColor: "#f8d8d4"
  },
  statusText: {
    color: "#302b25",
    fontSize: 14,
    fontWeight: "700"
  },
  notesPanel: {
    gap: 12
  },
  notesHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between"
  },
  notesTitleBlock: {
    flex: 1,
    gap: 4
  },
  notesTitle: {
    color: "#24211d",
    fontSize: 22,
    fontWeight: "800",
    lineHeight: 28
  },
  notesMeta: {
    color: "#6d6256",
    fontSize: 13,
    fontWeight: "600"
  },
  notesActions: {
    flexDirection: "row",
    gap: 8
  },
  smallButton: {
    backgroundColor: "#2f5d62",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  smallButtonText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "800"
  },
  warningBox: {
    backgroundColor: "#fff0c7",
    borderRadius: 8,
    gap: 6,
    padding: 12
  },
  warningText: {
    color: "#5c4520",
    fontSize: 13,
    lineHeight: 18
  },
  sectionCard: {
    backgroundColor: "#fffdf8",
    borderColor: "#e1d8ca",
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    padding: 14
  },
  timestamp: {
    color: "#2f5d62",
    fontSize: 13,
    fontWeight: "800"
  },
  sectionTitle: {
    color: "#24211d",
    fontSize: 18,
    fontWeight: "800",
    lineHeight: 24
  },
  bullet: {
    color: "#3c362f",
    fontSize: 15,
    lineHeight: 22
  },
  historyPanel: {
    gap: 10,
    paddingBottom: 40
  },
  historyTitle: {
    color: "#24211d",
    fontSize: 18,
    fontWeight: "800"
  },
  historyItem: {
    backgroundColor: "#fffdf8",
    borderColor: "#e1d8ca",
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
    marginBottom: 8,
    padding: 12
  },
  historyItemTitle: {
    color: "#2d2924",
    fontSize: 15,
    fontWeight: "800"
  },
  historyItemMeta: {
    color: "#6d6256",
    fontSize: 13,
    fontWeight: "600"
  },
  debugPanel: {
    backgroundColor: "#1a1a1a",
    borderRadius: 8,
    padding: 12,
    gap: 6
  },
  debugTitle: {
    color: "#ff9500",
    fontSize: 13,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  debugText: {
    color: "#e0e0e0",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 11,
    lineHeight: 16
  }
});
