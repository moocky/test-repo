import * as Speech from "expo-speech";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import type { Language } from "./languages";
import { serverTts } from "./api";

let voiceCache: Speech.Voice[] | null = null;
let player: AudioPlayer | null = null;

async function voices(): Promise<Speech.Voice[]> {
  if (!voiceCache) {
    try {
      voiceCache = await Speech.getAvailableVoicesAsync();
    } catch {
      voiceCache = [];
    }
  }
  return voiceCache;
}

const norm = (tag: string) => tag.replace("_", "-").toLowerCase();

/** Best on-device voice for the language, or null if the OS has none. */
export async function findDeviceVoice(lang: Language): Promise<Speech.Voice | null> {
  const all = await voices();
  const exact = all.filter((v) => norm(v.language) === norm(lang.code));
  const base = lang.code.split("-")[0].toLowerCase();
  const sameLang = all.filter((v) => norm(v.language).split("-")[0] === base);
  const pool = exact.length ? exact : sameLang;
  if (!pool.length) return null;
  return pool.find((v) => v.quality === Speech.VoiceQuality.Enhanced) ?? pool[0];
}

export async function hasDeviceVoice(lang: Language) {
  return (await findDeviceVoice(lang)) !== null;
}

export async function stopSpeaking() {
  Speech.stop();
  player?.pause();
}

/** Play MP3 audio delivered as base64 by the server. */
export async function playBase64Mp3(base64: string) {
  await stopSpeaking();
  let uri: string;
  if (Platform.OS === "web") {
    uri = `data:audio/mpeg;base64,${base64}`;
  } else {
    const file = new File(Paths.cache, `tts-${Date.now()}.mp3`);
    await file.write(base64, { encoding: "base64" });
    uri = file.uri;
  }
  player?.remove();
  player = createAudioPlayer(uri);
  player.play();
}

/**
 * Speak `text` in `lang`: on-device voice when available (instant, offline, free),
 * otherwise neural TTS from the server.
 */
export async function speak(text: string, lang: Language, prefetchedMp3?: string) {
  await stopSpeaking();
  if (prefetchedMp3) return playBase64Mp3(prefetchedMp3);
  const voice = await findDeviceVoice(lang);
  if (voice) {
    Speech.speak(text, { language: voice.language, voice: voice.identifier });
    return;
  }
  return playBase64Mp3(await serverTts(text, lang));
}
