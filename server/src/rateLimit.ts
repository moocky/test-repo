import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";

/**
 * In-memory rate limiting. Good for a single server instance (e.g. one Render service);
 * with several instances behind a load balancer, move the counters to Redis.
 *
 * Every client is counted twice:
 *  - by device id (random id the app generates and sends) – the tighter limits
 *  - by IP address – looser limits, so rotating device ids doesn't bypass anything
 *    (and so many phones behind one mobile-carrier IP aren't punished too early).
 */

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const LIMITS = {
  devicePerMinute: num("RATE_LIMIT_DEVICE_PER_MINUTE", 40),
  ipPerMinute: num("RATE_LIMIT_IP_PER_MINUTE", 120),
  devicePerDay: num("RATE_LIMIT_DEVICE_PER_DAY", 600),
  ipPerDay: num("RATE_LIMIT_IP_PER_DAY", 3000),
  liveConcurrentPerDevice: num("LIVE_MAX_CONCURRENT_PER_DEVICE", 1),
  liveConcurrentPerIp: num("LIVE_MAX_CONCURRENT_PER_IP", 6),
  liveConcurrentTotal: num("LIVE_MAX_CONCURRENT_TOTAL", 50),
  liveMaxSeconds: num("LIVE_MAX_SECONDS", 180),
  maxTextChars: num("MAX_TEXT_CHARS", 2000),
};

class FixedWindow {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    // Drop expired counters so memory doesn't grow forever.
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }, Math.min(windowMs, 10 * 60_000)).unref();
  }

  /** Count one hit. Returns seconds to wait if over the limit, else 0. */
  hit(key: string): number {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    return entry.count > this.limit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }
}

const perMinuteDevice = new FixedWindow(LIMITS.devicePerMinute, 60_000);
const perMinuteIp = new FixedWindow(LIMITS.ipPerMinute, 60_000);
const perDayDevice = new FixedWindow(LIMITS.devicePerDay, 24 * 3600_000);
const perDayIp = new FixedWindow(LIMITS.ipPerDay, 24 * 3600_000);

/**
 * Real client IP. Behind a reverse proxy (Render, Fly, Cloudflare…) the socket address is the
 * proxy's, so read X-Forwarded-For – but only as many hops as TRUST_PROXY says, otherwise a
 * client could spoof its IP by sending the header itself.
 */
export function clientIp(req: IncomingMessage): string {
  const hops = Number(process.env.TRUST_PROXY ?? 1);
  const xff = req.headers["x-forwarded-for"];
  if (hops > 0 && typeof xff === "string") {
    const chain = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const ip = chain[chain.length - hops];
    if (ip) return ip;
  }
  return req.socket.remoteAddress ?? "unknown";
}

const DEVICE_ID = /^[A-Za-z0-9-]{16,64}$/;
export function deviceId(raw: unknown): string | null {
  return typeof raw === "string" && DEVICE_ID.test(raw) ? raw : null;
}

export type LimitResult = { ok: true } | { ok: false; retryAfter: number; scope: "minute" | "day" };

/** Count one billable request for this client. */
export function consume(ip: string, device: string | null): LimitResult {
  // Check every counter (so all of them advance), then report the longest wait.
  const minute = Math.max(perMinuteIp.hit(ip), device ? perMinuteDevice.hit(device) : 0);
  const day = Math.max(perDayIp.hit(ip), device ? perDayDevice.hit(device) : 0);
  if (day) return { ok: false, retryAfter: day, scope: "day" };
  if (minute) return { ok: false, retryAfter: minute, scope: "minute" };
  return { ok: true };
}

export function limitMessage(r: Extract<LimitResult, { ok: false }>): string {
  return r.scope === "day"
    ? "Daily limit reached. Please try again tomorrow."
    : `Too many requests. Please wait ${r.retryAfter} seconds and try again.`;
}

/** Express middleware for the billable endpoints. */
export function rateLimit(req: Request, res: Response, next: NextFunction) {
  const r = consume(clientIp(req), deviceId(req.header("x-device-id")));
  if (r.ok) return next();
  res.setHeader("Retry-After", String(r.retryAfter));
  res.status(429).json({ error: limitMessage(r), retryAfter: r.retryAfter });
}

/** Concurrency tracking for live-transcription WebSocket sessions. */
const liveByIp = new Map<string, number>();
const liveByDevice = new Map<string, number>();
let liveTotal = 0;

export function acquireLiveSlot(ip: string, device: string | null): (() => void) | string {
  if (liveTotal >= LIMITS.liveConcurrentTotal) return "Server busy, please try again shortly.";
  if ((liveByIp.get(ip) ?? 0) >= LIMITS.liveConcurrentPerIp) return "Too many live sessions from this network.";
  if (device && (liveByDevice.get(device) ?? 0) >= LIMITS.liveConcurrentPerDevice)
    return "A live session is already running on this device.";

  liveTotal++;
  liveByIp.set(ip, (liveByIp.get(ip) ?? 0) + 1);
  if (device) liveByDevice.set(device, (liveByDevice.get(device) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    liveTotal--;
    const dec = (m: Map<string, number>, k: string) => {
      const n = (m.get(k) ?? 1) - 1;
      if (n <= 0) m.delete(k);
      else m.set(k, n);
    };
    dec(liveByIp, ip);
    if (device) dec(liveByDevice, device);
  };
}
