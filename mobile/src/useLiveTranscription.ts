import { useCallback, useRef, useState } from "react";
import { Platform } from "react-native";
import { useAudioStream, type AudioStreamBuffer } from "expo-audio";
import { API_URL, APP_KEY } from "./config";

const TARGET_RATE = 24000; // OpenAI Realtime expects PCM16 mono @ 24 kHz

/** Linear resample + downmix of int16 PCM to mono 24 kHz. */
function toPcm24k(buf: AudioStreamBuffer): ArrayBuffer {
  const src = new Int16Array(buf.data);
  const ch = buf.channels || 1;
  const frames = Math.floor(src.length / ch);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += src[i * ch + c];
    mono[i] = s / ch;
  }
  if (buf.sampleRate === TARGET_RATE) return Int16Array.from(mono).buffer;
  const ratio = buf.sampleRate / TARGET_RATE;
  const outLen = Math.floor(frames / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, frames - 1);
    const v = mono[i0] + (mono[i1] - mono[i0]) * (pos - i0);
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return out.buffer;
}

export type Segment = { id: string; text: string; final: boolean };

export type LiveResult = {
  /** Full transcript from live recognition ("" if live recognition failed or heard nothing). */
  transcript: string;
  /** Finished segments in spoken order. */
  segments: Segment[];
  /** WAV file of the same speech, for the batch fallback (native only). */
  fileUri: string | null;
  liveFailed: boolean;
};

/**
 * Streams microphone audio to the backend and exposes the transcript as it is spoken.
 * `liveText` updates several times per second while the user talks.
 */
export function useLiveTranscription(opts: { onFinal?: (seg: Segment, previous: Segment[]) => void } = {}) {
  const onFinalRef = useRef(opts.onFinal);
  onFinalRef.current = opts.onFinal;
  /** While true, mic audio is not sent (e.g. while the phone is speaking a translation → no echo). */
  const muted = useRef(false);
  const onBufferRef = useRef<(b: AudioStreamBuffer) => void>(() => {});
  const { stream } = useAudioStream({
    sampleRate: TARGET_RATE,
    channels: 1,
    encoding: "int16",
    onBuffer: (b) => onBufferRef.current(b),
  });

  const [liveText, setLiveText] = useState("");
  const [connected, setConnected] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const segments = useRef<Segment[]>([]);
  const failed = useRef(false);
  const fileRecording = useRef(false);
  const doneWaiter = useRef<(() => void) | null>(null);

  const render = () => setLiveText(segments.current.map((s) => s.text).filter(Boolean).join(" "));

  const upsert = (id: string, text: string, final: boolean) => {
    let seg = segments.current.find((s) => s.id === id);
    const wasFinal = seg?.final ?? false;
    if (seg) Object.assign(seg, { text, final });
    else segments.current.push((seg = { id, text, final }));
    render();
    if (final && !wasFinal && text.trim()) {
      const previous = segments.current.filter((s) => s.final && s.id !== id && s.text.trim());
      onFinalRef.current?.({ ...seg }, previous);
    }
  };

  const start = useCallback(
    async (sttLanguage: string | null) => {
      segments.current = [];
      failed.current = false;
      setLiveText("");
      setConnected(false);

      const params = new URLSearchParams();
      if (sttLanguage) params.set("lang", sttLanguage);
      if (APP_KEY) params.set("key", APP_KEY);
      const socket = new WebSocket(`${API_URL.replace(/^http/, "ws")}/ws/transcribe?${params}`);
      socket.binaryType = "arraybuffer";
      ws.current = socket;
      const pendingAudio: ArrayBuffer[] = [];

      socket.onopen = () => pendingAudio.splice(0).forEach((b) => socket.send(b));
      socket.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        const msg = JSON.parse(e.data);
        if (msg.type === "ready") setConnected(true);
        else if (msg.type === "partial") upsert(msg.id, msg.text, false);
        else if (msg.type === "final") upsert(msg.id, msg.text, true);
        else if (msg.type === "error") failed.current = true;
        else if (msg.type === "done") doneWaiter.current?.();
      };
      socket.onerror = () => {
        failed.current = true;
        doneWaiter.current?.();
      };
      socket.onclose = () => {
        setConnected(false);
        doneWaiter.current?.();
      };

      muted.current = false;
      onBufferRef.current = (b) => {
        let pcm = toPcm24k(b);
        // Muted → send silence of equal length, so the server's VAD still sees the pause and closes the sentence.
        if (muted.current) pcm = new ArrayBuffer(pcm.byteLength);
        if (socket.readyState === WebSocket.OPEN) socket.send(pcm);
        else if (socket.readyState === WebSocket.CONNECTING) pendingAudio.push(pcm);
      };

      await stream.start();
      // Keep a WAV copy so the turn can still be translated if live recognition drops.
      fileRecording.current = false;
      if (Platform.OS !== "web") {
        try {
          await stream.startFileRecordingAsync({ format: "wav" });
          fileRecording.current = true;
        } catch {
          // optional
        }
      }
    },
    [stream],
  );

  const stop = useCallback(async (): Promise<LiveResult> => {
    let fileUri: string | null = null;
    if (fileRecording.current) {
      try {
        fileUri = (await stream.stopFileRecordingAsync()).uri;
      } catch {
        fileUri = null;
      }
    }
    stream.stop();
    onBufferRef.current = () => {};

    const socket = ws.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 7000);
        doneWaiter.current = () => {
          clearTimeout(t);
          resolve();
        };
        socket.send(JSON.stringify({ type: "stop" }));
      });
    }
    doneWaiter.current = null;
    socket?.close();
    ws.current = null;

    const segs = segments.current.filter((s) => s.text.trim());
    const transcript = segs.map((s) => s.text.trim()).join(" ");
    return { transcript, segments: segs, fileUri, liveFailed: failed.current || !socket };
  }, [stream]);

  /** Abort without waiting for results. */
  const cancel = useCallback(() => {
    try {
      stream.stop();
    } catch {}
    ws.current?.close();
    ws.current = null;
    setLiveText("");
  }, [stream]);

  const setMuted = useCallback((m: boolean) => {
    muted.current = m;
  }, []);

  return { start, stop, cancel, setMuted, liveText, connected };
}
