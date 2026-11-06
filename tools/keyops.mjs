// Shared API-key operations used by keys.cmd (tools/keys.mjs) and the admin
// dashboard (tools/admin.mjs). Talks to the local OmniRoute management API with
// the machine CLI token, and to data/token-budgets.json for one-time budgets.

import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadBudgets, updateBudgets, onceBudgetState } from "./budgets.mjs";

export const ROUTER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.DATA_DIR || join(ROUTER_DIR, "data");
const PKG_DIR = join(ROUTER_DIR, "app", "node_modules", "omniroute");
const BASE_URL = `http://127.0.0.1:${process.env.PORT || "20128"}`;

export const PERIODIC = ["daily", "weekly", "monthly"];
export const RESETS = [...PERIODIC, "once"];

/** Error whose message is safe and meant to be shown to the person managing keys. */
export class KeyOpsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const fail = (message, status) => {
  throw new KeyOpsError(message, status);
};

// ---------- parsing ----------

export function parseTokens(value) {
  const match = String(value ?? "").trim().toLowerCase().replace(/[,_\s]/g, "").match(/^(\d+(?:\.\d+)?)([kmb]?)$/);
  if (!match) fail(`Invalid token amount "${value}". Use e.g. 50M, 500k, 1.5B or 50000000.`);
  const tokens = Math.round(Number(match[1]) * { "": 1, k: 1e3, m: 1e6, b: 1e9 }[match[2]]);
  if (!Number.isFinite(tokens) || tokens <= 0) fail("Token limit must be greater than 0.");
  if (tokens > 1e15) fail("Token limit is too large.");
  return tokens;
}

export function parseReset(value) {
  let reset = String(value ?? "").toLowerCase();
  if (["none", "never", "one-time", "onetime", "lifetime"].includes(reset)) reset = "once";
  if (!RESETS.includes(reset)) fail(`Invalid reset "${value}". Use: ${RESETS.join(", ")}.`);
  return reset;
}

export function normalizeModels(models) {
  if (models === undefined) return undefined; // no change
  if (models === null) return null; // all models
  if (!Array.isArray(models)) fail("Models must be a list.");
  const list = [...new Set(models.map((m) => String(m).trim()).filter(Boolean))];
  if (list.length === 0) fail("Pick at least one model, or allow all models.");
  if (list.some((m) => m.length > 200)) fail("A model ID is too long.");
  return list;
}

export function normalizeExpiry(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) fail(`Invalid expiry date "${value}".`);
  if (d.getTime() <= Date.now()) fail("The expiry date must be in the future.");
  return d.toISOString();
}

export function normalizeName(value) {
  const name = String(value ?? "").trim();
  if (!name) fail("Give the key a name.");
  if (name.length > 200) fail("The name is too long (200 characters max).");
  return name;
}

// ---------- formatting ----------

export function formatTokens(n) {
  if (n == null) return "-";
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(n);
}

// ---------- OmniRoute API ----------

let headers;
async function auth() {
  if (headers) return headers;
  const mod = await import(pathToFileURL(join(PKG_DIR, "bin", "cli", "utils", "cliToken.mjs")).href);
  const getCliToken = mod.getCliToken || mod.default;
  headers = { "x-omniroute-cli-token": await getCliToken(), "content-type": "application/json" };
  return headers;
}

export async function api(method, path, body) {
  let response;
  try {
    response = await fetch(BASE_URL + path, {
      method,
      headers: await auth(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    fail(`Cannot reach OmniRoute at ${BASE_URL}. Start it with start.cmd first.`, 503);
  }
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.error || data?.message || text;
    fail(`OmniRoute ${method} ${path} failed (${response.status}): ${typeof message === "string" ? message : JSON.stringify(message)}`, 502);
  }
  return data;
}

/** IDs of keys the admin dashboard uses internally; hidden from every list. */
export function internalKeyIds() {
  const file = join(DATA_DIR, "admin.json");
  if (!existsSync(file)) return new Set();
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    return new Set(cfg.catalogKeyId ? [cfg.catalogKeyId] : []);
  } catch {
    return new Set();
  }
}

export async function listKeys() {
  const data = await api("GET", "/api/keys");
  const hidden = internalKeyIds();
  return (data.keys || []).filter((k) => !hidden.has(k.id));
}

export async function getKey(id) {
  const key = (await listKeys()).find((k) => k.id === id);
  if (!key) fail("That key no longer exists.", 404);
  return key;
}

export async function findKey(nameOrId) {
  if (!nameOrId) fail("Give the key name.");
  const keys = await listKeys();
  const byId = keys.find((k) => k.id === nameOrId);
  if (byId) return byId;
  const byName = keys.filter((k) => k.name === nameOrId);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) fail(`More than one key is named "${nameOrId}". Use its ID instead.`);
  fail(`No key named "${nameOrId}".`, 404);
}

async function getTokenLimit(keyId) {
  const data = await api("GET", `/api/usage/token-limits?apiKeyId=${encodeURIComponent(keyId)}`);
  return (data.limits || []).find((l) => l.scopeType === "global") || null;
}

async function setTokenLimit(keyId, tokenLimit, resetInterval, existingId) {
  return api("POST", "/api/usage/token-limits", {
    ...(existingId ? { id: existingId } : {}),
    apiKeyId: keyId,
    scopeType: "global",
    scopeValue: "*",
    tokenLimit,
    resetInterval,
    enabled: true,
  });
}

// One-time keys also get an OmniRoute monthly limit as a safety cap, in case
// someone reaches OmniRoute without going through the portal. It is set to
// twice the budget because OmniRoute counts the first request of each window
// twice, so an equal-sized cap could block a key before its budget is used.
const omniResetFor = (reset) => (reset === "once" ? "monthly" : reset);
const omniLimitFor = (reset, tokens) => (reset === "once" ? tokens * 2 : tokens);

/** Unified view of a key's token limit, whether one-time or periodic. */
export async function limitInfo(keyId) {
  const once = onceBudgetState(DATA_DIR, keyId);
  if (once) return { reset: "once", nextResetAt: null, periodStartAt: null, ...once };
  const limit = await getTokenLimit(keyId);
  if (!limit) return null;
  return {
    reset: limit.resetInterval,
    tokenLimit: limit.tokenLimit,
    used: limit.tokensUsed,
    remaining: Math.max(0, limit.remaining),
    nextResetAt: Number(limit.nextResetAt) || null,
    periodStartAt: Number(limit.periodStartAt) || null,
    blockedByLimit: false,
  };
}

/** active | out_of_tokens | disabled | expired | revoked | banned */
export function keyStatus(key, info) {
  if (key.revokedAt) return "revoked";
  if (key.isBanned) return "banned";
  if (info && info.remaining <= 0 && (key.isActive !== false || info.blockedByLimit)) return "out_of_tokens";
  if (key.isActive === false) return "disabled";
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

const modelFields = (models) =>
  models === undefined ? {} : models === null ? { modelAccessMode: "all", allowedModels: [] } : { modelAccessMode: "restricted", allowedModels: models };

// ---------- operations ----------

/**
 * Create a key. Returns { key (OmniRoute record incl. plaintext `key`), secret }.
 * @param {{name:string, tokenLimit:number, reset:string, expiresAt?:string|null, models?:string[]|null}} input
 */
export async function createKey(input) {
  const name = normalizeName(input.name);
  const tokenLimit = typeof input.tokenLimit === "number" ? input.tokenLimit : parseTokens(input.tokenLimit);
  const reset = parseReset(input.reset ?? "monthly");
  const expiresAt = normalizeExpiry(input.expiresAt) ?? null;
  const models = normalizeModels(input.models ?? null);

  if ((await listKeys()).some((k) => k.name === name)) fail(`A key named "${name}" already exists.`, 409);

  const created = await api("POST", "/api/keys", { name, expiresAt, ...modelFields(models) });
  try {
    await setTokenLimit(created.id, omniLimitFor(reset, tokenLimit), omniResetFor(reset));
    if (reset === "once") {
      updateBudgets(DATA_DIR, (b) => {
        b[created.id] = { mode: "once", tokenLimit, name, createdAt: new Date().toISOString(), blockedByLimit: false };
      });
    }
  } catch (error) {
    // Do not leave a key without its limit behind.
    await api("DELETE", `/api/keys/${created.id}`).catch(() => {});
    updateBudgets(DATA_DIR, (b) => delete b[created.id]);
    throw error;
  }
  return { id: created.id, name, secret: created.key, tokenLimit, reset, expiresAt, models };
}

/**
 * Update a key. Any field left undefined is unchanged.
 * models: null = all models. expiresAt: null = never.
 * Returns { reenabled } — true when a key that had run out was turned back on.
 */
export async function updateKey(id, input) {
  const key = await getKey(id);
  const update = { ...modelFields(normalizeModels(input.models)) };
  const expiresAt = normalizeExpiry(input.expiresAt);
  if (expiresAt !== undefined) update.expiresAt = expiresAt;
  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    if (name !== key.name && (await listKeys()).some((k) => k.name === name)) fail(`A key named "${name}" already exists.`, 409);
    update.name = name;
  }

  const changingLimit = input.tokenLimit !== undefined || input.reset !== undefined;
  if (Object.keys(update).length === 0 && !changingLimit) fail("Nothing to change.");

  if (Object.keys(update).length > 0) await api("PATCH", `/api/keys/${key.id}`, update);

  let reenabled = false;
  if (changingLimit) {
    const current = await getTokenLimit(key.id);
    const budget = loadBudgets(DATA_DIR)[key.id];
    const currentReset = budget?.mode === "once" ? "once" : current?.resetInterval;
    const tokenLimit =
      input.tokenLimit !== undefined
        ? typeof input.tokenLimit === "number" ? input.tokenLimit : parseTokens(input.tokenLimit)
        : budget?.tokenLimit ?? current?.tokenLimit;
    if (!tokenLimit) fail("This key has no token limit yet, so a token amount is required.");
    const reset = input.reset !== undefined ? parseReset(input.reset) : currentReset || "monthly";

    await setTokenLimit(key.id, omniLimitFor(reset, tokenLimit), omniResetFor(reset), current?.id);

    const wasBlocked = !!budget?.blockedByLimit;
    updateBudgets(DATA_DIR, (b) => {
      if (reset === "once") {
        b[key.id] = { ...(b[key.id] || {}), mode: "once", tokenLimit, name: update.name || key.name, blockedByLimit: wasBlocked };
        if (!b[key.id].createdAt) b[key.id].createdAt = new Date().toISOString();
      } else {
        delete b[key.id];
      }
    });

    // A key the portal turned off for running out comes back on if it now has tokens left.
    if (wasBlocked) {
      const info = await limitInfo(key.id);
      if (!info || info.remaining > 0) {
        await api("PATCH", `/api/keys/${key.id}`, { isActive: true });
        updateBudgets(DATA_DIR, (b) => { if (b[key.id]) b[key.id].blockedByLimit = false; });
        reenabled = true;
      }
    }
  } else if (update.name) {
    updateBudgets(DATA_DIR, (b) => { if (b[key.id]) b[key.id].name = update.name; });
  }
  return { reenabled };
}

export async function setKeyActive(id, isActive) {
  const key = await getKey(id);
  if (isActive) {
    const once = onceBudgetState(DATA_DIR, key.id);
    if (once?.exhausted) {
      fail(`"${key.name}" has used its one-time ${formatTokens(once.tokenLimit)} tokens. Give it more tokens first.`, 409);
    }
  }
  await api("PATCH", `/api/keys/${key.id}`, { isActive });
  updateBudgets(DATA_DIR, (b) => { if (b[key.id]) b[key.id].blockedByLimit = false; });
  return key;
}

export async function deleteKey(id) {
  const key = await getKey(id);
  await api("DELETE", `/api/keys/${key.id}`);
  updateBudgets(DATA_DIR, (b) => delete b[key.id]);
  return key;
}
