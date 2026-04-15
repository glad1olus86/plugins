import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { cacheKey, getFromCache, putInCache } from "../hooks/scripts/cache.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CACHE_FILE = join(homedir(), ".cache", "mismatch-auditor", "audit-cache.json");

function cleanCache() {
  try { rmSync(CACHE_FILE); } catch { /* ok */ }
}

// ========== cacheKey ==========

describe("cacheKey", () => {
  it("produces consistent sha256 hex string", () => {
    const k1 = cacheKey("intent text", "ls -la");
    const k2 = cacheKey("intent text", "ls -la");
    assert.equal(k1, k2);
    assert.match(k1, /^[0-9a-f]{64}$/);
  });

  it("different inputs produce different keys", () => {
    const k1 = cacheKey("intent A", "command A");
    const k2 = cacheKey("intent B", "command B");
    assert.notEqual(k1, k2);
  });

  it("uses last 200 chars of reasoning", () => {
    const longA = "x".repeat(300) + "TAIL";
    const longB = "y".repeat(300) + "TAIL";
    // Both end with same 200 chars, so keys should match
    const k1 = cacheKey(longA, "cmd");
    const k2 = cacheKey(longB, "cmd");
    // The last 200 chars of longA = "xxx...xTAIL" vs longB = "yyy...yTAIL"
    // They differ because the prefix within last 200 differs
    assert.notEqual(k1, k2);

    // Same tail → same key
    const base = "Z".repeat(300);
    const k3 = cacheKey("A" + base, "cmd");
    const k4 = cacheKey("B" + base, "cmd");
    // last 200 chars of both are identical (all Z's from the end)
    assert.equal(k3, k4);
  });
});

// ========== getFromCache / putInCache ==========

describe("cache read/write", () => {
  beforeEach(() => cleanCache());

  it("returns null on cache miss", () => {
    const result = getFromCache("intent", "cmd", { enabled: true });
    assert.equal(result, null);
  });

  it("stores and retrieves a result", () => {
    putInCache("intent", "cmd", { score: 0.2, reason: "ok" }, { enabled: true });
    const result = getFromCache("intent", "cmd", { enabled: true });
    assert.deepEqual(result, { score: 0.2, reason: "ok" });
  });

  it("returns null when cache is disabled", () => {
    putInCache("intent", "cmd", { score: 0.2, reason: "ok" }, { enabled: true });
    const result = getFromCache("intent", "cmd", { enabled: false });
    assert.equal(result, null);
  });

  it("does not write when cache is disabled", () => {
    putInCache("intent", "cmd", { score: 0.2, reason: "ok" }, { enabled: false });
    const result = getFromCache("intent", "cmd", { enabled: true });
    assert.equal(result, null);
  });

  it("respects TTL", () => {
    putInCache("intent", "cmd", { score: 0.2, reason: "ok" }, { enabled: true, ttlSeconds: 0 });
    // TTL=0 means everything is expired immediately
    const result = getFromCache("intent", "cmd", { enabled: true, ttlSeconds: 0 });
    assert.equal(result, null);
  });

  it("evicts oldest entries when maxSize exceeded", () => {
    const opts = { enabled: true, maxSize: 3 };
    putInCache("a", "1", { score: 0.1, reason: "a" }, opts);
    putInCache("b", "2", { score: 0.2, reason: "b" }, opts);
    putInCache("c", "3", { score: 0.3, reason: "c" }, opts);
    putInCache("d", "4", { score: 0.4, reason: "d" }, opts);

    // "a" should be evicted (oldest)
    assert.equal(getFromCache("a", "1", opts), null);
    // "d" should still be there
    assert.notEqual(getFromCache("d", "4", opts), null);
  });
});
