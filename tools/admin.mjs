// Admin dashboard for OmniRoute API keys: create keys with token limits,
// one-time or resetting budgets, expiry and allowed models; watch usage.
//
//   http://127.0.0.1:20140   (local only, never share this port)
//
// Sign in with the same password as the OmniRoute dashboard.

import http from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  DATA_DIR,
  KeyOpsError,
  api,
  listKeys,
  limitInfo,
  keyStatus,
  createKey,
  updateKey,
  setKeyActive,
  deleteKey,
  getKey,
} from "./keyops.mjs";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const OMNI_PORT = Number(process.env.PORT || 20128);
// Bind address. Default loopback (the PC). In the container it is 0.0.0.0, published on the server's loopback only.
const HOST = process.env.ADMIN_HOST || "127.0.0.1";
const PORT = Number(process.env.ADMIN_PORT || 20140);
const PORTAL_PORT = Number(process.env.PORTAL_PORT || 20130);
const PID_FILE = join(DATA_DIR, "admin.pid");
const CONFIG_FILE = join(DATA_DIR, "admin.json");
const PAGE_FILE = join(TOOLS_DIR, "admin", "index.html");

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const SESSION_COOKIE = "omr_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// ---------- config ----------

function readConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, CONFIG_FILE);
}

// ---------- sessions & login ----------

const sessions = new Map(); // token -> expiresAt

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionOf(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS); // sliding expiry
  return token;
}

const loginAttempts = { count: 0, resetAt: 0 };
function allowLoginAttempt() {
  const now = Date.now();
  if (now > loginAttempts.resetAt) {
    loginAttempts.count = 0;
    loginAttempts.resetAt = now + 5 * 60 * 1000;
  }
  loginAttempts.count++;
  return loginAttempts.count <= 10;
}

/** Check the password against OmniRoute's own dashboard login. */
async function verifyPassword(password) {
  const response = await fetch(`http://127.0.0.1:${OMNI_PORT}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${OMNI_PORT}` },
    body: JSON.stringify({ password }),
  });
  await response.arrayBuffer().catch(() => {});
  if (response.status === 429) throw new KeyOpsError("Too many sign-in attempts. Wait a few minutes.", 429);
  return response.ok;
}

// ---------- usage database ----------

let db;
function usageDb() {
  if (!db) db = new DatabaseSync(join(DATA_DIR, "storage.sqlite"), { readOnly: true });
  return db;
}

const billable = "COALESCE(tokens_input,0) + COALESCE(tokens_output,0) + COALESCE(tokens_reasoning,0)";
const outputExpr = "COALESCE(tokens_output,0) + COALESCE(tokens_reasoning,0)";

function sinceIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function localDayStartIso(daysAgo = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

function totals(whereSql, params) {
  const r = usageDb()
    .prepare(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(tokens_input),0) AS input, COALESCE(SUM(${outputExpr}),0) AS output
         FROM usage_history WHERE ${whereSql}`
    )
    .get(...params);
  return { requests: Number(r.requests), input: Number(r.input), output: Number(r.output) };
}

function dailySeries(days, keyId) {
  const from = localDayStartIso(days - 1);
  const rows = usageDb()
    .prepare(
      `SELECT date(timestamp, 'localtime') AS day, COUNT(*) AS requests,
              COALESCE(SUM(tokens_input),0) AS input, COALESCE(SUM(${outputExpr}),0) AS output
         FROM usage_history
        WHERE timestamp >= ? ${keyId ? "AND api_key_id = ?" : ""}
        GROUP BY day ORDER BY day`
    )
    .all(...(keyId ? [from, keyId] : [from]));
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const r = byDay.get(day);
    out.push({ day, requests: Number(r?.requests || 0), input: Number(r?.input || 0), output: Number(r?.output || 0) });
  }
  return out;
}

function perKeyUsage(fromIso) {
  const rows = usageDb()
    .prepare(
      `SELECT api_key_id AS id, COUNT(*) AS requests, COALESCE(SUM(tokens_input),0) AS input, COALESCE(SUM(${outputExpr}),0) AS output
         FROM usage_history WHERE timestamp >= ? AND api_key_id IS NOT NULL GROUP BY api_key_id`
    )
    .all(fromIso);
  return new Map(rows.map((r) => [r.id, { requests: Number(r.requests), input: Number(r.input), output: Number(r.output) }]));
}

function perModelUsage(fromIso, keyId) {
  return usageDb()
    .prepare(
      `SELECT COALESCE(provider,'') AS provider, COALESCE(model,'unknown') AS model, COUNT(*) AS requests,
              COALESCE(SUM(tokens_input),0) AS input, COALESCE(SUM(${outputExpr}),0) AS output,
              MAX(timestamp) AS lastUsed
         FROM usage_history WHERE timestamp >= ? ${keyId ? "AND api_key_id = ?" : ""}
        GROUP BY provider, model ORDER BY (input + output) DESC`
    )
    .all(...(keyId ? [fromIso, keyId] : [fromIso]))
    .map((r) => ({ ...r, requests: Number(r.requests), input: Number(r.input), output: Number(r.output) }));
}

function recentRequests(keyId, limit = 40) {
  return usageDb()
    .prepare(
      `SELECT timestamp, requested_model AS requestedModel, model, provider, status, duration,
              COALESCE(tokens_in,0) AS input, COALESCE(tokens_out,0) + COALESCE(tokens_reasoning,0) AS output
         FROM call_logs WHERE api_key_id = ? ORDER BY timestamp DESC LIMIT ?`
    )
    .all(keyId, limit)
    .map((r) => ({ ...r, status: Number(r.status), duration: Number(r.duration), input: Number(r.input), output: Number(r.output) }));
}

// ---------- model catalog ----------

const CATALOG_KEY_NAME = "admin-model-catalog (internal, list models only)";
let catalogCache = { at: 0, models: null };

async function catalogSecret() {
  const cfg = readConfig();
  if (cfg.catalogKeyId && cfg.catalogSecret) {
    const all = (await api("GET", "/api/keys")).keys || [];
    if (all.some((k) => k.id === cfg.catalogKeyId)) return cfg.catalogSecret;
  }
  // A key that can only call /v1/models (read-only), used to see the exact model list clients see.
  const created = await api("POST", "/api/keys", { name: CATALOG_KEY_NAME });
  await api("PATCH", `/api/keys/${created.id}`, { allowedEndpoints: ["models"] });
  writeConfig({ ...readConfig(), catalogKeyId: created.id, catalogSecret: created.key });
  return created.key;
}

async function modelCatalog(force = false) {
  if (!force && catalogCache.models && Date.now() - catalogCache.at < 5 * 60 * 1000) return catalogCache.models;
  const secret = await catalogSecret();
  const response = await fetch(`http://127.0.0.1:${OMNI_PORT}/v1/models`, { headers: { authorization: `Bearer ${secret}` } });
  if (!response.ok) throw new KeyOpsError(`Could not load models from OmniRoute (${response.status}).`, 502);
  const data = await response.json();
  const models = (data.data || []).map((m) => ({
    id: m.id,
    group: m.id.includes("/") ? m.id.split("/")[0] : "other",
    ownedBy: m.owned_by || null,
    contextLength: m.context_length || m.max_input_tokens || null,
    maxOutput: m.max_output_tokens || null,
    vision: Array.isArray(m.input_modalities) ? m.input_modalities.includes("image") : false,
    reasoning: !!m.capabilities?.reasoning,
    tools: !!m.capabilities?.tool_calling,
  }));
  catalogCache = { at: Date.now(), models };
  return models;
}

// ---------- views ----------

async function keyRows() {
  const keys = await listKeys();
  const usage30 = perKeyUsage(sinceIso(30));
  const usageAll = perKeyUsage("0000");
  const rows = [];
  for (const key of keys) {
    const info = await limitInfo(key.id);
    rows.push({
      id: key.id,
      name: key.name,
      prefix: key.keyPrefix,
      status: keyStatus(key, info),
      isActive: key.isActive !== false,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      expiresAt: key.expiresAt,
      models: key.modelAccessMode === "restricted" ? key.allowedModels : null,
      limit: info
        ? { tokenLimit: info.tokenLimit, used: info.used, remaining: info.remaining, reset: info.reset, nextResetAt: info.nextResetAt }
        : null,
      usage30d: usage30.get(key.id) || { requests: 0, input: 0, output: 0 },
      usageAll: usageAll.get(key.id) || { requests: 0, input: 0, output: 0 },
    });
  }
  return rows;
}

async function overview() {
  const keys = await keyRows();
  const counts = { total: keys.length };
  for (const k of keys) counts[k.status] = (counts[k.status] || 0) + 1;
  const today = totals("timestamp >= ?", [localDayStartIso(0)]);
  const last7 = totals("timestamp >= ?", [localDayStartIso(6)]);
  const last30 = totals("timestamp >= ?", [localDayStartIso(29)]);
  const allTime = totals("1 = 1", []);
  const topKeys = [...keys]
    .filter((k) => k.usage30d.input + k.usage30d.output > 0)
    .sort((a, b) => b.usage30d.input + b.usage30d.output - (a.usage30d.input + a.usage30d.output))
    .slice(0, 6)
    .map((k) => ({ id: k.id, name: k.name, status: k.status, usage: k.usage30d, limit: k.limit }));
  const attention = keys
    .filter((k) => k.status === "out_of_tokens" || k.status === "expired" || (k.limit && k.limit.tokenLimit > 0 && k.limit.remaining / k.limit.tokenLimit <= 0.1 && k.status === "active") ||
      (k.expiresAt && k.status === "active" && new Date(k.expiresAt).getTime() - Date.now() < 3 * 86400000))
    .map((k) => ({ id: k.id, name: k.name, status: k.status, limit: k.limit, expiresAt: k.expiresAt }));
  // Provider balance summary (cached live check, at most every 2 minutes).
  let providers = null;
  try {
    const p = await providersView(false);
    const withCredit = p.providers.filter((x) => x.isActive && x.credit && x.credit.remaining != null);
    if (withCredit.length) {
      const resets = withCredit.map((x) => toDateMs(x.credit.resetAt)).filter(Boolean);
      providers = {
        count: withCredit.length,
        creditsLeft: withCredit.reduce((s, x) => s + x.credit.remaining, 0),
        creditsTotal: withCredit.reduce((s, x) => s + (x.credit.total || 0), 0),
        tokensLeft: p.tokensAvailable,
        hasEstimate: withCredit.some((x) => x.estimate),
        nextResetAt: resets.length ? Math.min(...resets) : null,
        committed: p.committed,
        unlimitedKeys: p.unlimitedKeys,
        name: withCredit.length === 1 ? withCredit[0].provider : null,
      };
    }
  } catch {
    // Provider check failing must not break the overview.
  }
  return {
    counts,
    providers,
    totals: { today, last7, last30, allTime },
    daily: dailySeries(30),
    topKeys,
    topModels: perModelUsage(localDayStartIso(29)).filter((m) => m.input + m.output > 0).slice(0, 6),
    attention,
  };
}

async function modelsView(force) {
  let catalog = [];
  let catalogError = null;
  try {
    catalog = await modelCatalog(force);
  } catch (error) {
    catalogError = error.message;
  }
  const keys = await listKeys();
  // usage_history stores the real provider id (e.g. "kiro"), while the catalog can also list
  // the same model under an alias prefix (e.g. "kr/..."). Usage is shown on the provider's own
  // id only; alias rows point at it, so the same tokens are never counted twice.
  const usageKey = (provider, model) => `${provider}/${model}`;
  const usage30 = new Map(perModelUsage(localDayStartIso(29)).map((m) => [usageKey(m.provider, m.model), m]));
  const usageAll = new Map(perModelUsage("0000").map((m) => [usageKey(m.provider, m.model), m]));
  const ids = new Set(catalog.map((m) => m.id));
  const strip = (id) => (id.includes("/") ? id.slice(id.indexOf("/") + 1) : id);
  return {
    catalogError,
    models: catalog.map((m) => {
      const canonicalId = m.ownedBy && m.group !== m.ownedBy && ids.has(`${m.ownedBy}/${strip(m.id)}`) ? `${m.ownedBy}/${strip(m.id)}` : null;
      const own = canonicalId ? null : usageKey(m.ownedBy || m.group, strip(m.id));
      return {
        ...m,
        aliasOf: canonicalId,
        usage30d: own ? usage30.get(own) || null : null,
        usageAll: own ? usageAll.get(own) || null : null,
      };
    }),
    keyCount: keys.length,
  };
}

// ---------- provider balances ----------

const providerCache = new Map(); // connectionId -> { at, data }
const PROVIDER_TTL_MS = 2 * 60 * 1000;

function startOfPeriod(resetAt) {
  // Provider credit windows here are monthly: the period started one calendar month before the reset.
  const r = toDateMs(resetAt);
  if (!r) return null;
  const d = new Date(r);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.getTime();
}
function toDateMs(v) {
  if (v == null || v === "") return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Credits spent per token by this connection, measured from OmniRoute's own request history. */
function creditRate(connectionId, provider) {
  const q = (where, params) =>
    usageDb()
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(provider_credits),0) AS credits,
                COALESCE(SUM(${billable}),0) AS tokens, COALESCE(SUM(tokens_input),0) AS input, COALESCE(SUM(${outputExpr}),0) AS output
           FROM usage_history WHERE provider_credits > 0 AND ${where}`
      )
      .get(...params);
  let r = q("connection_id = ? AND timestamp >= ?", [connectionId, sinceIso(30)]);
  let scope = "this connection, last 30 days";
  if (!Number(r.n)) {
    r = q("provider = ?", [provider]);
    scope = "this provider, all time";
  }
  const n = Number(r.n), credits = Number(r.credits), tokens = Number(r.tokens);
  if (!n || !tokens || !credits) return null;
  return { requests: n, credits, tokens, input: Number(r.input), output: Number(r.output), creditsPerMillion: (credits / tokens) * 1e6, scope };
}

function creditsRecordedSince(connectionId, fromMs) {
  const r = usageDb()
    .prepare(`SELECT COALESCE(SUM(provider_credits),0) AS credits, COUNT(*) AS n FROM usage_history WHERE connection_id = ? AND timestamp >= ?`)
    .get(connectionId, new Date(fromMs).toISOString());
  return { credits: Number(r.credits), requests: Number(r.n) };
}

async function liveUsage(connectionId, force) {
  const hit = providerCache.get(connectionId);
  if (!force && hit && Date.now() - hit.at < PROVIDER_TTL_MS) return hit.data;
  const data = await api("GET", `/api/usage/${encodeURIComponent(connectionId)}`);
  providerCache.set(connectionId, { at: Date.now(), data });
  return data;
}

async function providersView(force) {
  const [{ connections = [] } = {}, cachedLimits] = await Promise.all([
    api("GET", "/api/providers"),
    api("GET", "/api/usage/provider-limits").catch(() => ({ caches: {} })),
  ]);

  // Tokens every key could still use right now, to compare against what the providers can supply.
  const keys = await listKeys();
  let committed = 0, unlimitedKeys = 0;
  for (const key of keys) {
    if (key.isActive === false || key.revokedAt || (key.expiresAt && Date.parse(key.expiresAt) <= Date.now())) continue;
    const info = await limitInfo(key.id);
    if (!info) unlimitedKeys++;
    else committed += Math.max(0, info.remaining);
  }

  const out = [];
  for (const c of connections) {
    let live = null, liveError = null, fetchedAt = null;
    if (c.isActive) {
      try {
        live = await liveUsage(c.id, force);
        fetchedAt = providerCache.get(c.id)?.at || Date.now();
      } catch (error) {
        liveError = error.message;
      }
    }
    const cached = cachedLimits.caches?.[c.id];
    const source = live || cached || null;
    if (!live && cached?.fetchedAt) fetchedAt = Date.parse(cached.fetchedAt);

    const quotas = Object.entries(source?.quotas || {}).map(([name, q]) => {
      const total = Number(q.total) || null;
      const used = Number(q.used) || 0;
      const remaining = q.remaining != null ? Number(q.remaining) : total != null ? total - used : null;
      return {
        name,
        used,
        total,
        remaining,
        remainingPct: q.remainingPercentage != null ? Number(q.remainingPercentage) : total ? (remaining / total) * 100 : null,
        resetAt: q.resetAt || null,
        unlimited: !!q.unlimited,
      };
    });

    const credit = quotas.find((q) => /credit/i.test(q.name)) || null;
    const rate = creditRate(c.id, c.provider);
    let estimate = null;
    if (credit && rate && credit.remaining != null) {
      const periodStart = startOfPeriod(credit.resetAt);
      const viaOmni = periodStart ? creditsRecordedSince(c.id, periodStart) : null;
      estimate = {
        tokensLeft: Math.max(0, Math.floor((credit.remaining / rate.credits) * rate.tokens)),
        rate,
        periodStart,
        creditsViaOmniRoute: viaOmni?.credits ?? null,
        creditsElsewhere: viaOmni ? Math.max(0, credit.used - viaOmni.credits) : null,
      };
    }

    out.push({
      id: c.id,
      provider: c.provider,
      name: c.name,
      isActive: !!c.isActive,
      testStatus: c.testStatus || null,
      plan: source?.plan || null,
      fetchedAt,
      live: !!live,
      liveError,
      quotas: quotas.filter((q) => !credit || q !== credit),
      credit,
      estimate,
    });
  }

  const tokensAvailable = out.reduce((s, p) => s + (p.isActive && p.estimate ? p.estimate.tokensLeft : 0), 0);
  return { providers: out, committed, unlimitedKeys, tokensAvailable, keyCount: keys.length };
}

async function keyDetail(id) {
  const key = await getKey(id);
  const info = await limitInfo(id);
  return {
    id: key.id,
    name: key.name,
    prefix: key.keyPrefix,
    status: keyStatus(key, info),
    isActive: key.isActive !== false,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    models: key.modelAccessMode === "restricted" ? key.allowedModels : null,
    limit: info
      ? { tokenLimit: info.tokenLimit, used: info.used, remaining: info.remaining, reset: info.reset, nextResetAt: info.nextResetAt, periodStartAt: info.periodStartAt }
      : null,
    usage30d: totals("api_key_id = ? AND timestamp >= ?", [id, localDayStartIso(29)]),
    usageAll: totals("api_key_id = ?", [id]),
    daily: dailySeries(30, id),
    byModel: perModelUsage("0000", id),
    recent: recentRequests(id),
  };
}

// ---------- HTTP plumbing ----------

function sendJson(res, status, body, extraHeaders = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(data);
}

function readJson(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new KeyOpsError("Request too large.", 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new KeyOpsError("Invalid JSON.", 400));
      }
    });
    req.on("error", reject);
  });
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

async function route(req, res) {
  // Block DNS-rebinding and cross-site requests.
  if (!ALLOWED_HOSTS.has(String(req.headers.host || "").toLowerCase())) return sendJson(res, 421, { error: "Wrong host." });
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method || "GET";

  if (method === "GET" && path === "/") {
    const page = readFileSync(PAGE_FILE);
    res.writeHead(200, { ...PAGE_HEADERS, "content-length": page.length });
    return res.end(page);
  }

  if (!path.startsWith("/admin/api/")) return sendJson(res, 404, { error: "Not found" });

  if (method !== "GET") {
    const origin = req.headers.origin;
    if (!origin || !ALLOWED_ORIGINS.has(origin)) return sendJson(res, 403, { error: "Cross-site request blocked." });
    if (req.headers["x-admin-request"] !== "1") return sendJson(res, 403, { error: "Missing request header." });
  }

  // --- auth endpoints ---
  if (path === "/admin/api/session" && method === "GET") {
    // The address users are given. Set "publicUrl" in data/admin.json; falls back to the local portal.
    const publicUrl = String(readConfig().publicUrl || "").replace(/\/+$/, "");
    return sendJson(res, 200, { signedIn: !!sessionOf(req), portalUrl: publicUrl || `http://127.0.0.1:${PORTAL_PORT}` });
  }
  if (path === "/admin/api/login" && method === "POST") {
    if (!allowLoginAttempt()) return sendJson(res, 429, { error: "Too many sign-in attempts. Wait a few minutes." });
    const { password } = await readJson(req);
    if (typeof password !== "string" || !password || password.length > 512) return sendJson(res, 400, { error: "Enter your password." });
    if (!(await verifyPassword(password))) return sendJson(res, 401, { error: "Wrong password." });
    const token = randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return sendJson(res, 200, { ok: true }, {
      "set-cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    });
  }
  if (path === "/admin/api/logout" && method === "POST") {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    return sendJson(res, 200, { ok: true }, { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }

  if (!sessionOf(req)) return sendJson(res, 401, { error: "Sign in first." });

  // --- data endpoints ---
  if (path === "/admin/api/overview" && method === "GET") return sendJson(res, 200, await overview());
  if (path === "/admin/api/providers" && method === "GET") return sendJson(res, 200, await providersView(url.searchParams.get("refresh") === "1"));
  if (path === "/admin/api/models" && method === "GET") return sendJson(res, 200, await modelsView(url.searchParams.get("refresh") === "1"));
  if (path === "/admin/api/keys" && method === "GET") return sendJson(res, 200, { keys: await keyRows() });

  if (path === "/admin/api/keys" && method === "POST") {
    const body = await readJson(req);
    const created = await createKey({
      name: body.name,
      tokenLimit: body.tokenLimit,
      reset: body.reset,
      expiresAt: body.expiresAt ?? null,
      models: body.models ?? null,
    });
    return sendJson(res, 201, created);
  }

  const m = /^\/admin\/api\/keys\/([0-9a-f-]{36})(?:\/(enable|disable))?$/i.exec(path);
  if (m) {
    const [, id, action] = m;
    if (!action && method === "GET") return sendJson(res, 200, await keyDetail(id));
    if (!action && method === "PATCH") {
      const body = await readJson(req);
      const pick = (k) => (Object.prototype.hasOwnProperty.call(body, k) ? body[k] : undefined);
      const result = await updateKey(id, {
        name: pick("name"),
        tokenLimit: pick("tokenLimit"),
        reset: pick("reset"),
        expiresAt: pick("expiresAt"),
        models: pick("models"),
      });
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (!action && method === "DELETE") {
      await deleteKey(id);
      return sendJson(res, 200, { ok: true });
    }
    if (action && method === "POST") {
      await setKeyActive(id, action === "enable");
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    const known = error instanceof KeyOpsError;
    if (!known) console.error("[admin] error:", error);
    if (!res.headersSent) sendJson(res, known ? error.status : 500, { error: known ? error.message : "Something went wrong. Check the admin log." });
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  writeFileSync(PID_FILE, String(process.pid));
  console.log(`OmniRoute admin dashboard: http://127.0.0.1:${PORT}${HOST === "127.0.0.1" ? "" : ` (listening on ${HOST})`}`);
});

const shutdown = () => {
  try {
    rmSync(PID_FILE, { force: true });
  } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
