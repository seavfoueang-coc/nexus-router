// keys.cmd: manage OmniRoute API keys from the command line.
// The same operations are available in the admin dashboard (admin.cmd).
//
// Usage: keys.cmd help

import {
  KeyOpsError,
  parseTokens,
  parseReset,
  formatTokens,
  findKey,
  listKeys,
  limitInfo,
  keyStatus,
  createKey,
  updateKey,
  setKeyActive,
  deleteKey,
} from "./keyops.mjs";

const HELP = `
OmniRoute key manager

  keys.cmd create <name> --tokens <n> [--reset once|daily|weekly|monthly] [--days <n> | --expires <YYYY-MM-DD>] [--models <a,b>]
  keys.cmd edit   <name> [--tokens <n>] [--reset <period>] [--days <n> | --expires <date> | --no-expiry] [--models <a,b> | --all-models] [--name <new>]
  keys.cmd list
  keys.cmd show    <name>
  keys.cmd disable <name>
  keys.cmd enable  <name>
  keys.cmd delete  <name>

Options
  --tokens   Token limit, input + output combined. Accepts 50M, 1.5B, 500k or a plain number.
  --reset    once     one-time balance that never resets: when it is used up, the key stops
                      working until you give it more with "edit --tokens"
             daily, weekly, monthly   the count starts over each period (default: monthly)
  --days     Key stops working this many days from now.
  --expires  Key stops working at the end of this date (local time), e.g. 2026-12-31.
  --models   Comma-separated model IDs the key may use. Omit to allow all models.

Examples
  keys.cmd create friend --tokens 50M --reset once --models "kr/claude-opus-5.5"
  keys.cmd create team --tokens 50M --reset monthly --days 30
  keys.cmd edit friend --tokens 100M          (top up a one-time key: 100M in total)
  keys.cmd list

Tip: admin.cmd opens a dashboard with the same features.
`;

// ---------- argument parsing ----------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function parseExpiryFlags(flags) {
  if (flags["no-expiry"]) return null;
  if (flags.days !== undefined) {
    const days = Number(flags.days);
    if (!Number.isFinite(days) || days <= 0) throw new KeyOpsError(`Invalid --days "${flags.days}".`);
    return new Date(Date.now() + days * 86400000).toISOString();
  }
  if (flags.expires !== undefined) {
    const match = String(flags.expires).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw new KeyOpsError(`Invalid --expires "${flags.expires}". Use YYYY-MM-DD.`);
    const end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59);
    if (Number.isNaN(end.getTime())) throw new KeyOpsError(`Invalid --expires "${flags.expires}".`);
    return end.toISOString();
  }
  return undefined;
}

function parseModelFlags(flags) {
  if (flags["all-models"]) return null;
  if (flags.models !== undefined) return String(flags.models).split(",");
  return undefined;
}

// ---------- formatting ----------

function formatDate(value) {
  if (value == null) return "never";
  const date = new Date(typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (x) => String(x).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const statusText = (s) => s.replace(/_/g, " ");

function describeReset(info) {
  if (!info) return "-";
  return info.reset === "once" ? "never (one-time)" : `${info.reset} (${formatDate(info.nextResetAt)})`;
}

// ---------- commands ----------

async function create(name, flags) {
  if (!name) throw new KeyOpsError("Usage: keys.cmd create <name> --tokens <n> ...");
  if (flags.tokens === undefined) throw new KeyOpsError("--tokens is required, e.g. --tokens 50M");
  const created = await createKey({
    name,
    tokenLimit: parseTokens(flags.tokens),
    reset: parseReset(flags.reset ?? "monthly"),
    expiresAt: parseExpiryFlags(flags) ?? null,
    models: parseModelFlags(flags) ?? null,
  });
  console.log(`
Key created: ${created.name}
  API key     : ${created.secret}
  Token limit : ${formatTokens(created.tokenLimit)} (input + output), ${created.reset === "once" ? "one-time, never resets" : `resets ${created.reset}`}
  Expires     : ${formatDate(created.expiresAt)}
  Models      : ${created.models?.length ? created.models.join(", ") : "all"}

Copy the API key now. OmniRoute will not show it again.${created.reset === "once" ? `
One-time limits are enforced by the user portal (portal.cmd, started by start.cmd). Keep it running.` : ""}`);
}

async function edit(nameOrId, flags) {
  const key = await findKey(nameOrId);
  const { reenabled } = await updateKey(key.id, {
    name: flags.name !== undefined ? String(flags.name) : undefined,
    tokenLimit: flags.tokens !== undefined ? parseTokens(flags.tokens) : undefined,
    reset: flags.reset !== undefined ? parseReset(flags.reset) : undefined,
    expiresAt: parseExpiryFlags(flags),
    models: parseModelFlags(flags),
  });
  if (reenabled) console.log("The key had run out of tokens and is now turned back on.");
  console.log(`Updated "${key.name}".`);
  await show(key.id);
}

async function list() {
  const keys = await listKeys();
  if (keys.length === 0) return console.log("No keys yet. Create one with keys.cmd create.");
  const rows = [];
  for (const key of keys) {
    const info = await limitInfo(key.id);
    rows.push({
      name: key.name,
      status: statusText(keyStatus(key, info)),
      used: info ? formatTokens(info.used) : "-",
      limit: info ? formatTokens(info.tokenLimit) : "none",
      left: info ? formatTokens(info.remaining) : "-",
      resets: describeReset(info),
      expires: formatDate(key.expiresAt),
      models: key.modelAccessMode === "restricted" ? key.allowedModels.join(", ") : "all",
    });
  }
  console.table(rows);
}

async function show(nameOrId) {
  const key = await findKey(nameOrId);
  const info = await limitInfo(key.id);
  console.log(`
${key.name}  (${statusText(keyStatus(key, info))})
  ID          : ${key.id}
  Key prefix  : ${key.keyPrefix}...
  Token limit : ${info ? `${formatTokens(info.tokenLimit)}, ${info.reset === "once" ? "one-time" : `resets ${info.reset}`}` : "none"}
  Used        : ${info ? `${formatTokens(info.used)} (${formatTokens(info.remaining)} left)` : "-"}
  Next reset  : ${describeReset(info)}
  Expires     : ${formatDate(key.expiresAt)}
  Models      : ${key.modelAccessMode === "restricted" ? key.allowedModels.join(", ") : "all"}
  Last used   : ${formatDate(key.lastUsedAt)}`);
}

async function setActive(nameOrId, isActive) {
  const key = await findKey(nameOrId);
  await setKeyActive(key.id, isActive);
  console.log(`"${key.name}" is now ${isActive ? "enabled" : "disabled"}.`);
}

async function remove(nameOrId) {
  const key = await findKey(nameOrId);
  await deleteKey(key.id);
  console.log(`Deleted "${key.name}".`);
}

// ---------- main ----------

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, target] = positional;

if (!command || command === "help" || flags.help) {
  console.log(HELP);
  process.exit(0);
}

try {
  switch (command) {
    case "create": await create(target, flags); break;
    case "edit": await edit(target, flags); break;
    case "list": await list(); break;
    case "show": await show(target); break;
    case "disable": await setActive(target, false); break;
    case "enable": await setActive(target, true); break;
    case "delete": await remove(target); break;
    default: throw new KeyOpsError(`Unknown command "${command}". Run keys.cmd help.`);
  }
} catch (error) {
  console.error(`Error: ${error instanceof KeyOpsError ? error.message : error?.stack || error}`);
  process.exit(1);
}
