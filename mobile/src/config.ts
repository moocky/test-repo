/**
 * Backend URL. Set EXPO_PUBLIC_API_URL in mobile/.env, e.g.
 *   EXPO_PUBLIC_API_URL=http://192.168.1.20:8787   (your computer's LAN IP while developing)
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
export const APP_KEY = process.env.EXPO_PUBLIC_APP_KEY ?? "";
