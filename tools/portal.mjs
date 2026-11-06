// OmniRoute user portal + public API gateway.
//
//   GET  /                  user page: paste an API key, see token usage
//   POST /portal/api/usage  JSON { key } -> usage for that key only
//   ANY  /v1/*              forwarded to OmniRoute; "token limit" errors are
//                           rewritten into a plain "out of tokens" message
//   anything else           404 (the admin dashboard is never reachable here)
//
// Share THIS port (not 20128) with users, e.g. through a Cloudflare tunnel.

import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadBudgets, updateBudgets, onceBudgetState, keyIdForSecret } from "./budgets.mjs";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ROUTER_DIR = join(TOOLS_DIR, "..");
const DATA_DIR = process.env.DATA_DIR || join(ROUTER_DIR, "data");
const PKG_DIR = join(ROUTER_DIR, "app", "node_modules", "omniroute");

const OMNI_HOST = "127.0.0.1";
const OMNI_PORT = Number(process.env.PORT || 20128);
const PORTAL_HOST = process.env.PORTAL_HOST || "127.0.0.1";
const PORTAL_PORT = Number(process.env.PORTAL_PORT || 20130);
const PID_FILE = join(DATA_DIR, "portal.pid");

const PAGE = readFileSync(join(TOOLS_DIR, "portal", "index.html"));
const DOCS = readFileSync(join(TOOLS_DIR, "portal", "docs.html"));

// ---------- helpers ----------

function formatTokens(n) {
  if (n == null) return "-";
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function formatLocalDate(ms) {
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const oh = Math.floor(Math.abs(offsetMin) / 60);
  const om = Math.abs(offsetMin) % 60;
  const zone = `UTC${sign}${oh}${om ? ":" + pad(om) : ""}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${zone})`;
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
  });
  res.end(data);
}

function clientIp(req) {
  const socketIp = req.socket.remoteAddress || "";
  const fromLoopback = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
  // cloudflared connects from loopback and sets cf-connecting-ip; only trust it then.
  const cfIp = req.headers["cf-connecting-ip"];
  if (fromLoopback && typeof cfIp === "string" && cfIp) return cfIp;
  return socketIp;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Simple per-IP limiter for key lookups (keys are long random strings, this
// only stops someone hammering the endpoint).
const lookups = new Map();
function allowLookup(ip) {
  const now = Date.now();
  const entry = lookups.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 60_000;
  }
  entry.count++;
  lookups.set(ip, entry);
  if (lookups.size > 10_000) lookups.clear();
  return entry.count <= 30;
}

// ---------- OmniRoute management API (loopback only) ----------

let cliToken;
async function omniApi(path, method = "GET", body) {
  if (!cliToken) {
    const mod = await import(pathToFileURL(join(PKG_DIR, "bin", "cli", "utils", "cliToken.mjs")).href);
    cliToken = await (mod.getCliToken || mod.default)();
  }
  const response = await fetch(`http://${OMNI_HOST}:${OMNI_PORT}${path}`, {
    method,
    headers: { "x-omniroute-cli-token": cliToken, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`OmniRoute ${method} ${path} returned ${response.status}`);
  return response.json();
}

let db;
function usageDb() {
  if (!db) db = new DatabaseSync(join(DATA_DIR, "storage.sqlite"), { readOnly: true });
  return db;
}

function sumUsage(apiKeyId, sinceIso) {
  const row = usageDb()
    .prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(tokens_input), 0) AS input,
              COALESCE(SUM(tokens_output), 0) + COALESCE(SUM(tokens_reasoning), 0) AS output
         FROM usage_history
        WHERE api_key_id = ? AND timestamp >= ?`
    )
    .get(apiKeyId, sinceIso);
  return { requests: Number(row.requests), input: Number(row.input), output: Number(row.output) };
}

function keyStatus(key) {
  if (key.revokedAt) return "revoked";
  if (key.isBanned) return "banned";
  if (key.isActive === false) return "disabled";
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

async function usageForKey(plainKey) {
  const hash = createHash("sha256").update(plainKey).digest("hex");
  const { keys = [] } = await omniApi("/api/keys");
  const key = keys.find((k) => k.keyHash === hash);
  if (!key) return null;

  const once = onceBudgetState(DATA_DIR, key.id);
  const allTime = sumUsage(key.id, "0000");

  let limit = null;
  let period = null;
  if (once) {
    limit = {
      tokenLimit: once.tokenLimit,
      used: once.used,
      remaining: once.remaining,
      resetInterval: "once",
      periodStartAt: null,
      nextResetAt: null,
    };
  } else {
    const { limits = [] } = await omniApi(`/api/usage/token-limits?apiKeyId=${encodeURIComponent(key.id)}`);
    const l = limits.find((x) => x.scopeType === "global" && x.enabled) || null;
    if (l) {
      limit = {
        tokenLimit: l.tokenLimit,
        used: l.tokensUsed,
        remaining: Math.max(0, l.remaining),
        resetInterval: l.resetInterval,
        periodStartAt: Number(l.periodStartAt),
        nextResetAt: Number(l.nextResetAt),
      };
      period = sumUsage(key.id, new Date(Number(l.periodStartAt)).toISOString());
    }
  }

  let status = keyStatus(key);
  const outOfTokens = limit && limit.remaining <= 0;
  if (outOfTokens && (status === "active" || (status === "disabled" && once?.blockedByLimit))) status = "out_of_tokens";

  return {
    name: key.name,
    status,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    models: key.modelAccessMode === "restricted" ? key.allowedModels : null,
    limit,
    period,
    allTime,
  };
}

// ---------- /v1 proxy ----------

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"];

function isSafeV1Path(rawUrl) {
  if (!rawUrl || !rawUrl.startsWith("/v1")) return false;
  if (/%2e|%2f|%5c|\\/i.test(rawUrl)) return false;
  const pathname = rawUrl.split("?")[0];
  if (pathname !== "/v1" && !pathname.startsWith("/v1/")) return false;
  return !pathname.split("/").some((seg) => seg === ".." || seg === ".");
}

function outOfTokensMessage(original, once) {
  if (once) {
    return `Out of tokens. This API key has used its full one-time ${formatTokens(once.tokenLimit)} token limit. This limit does not reset.`;
  }
  const usedMatch = /(\d+)\s*\/\s*(\d+)\s*tokens/i.exec(original.message || "");
  const limit = usedMatch ? formatTokens(Number(usedMatch[2])) : null;
  const resetAt = original.reset_at ? Date.parse(original.reset_at) : NaN;
  let message = "Out of tokens.";
  message += limit ? ` This API key has used its full ${limit} token limit.` : " This API key has used its full token limit.";
  if (Number.isFinite(resetAt)) message += ` Tokens reset on ${formatLocalDate(resetAt)}.`;
  return message;
}

function rewriteTokenLimitError(buffer, once) {
  let data;
  try {
    data = JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
  const err = data && typeof data === "object" ? data.error : null;
  if (!err || typeof err !== "object") return null;
  const isTokenLimit = err.code === "token_limit_exceeded" || /token limit exceeded/i.test(err.message || "");
  if (!isTokenLimit) return null;
  err.message = outOfTokensMessage(err, once);
  err.code = "token_limit_exceeded";
  if (once) {
    delete err.retry_after;
    delete err.reset_at;
  }
  return Buffer.from(JSON.stringify(data));
}

function requestSecret(req) {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const xKey = req.headers["x-api-key"];
  return typeof xKey === "string" && xKey.trim() ? xKey.trim() : null;
}

function sendOutOfTokens(req, res, once) {
  const message = outOfTokensMessage({}, once);
  const anthropic = (req.url || "").startsWith("/v1/messages");
  const body = anthropic
    ? { type: "error", error: { type: "rate_limit_error", message } }
    : { error: { message, type: "rate_limit_error", code: "token_limit_exceeded" } };
  req.resume(); // discard the unread request body
  sendJson(res, 429, body);
}

function proxyV1(req, res) {
  // One-time budgets: block before the request reaches OmniRoute.
  let once = null;
  const budgets = loadBudgets(DATA_DIR);
  if (Object.keys(budgets).length > 0) {
    try {
      const keyId = keyIdForSecret(DATA_DIR, requestSecret(req));
      once = keyId ? onceBudgetState(DATA_DIR, keyId) : null;
      if (once?.exhausted) {
        disableExhausted(keyId).catch(() => {});
        return sendOutOfTokens(req, res, once);
      }
    } catch (error) {
      console.error("[portal] budget check failed:", error.message);
    }
  }

  const headers = { ...req.headers };
  for (const h of HOP_BY_HOP) delete headers[h];
  delete headers["x-omniroute-cli-token"]; // never let callers present a management token
  delete headers.cookie; // no dashboard sessions through the public port
  delete headers["accept-encoding"]; // keep bodies plain so error rewriting works
  headers.host = `${OMNI_HOST}:${OMNI_PORT}`;
  headers["x-forwarded-for"] = clientIp(req);
  headers["x-forwarded-proto"] = req.headers["x-forwarded-proto"] || "http";

  const upstream = http.request(
    { host: OMNI_HOST, port: OMNI_PORT, method: req.method, path: req.url, headers },
    (up) => {
      const responseHeaders = { ...up.headers };
      for (const h of HOP_BY_HOP) delete responseHeaders[h];
      delete responseHeaders["set-cookie"];

      if (up.statusCode === 429) {
        readBody(up, 256 * 1024)
          .then((body) => {
            const rewritten = rewriteTokenLimitError(body, once);
            const out = rewritten || body;
            if (rewritten && once) delete responseHeaders["retry-after"];
            responseHeaders["content-length"] = out.length;
            res.writeHead(up.statusCode, responseHeaders);
            res.end(out);
          })
          .catch(() => {
            if (!res.headersSent) sendJson(res, 502, { error: { message: "Upstream error", type: "api_error" } });
            else res.destroy();
          });
        return;
      }

      res.writeHead(up.statusCode || 502, responseHeaders);
      res.flushHeaders();
      up.pipe(res);
    }
  );

  upstream.on("error", () => {
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: "The AI gateway is offline. Try again later.", type: "api_error" } });
    } else {
      res.destroy();
    }
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

// ---------- one-time budget sweep ----------

const disabling = new Set();
async function disableExhausted(keyId) {
  if (disabling.has(keyId)) return;
  disabling.add(keyId);
  try {
    const budget = loadBudgets(DATA_DIR)[keyId];
    if (!budget || budget.blockedByLimit) return;
    const { keys = [] } = await omniApi("/api/keys");
    const key = keys.find((k) => k.id === keyId);
    if (!key || key.isActive === false) return; // already off (maybe by the owner): leave it alone
    await omniApi(`/api/keys/${keyId}`, "PATCH", { isActive: false });
    updateBudgets(DATA_DIR, (b) => { if (b[keyId]) b[keyId].blockedByLimit = true; });
    console.log(`[portal] "${key.name}" used its one-time ${formatTokens(budget.tokenLimit)} tokens and was turned off.`);
  } finally {
    disabling.delete(keyId);
  }
}

async function sweepBudgets() {
  const budgets = loadBudgets(DATA_DIR);
  const ids = Object.keys(budgets);
  if (ids.length === 0) return;
  let keys;
  try {
    ({ keys = [] } = await omniApi("/api/keys"));
  } catch {
    return; // OmniRoute not up yet
  }
  const existing = new Set(keys.map((k) => k.id));
  const gone = ids.filter((id) => !existing.has(id));
  if (gone.length) updateBudgets(DATA_DIR, (b) => gone.forEach((id) => delete b[id]));
  for (const id of ids) {
    if (!existing.has(id)) continue;
    const state = onceBudgetState(DATA_DIR, id);
    if (state?.exhausted && !state.blockedByLimit) await disableExhausted(id).catch((e) => console.error("[portal] disable failed:", e.message));
  }
}
setInterval(() => sweepBudgets().catch(() => {}), 30_000);
setTimeout(() => sweepBudgets().catch(() => {}), 5_000);

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url || "/";

    if (url.startsWith("/v1")) {
      if (!isSafeV1Path(url)) return sendJson(res, 400, { error: { message: "Invalid path", type: "invalid_request_error" } });
      return proxyV1(req, res);
    }

    const pageHeaders = (body) => ({
      "content-type": "text/html; charset=utf-8",
      "content-length": body.length,
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });

    if (req.method === "GET" && /^\/docs\/?(\?.*)?$/.test(url)) {
      res.writeHead(200, pageHeaders(DOCS));
      return res.end(DOCS);
    }

    if (req.method === "GET" && (url === "/" || url.startsWith("/?"))) {
      res.writeHead(200, pageHeaders(PAGE));
      return res.end(PAGE);
    }

    if (req.method === "POST" && url === "/portal/api/usage") {
      if (!allowLookup(clientIp(req))) return sendJson(res, 429, { error: "Too many attempts. Wait a minute and try again." });
      let key;
      try {
        key = JSON.parse((await readBody(req, 4096)).toString("utf8")).key;
      } catch {
        return sendJson(res, 400, { error: "Bad request." });
      }
      if (typeof key !== "string" || key.trim().length < 10 || key.length > 512) {
        return sendJson(res, 400, { error: "Enter a valid API key." });
      }
      let usage;
      try {
        usage = await usageForKey(key.trim());
      } catch (error) {
        console.error("[portal] lookup failed:", error.message);
        return sendJson(res, 503, { error: "The server is busy or offline. Try again later." });
      }
      if (!usage) return sendJson(res, 404, { error: "This API key was not found." });
      return sendJson(res, 200, usage);
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("[portal] error:", error);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
    else res.destroy();
  }
});

server.requestTimeout = 0; // long streaming responses
server.timeout = 0;

server.listen(PORTAL_PORT, PORTAL_HOST, () => {
  writeFileSync(PID_FILE, String(process.pid));
  console.log(`OmniRoute user portal: http://${PORTAL_HOST === "0.0.0.0" ? "localhost" : PORTAL_HOST}:${PORTAL_PORT}`);
  console.log(`API for users:         http://${PORTAL_HOST === "0.0.0.0" ? "localhost" : PORTAL_HOST}:${PORTAL_PORT}/v1`);
});

const shutdown = () => {
  try {
    rmSync(PID_FILE, { force: true });
  } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
