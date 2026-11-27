import type { Server } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import OpenAI from "openai";
import { OpenAIRealtimeWS } from "openai/realtime/ws";
import { LIMITS, acquireLiveSlot, clientIp, consume, deviceId, limitMessage } from "./rateLimit.js";

/**
 * Live transcription proxy:  app  <—ws—>  this server  <—ws—>  OpenAI Realtime (transcription intent)
 *
 * App → server
 *   binary frame          PCM16 little-endian, mono, 24 kHz
 *   {"type":"stop"}       speaker finished; flush and finalize
 * Server → app
 *   {"type":"ready"}
 *   {"type":"partial","id","text"}   growing text of the current segment
 *   {"type":"final","id","text"}     finished segment (server VAD splits on pauses)
 *   {"type":"maxDuration"}           session hit LIVE_MAX_SECONDS; server finalizes as if "stop"
 *   {"type":"done"}                  everything finalized after "stop"
 *   {"type":"error","message"}
 *
 * The API key stays on the server; the app never talks to OpenAI directly.
 */
export function attachLiveTranscription(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws/transcribe", maxPayload: 1024 * 1024 });

  wss.on("connection", async (client, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const appKey = process.env.APP_KEY;
    if (appKey && url.searchParams.get("key") !== appKey) {
      client.close(4401, "Unauthorized");
      return;
    }
    // Rate limits: each live session counts as one request, plus concurrency caps.
    const ip = clientIp(req);
    const device = deviceId(url.searchParams.get("device"));
    const limited = consume(ip, device);
    if (!limited.ok) {
      client.send(JSON.stringify({ type: "error", message: limitMessage(limited), retryAfter: limited.retryAfter }));
      client.close(4429, "Rate limited");
      return;
    }
    const release = acquireLiveSlot(ip, device);
    if (typeof release === "string") {
      client.send(JSON.stringify({ type: "error", message: release }));
      client.close(4429, "Too many live sessions");
      return;
    }

    const language = url.searchParams.get("lang") || undefined;
    const prompt = url.searchParams.get("prompt") || undefined;

    const send = (msg: object) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(msg));
    const queued: Buffer[] = [];
    let upstream: OpenAIRealtimeWS | null = null;
    let upstreamReady = false;
    let stopping = false;
    const pending = new Set<string>(); // committed segments awaiting their final transcript
    const partials = new Map<string, string>();
    let doneTimer: NodeJS.Timeout | null = null;

    const appendAudio = (chunk: Buffer) =>
      upstream!.send({ type: "input_audio_buffer.append", audio: chunk.toString("base64") });

    const finish = () => {
      if (doneTimer) clearTimeout(doneTimer);
      clearTimeout(maxTimer);
      release();
      send({ type: "done" });
      upstream?.close({ code: 1000, reason: "done" });
      client.close(1000);
    };
    // After "stop": wait until every committed segment has its transcript (max 6 s).
    const maybeFinish = () => {
      if (stopping && pending.size === 0) setTimeout(() => pending.size === 0 && finish(), 400);
    };

    const beginStop = () => {
      if (stopping) return;
      stopping = true;
      doneTimer = setTimeout(finish, 6000);
      if (upstreamReady) upstream!.send({ type: "input_audio_buffer.commit" });
      maybeFinish();
    };
    // Cap session length so one forgotten open mic can't run up the bill.
    const maxTimer = setTimeout(() => {
      send({ type: "maxDuration", seconds: LIMITS.liveMaxSeconds });
      beginStop();
    }, LIMITS.liveMaxSeconds * 1000);

    client.on("message", (data: RawData, isBinary) => {
      if (isBinary) {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (stopping) return;
        if (upstreamReady) appendAudio(chunk);
        else if (queued.length < 500) queued.push(chunk); // ~20 s of audio while connecting
        return;
      }
      let msg: { type?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "stop") beginStop();
    });

    client.on("close", () => {
      if (doneTimer) clearTimeout(doneTimer);
      clearTimeout(maxTimer);
      release();
      upstream?.close({ code: 1000, reason: "client closed" });
    });

    try {
      upstream = await OpenAIRealtimeWS.create(new OpenAI(), { intent: "transcription" });
      if (upstream.socket.readyState !== WebSocket.OPEN) {
        await new Promise<void>((resolve, reject) => {
          upstream!.socket.once("open", () => resolve());
          upstream!.socket.once("error", reject);
        });
      }

      upstream.send({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              noise_reduction: { type: "near_field" },
              transcription: { model: "gpt-4o-transcribe", ...(language ? { language } : {}), ...(prompt ? { prompt } : {}) },
              // Split into segments on short pauses so finished sentences appear while still talking.
              turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
            },
          },
        },
      });

      upstream.on("input_audio_buffer.committed", (ev) => pending.add(ev.item_id));
      upstream.on("conversation.item.input_audio_transcription.delta", (ev) => {
        const text = (partials.get(ev.item_id) ?? "") + (ev.delta ?? "");
        partials.set(ev.item_id, text);
        send({ type: "partial", id: ev.item_id, text });
      });
      upstream.on("conversation.item.input_audio_transcription.completed", (ev) => {
        pending.delete(ev.item_id);
        partials.delete(ev.item_id);
        send({ type: "final", id: ev.item_id, text: ev.transcript.trim() });
        maybeFinish();
      });
      upstream.on("conversation.item.input_audio_transcription.failed", (ev) => {
        pending.delete(ev.item_id);
        maybeFinish();
      });
      upstream.on("error", (err) => {
        // Committing an empty/too-short buffer on stop is expected and harmless.
        if (/buffer too small|buffer is empty|empty/i.test(err.message)) {
          maybeFinish();
          return;
        }
        console.error("realtime error:", err.message);
        send({ type: "error", message: err.message });
      });
      upstream.on("close", () => client.readyState === WebSocket.OPEN && finish());

      upstreamReady = true;
      for (const chunk of queued.splice(0)) appendAudio(chunk);
      send({ type: "ready" });
      if (stopping) upstream.send({ type: "input_audio_buffer.commit" });
    } catch (err) {
      console.error("live transcription setup failed:", err);
      send({ type: "error", message: "Live transcription unavailable" });
      client.close(1011);
    }
  });
}
