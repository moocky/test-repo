import { requireOptionalNativeModule, type NativeModule } from "expo";

export type AudioRoute = {
  /** Output is wired, Bluetooth or USB headphones (no echo into the phone's mic). */
  headphones: boolean;
  type: "wired" | "bluetooth" | "usb" | "speaker";
  name: string;
};

type Events = { onChange: (route: AudioRoute) => void };

declare class AudioRouteNative extends NativeModule<Events> {
  getCurrentRoute(): AudioRoute;
}

/** null in Expo Go / web, where this custom native module is not compiled in. */
const native = requireOptionalNativeModule<AudioRouteNative>("AudioRoute");

export const isAvailable = native !== null;

export function getCurrentRoute(): AudioRoute | null {
  try {
    return native?.getCurrentRoute() ?? null;
  } catch {
    return null;
  }
}

export function addRouteListener(listener: (route: AudioRoute) => void): () => void {
  if (!native) return () => {};
  const sub = native.addListener("onChange", listener);
  return () => sub.remove();
}
