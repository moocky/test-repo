import * as DeviceTranslate from "../modules/device-translate";
import { textTranslate } from "./api";
import { CLOUD_CONFIGURED } from "./config";
import { deviceTranslateCode, type Language } from "./languages";

/**
 * "device": free and offline – OS speech recognition, ML Kit translation, OS voices. ~60 languages.
 * "cloud":  needs the server – OpenAI transcription, Claude translation. 116 languages, auto-detect.
 */
export type Engine = "device" | "cloud";

/** Without a configured server only the on-device engine exists. */
export const effectiveEngine = (preferred: Engine): Engine => (CLOUD_CONFIGURED ? preferred : "device");

export const deviceEngineAvailable = DeviceTranslate.isAvailable;

export type TextTranslation = { translation: string; detectedLanguage: string | null; detectedLanguageCode: string | null };

export class NeedsCloudError extends Error {}

/** Why a language pair can't run on the device, or null if it can. */
export function deviceProblem(source: Language | null, target: Language): string | null {
  if (!source) return "Auto-detect needs the cloud engine.";
  for (const l of [source, target]) {
    if (!deviceTranslateCode(l)) return `${l.name} can't be translated on the device${CLOUD_CONFIGURED ? " – switch to the cloud engine" : ""}.`;
  }
  return null;
}

export async function translateText(
  engine: Engine,
  text: string,
  source: Language | null,
  target: Language,
  context: string[] = [],
): Promise<TextTranslation> {
  if (engine === "cloud") {
    const r = await textTranslate(text, source, target, context);
    return { translation: r.translation, detectedLanguage: r.detectedLanguage ?? null, detectedLanguageCode: r.detectedLanguageCode ?? null };
  }
  const problem = deviceProblem(source, target);
  if (problem) throw new NeedsCloudError(problem);
  const from = deviceTranslateCode(source!)!;
  const translation = await DeviceTranslate.translate(text, from, deviceTranslateCode(target)!);
  return { translation, detectedLanguage: source!.name, detectedLanguageCode: from };
}

/** Make sure the offline language packs for these languages are on the device. */
export async function ensureLanguagePacks(langs: Language[]): Promise<"ready" | "downloaded"> {
  let downloaded = false;
  for (const l of langs) {
    const code = deviceTranslateCode(l);
    if (!code || (await DeviceTranslate.isModelDownloaded(code))) continue;
    await DeviceTranslate.downloadModel(code, false);
    downloaded = true;
  }
  return downloaded ? "downloaded" : "ready";
}

export async function languagePacksMissing(langs: Language[]): Promise<boolean> {
  for (const l of langs) {
    const code = deviceTranslateCode(l);
    if (code && !(await DeviceTranslate.isModelDownloaded(code))) return true;
  }
  return false;
}
