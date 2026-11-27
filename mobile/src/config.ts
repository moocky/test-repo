/**
 * Backend URL for the cloud engine (best quality, 116 languages, auto-detect). Set
 * EXPO_PUBLIC_API_URL in mobile/.env (or in eas.json for builds), e.g.
 *   EXPO_PUBLIC_API_URL=http://192.168.1.20:8787   (your computer's LAN IP while developing)
 * Leave it empty to run the app fully on-device: free, no server, no API keys.
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "").trim().replace(/\/$/, "");
export const APP_KEY = process.env.EXPO_PUBLIC_APP_KEY ?? "";

/** A server is configured, so the cloud engine can be used. */
export const CLOUD_CONFIGURED = API_URL !== "";
