import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";
import { transcribe } from "./stt.js";
import { translate, TranslationRefusedError } from "./translate.js";
import { synthesize } from "./tts.js";
import { attachLiveTranscription } from "./live.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.use(express.json({ limit: "1mb" }));

// Optional shared-secret check so a deployed server isn't an open proxy to your API keys.
app.use((req, res, next) => {
  const key = process.env.APP_KEY;
  if (key && req.path !== "/health" && req.header("x-app-key") !== key) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * POST /api/speech-translate  (multipart/form-data)
 *   audio:           recorded audio file (m4a / wav / webm / mp3)
 *   sourceStt:       ISO-639-1 hint for STT, or empty for auto-detect
 *   sourceName:      English name of source language, or empty for auto-detect
 *   targetName:      English name of target language
 *   serverTts:       "1" to also return synthesized MP3 (base64)
 */
app.post("/api/speech-translate", upload.single("audio"), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "Missing audio" });
      return;
    }
    const targetName = str(req.body.targetName);
    if (!targetName) {
      res.status(400).json({ error: "Missing targetName" });
      return;
    }
    const transcript = await transcribe(
      req.file.buffer,
      req.file.originalname || "speech.m4a",
      req.file.mimetype || "audio/m4a",
      str(req.body.sourceStt),
    );
    if (!transcript) {
      res.json({ transcript: "", translation: "", detectedLanguage: null });
      return;
    }
    const result = await translate(transcript, str(req.body.sourceName), targetName);
    const audioBase64 =
      req.body.serverTts === "1" && result.translation
        ? (await synthesize(result.translation, targetName)).toString("base64")
        : undefined;
    res.json({ transcript, ...result, audioBase64 });
  } catch (err) {
    next(err);
  }
});

/** POST /api/translate  { text, sourceName?, targetName } – typed-text translation */
app.post("/api/translate", async (req, res, next) => {
  try {
    const text = str(req.body?.text);
    const targetName = str(req.body?.targetName);
    if (!text || !targetName) {
      res.status(400).json({ error: "Missing text or targetName" });
      return;
    }
    res.json(await translate(text, str(req.body.sourceName), targetName));
  } catch (err) {
    next(err);
  }
});

/** POST /api/tts  { text, languageName } -> { audioBase64 } (MP3) */
app.post("/api/tts", async (req, res, next) => {
  try {
    const text = str(req.body?.text);
    const languageName = str(req.body?.languageName);
    if (!text || !languageName) {
      res.status(400).json({ error: "Missing text or languageName" });
      return;
    }
    res.json({ audioBase64: (await synthesize(text, languageName)).toString("base64") });
  } catch (err) {
    next(err);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  if (err instanceof TranslationRefusedError) {
    res.status(422).json({ error: "This content could not be translated." });
  } else if (err instanceof Anthropic.RateLimitError) {
    res.status(429).json({ error: "Translation service is busy, try again." });
  } else if (err instanceof Anthropic.APIError) {
    res.status(502).json({ error: `Translation service error (${err.status})` });
  } else {
    res.status(500).json({ error: "Internal error" });
  }
});

const port = Number(process.env.PORT ?? 8787);
const server = app.listen(port, "0.0.0.0", () => console.log(`Speech translator API on :${port}`));
attachLiveTranscription(server);
