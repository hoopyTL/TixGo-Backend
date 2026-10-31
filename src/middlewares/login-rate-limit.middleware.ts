import { createHash } from "node:crypto";
import { NextFunction, RequestHandler } from "express";
import { TooManyRequestsError } from "../errors/http-errors";

type Window = { count: number; resetAt: number };

type LoginRateLimitOptions = {
  windowMs?: number;
  principalLimit?: number;
  ipLimit?: number;
  maxEntries?: number;
  now?: () => number;
};

export const createLoginRateLimiter = (options: LoginRateLimitOptions = {}): RequestHandler => {
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const principalLimit = options.principalLimit ?? 5;
  const ipLimit = options.ipLimit ?? 100;
  const maxEntries = options.maxEntries ?? 10000;
  const now = options.now ?? Date.now;
  for (const [name, value] of Object.entries({ windowMs, principalLimit, ipLimit, maxEntries })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  if (maxEntries < 2) throw new Error("maxEntries must allow an IP and a principal window");

  const windows = new Map<string, Window>();
  let nextSweepAt = 0;
  const reject = (next: NextFunction, resetAt: number, time: number): void => {
    const retryAfter = Math.max(1, Math.ceil((resetAt - time) / 1000));
    next(new TooManyRequestsError("Too many login attempts. Try again later.", retryAfter));
  };

  return (req, res, next) => {
    const time = now();
    if (time >= nextSweepAt || windows.size >= maxEntries) {
      for (const [key, window] of windows) {
        if (window.resetAt <= time) windows.delete(key);
      }
      nextSweepAt = time + Math.min(windowMs, 60000);
    }

    // Express derives req.ip from the socket while trust proxy remains false.
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const ipKey = `ip:${ip}`;
    // Avoid retaining email addresses, password fields or access tokens in the store.
    const principalKey = `principal:${createHash("sha256").update(JSON.stringify([ip, email])).digest("hex")}`;
    for (const key of [ipKey, principalKey]) {
      if ((windows.get(key)?.resetAt ?? Infinity) <= time) windows.delete(key);
    }

    const ipWindow = windows.get(ipKey);
    if (ipWindow && ipWindow.count >= ipLimit) {
      reject(next, ipWindow.resetAt, time);
      return;
    }

    const missing = Number(!windows.has(ipKey)) + Number(!windows.has(principalKey));
    if (windows.size + missing > maxEntries) {
      // Do not evict active entries: eviction would let an attacker reset a budget.
      let resetAt = time + windowMs;
      for (const window of windows.values()) resetAt = Math.min(resetAt, window.resetAt);
      reject(next, resetAt, time);
      return;
    }

    let blockedUntil = 0;
    for (const [key, limit] of [[ipKey, ipLimit], [principalKey, principalLimit]] as const) {
      let window = windows.get(key);
      if (!window) {
        window = { count: 0, resetAt: time + windowMs };
        windows.set(key, window);
      }
      window.count = Math.min(window.count + 1, limit + 1);
      if (window.count > limit) blockedUntil = Math.max(blockedUntil, window.resetAt);
    }
    if (blockedUntil) {
      reject(next, blockedUntil, time);
      return;
    }
    next();
  };
};

// This store is local to one process. Multiple API instances need a shared store.
export const loginRateLimiter = createLoginRateLimiter();
