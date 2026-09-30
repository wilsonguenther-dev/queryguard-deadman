#!/usr/bin/env node
// Outside dead-man switch for QueryGuard Uptime (docs/specs/QUERYGUARD-UPTIME.md §6, revisions R-F and R-O; decision D42).
// Owner doc: docs/uptime/DEADMAN.md. CANONICAL in wilsonguenther-dev/drivia-consulting; the public repo
// wilsonguenther-dev/queryguard-deadman carries a byte-identical copy (any change pushes the same bytes there and
// pastes both sha256s; the QGU-U5A preflight compares them).
//
// Node 24, no dependencies, no secrets. For each target in docs/uptime/deadman-targets.json it GETs the URL with a
// 10 s timeout and one retry after 20 s; a target fails when both attempts miss (non-2xx status, timeout, network
// error, or a keyword that is not in the body byte for byte). A 429 with retry-after is a retry, not a failure.
// Run logs of the public repo are readable by anyone, so this prints NO response body: one line per target with
// PASS/FAIL, the URL, the status and a reason code. Exit 1 on any failure (the failed run is the alert).
//
// Then (§6 step 2, QGU-U5B) it GETs https://drivia.consulting/api/uptime/heartbeat (same timeout and retry) and fails
// unless the answer is 200 with "ok": true and age_s <= HEARTBEAT_MAX_AGE_S. The route itself answers 503 heartbeat_stale
// once the pg_cron prober's newest check is over 1200 s old, so that 503 is the prober-freshness alarm; the client-side
// age_s ceiling is a second line only (default 21600 s = 6 h, env HEARTBEAT_MAX_AGE_S overrides; the same 6 h as the
// reciprocal threshold, because GitHub runs this schedule hours late on this account: docs/uptime/DEADMAN.md).
// A 503 carries a reason code from the body (heartbeat_stale, stale_monitors, alerts_stale); nothing else from it is printed.
// The User-Agent 'uptime-deadman/1' is also how the heartbeat knows the dead-man is alive: each call stamps
// ops.uptime_deadman_seen, and database #2 emails ops when that stamp is older than ops.app_config
// 'uptime_deadman_silence_threshold' (default 6 hours; the reciprocal dead-man).
//
//   node scripts/uptime/deadman.mjs                 probe every target in docs/uptime/deadman-targets.json, then the heartbeat
//   node scripts/uptime/deadman.mjs --target <url>  probe <url> alone (keyword none, no heartbeat); honoured ONLY when
//                                                   GITHUB_EVENT_NAME is workflow_dispatch (alert-path proof)
//   node scripts/uptime/deadman.mjs --self-test     run the same logic against in-process fixtures, exit 0 iff
//                                                   every fixture produces its expected verdict
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USER_AGENT = 'uptime-deadman/1';
const TARGETS_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/uptime/deadman-targets.json');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LIVE = { timeoutMs: 10_000, retryDelayMs: 20_000, maxRetryAfterMs: 20_000, max429Retries: 2 };
const HEARTBEAT = { name: 'drivia.consulting heartbeat', url: 'https://drivia.consulting/api/uptime/heartbeat', heartbeat: true };
const HEARTBEAT_MAX_AGE_S = (() => {
  const v = Number(process.env.HEARTBEAT_MAX_AGE_S);
  return Number.isFinite(v) && v > 0 ? v : 21_600;
})();

// The heartbeat's verdict from its JSON (docs/specs/QUERYGUARD-UPTIME.md §6 + R-F). Returns a reason code, never the body.
function heartbeatReason(status, body) {
  let j = null;
  try {
    j = JSON.parse(body.toString('utf8'));
  } catch {
    j = null;
  }
  if (status !== 200) {
    if (j && j.alerts_stale === true) return 'alerts_stale';
    if (j && j.stale === true) return 'heartbeat_stale';
    if (j && typeof j.stale_monitors === 'number') return 'stale_monitors';
    return `http_${status}`;
  }
  if (!j || typeof j !== 'object') return 'bad_body';
  if (j.ok !== true) return 'not_ok';
  if (typeof j.age_s !== 'number' || !Number.isFinite(j.age_s)) return 'bad_body';
  if (j.age_s > HEARTBEAT_MAX_AGE_S) return 'heartbeat_stale';
  return 'ok';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// retry-after is either delay-seconds or an HTTP date (RFC 9110 §10.2.3). Returns ms, or null when absent/unusable.
function parseRetryAfter(value) {
  if (value == null || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

async function readBodyCapped(res) {
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= MAX_BODY_BYTES) break;
  }
  return Buffer.concat(chunks);
}

// One GET. Returns { status, reason, retryAfterMs } where reason is 'ok' on success. Never returns the body.
async function attempt(target, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    const res = await fetch(target.url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, 'cache-control': 'no-cache' },
      redirect: 'follow',
      signal: ctl.signal,
    });
    const body = await readBodyCapped(res);
    if (res.status === 429) {
      return { status: 429, reason: 'rate_limited', retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) };
    }
    if (target.heartbeat) return { status: res.status, reason: heartbeatReason(res.status, body) };
    if (res.status < 200 || res.status > 299) return { status: res.status, reason: `http_${res.status}` };
    if (typeof target.keyword === 'string' && !body.includes(Buffer.from(target.keyword, 'utf8'))) {
      return { status: res.status, reason: 'keyword_missing' };
    }
    return { status: res.status, reason: 'ok' };
  } catch (err) {
    if (ctl.signal.aborted) return { status: 0, reason: 'timeout' };
    return { status: 0, reason: `network_${err?.cause?.code || err?.name || 'error'}`.toLowerCase() };
  } finally {
    clearTimeout(timer);
  }
}

// Two real attempts (one retry after retryDelayMs). A 429 carrying retry-after waits (capped) and tries again
// without spending an attempt, at most max429Retries times.
async function probe(target, opts) {
  let attempts = 0;
  let waits429 = 0;
  let last;
  while (attempts < 2) {
    last = await attempt(target, opts);
    if (last.reason === 'ok') return { ...last, pass: true };
    if (last.status === 429 && last.retryAfterMs != null && waits429 < opts.max429Retries) {
      waits429 += 1;
      await sleep(Math.min(last.retryAfterMs, opts.maxRetryAfterMs));
      continue;
    }
    attempts += 1;
    if (attempts < 2) await sleep(opts.retryDelayMs);
  }
  return { ...last, pass: false };
}

function line(target, r) {
  return `${r.pass ? 'PASS' : 'FAIL'} ${target.url} status=${r.status || '-'} reason=${r.reason}`;
}

function loadTargets() {
  const list = JSON.parse(readFileSync(TARGETS_FILE, 'utf8'));
  if (!Array.isArray(list) || list.length === 0) throw new Error('deadman-targets.json: expected a non-empty array');
  for (const t of list) {
    if (!t || typeof t.url !== 'string' || !/^https?:\/\//.test(t.url)) throw new Error('deadman-targets.json: bad url');
    if (t.keyword !== null && typeof t.keyword !== 'string') throw new Error('deadman-targets.json: keyword must be string or null');
  }
  return list;
}

async function runLive(argv) {
  let targets = loadTargets();
  let dispatchOnly = false;
  const i = argv.indexOf('--target');
  if (i !== -1) {
    const url = argv[i + 1];
    if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
      console.log('NOTE --target ignored: only honoured when GITHUB_EVENT_NAME is workflow_dispatch');
    } else if (!url || !/^https?:\/\//.test(url)) {
      console.log('FAIL --target reason=bad_target_url');
      return 1;
    } else {
      targets = [{ name: 'dispatch target', url, keyword: null }];
      dispatchOnly = true;
    }
  }
  if (!dispatchOnly) targets = [...targets, HEARTBEAT];
  const results = await Promise.all(targets.map((t) => probe(t, LIVE)));
  let failed = 0;
  targets.forEach((t, k) => {
    console.log(line(t, results[k]));
    if (!results[k].pass) failed += 1;
  });
  console.log(`deadman: ${targets.length - failed}/${targets.length} PASS`);
  return failed ? 1 : 0;
}

// ---- self-test: the same probe() against an in-process http server -------------------------------------------
async function runSelfTest() {
  let hits429 = 0;
  const server = createServer((req, res) => {
    if (req.headers['user-agent'] !== USER_AGENT) {
      res.writeHead(400).end('wrong user-agent');
      return;
    }
    switch (req.url) {
      case '/healthy':
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"db":true}');
        return;
      case '/home':
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>home</body></html>');
        return;
      case '/missing-keyword':
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok": true,"db":false}');
        return;
      case '/not-found':
        res.writeHead(404).end('nope');
        return;
      case '/timeout':
        return; // never answers; the client's abort ends it
      // Heartbeat fixtures: the real route's body shapes (counts and ages only, no monitor name or URL). Freshness comes
      // from the prober's last_check_at alone; the dead-man's own call never makes a heartbeat fresh.
      case '/hb-fresh':
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, last_check_at: new Date(Date.now() - 42_000).toISOString(), age_s: 42 }));
        return;
      case '/hb-stale-200':
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, last_check_at: new Date(Date.now() - (HEARTBEAT_MAX_AGE_S + 300) * 1000).toISOString(), age_s: HEARTBEAT_MAX_AGE_S + 300 }));
        return;
      case '/hb-stale-503':
        res.writeHead(503, { 'content-type': 'application/json' }).end('{"ok":false,"stale":true,"age_s":1500}');
        return;
      case '/hb-alerts-stale':
        res.writeHead(503, { 'content-type': 'application/json' }).end('{"ok":false,"alerts_stale":true}');
        return;
      case '/hb-not-ok':
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":false}');
        return;
      case '/429-then-200':
        hits429 += 1;
        if (hits429 === 1) res.writeHead(429, { 'retry-after': '0' }).end('slow down');
        else res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      default:
        res.writeHead(500).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const opts = { timeoutMs: 400, retryDelayMs: 50, maxRetryAfterMs: 50, max429Retries: 2 };
  const fixtures = [
    { name: 'healthy', path: '/healthy', keyword: '"ok":true', expect: 'PASS', reason: 'ok' },
    { name: 'healthy-no-keyword', path: '/home', keyword: null, expect: 'PASS', reason: 'ok' },
    { name: 'missing-keyword', path: '/missing-keyword', keyword: '"ok":true', expect: 'FAIL', reason: 'keyword_missing' },
    { name: 'timeout', path: '/timeout', keyword: null, expect: 'FAIL', reason: 'timeout' },
    { name: '429-then-200', path: '/429-then-200', keyword: '"ok":true', expect: 'PASS', reason: 'ok' },
    { name: 'http-404', path: '/not-found', keyword: null, expect: 'FAIL', reason: 'http_404' },
    { name: 'heartbeat-fresh', path: '/hb-fresh', heartbeat: true, expect: 'PASS', reason: 'ok' },
    { name: 'heartbeat-stale-200', path: '/hb-stale-200', heartbeat: true, expect: 'FAIL', reason: 'heartbeat_stale' },
    { name: 'heartbeat-stale-503', path: '/hb-stale-503', heartbeat: true, expect: 'FAIL', reason: 'heartbeat_stale' },
    { name: 'heartbeat-alerts-stale-503', path: '/hb-alerts-stale', heartbeat: true, expect: 'FAIL', reason: 'alerts_stale' },
    { name: 'heartbeat-not-ok', path: '/hb-not-ok', heartbeat: true, expect: 'FAIL', reason: 'not_ok' },
  ];
  let mismatches = 0;
  try {
    for (const f of fixtures) {
      const r = await probe({ name: f.name, url: base + f.path, keyword: f.keyword ?? null, heartbeat: f.heartbeat === true }, opts);
      const got = r.pass ? 'PASS' : 'FAIL';
      const ok = got === f.expect && r.reason === f.reason;
      if (!ok) mismatches += 1;
      console.log(`${ok ? 'OK  ' : 'BAD '} fixture=${f.name} expected=${f.expect}/${f.reason} got=${got}/${r.reason} status=${r.status || '-'}`);
    }
    if (hits429 !== 2) {
      mismatches += 1;
      console.log(`BAD  fixture=429-then-200 expected 2 requests, server saw ${hits429}`);
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  console.log(`self-test: ${fixtures.length - mismatches}/${fixtures.length} fixtures as expected`);
  return mismatches ? 1 : 0;
}

const argv = process.argv.slice(2);
const main = argv.includes('--self-test') ? runSelfTest : () => runLive(argv);
main().then(
  (code) => process.exit(code),
  (err) => {
    console.log(`FAIL deadman reason=crash:${String(err?.message || err).slice(0, 120)}`);
    process.exit(1);
  },
);
