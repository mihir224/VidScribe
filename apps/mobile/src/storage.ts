import AsyncStorage from "@react-native-async-storage/async-storage";
import type { NoteDocument } from "@vidscribe/shared";

export type HistoryItem = {
  id: string;
  savedAt: string;
  document: NoteDocument;
};

const HISTORY_KEY = "vidscribe.history.v1";
const MAX_HISTORY_ITEMS = 10;

export async function loadHistory(): Promise<HistoryItem[]> {
  const raw = await AsyncStorage.getItem(HISTORY_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as HistoryItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveHistoryItem(document: NoteDocument): Promise<HistoryItem[]> {
  const current = await loadHistory();
  const item: HistoryItem = {
    id: `${document.video.id}-${Date.now()}`,
    savedAt: new Date().toISOString(),
    document
  };
  const next = [
    item,
    ...current.filter((entry) => entry.document.video.id !== document.video.id)
  ].slice(0, MAX_HISTORY_ITEMS);

  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}
