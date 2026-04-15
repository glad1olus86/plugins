/**
 * File-based LRU cache with TTL.
 * Stores audit results to avoid repeated LLM calls for identical (reasoning, command) pairs.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const CACHE_DIR = join(homedir(), ".cache", "mismatch-auditor");
const CACHE_FILE = join(CACHE_DIR, "audit-cache.json");

/**
 * Build cache key from reasoning tail + command.
 * @param {string} reasoning
 * @param {string} command
 * @returns {string}
 */
export function cacheKey(reasoning, command) {
  const tail = reasoning.slice(-200);
  return createHash("sha256").update(tail + "\n" + command).digest("hex");
}

/**
 * Read the cache file. Returns empty map on any error.
 * @returns {Map<string, { score: number, reason: string, timestamp: number }>}
 */
function readCache() {
  try {
    const raw = readFileSync(CACHE_FILE, "utf8");
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return new Map();
    return new Map(entries.map(e => [e.key, e]));
  } catch {
    return new Map();
  }
}

/**
 * Write cache map to file. Silently ignores errors.
 * @param {Map<string, object>} map
 */
function writeCache(map) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const entries = [...map.values()];
    writeFileSync(CACHE_FILE, JSON.stringify(entries), "utf8");
  } catch {
    // fail-open: cache write failure is not critical
  }
}

/**
 * @param {string} reasoning
 * @param {string} command
 * @param {{ enabled?: boolean, maxSize?: number, ttlSeconds?: number }} opts
 * @returns {{ score: number, reason: string } | null}
 */
export function getFromCache(reasoning, command, opts = {}) {
  if (opts.enabled === false) return null;

  const ttlSec = opts.ttlSeconds ?? 300;
  if (ttlSec <= 0) return null; // TTL=0 means cache disabled for reads

  const ttl = ttlSec * 1000;
  const key = cacheKey(reasoning, command);
  const map = readCache();
  const entry = map.get(key);

  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttl) return null;

  return { score: entry.score, reason: entry.reason };
}

/**
 * @param {string} reasoning
 * @param {string} command
 * @param {{ score: number, reason: string }} result
 * @param {{ enabled?: boolean, maxSize?: number, ttlSeconds?: number }} opts
 */
export function putInCache(reasoning, command, result, opts = {}) {
  if (opts.enabled === false) return;

  const maxSize = opts.maxSize ?? 256;
  const key = cacheKey(reasoning, command);
  const map = readCache();

  map.set(key, {
    key,
    score: result.score,
    reason: result.reason,
    timestamp: Date.now(),
  });

  // Evict oldest entries if over limit
  if (map.size > maxSize) {
    const sorted = [...map.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = sorted.slice(0, map.size - maxSize);
    for (const [k] of toRemove) map.delete(k);
  }

  writeCache(map);
}
