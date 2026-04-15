import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDITOR = join(__dirname, "..", "hooks", "scripts", "auditor.js");
const FIXTURES = join(__dirname, "fixtures");

/**
 * Run auditor.js with given stdin and env.
 * Returns { exitCode, stdout, stderr }.
 */
function runAuditor(stdinData, env = {}) {
  try {
    const stdout = execFileSync("node", [AUDITOR], {
      input: stdinData,
      env: {
        ...process.env,
        // Ensure no real API keys leak into tests
        GROQ_API_KEY_1: "",
        GROQ_API_KEY_2: "",
        OPENROUTER_API_KEY: "",
        AUDITOR_LOG_LEVEL: "silent",
        ...env,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      exitCode: err.status,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
    };
  }
}

// ========== Integration tests (no real API calls) ==========

describe("auditor.js integration", () => {
  it("passes through when AUDITOR_DISABLE=1", () => {
    const input = readFileSync(join(FIXTURES, "dangerous-mismatch.json"), "utf8");
    const { exitCode } = runAuditor(input, { AUDITOR_DISABLE: "1" });
    assert.equal(exitCode, 0);
  });

  it("passes through non-Bash events (no command field)", () => {
    const input = readFileSync(join(FIXTURES, "no-command.json"), "utf8");
    const { exitCode } = runAuditor(input);
    assert.equal(exitCode, 0);
  });

  it("passes through invalid JSON", () => {
    const { exitCode } = runAuditor("not json at all");
    assert.equal(exitCode, 0);
  });

  it("passes through empty stdin", () => {
    const { exitCode } = runAuditor("");
    assert.equal(exitCode, 0);
  });

  it("allows allowlisted command (git status)", () => {
    const input = readFileSync(join(FIXTURES, "safe-command.json"), "utf8");
    const { exitCode, stdout } = runAuditor(input);
    assert.equal(exitCode, 0);
    if (stdout) {
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput?.permissionDecision, "allow");
    }
  });

  it("blocks denylisted command (curl | bash)", () => {
    const input = readFileSync(join(FIXTURES, "denylist-curl-pipe.json"), "utf8");
    const { exitCode, stderr } = runAuditor(input);
    assert.equal(exitCode, 2);
    assert.ok(stderr.includes("BLOCKED"));
    assert.ok(stderr.includes("denylist"));
  });

  it("blocks denylisted rm -rf / from prompt-injection fixture", () => {
    const input = readFileSync(join(FIXTURES, "prompt-injection.json"), "utf8");
    const { exitCode, stderr } = runAuditor(input);
    assert.equal(exitCode, 2);
    assert.ok(stderr.includes("BLOCKED"));
  });

  it("passes through when no providers configured and no API keys", () => {
    // Command not in allowlist or denylist, no transcript, no providers → passthrough
    const input = JSON.stringify({
      session_id: "test",
      transcript_path: "",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
    });
    const { exitCode } = runAuditor(input);
    assert.equal(exitCode, 0);
  });
});
