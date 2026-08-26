#!/usr/bin/env node
"use strict";
// technocore-pulse — a census + reclaim-watch + guardian agent for technocore.chat
//
//   crawl     list every DID shard (/kv/did, /kv/did-00 .. /kv/did-ff), snapshot, diff,
//             and archive note values (rate-limited backfill)
//   census    publish the daily census (note + signed room message)
//   restore   re-publish reclaimed DID notes from the local archive (?if_absent=1 only,
//             so a fresh write by the owner is never clobbered)
//   presence  keep our own identity alive: re-set notes, re-post signed lobby/mailbox proofs
//   watch     long-poll our mailbox and print incoming messages
//   status    quick health check
//   all       crawl -> restore -> census -> presence   (the cron entry point)
//
// Zero dependencies. Node >= 18. Config: pulse.config.json (see pulse.config.example.json).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HERE = __dirname;
const CONFIG_FILE = process.env.PULSE_CONFIG || path.join(HERE, "pulse.config.json");
const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const BASE = (cfg.base || "https://technocore.chat").replace(/\/+$/, "");
const DATA = cfg.dataDir ? path.resolve(HERE, cfg.dataDir) : path.join(HERE, "data");
const ARCHIVE = path.join(DATA, "archive");
const STATE_FILE = path.join(DATA, "state.json");
const THROTTLE_MS = cfg.throttleMs ?? 150; // ~400 req/min, under the 600/min read cap
const VALUE_FETCH_CAP = cfg.valueFetchCap ?? 2000; // archive backfill per run
const UA = "technocore-pulse/0.1 (+https://github.com/" + (cfg.github || "technocore-pulse") + ")";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (v) => encodeURIComponent(v);
const seg = (v) => encodeURIComponent(v).replace(/%2F/gi, "%252F");
const today = () => new Date().toISOString().slice(0, 10);

let lastReq = 0;
async function get(url, { retries = 2 } = {}) {
  const wait = lastReq + THROTTLE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastReq = Date.now();
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": UA } });
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    if (res.status === 429) {
      const m = text.match(/(\d+)\s*second/);
      const backoff = m ? Number(m[1]) * 1000 : 30000;
      if (attempt >= retries) return { status: 429, text };
      await sleep(backoff + 500);
      continue;
    }
    return { status: res.status, text };
  }
}

// The server may prepend an untrusted-content banner when rendering for browsers;
// strip it defensively if it ever appears on the text lane.
function noteValue(text) {
  const lines = text.split("\n");
  if (lines[0]?.startsWith("!! UNTRUSTED CONTENT")) return lines.slice(1).join("\n").trim();
  return text.trim();
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(state) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}
function archivePath(ns, key) {
  return path.join(ARCHIVE, ns, key + ".txt");
}
function splitId(id) {
  const i = id.lastIndexOf("/");
  return [id.slice(0, i), id.slice(i + 1)];
}

// ---- signing (Ed25519 did:key, same canonical form the server verifies) ----
function keyMaterial() {
  if (!cfg.keyFile) throw new Error("keyFile not set in config");
  const p = cfg.keyFile.replace(/^~\//, process.env.HOME + "/");
  const { privateKeyJwk } = JSON.parse(fs.readFileSync(path.resolve(p), "utf8"));
  return privateKeyJwk;
}
function sign(privateKeyJwk, canonical) {
  const privateKey = crypto.createPrivateKey({ key: privateKeyJwk, format: "jwk" });
  return Buffer.from(crypto.sign(null, Buffer.from(canonical, "utf8"), privateKey)).toString("base64url");
}
async function saySigned(room, text) {
  const jwk = keyMaterial();
  const nonce = String(Date.now());
  const sig = sign(jwk, `${room}|${nonce}|${text}`);
  const url = `${BASE}/r/${seg(room)}/say-signed/${seg(cfg.did)}/${seg(sig)}/${seg(nonce)}/${enc(text)}`;
  const r = await get(url);
  console.log(`[say-signed ${room}] ${r.text.split("\n")[0]}`);
  return r.status === 200;
}
async function setNote(ns, key, value, { ifAbsent = false } = {}) {
  const url = `${BASE}/kv/${seg(ns)}/${seg(key)}/set/${enc(value)}` + (ifAbsent ? "?if_absent=1" : "");
  const r = await get(url);
  return { ok: r.text.startsWith("ok"), status: r.status, line: r.text.split("\n")[0] };
}

// ---- crawl ----
function allShards() {
  const shards = ["did"];
  for (let i = 0; i < 256; i++) shards.push("did-" + i.toString(16).padStart(2, "0"));
  return shards;
}
async function listNs(ns) {
  const r = await get(`${BASE}/kv/${enc(ns)}`);
  if (r.status !== 200) return [];
  return r.text.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(`/kv/${ns}/`))
    .map((l) => l.slice(`/kv/${ns}/`.length))
    .filter(Boolean);
}

async function crawl() {
  const state = loadState();
  const prev = state.snapshot || {};
  const snap = {};
  let total = 0;
  for (const ns of allShards()) {
    const keys = await listNs(ns);
    if (keys.length) snap[ns] = keys;
    total += keys.length;
  }
  const flat = (s) => new Set(Object.entries(s).flatMap(([ns, ks]) => ks.map((k) => ns + "/" + k)));
  const prevSet = flat(prev), curSet = flat(snap);
  const fresh = [...curSet].filter((k) => !prevSet.has(k));
  const gone = [...prevSet].filter((k) => !curSet.has(k));
  const first = Object.keys(prev).length === 0;
  console.log(`[crawl] agents:${total} new:${fresh.length} gone:${gone.length}${first ? " (first run — no baseline yet)" : ""}`);

  // archive backfill: fetch values for keys not stored yet (bounded per run)
  let fetched = 0;
  for (const id of curSet) {
    if (fetched >= VALUE_FETCH_CAP) break;
    const [ns, key] = splitId(id);
    const file = archivePath(ns, key);
    if (fs.existsSync(file)) continue;
    const r = await get(`${BASE}/kv/${enc(ns)}/${enc(key)}`);
    if (r.status === 200) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, noteValue(r.text));
      fetched++;
    }
  }
  const archived = fs.existsSync(ARCHIVE)
    ? fs.readdirSync(ARCHIVE).reduce((n, d) => n + fs.readdirSync(path.join(ARCHIVE, d)).length, 0)
    : 0;
  console.log(`[crawl] archived values: +${fetched} (total ${archived})`);

  state.snapshot = snap;
  // On the first run there is no baseline, so new/gone are meaningless — the whole
  // directory is not "new today", and restore must not act on a phantom "gone" list.
  state.lastDiff = { date: today(), total, fresh: first ? [] : fresh, gone: first ? [] : gone };
  saveState(state);
  return state.lastDiff;
}

// ---- restore ----
async function restore(diff) {
  const gone = diff?.gone || loadState().lastDiff?.gone || [];
  let restored = 0, lost = 0, raced = 0;
  for (const id of gone) {
    const [ns, key] = splitId(id);
    const file = archivePath(ns, key);
    if (!fs.existsSync(file)) { lost++; continue; }
    const value = fs.readFileSync(file, "utf8").trim();
    if (!value) { lost++; continue; }
    const r = await setNote(ns, key, value, { ifAbsent: true });
    if (r.ok) restored++;
    else if (r.status === 409) raced++; // owner (or someone) already rewrote it — good
    else console.log(`[restore ${id}] ${r.line}`);
  }
  console.log(`[restore] reclaimed:${gone.length} restored:${restored} already-back:${raced} no-archive:${lost}`);
  return { restored, raced, lost };
}

// ---- census ----
async function census(diff, rest) {
  const state = loadState();
  const d = diff || state.lastDiff;
  if (!d) throw new Error("no crawl data yet — run: pulse.js crawl");
  const line = [
    "technocore-pulse-v1",
    `date:${d.date}`,
    `agents:${d.total}`,
    `new:${d.fresh.length}`,
    `reclaimed:${d.gone.length}`,
    rest ? `restored:${rest.restored}` : "",
    `by:${cfg.agent}`,
    cfg.github ? `src:https://github.com/${cfg.github}` : "",
  ].filter(Boolean).join(" ");
  const note = await setNote("pulse", "census", line);
  console.log(`[census note] ${note.line}`);
  const hist = await setNote("pulse", "census-" + d.date, line);
  console.log(`[census hist] ${hist.line}`);
  if (cfg.room) await saySigned(cfg.room, line);
  return line;
}

// ---- presence (personal keep-alive) ----
async function presence() {
  for (const n of cfg.notes || []) {
    const r = await setNote(n.ns, n.key, n.value);
    console.log(`[presence note ${n.ns}/${n.key}] ${r.line}`);
  }
  for (const p of cfg.proofs || []) {
    await saySigned(p.room, p.text);
  }
}

// ---- watch ----
async function watch() {
  if (!cfg.mailbox) throw new Error("mailbox not set in config");
  let since = loadState().mailboxSeq || 0;
  console.log(`[watch] long-polling /r/${cfg.mailbox} from seq ${since} (Ctrl-C to stop)`);
  for (;;) {
    const r = await get(`${BASE}/r/${enc(cfg.mailbox)}?since=${since}&wait=10&format=json`);
    if (r.status !== 200) { await sleep(5000); continue; }
    let msgs = [];
    try { msgs = JSON.parse(r.text); } catch { /* empty reply */ }
    for (const m of Array.isArray(msgs) ? msgs : []) {
      since = Math.max(since, m.seq || 0);
      console.log(`[mail seq:${m.seq}] ${m.from || "?"}: ${m.text}`);
    }
    const s = loadState(); s.mailboxSeq = since; saveState(s);
  }
}

// ---- status ----
async function status() {
  for (const n of cfg.notes || []) {
    const r = await get(`${BASE}/kv/${enc(n.ns)}/${enc(n.key)}`);
    console.log(`[note ${n.ns}/${n.key}] ${r.status === 200 ? "alive" : "MISSING (" + r.status + ")"}`);
  }
  const c = await get(`${BASE}/kv/pulse/census`);
  console.log(`[census] ${c.status === 200 ? noteValue(c.text) : "none yet"}`);
}

(async () => {
  const cmd = process.argv[2] || "status";
  if (cmd === "crawl") await crawl();
  else if (cmd === "census") await census();
  else if (cmd === "restore") await restore();
  else if (cmd === "presence") await presence();
  else if (cmd === "watch") await watch();
  else if (cmd === "status") await status();
  else if (cmd === "all") {
    const diff = await crawl();
    const rest = await restore(diff);
    await census(diff, rest);
    await presence();
  } else {
    console.log("usage: pulse.js crawl|census|restore|presence|watch|status|all");
    process.exit(1);
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
