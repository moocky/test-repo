import * as Speech from "expo-speech";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import type { Language } from "./languages";
import { serverTts } from "./api";

let voiceCache: Speech.Voice[] | null = null;
/** Server voices only exist with the cloud engine; on-device mode must use the OS voices. */
let serverVoiceAllowed = true;
export function setServerVoiceAllowed(allowed: boolean) {
  serverVoiceAllowed = allowed;
}
const noVoice = (lang: Language) =>
  new Error(`This device has no ${lang.name} voice. Install one in the system text-to-speech settings.`);
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

let queue: Promise<void> = Promise.resolve();
let queueToken = 0;
let activeCount = 0;
const listeners = new Set<(speaking: boolean) => void>();
const emit = () => listeners.forEach((l) => l(activeCount > 0));

/** Subscribe to "is the app currently speaking a queued sentence". Returns an unsubscribe fn. */
export function onSpeakingChange(fn: (speaking: boolean) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function stopSpeaking() {
  queueToken++; // drop anything still waiting in the queue
  Speech.stop();
  player?.pause();
}

/** Play MP3 audio delivered as base64 by the server; resolves when playback ends. */
export async function playBase64Mp3(base64: string, interrupt = true): Promise<void> {
  if (interrupt) await stopSpeaking();
  let uri: string;
  if (Platform.OS === "web") {
    uri = `data:audio/mpeg;base64,${base64}`;
  } else {
    const file = new File(Paths.cache, `tts-${Date.now()}.mp3`);
    await file.write(base64, { encoding: "base64" });
    uri = file.uri;
  }
  player?.remove();
  const p = createAudioPlayer(uri);
  player = p;
  await new Promise<void>((resolve) => {
    const sub = p.addListener("playbackStatusUpdate", (st) => {
      if (st.didJustFinish) {
        sub.remove();
        resolve();
      }
    });
    // Safety net in case the finish event never arrives.
    setTimeout(() => {
      sub.remove();
      resolve();
    }, 60_000);
    p.play();
  });
}

/** Speak and resolve when finished (device voice or server MP3). */
async function speakToEnd(text: string, lang: Language): Promise<void> {
  const voice = await findDeviceVoice(lang);
  if (voice) {
    await new Promise<void>((resolve) => {
      Speech.speak(text, {
        language: voice.language,
        voice: voice.identifier,
        onDone: () => resolve(),
        onStopped: () => resolve(),
        onError: () => resolve(),
      });
    });
    return;
  }
  if (!serverVoiceAllowed) throw noVoice(lang);
  await playBase64Mp3(await serverTts(text, lang), false);
}

/**
 * Queue a sentence to be spoken after anything already queued — used for live translation
 * so consecutive sentences don't cut each other off.
 */
export function enqueueSpeech(text: string, lang: Language): Promise<void> {
  const token = queueToken;
  queue = queue.then(async () => {
    if (token !== queueToken) return; // cancelled by stopSpeaking()
    activeCount++;
    emit();
    try {
      await speakToEnd(text, lang);
    } catch {
      // skip a sentence that fails to synthesize
    } finally {
      activeCount--;
      emit();
    }
  });
  return queue;
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
  if (!serverVoiceAllowed) throw noVoice(lang);
  return playBase64Mp3(await serverTts(text, lang));
}
