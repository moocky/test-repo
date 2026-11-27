import OpenAI from "openai";

let _openai: OpenAI | null = null;
const openaiClient = () => (_openai ??= new OpenAI());

/** Server-side TTS used when the device has no voice for the target language. Returns MP3. */
export async function synthesize(text: string, languageName: string): Promise<Buffer> {
  const res = await openaiClient().audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: text,
    instructions: `Speak naturally in ${languageName}, with native pronunciation.`,
    response_format: "mp3",
  });
  return Buffer.from(await res.arrayBuffer());
}
