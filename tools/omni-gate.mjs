// Public access to the admin dashboard and the OmniRoute dashboard, behind one hardened login.
// Used by tools/admin.mjs. See VPS-DEPLOY.md section 9 and DEPLOY.md.
//
//   https://<ADMIN_PUBLIC_HOST>  -> the admin dashboard (same app as http://127.0.0.1:20140)
//   https://<OMNI_PUBLIC_HOST>   -> gate login, then a reverse proxy to OmniRoute (127.0.0.1:20128),
//                                   including WebSocket upgrades. OmniRoute still asks for its own login.
//
// Public hosts are only accepted from the loopback peer (cloudflared runs in the same container) and only
// while the OmniRoute dashboard password is not the default CHANGEME.

import http from "node:http";
import net from "node:net";

export const ADMIN_PUBLIC_HOST = (process.env.ADMIN_PUBLIC_HOST || "").trim().toLowerCase();
export const OMNI_PUBLIC_HOST = (process.env.OMNI_PUBLIC_HOST || "").trim().toLowerCase();
const OMNI_PORT = Number(process.env.PORT || 20128);
const OMNI_TARGET = `127.0.0.1:${OMNI_PORT}`;

export const GATE_COOKIE = "omr_gate";
const LOCK_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "proxy-authenticate"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isLoopbackPeer(req) {
  const ip = req.socket.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/** Real visitor IP: cf-connecting-ip, trusted only from the loopback peer (cloudflared). */
export function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (isLoopbackPeer(req) && typeof cf === "string" && cf) return cf;
  return req.socket.remoteAddress || "unknown";
}

/** "local" | "admin" | "omni" | null, from the Host header. */
export function hostKind(req, localHosts) {
  const host = String(req.headers.host || "").toLowerCase();
  if (localHosts.has(host)) return "local";
  if (ADMIN_PUBLIC_HOST && host === ADMIN_PUBLIC_HOST) return "admin";
  if (OMNI_PUBLIC_HOST && host === OMNI_PUBLIC_HOST) return "omni";
  return null;
}

// ---------- per-IP lockout (on top of the global limit in admin.mjs) ----------

const failures = new Map(); // ip -> { count, firstAt, lockedUntil }

export function lockedFor(ip) {
  const f = failures.get(ip);
  if (!f) return 0;
  if (f.lockedUntil && f.lockedUntil > Date.now()) return f.lockedUntil - Date.now();
  if (Date.now() - f.firstAt > FAIL_WINDOW_MS) failures.delete(ip);
  return 0;
}

export function recordFailure(ip, where) {
  const now = Date.now();
  let f = failures.get(ip);
  if (!f || now - f.firstAt > FAIL_WINDOW_MS) f = { count: 0, firstAt: now, lockedUntil: 0 };
  f.count++;
  if (f.count >= LOCK_FAILS) f.lockedUntil = now + LOCK_MS;
  failures.set(ip, f);
  if (failures.size > 50_000) failures.clear();
  console.warn(`[gate] failed sign-in from ${ip} on ${where} (${f.count} in 15 min${f.lockedUntil ? ", locked 15 min" : ""})`);
}

export function recordSuccess(ip) {
  failures.delete(ip);
}

// ---------- CHANGEME guard ----------

let publicAllowed = null; // null = not checked yet
let guardTimer = null;

export function startPasswordGuard(verifyPassword) {
  const check = async () => {
    try {
      const isDefault = await verifyPassword("CHANGEME");
      if (isDefault && publicAllowed !== false) console.warn("[gate] OmniRoute still accepts CHANGEME: public dashboards are OFF");
      publicAllowed = !isDefault;
    } catch {
      // OmniRoute not up yet, or rate limited: keep the last known state.
    }
  };
  check();
  guardTimer = setInterval(check, 10 * 60 * 1000);
  guardTimer.unref?.();
}

export function publicState() {
  return publicAllowed;
}

// ---------- pages ----------

const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function sendHtml(res, status, html) {
  const body = Buffer.from(html);
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000",
    "content-security-policy": PAGE_CSP,
  });
  res.end(body);
}

export function sendNotReady(res) {
  sendHtml(
    res,
    503,
    `<!doctype html><meta charset="utf-8"><title>Not available</title><body style="font:16px system-ui;margin:4rem auto;max-width:32rem;color:#ddd;background:#111">
<h1 style="font-size:1.3rem">Not available yet</h1>
<p>The public dashboards stay off while the OmniRoute dashboard password is still the default (CHANGEME), or while OmniRoute is starting. Set a new password locally, then try again in a few minutes.</p></body>`
  );
}

function gateLoginPage() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:grid;place-items:center;min-height:100vh;margin:0}
 form{width:min(22rem,90vw);background:#171a21;border:1px solid #2a2f3a;border-radius:10px;padding:1.6rem}
 h1{font-size:1.15rem;margin:0 0 .3rem} p{margin:0 0 1rem;color:#9aa3b2;font-size:.9rem}
 input{width:100%;box-sizing:border-box;height:44px;border-radius:6px;border:1px solid #2f3542;background:#0f1115;color:#fff;padding:0 .8rem;font-size:1rem}
 button{margin-top:.9rem;width:100%;height:44px;border:0;border-radius:6px;background:#3b82f6;color:#fff;font-weight:600;font-size:1rem;cursor:pointer}
 button:disabled{opacity:.6} .err{color:#f87171;min-height:1.4em;margin-top:.7rem;font-size:.9rem}
</style>
<form id="f"><h1>OmniRoute</h1><p>Sign in with the OmniRoute dashboard password. OmniRoute then asks for it once more.</p>
<label for="p" style="font-size:.85rem;color:#9aa3b2">Password</label>
<input id="p" type="password" autocomplete="current-password" required autofocus>
<button id="b">Sign in</button><div class="err" id="e" role="alert"></div></form>
<script>
 const f=document.getElementById('f'),b=document.getElementById('b'),e=document.getElementById('e');
 f.addEventListener('submit',async(ev)=>{ev.preventDefault();b.disabled=true;e.textContent='';
  try{const r=await fetch('/__gate/login',{method:'POST',headers:{'content-type':'application/json','x-admin-request':'1'},body:JSON.stringify({password:document.getElementById('p').value})});
   const d=await r.json().catch(()=>({}));
   if(r.ok){const n=new URLSearchParams(location.search).get('next')||'/';location.replace(/^\\/(?!\\/)/.test(n)?n:'/');return;}
   e.textContent=d.error||'Sign-in failed.';}catch{e.textContent='Network error.';}
  b.disabled=false;});
</script></html>`;
}

export function sendGateLogin(res) {
  sendHtml(res, 200, gateLoginPage());
}

// ---------- reverse proxy to OmniRoute ----------

function stripGateCookie(cookieHeader) {
  if (!cookieHeader) return undefined;
  const kept = String(cookieHeader)
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(`${GATE_COOKIE}=`));
  return kept.length ? kept.join("; ") : undefined;
}

const publicOrigin = () => `https://${OMNI_PUBLIC_HOST}`;
const localOrigin = `http://${OMNI_TARGET}`;

function rewriteToLocal(value) {
  return String(value).startsWith(publicOrigin()) ? localOrigin + String(value).slice(publicOrigin().length) : value;
}

function rewriteToPublic(value) {
  const v = String(value);
  for (const prefix of [localOrigin, `http://localhost:${OMNI_PORT}`]) {
    if (v.startsWith(prefix)) return publicOrigin() + v.slice(prefix.length);
  }
  return v;
}

/** Headers sent to OmniRoute: no CLI token, no gate cookie, visitor IP in X-Forwarded-For (so loopback-only
 *  trust paths in OmniRoute fail closed), Host/Origin/Referer as if the browser were local. */
function upstreamHeaders(req, keepUpgrade) {
  const headers = { ...req.headers };
  if (!keepUpgrade) for (const h of HOP_BY_HOP) delete headers[h];
  delete headers["x-omniroute-cli-token"];
  const cookie = stripGateCookie(req.headers.cookie);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  headers.host = OMNI_TARGET;
  if (headers.origin) headers.origin = rewriteToLocal(headers.origin);
  if (headers.referer) headers.referer = rewriteToLocal(headers.referer);
  headers["x-forwarded-for"] = clientIp(req);
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-host"] = OMNI_PUBLIC_HOST;
  return headers;
}

/** State-changing requests must come from the public OmniRoute page itself. */
export function originOk(req) {
  if (SAFE_METHODS.has(req.method || "GET")) return true;
  return req.headers.origin === publicOrigin();
}

function fixSetCookie(values) {
  const list = Array.isArray(values) ? values : [values];
  return list.map((c) => {
    let v = String(c).replace(/;\s*domain=[^;]*/gi, "");
    if (!/;\s*secure/i.test(v)) v += "; Secure";
    return v;
  });
}

export function proxyHttp(req, res) {
  const upstream = http.request(
    { host: "127.0.0.1", port: OMNI_PORT, method: req.method, path: req.url, headers: upstreamHeaders(req, false) },
    (up) => {
      const headers = { ...up.headers };
      for (const h of HOP_BY_HOP) delete headers[h];
      if (headers.location) headers.location = rewriteToPublic(headers.location);
      if (headers["set-cookie"]) headers["set-cookie"] = fixSetCookie(headers["set-cookie"]);
      headers["strict-transport-security"] = "max-age=31536000";
      res.writeHead(up.statusCode || 502, headers);
      up.pipe(res);
    }
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("OmniRoute is not answering.");
    } else res.destroy();
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

export function proxyUpgrade(req, socket, head) {
  const upstream = net.connect(OMNI_PORT, "127.0.0.1", () => {
    const headers = upstreamHeaders(req, true);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      for (const one of Array.isArray(v) ? v : [v]) raw += `${k}: ${one}\r\n`;
    }
    upstream.write(raw + "\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
  socket.on("close", () => upstream.destroy());
}
