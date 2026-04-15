/**
 * Allowlist / Denylist module.
 * Checks commands against regex patterns before calling LLM.
 */

/**
 * @param {string} rawCommand
 * @returns {string[]} normalized command segments (pipe-split, unwrapped from sh -c)
 */
export function normalizeCommand(rawCommand) {
  let cmd = rawCommand.trim();

  // Unwrap `bash -c "..."` / `sh -c '...'` wrappers (recursive)
  const shellWrapRe = /^(?:bash|sh|\/bin\/(?:ba)?sh)\s+-c\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))$/;
  for (let i = 0; i < 5; i++) {
    const m = cmd.match(shellWrapRe);
    if (!m) break;
    cmd = (m[1] ?? m[2] ?? m[3]).trim();
  }

  // Split by pipes — each segment is checked independently
  const segments = cmd.split(/\s*\|\s*/).filter(Boolean);
  return segments.length ? segments : [cmd];
}

/**
 * @param {string} rawCommand
 * @param {string[]} denyPatterns
 * @returns {{ blocked: true, pattern: string, segment: string } | { blocked: false }}
 */
export function checkDenylist(rawCommand, denyPatterns) {
  if (!denyPatterns?.length) return { blocked: false };

  const compiled = denyPatterns.map(p => new RegExp(p, "i"));
  const normalized = normalizeCommand(rawCommand);

  // Check the full normalized command (joined) — catches cross-pipe patterns like `curl ... | bash`
  const full = normalized.join(" | ");
  for (let i = 0; i < compiled.length; i++) {
    if (compiled[i].test(full)) {
      return { blocked: true, pattern: denyPatterns[i], segment: full };
    }
  }

  // Check each segment individually — catches single-segment patterns like `sudo`
  for (const seg of normalized) {
    for (let i = 0; i < compiled.length; i++) {
      if (compiled[i].test(seg)) {
        return { blocked: true, pattern: denyPatterns[i], segment: seg };
      }
    }
  }

  // Also check the raw (pre-normalization) trimmed command — catches patterns in bash -c wrappers
  const trimmed = rawCommand.trim();
  if (trimmed !== full) {
    for (let i = 0; i < compiled.length; i++) {
      if (compiled[i].test(trimmed)) {
        return { blocked: true, pattern: denyPatterns[i], segment: trimmed };
      }
    }
  }

  return { blocked: false };
}

/**
 * @param {string} rawCommand
 * @param {string[]} allowPatterns
 * @returns {boolean} true if command is allowlisted (skip LLM)
 */
export function checkAllowlist(rawCommand, allowPatterns) {
  if (!allowPatterns?.length) return false;

  const segments = normalizeCommand(rawCommand);
  const compiled = allowPatterns.map(p => new RegExp(p, "i"));

  // ALL segments must match allowlist for the whole command to pass
  return segments.every(seg => compiled.some(re => re.test(seg)));
}
