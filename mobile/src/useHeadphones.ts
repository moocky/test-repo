import { useEffect, useState } from "react";
import { addRouteListener, getCurrentRoute, isAvailable, type AudioRoute } from "../modules/audio-route";

/**
 * Live headphone state from the OS audio route (wired, Bluetooth, USB).
 * `detectable` is false in Expo Go / web, where the native module isn't compiled in;
 * the app then falls back to a manual "I'm wearing headphones" switch.
 */
export function useHeadphones() {
  const [route, setRoute] = useState<AudioRoute | null>(() => getCurrentRoute());
  useEffect(() => addRouteListener(setRoute), []);
  return { detectable: isAvailable, route, connected: route?.headphones ?? false };
}
