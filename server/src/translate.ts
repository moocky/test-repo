import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;
const claude = () => (_client ??= new Anthropic());

export type TranslationResult = {
  detectedLanguage: string;
  translation: string;
};

const SYSTEM = `You are a professional real-time interpreter inside a speech translation app.
You receive a speech-to-text transcript (it may contain recognition errors, missing punctuation or filler words).
Translate it into the requested target language so it sounds natural when read aloud by a text-to-speech voice:
- Preserve meaning, tone, register and names. Fix obvious transcription mistakes silently.
- Write numbers, dates and units the way a native speaker would say them.
- Use the target language's native script.
- Output only the translation, never commentary, notes or the original text.
Also report the source language you detected, as its English name.`;

const SCHEMA = {
  type: "object",
  properties: {
    detected_language: { type: "string", description: "English name of the transcript's language" },
    translation: { type: "string" },
  },
  required: ["detected_language", "translation"],
  additionalProperties: false,
} as const;

export class TranslationRefusedError extends Error {}

export async function translate(
  transcript: string,
  sourceLanguageName: string | null,
  targetLanguageName: string,
  /** Earlier sentences of the same utterance (source language), for live segment-by-segment translation. */
  context: string[] = [],
): Promise<TranslationResult> {
  const source = sourceLanguageName
    ? `The speaker selected ${sourceLanguageName} as their language.`
    : "The source language is unknown; detect it.";

  const response = await claude().beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4096,
    // Live conversation: favour latency. Translation doesn't need deep reasoning.
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: SCHEMA },
    },
    // Re-route a rare safety decline to a fallback model instead of failing the turn.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `${source}\nTarget language: ${targetLanguageName}\n\n` +
          (context.length
            ? `This is a live, sentence-by-sentence translation. Earlier sentences from the same speaker, for context only (already translated, do NOT translate them again):\n<context>\n${context.join("\n")}\n</context>\n\nTranslate only this new segment, continuing naturally from the context:\n`
            : "") +
          `<transcript>\n${transcript}\n</transcript>`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new TranslationRefusedError(response.stop_details?.explanation ?? "Request declined");
  }

  const text = response.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("");
  const parsed = JSON.parse(text) as { detected_language: string; translation: string };
  return { detectedLanguage: parsed.detected_language, translation: parsed.translation.trim() };
}
