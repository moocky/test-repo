import { requireOptionalNativeModule, type NativeModule } from "expo";

declare class DeviceTranslateNative extends NativeModule {
  supportedLanguages(): string[];
  translate(text: string, from: string, to: string): Promise<string>;
  isModelDownloaded(language: string): Promise<boolean>;
  downloadModel(language: string, wifiOnly: boolean): Promise<boolean>;
}

/** null in Expo Go / web, where this custom native module is not compiled in. */
const native = requireOptionalNativeModule<DeviceTranslateNative>("DeviceTranslate");

export const isAvailable = native !== null;

function require_(): DeviceTranslateNative {
  if (!native) throw new Error("On-device translation needs a development build (it is not available in Expo Go or on web).");
  return native;
}

/** Translate on the device (ML Kit). Language models are downloaded automatically on first use. */
export const translate = (text: string, from: string, to: string) => require_().translate(text, from, to);
export const isModelDownloaded = (language: string) => (native ? native.isModelDownloaded(language) : Promise.resolve(false));
export const downloadModel = (language: string, wifiOnly = false) => require_().downloadModel(language, wifiOnly);
