// One-time ("once") token budgets: a total token allowance that never resets.
//
// OmniRoute only supports daily/weekly/monthly token windows, so one-time
// budgets are kept here, in <DATA_DIR>/token-budgets.json, and enforced by the
// user portal (tools/portal.mjs):
//   - every /v1 request through the portal is checked before it is forwarded;
//   - a sweep disables keys that have used their budget, so they stop working
//     everywhere, including direct calls to OmniRoute.
// Each one-time key also gets an OmniRoute monthly limit of twice the budget as
// a safety cap (see keys.mjs), in case the portal is not running.
//
// Usage is counted from OmniRoute's usage_history table, with the same formula
// OmniRoute uses for its own limits: input + output + reasoning tokens.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function budgetsPath(dataDir) {
  return join(dataDir, "token-budgets.json");
}

let cache = { mtimeMs: -1, data: {} };

export function loadBudgets(dataDir) {
  const file = budgetsPath(dataDir);
  if (!existsSync(file)) return {};
  const mtimeMs = statSync(file).mtimeMs;
  if (mtimeMs !== cache.mtimeMs) {
    try {
      cache = { mtimeMs, data: JSON.parse(readFileSync(file, "utf8")) || {} };
    } catch {
      // Keep the last good copy if the file is mid-write or damaged.
    }
  }
  return cache.data;
}

export function saveBudgets(dataDir, data) {
  const file = budgetsPath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
  cache = { mtimeMs: statSync(file).mtimeMs, data };
}

export function updateBudgets(dataDir, change) {
  // Re-read from disk (bypassing the cache) so concurrent writers do not clobber each other.
  const file = budgetsPath(dataDir);
  let data = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf8")) || {};
    } catch {
      data = {};
    }
  }
  change(data);
  saveBudgets(dataDir, data);
  return data;
}

let db;
function usageDb(dataDir) {
  if (!db) db = new DatabaseSync(join(dataDir, "storage.sqlite"), { readOnly: true });
  return db;
}

/** Lifetime billable tokens (input + output + reasoning) for an API key. */
export function lifetimeTokens(dataDir, apiKeyId) {
  const row = usageDb(dataDir)
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0) + COALESCE(tokens_reasoning, 0)), 0) AS total
         FROM usage_history WHERE api_key_id = ?`
    )
    .get(apiKeyId);
  return Number(row?.total || 0);
}

/** Resolve a plaintext API key to its OmniRoute key id (null when unknown). */
export function keyIdForSecret(dataDir, secret) {
  if (!secret) return null;
  const hash = createHash("sha256").update(secret).digest("hex");
  const row = usageDb(dataDir).prepare("SELECT id FROM api_keys WHERE key_hash = ?").get(hash);
  return row?.id || null;
}

/** Budget state for a key, or null when it has no one-time budget. */
export function onceBudgetState(dataDir, apiKeyId) {
  const budget = loadBudgets(dataDir)[apiKeyId];
  if (!budget || budget.mode !== "once") return null;
  const used = lifetimeTokens(dataDir, apiKeyId);
  return {
    tokenLimit: budget.tokenLimit,
    used,
    remaining: Math.max(0, budget.tokenLimit - used),
    exhausted: used >= budget.tokenLimit,
    blockedByLimit: !!budget.blockedByLimit,
  };
}
