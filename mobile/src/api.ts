import { Platform } from "react-native";
import { API_URL, APP_KEY } from "./config";
import type { Language } from "./languages";

export type SpeechTranslation = {
  transcript: string;
  translation: string;
  detectedLanguage: string | null;
  audioBase64?: string;
};

const headers = (): Record<string, string> => (APP_KEY ? { "x-app-key": APP_KEY } : {});

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Server error ${res.status}`);
  return body as T;
}

export async function speechTranslate(
  audioUri: string,
  source: Language | null,
  target: Language,
  wantServerTts: boolean,
): Promise<SpeechTranslation> {
  const form = new FormData();
  if (Platform.OS === "web") {
    const blob = await (await fetch(audioUri)).blob();
    form.append("audio", blob, "speech.webm");
  } else {
    const ext = audioUri.split(".").pop() ?? "m4a";
    // React Native's FormData accepts a { uri, name, type } file descriptor.
    form.append("audio", { uri: audioUri, name: `speech.${ext}`, type: `audio/${ext === "m4a" ? "m4a" : ext}` } as any);
  }
  form.append("sourceStt", source?.stt ?? "");
  form.append("sourceName", source?.name ?? "");
  form.append("targetName", target.name);
  form.append("serverTts", wantServerTts ? "1" : "0");

  const res = await fetch(`${API_URL}/api/speech-translate`, { method: "POST", body: form, headers: headers() });
  return parse<SpeechTranslation>(res);
}

export async function textTranslate(text: string, source: Language | null, target: Language, context: string[] = []) {
  const res = await fetch(`${API_URL}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers() },
    body: JSON.stringify({ text, sourceName: source?.name, targetName: target.name, context }),
  });
  return parse<{ translation: string; detectedLanguage: string }>(res);
}

export async function serverTts(text: string, target: Language): Promise<string> {
  const res = await fetch(`${API_URL}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers() },
    body: JSON.stringify({ text, languageName: target.name }),
  });
  return (await parse<{ audioBase64: string }>(res)).audioBase64;
}
