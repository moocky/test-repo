import AsyncStorage from "@react-native-async-storage/async-storage";

export type Entry = {
  id: string;
  side: "A" | "B";
  sourceCode: string | null; // null = auto-detected
  detected: string | null;
  targetCode: string;
  transcript: string;
  translation: string;
  at: number;
};

export type Settings = { langA: string; langB: string; autoSpeak: boolean };

const HISTORY = "history.v1";
const SETTINGS = "settings.v1";

async function load<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export const loadSettings = () =>
  load<Settings>(SETTINGS, { langA: "he-IL", langB: "en-US", autoSpeak: true });
export const saveSettings = (s: Settings) => AsyncStorage.setItem(SETTINGS, JSON.stringify(s));

export async function loadHistory(): Promise<Entry[]> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
export const saveHistory = (h: Entry[]) => AsyncStorage.setItem(HISTORY, JSON.stringify(h.slice(0, 200)));
