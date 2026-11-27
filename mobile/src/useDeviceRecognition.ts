import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import type { LiveResult, Segment } from "./useLiveTranscription";

/**
 * Free, on-device speech recognition (Android SpeechRecognizer / iOS SFSpeechRecognizer) with the
 * same interface as the cloud `useLiveTranscription`, so the screen doesn't care which runs.
 *
 * The native module isn't in Expo Go, and importing it there throws – so load it lazily.
 */
type SR = typeof import("expo-speech-recognition");
let sr: SR | null = null;
try {
  sr = require("expo-speech-recognition") as SR;
  // Accessing the module object throws when the native side is missing.
  if (!sr.ExpoSpeechRecognitionModule) sr = null;
} catch {
  sr = null;
}
export const deviceRecognitionAvailable = sr !== null;

export class OfflineSpeechError extends Error {}

const sameLanguage = (a: string, b: string) =>
  a.toLowerCase().replace("_", "-") === b.toLowerCase() ||
  a.toLowerCase().split(/[-_]/)[0] === b.toLowerCase().split("-")[0];

/**
 * Make sure speech for `locale` can be recognised without sending audio anywhere.
 * On Android the offline model may need downloading first: trigger it and ask the user to retry.
 */
async function ensureOfflineSpeech(locale: string, languageName: string) {
  const m = sr!.ExpoSpeechRecognitionModule;
  if (!m.supportsOnDeviceRecognition()) {
    throw new OfflineSpeechError(
      "This phone can't recognise speech offline (needs Android 13+ or a recent iPhone). " +
        "Turn off \"Offline speech only\" to allow the phone's online recogniser.",
    );
  }
  if (Platform.OS !== "android") return; // iOS reports per-request; nothing to pre-download
  let installed: string[] = [];
  try {
    installed = (await m.getSupportedLocales({ androidRecognitionServicePackage: "com.google.android.as" })).installedLocales;
  } catch {
    return; // can't tell – let the recogniser try
  }
  if (installed.length === 0 || installed.some((l) => sameLanguage(l, locale))) return;
  const r = await m.androidTriggerOfflineModelDownload({ locale }).catch(() => null);
  throw new OfflineSpeechError(
    r?.status === "download_success"
      ? `Offline ${languageName} speech is ready – tap the mic again.`
      : `Downloading offline ${languageName} speech recognition. Try again when it finishes ` +
        "(Settings → System → Languages → On-device speech recognition).",
  );
}

// Latin/Arabic/Indic sentence ends need a following space (so "3.50" isn't split);
// CJK full-width punctuation ends a sentence by itself.
const SENTENCE_END = /[.!?؟۔।]+["'”’)\]]*\s+|[。！？]+[」』）"]*\s*/g;

/**
 * Recognisers give a growing transcript per utterance. This emits each completed sentence as soon
 * as it appears (so live translation works like the cloud engine), and the rest when the utterance
 * ends. Returns the not-yet-emitted tail, for display.
 */
export function createSentenceSplitter(emit: (sentence: string) => void) {
  let text = "";
  let emitted = 0;
  return {
    push(next: string, isFinal: boolean): string {
      if (emitted > 0 && !next.startsWith(text.slice(0, emitted))) {
        // The recogniser changed text we already sent for translation. Same beginning → it revised
        // an emitted sentence: don't translate it twice. Different text → it restarted (new speech).
        const sameStart = next.slice(0, 6).toLowerCase() === text.slice(0, 6).toLowerCase();
        emitted = sameStart ? Math.min(emitted, next.length) : 0;
      }
      text = next;
      const rest = text.slice(emitted);
      let last = 0;
      for (const m of rest.matchAll(SENTENCE_END)) {
        const end = (m.index ?? 0) + m[0].length;
        const sentence = rest.slice(last, end).trim();
        if (sentence) emit(sentence);
        last = end;
      }
      emitted += last;
      if (isFinal) {
        const tail = text.slice(emitted).trim();
        if (tail) emit(tail);
        text = "";
        emitted = 0;
      }
      return text.slice(emitted).trim();
    },
    /** Emit whatever is left (recogniser stopped without a final result). */
    flush() {
      return this.push(text, true);
    },
    reset() {
      text = "";
      emitted = 0;
    },
  };
}

export function useDeviceRecognition(
  opts: {
    onFinal?: (seg: Segment, previous: Segment[]) => void;
    onMaxDuration?: () => void;
    /** The recogniser stopped by itself (error, or it gave up) while we were still recording. */
    onEnded?: () => void;
  } = {},
) {
  const onFinalRef = useRef(opts.onFinal);
  onFinalRef.current = opts.onFinal;
  const onEndedRef = useRef(opts.onEnded);
  onEndedRef.current = opts.onEnded;
  /** True between "start" and "end" of the native recogniser. */
  const running = useRef(false);
  const stopping = useRef(false);
  const startTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [liveText, setLiveText] = useState("");
  const [connected, setConnected] = useState(false);
  const segments = useRef<Segment[]>([]);
  const pending = useRef("");
  const counter = useRef(0);
  const active = useRef(false);
  const errorMessage = useRef<string | null>(null);
  const endWaiter = useRef<(() => void) | null>(null);

  const render = () => {
    const done = segments.current.map((s) => s.text).join(" ");
    setLiveText([done, pending.current].filter(Boolean).join(" "));
  };

  const emit = (t: string) => {
    const seg: Segment = { id: `d${++counter.current}`, text: t, final: true };
    const previous = [...segments.current];
    segments.current.push(seg);
    onFinalRef.current?.({ ...seg }, previous);
  };

  const splitter = useRef(createSentenceSplitter((t) => emit(t))).current;
  const onTranscript = (text: string, isFinal: boolean) => {
    pending.current = splitter.push(text, isFinal);
    render();
  };

  useEffect(() => {
    if (!sr) return;
    const m = sr.ExpoSpeechRecognitionModule;
    const subs = [
      m.addListener("start", () => {
        running.current = true;
        if (startTimer.current) clearTimeout(startTimer.current);
        setConnected(true);
      }),
      m.addListener("result", (e) => {
        if (!active.current) return;
        const text = e.results[0]?.transcript ?? "";
        onTranscript(text, e.isFinal);
      }),
      m.addListener("error", (e) => {
        // "no-speech" just means silence; anything else is worth reporting.
        if (e.error === "language-not-supported")
          errorMessage.current =
            "This language can't be recognised offline on this phone. Install its offline speech model in the " +
            "phone's settings, or turn off \"Offline speech only\".";
        else if (e.error === "network")
          errorMessage.current = "The phone's recogniser needs the internet for this language. Turn on \"Offline speech only\" only for languages with an offline model.";
        else if (e.error !== "no-speech" && e.error !== "aborted")
          errorMessage.current = `${e.message || "Speech recognition failed"} (${e.error})`;
      }),
      m.addListener("end", () => {
        running.current = false;
        setConnected(false);
        endWaiter.current?.();
        // Ended on its own while the user is still "recording" → finish the turn so the UI
        // doesn't hang, and so any error is shown right away.
        if (active.current && !stopping.current) onEndedRef.current?.();
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  const start = useCallback(
    async (locale: string, opts2: { echoCancellation?: boolean; offlineOnly?: boolean; languageName?: string } = {}) => {
    if (!sr) throw new Error("On-device speech recognition needs a development build (not available in Expo Go).");
    const perm = await sr.ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) throw new Error("Allow microphone and speech recognition access in Settings.");
    if (opts2.offlineOnly) await ensureOfflineSpeech(locale, opts2.languageName ?? locale);
    segments.current = [];
    splitter.reset();
    pending.current = "";
    errorMessage.current = null;
    setLiveText("");
    setConnected(false);
    active.current = true;
    stopping.current = false;
    running.current = false;
    if (startTimer.current) clearTimeout(startTimer.current);
    startTimer.current = setTimeout(() => {
      if (active.current && !running.current && !stopping.current) {
        errorMessage.current ??= "Speech recognition didn't start on this phone.";
        onEndedRef.current?.();
      }
    }, 6000);
    sr.ExpoSpeechRecognitionModule.start({
      lang: locale,
      interimResults: true,
      continuous: true,
      addsPunctuation: true,
      // Keep audio on the phone: never fall back to a cloud recogniser.
      requiresOnDeviceRecognition: !!opts2.offlineOnly,
      // iOS: cancel the phone's own voice from the mic when speaking through the loudspeaker.
      iosVoiceProcessingEnabled: !!opts2.echoCancellation,
    });
    },
    [],
  );

  const stop = useCallback(async (): Promise<LiveResult> => {
    stopping.current = true;
    if (startTimer.current) clearTimeout(startTimer.current);
    if (sr && active.current && running.current) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 4000);
        endWaiter.current = () => {
          clearTimeout(t);
          resolve();
        };
        sr!.ExpoSpeechRecognitionModule.stop(); // final results arrive before "end"
      });
    }
    endWaiter.current = null;
    active.current = false;
    // Whatever the recogniser hadn't finalised yet still counts.
    pending.current = splitter.flush();
    const segs = segments.current.filter((s) => s.text.trim());
    return {
      transcript: segs.map((s) => s.text).join(" "),
      segments: segs,
      fileUri: null,
      liveFailed: !!errorMessage.current && segs.length === 0,
      rateLimited: false,
      errorMessage: errorMessage.current,
    };
  }, []);

  const cancel = useCallback(() => {
    active.current = false;
    if (startTimer.current) clearTimeout(startTimer.current);
    sr?.ExpoSpeechRecognitionModule.abort();
    setLiveText("");
  }, []);

  /** Recognisers can't be muted; echo is handled by iOS voice processing / headphones instead. */
  const setMuted = useCallback((_m: boolean) => {}, []);

  return { start, stop, cancel, setMuted, liveText, connected };
}
