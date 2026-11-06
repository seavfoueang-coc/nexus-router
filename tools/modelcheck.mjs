// Model check: sends one tiny chat request per model and remembers which ones the provider really accepts.
// OmniRoute lists some IDs the provider rejects (for Kiro: most "-low/-medium/-high/-xhigh" variants answer
// 400 INVALID_MODEL_ID). Results live in data/model-checks.json; the admin dashboard hides "broken" models
// from the key editor and shows the status on the Models page.
//
// Status per model:
//   ok      the provider answered 2xx
//   broken  the provider said the model ID does not exist (permanent, safe to hide)
//   failed  any other error (quota, expired account, timeout): shown, not hidden, may pass later

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, api, createKey, deleteKey } from "./keyops.mjs";

const FILE = join(DATA_DIR, "model-checks.json");
const OMNI_PORT = Number(process.env.PORT || 20128);
const CONCURRENCY = 3;
const TIMEOUT_MS = 60_000;
export const TEMP_KEY_NAME = "admin-model-check (temporary)";

export function readChecks() {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function saveChecks(results) {
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(results, null, 1));
  renameSync(tmp, FILE);
}

/** Decide ok / broken / failed from one response. Exported for tests. */
export function classify(status, bodyText) {
  if (status >= 200 && status < 300) return { status: "ok" };
  let message = String(bodyText || "").slice(0, 300);
  try {
    const j = JSON.parse(bodyText);
    const e = j.error ?? j;
    message = typeof e === "string" ? e : e.message || JSON.stringify(e);
  } catch {}
  message = String(message).replace(/\s+/g, " ").slice(0, 200);
  const invalidId = /INVALID_MODEL_ID|invalid model id|model[^.]{0,40}(not found|does not exist|not supported|unknown)|unknown model/i;
  if ((status === 400 || status === 404) && invalidId.test(`${bodyText}`)) return { status: "broken", code: status, message };
  return { status: "failed", code: status, message };
}

let job = null; // { running, total, done, startedAt, finishedAt, error }

export function checkJob() {
  return job ? { ...job } : null;
}

/** Start checking the given model IDs in the background. Returns false when a check is already running. */
export function startCheck(ids) {
  if (job?.running) return false;
  const list = [...new Set(ids.map(String).filter(Boolean))].slice(0, 400);
  job = { running: true, total: list.length, done: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null };
  runCheck(list).catch((error) => {
    job.error = error.message;
  }).finally(() => {
    job.running = false;
    job.finishedAt = new Date().toISOString();
  });
  return true;
}

async function runCheck(list) {
  // Remove temporary keys a stopped check may have left behind.
  const leftovers = ((await api("GET", "/api/keys")).keys || []).filter((k) => String(k.name || "").startsWith(TEMP_KEY_NAME));
  for (const k of leftovers) await deleteKey(k.id).catch(() => {});
  // A short-lived key that can use every model, with a small one-time budget, deleted afterwards.
  const key = await createKey({ name: `${TEMP_KEY_NAME} ${Date.now().toString(36)}`, tokenLimit: "2M", reset: "once", models: null });
  try {
    const queue = [...list];
    const one = async (model) => {
      let result;
      try {
        const res = await fetch(`http://127.0.0.1:${OMNI_PORT}/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
          body: JSON.stringify({ model, max_tokens: 8, stream: false, messages: [{ role: "user", content: "Say ok" }] }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        result = classify(res.status, await res.text());
      } catch (error) {
        result = { status: "failed", code: null, message: error.name === "TimeoutError" ? "No answer within 60 s" : error.message };
      }
      const all = readChecks();
      all[model] = { ...result, at: new Date().toISOString() };
      saveChecks(all);
      job.done += 1;
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) await one(queue.shift());
    }));
  } finally {
    await deleteKey(key.id).catch(() => {});
  }
}
