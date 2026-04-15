import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { checkMismatch } from "../hooks/scripts/providers.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const RATE_STATE_FILE = join(homedir(), ".cache", "mismatch-auditor", "rate-state.json");

function cleanRateState() {
  try { rmSync(RATE_STATE_FILE); } catch { /* ok */ }
}

// Mock fetch for testing without real API calls
function mockFetchSuccess(score, reason) {
  return mock.fn(() =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            { message: { content: JSON.stringify({ score, reason }) } },
          ],
        }),
    })
  );
}

function mockFetchFailure(status, body) {
  return mock.fn(() =>
    Promise.resolve({
      ok: false,
      status,
      text: () => Promise.resolve(body || "error"),
    })
  );
}

const PROVIDERS = [
  {
    name: "test-provider-1",
    apiBase: "https://api.example.com/v1",
    model: "test-model",
    envKey: "TEST_API_KEY_1",
    priority: 1,
    rateLimit: { maxRequestsPerMinute: 30 },
  },
  {
    name: "test-provider-2",
    apiBase: "https://api.example2.com/v1",
    model: "test-model-2",
    envKey: "TEST_API_KEY_2",
    priority: 2,
    rateLimit: { maxRequestsPerMinute: 30 },
  },
];

describe("checkMismatch", () => {
  let originalFetch;

  beforeEach(() => {
    cleanRateState();
    originalFetch = globalThis.fetch;
    process.env.TEST_API_KEY_1 = "test-key-1";
    process.env.TEST_API_KEY_2 = "test-key-2";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_API_KEY_1;
    delete process.env.TEST_API_KEY_2;
  });

  it("returns score from first provider on success", async () => {
    globalThis.fetch = mockFetchSuccess(0.15, "consistent");

    const result = await checkMismatch(
      { reasoning: "List files", command: "ls -la" },
      PROVIDERS
    );

    assert.equal(result.score, 0.15);
    assert.equal(result.reason, "consistent");
  });

  it("falls back to second provider on first failure", async () => {
    let callCount = 0;
    globalThis.fetch = mock.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              { message: { content: '{"score": 0.85, "reason": "mismatch"}' } },
            ],
          }),
      });
    });

    const result = await checkMismatch(
      { reasoning: "Read file", command: "rm -rf /home" },
      PROVIDERS
    );

    assert.equal(result.score, 0.85);
    assert.equal(callCount, 2);
  });

  it("throws when all providers fail", async () => {
    globalThis.fetch = mockFetchFailure(500, "down");

    await assert.rejects(
      () => checkMismatch({ reasoning: "test", command: "test" }, PROVIDERS),
      /test-provider-2.*HTTP 500/
    );
  });

  it("throws with no providers", async () => {
    await assert.rejects(
      () => checkMismatch({ reasoning: "test", command: "test" }, []),
      /No providers configured/
    );
  });

  it("skips provider with missing API key", async () => {
    delete process.env.TEST_API_KEY_1;
    globalThis.fetch = mockFetchSuccess(0.1, "ok");

    const result = await checkMismatch(
      { reasoning: "List files", command: "ls" },
      PROVIDERS
    );

    assert.equal(result.score, 0.1);
    // Should have only called fetch once (skipped first provider)
    assert.equal(globalThis.fetch.mock.callCount(), 1);
  });

  it("handles malformed LLM response", async () => {
    globalThis.fetch = mock.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "I cannot help with that" } }],
          }),
      })
    );

    // Both providers return garbage → should throw
    await assert.rejects(
      () => checkMismatch({ reasoning: "test", command: "test" }, PROVIDERS),
      /Cannot parse/
    );
  });

  it("respects provider priority order", async () => {
    const reversedProviders = [
      { ...PROVIDERS[1], priority: 1 },
      { ...PROVIDERS[0], priority: 2 },
    ];

    const urls = [];
    globalThis.fetch = mock.fn((url) => {
      urls.push(url);
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              { message: { content: '{"score": 0.0, "reason": "ok"}' } },
            ],
          }),
      });
    });

    await checkMismatch(
      { reasoning: "test", command: "ls" },
      reversedProviders
    );

    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes("example2")); // provider-2 has priority 1 now
  });
});
