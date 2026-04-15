#!/usr/bin/env node

/**
 * Mismatch Auditor — PreToolUse hook for Claude Code.
 * Verifies that bash commands match the agent's stated intent.
 *
 * stdin:  JSON event from Claude Code (PreToolUse)
 * stdout: JSON with hookSpecificOutput (permissionDecision)
 * stderr: human-readable log messages
 * exit 0: allow / non-blocking
 * exit 2: block command
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAllowlist, checkDenylist } from "./allowlist.js";
import { getFromCache, putInCache } from "./cache.js";
import { checkMismatch } from "./providers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---

function loadConfig() {
  // Config resolution: explicit env > plugin root > relative to script
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const configPath =
    process.env.AUDITOR_CONFIG ||
    (pluginRoot ? join(pluginRoot, "config", "auditor.config.json") : null) ||
    join(__dirname, "..", "..", "config", "auditor.config.json");

  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    // Return minimal defaults if config not found
    return {
      providers: [],
      threshold: 0.7,
      allowlist: [],
      denylist: [],
      cache: { enabled: true, maxSize: 256, ttlSeconds: 300 },
      logging: { level: "warn" },
    };
  }
}

// --- Logging ---

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

function createLogger(level) {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.warn;
  return {
    debug: (...args) => threshold <= 0 && process.stderr.write(`[mismatch-auditor] DEBUG: ${args.join(" ")}\n`),
    info:  (...args) => threshold <= 1 && process.stderr.write(`[mismatch-auditor] INFO: ${args.join(" ")}\n`),
    warn:  (...args) => threshold <= 2 && process.stderr.write(`[mismatch-auditor] WARN: ${args.join(" ")}\n`),
    error: (...args) => threshold <= 3 && process.stderr.write(`[mismatch-auditor] ERROR: ${args.join(" ")}\n`),
  };
}

// --- Reasoning extraction from transcript ---

function extractReasoning(transcriptPath) {
  if (!transcriptPath) return null;

  try {
    const content = readFileSync(transcriptPath, "utf8");

    // Read last ~8KB for efficiency
    const tail = content.length > 8192 ? content.slice(-8192) : content;
    const lines = tail.split("\n").filter(Boolean);

    // Walk backwards, find last assistant message with text
    for (let i = lines.length - 1; i >= 0; i--) {
      let msg;
      try {
        msg = JSON.parse(lines[i]);
      } catch {
        continue;
      }

      if (msg.role !== "assistant") continue;

      // content can be string or array of blocks
      if (typeof msg.content === "string" && msg.content.trim()) {
        return msg.content.slice(-500);
      }
      if (Array.isArray(msg.content)) {
        const textBlock = msg.content.findLast?.(b => b.type === "text" && b.text?.trim())
          || [...msg.content].reverse().find(b => b.type === "text" && b.text?.trim());
        if (textBlock?.text) return textBlock.text.slice(-500);
      }
    }
  } catch {
    // transcript unreadable
  }

  return null;
}

// --- Output helpers ---

function allow(reason) {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: `Mismatch Auditor: ${reason}`,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

function deny(reason) {
  process.stderr.write(`[mismatch-auditor] BLOCKED: ${reason}\n`);
  process.exit(2);
}

function passthrough() {
  // No output, exit 0 — Claude Code proceeds normally
  process.exit(0);
}

// --- stdin reader ---

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

// --- Main ---

async function main() {
  // Quick bail: disabled by env
  if (process.env.AUDITOR_DISABLE === "1") process.exit(0);

  const config = loadConfig();
  const logLevel = process.env.AUDITOR_LOG_LEVEL
    || process.env.CLAUDE_PLUGIN_OPTION_LOG_LEVEL
    || config.logging?.level;
  const log = createLogger(logLevel);
  const threshold = parseFloat(
    process.env.AUDITOR_THRESHOLD
    || process.env.CLAUDE_PLUGIN_OPTION_THRESHOLD
    || config.threshold
  ) || 0.7;

  // 1. Parse stdin event
  let event;
  try {
    const raw = await readStdin();
    event = JSON.parse(raw);
  } catch {
    passthrough(); // not our format
  }

  const command = event?.tool_input?.command;
  if (!command) {
    log.debug("No command in event, passing through");
    passthrough();
  }

  log.debug(`Checking command: ${command.slice(0, 120)}`);

  // 2. Denylist — instant block, no LLM needed
  const denyResult = checkDenylist(command, config.denylist);
  if (denyResult.blocked) {
    deny(
      `Command matches denylist pattern /${denyResult.pattern}/\n` +
      `  Segment: ${denyResult.segment}`
    );
  }

  // 3. Allowlist — instant pass, no LLM needed
  if (checkAllowlist(command, config.allowlist)) {
    log.debug("Command allowlisted, skipping LLM check");
    allow("command allowlisted");
  }

  // 4. Extract reasoning from transcript
  const reasoning = extractReasoning(event.transcript_path);
  if (!reasoning) {
    log.info("No reasoning found in transcript, passing through");
    passthrough();
  }

  // 5. Check cache
  const cached = getFromCache(reasoning, command, config.cache);
  if (cached) {
    log.debug(`Cache hit: score=${cached.score}`);
    if (cached.score > threshold) {
      deny(
        `Mismatch detected (cached, score=${cached.score.toFixed(2)})\n` +
        `  Intent: ${reasoning.slice(-120)}\n` +
        `  Command: ${command}\n` +
        `  Reason: ${cached.reason}`
      );
    }
    allow(`consistent (cached, score=${cached.score.toFixed(2)})`);
  }

  // 6. Call LLM via providers
  const providers = config.providers || [];
  if (!providers.length) {
    log.warn("No providers configured, skipping LLM check");
    passthrough();
  }

  let result;
  try {
    result = await checkMismatch({ reasoning, command }, providers);
  } catch (err) {
    log.error(`All providers failed: ${err.message}`);
    passthrough(); // fail-open
  }

  log.info(`LLM score=${result.score.toFixed(2)}: ${result.reason}`);

  // 7. Cache the result
  putInCache(reasoning, command, result, config.cache);

  // 8. Decision
  if (result.score > threshold) {
    deny(
      `Mismatch detected (score=${result.score.toFixed(2)})\n` +
      `  Intent: ${reasoning.slice(-120)}\n` +
      `  Command: ${command}\n` +
      `  Reason: ${result.reason}`
    );
  }

  allow(`consistent (score=${result.score.toFixed(2)})`);
}

main().catch((err) => {
  process.stderr.write(`[mismatch-auditor] Unhandled error: ${err.message}\n`);
  process.exit(0); // fail-open
});
