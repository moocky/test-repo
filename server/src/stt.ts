import OpenAI, { toFile } from "openai";

let _openai: OpenAI | null = null;
const openaiClient = () => (_openai ??= new OpenAI());

/**
 * Speech-to-text. `languageHint` is an ISO-639-1 code; when null the model auto-detects.
 */
export async function transcribe(
  audio: Buffer,
  filename: string,
  mimeType: string,
  languageHint: string | null,
): Promise<string> {
  const file = await toFile(audio, filename, { type: mimeType });
  const result = await openaiClient().audio.transcriptions.create({
    file,
    model: "gpt-4o-transcribe",
    ...(languageHint ? { language: languageHint } : {}),
  });
  return result.text.trim();
}
