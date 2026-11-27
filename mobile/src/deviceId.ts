import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Random per-install id, sent to the server so rate limits apply per device rather than per
 * network (many phones can share one mobile-carrier IP). Not personal data, not a secret.
 */
const KEY = "deviceId.v1";
let cached: string | null = null;
let loading: Promise<string> | null = null;

function generate(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getDeviceId(): Promise<string> {
  if (cached) return Promise.resolve(cached);
  loading ??= (async () => {
    let id: string | null = null;
    try {
      id = await AsyncStorage.getItem(KEY);
    } catch {}
    if (!id || !/^[A-Za-z0-9-]{16,64}$/.test(id)) {
      id = generate();
      AsyncStorage.setItem(KEY, id).catch(() => {});
    }
    cached = id;
    return id;
  })();
  return loading;
}
