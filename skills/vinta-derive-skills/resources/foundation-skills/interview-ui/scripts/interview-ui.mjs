#!/usr/bin/env node
// interview-ui — local server + CLI that turns an agent interview into a
// browser form. The agent writes `rounds/round-NN.json` (+ explainer docs
// under `docs/`), the user answers in the shell (`../resources/index.html`),
// the shell POSTs `answers/round-NN.json`, and `wait` unblocks the agent.
//
//   node interview-ui.mjs start --dir <interview-dir> [--port N] [--no-open]
//   node interview-ui.mjs wait  --dir <interview-dir> --round N [--timeout SECONDS]
//   node interview-ui.mjs status --dir <interview-dir>
//   node interview-ui.mjs stop  --dir <interview-dir>
//   node interview-ui.mjs serve --dir <interview-dir> [--port N]   # foreground
//
// Zero runtime deps, Node >= 18. Binds 127.0.0.1 only. Serves files only from
// inside <interview-dir>/docs. Never deletes anything.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync,
  statSync, watch, createReadStream, unlinkSync,
} from 'node:fs';
import { resolve, join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_HTML = resolve(HERE, '..', 'resources', 'index.html');
const SERVER_FILE = 'server.json';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
};

// ───────────────────────── CLI parsing ─────────────────────────

function usage(code = 0) {
  const out = code === 0 ? console.log : console.error;
  out(`interview-ui — browser form for agent interviews

Usage:
  interview-ui.mjs start  --dir <interview-dir> [--port N] [--no-open]
  interview-ui.mjs wait   --dir <interview-dir> --round N [--timeout SECONDS]
  interview-ui.mjs status --dir <interview-dir>
  interview-ui.mjs stop   --dir <interview-dir>
  interview-ui.mjs serve  --dir <interview-dir> [--port N]

Layout of <interview-dir>:
  rounds/round-NN.json   written by the agent   (interview-round.v1)
  answers/round-NN.json  written by the browser (interview-answers.v1)
  docs/**                explainer docs referenced from rounds (md / html / images)
  server.json            pid + url of the running server (managed by this script)

Exit codes: 0 ok · 1 usage / not found · 2 internal error · 124 wait timed out`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { cmd: argv[0], dir: null, port: null, round: null, timeout: null, open: true };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) { console.error(`${a} needs a value`); usage(1); }
      return v;
    };
    if (a === '--dir' || a === '-d') opts.dir = val();
    else if (a === '--port' || a === '-p') opts.port = Number(val());
    else if (a === '--round' || a === '-r') opts.round = Number(val());
    else if (a === '--timeout' || a === '-t') opts.timeout = Number(val());
    else if (a === '--no-open') opts.open = false;
    else if (a === '--open') opts.open = true;
    else if (a === '-h' || a === '--help') usage(0);
    else { console.error(`unknown argument: ${a}`); usage(1); }
  }
  if (!opts.cmd || opts.cmd === '-h' || opts.cmd === '--help') usage(0);
  if (!opts.dir) { console.error('--dir is required'); usage(1); }
  opts.dir = resolve(opts.dir);
  return opts;
}

// ───────────────────────── fs helpers ─────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const roundFile = (dir, n) => join(dir, 'rounds', `round-${pad2(n)}.json`);
const answersFile = (dir, n) => join(dir, 'answers', `round-${pad2(n)}.json`);

function ensureLayout(dir) {
  for (const sub of ['rounds', 'answers', 'docs']) mkdirSync(join(dir, sub), { recursive: true });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Write-then-rename so a reader never sees a half-written JSON file.
function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

function listRounds(dir) {
  const roundsDir = join(dir, 'rounds');
  if (!existsSync(roundsDir)) return [];
  return readdirSync(roundsDir)
    .map((f) => /^round-(\d+)\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

function readServerInfo(dir) {
  const p = join(dir, SERVER_FILE);
  if (!existsSync(p)) return null;
  try { return readJson(p); } catch { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ───────────────────────── state ─────────────────────────

function buildState(dir) {
  const rounds = listRounds(dir).map((n) => {
    let title = null; let kind = null; let error = null;
    try {
      const r = readJson(roundFile(dir, n));
      title = r.title ?? r.interview?.title ?? null;
      kind = r.kind ?? 'questions';
    } catch (e) { error = `round file is not valid JSON: ${e.message}`; }
    return { round: n, title, kind, answered: existsSync(answersFile(dir, n)), error };
  });
  const open = rounds.filter((r) => !r.answered && !r.error).map((r) => r.round);
  return {
    dir,
    rounds,
    latest: rounds.length ? rounds[rounds.length - 1].round : null,
    current: open.length ? open[0] : null,
  };
}

// ───────────────────────── http server ─────────────────────────

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Resolve a docs path and refuse anything that escapes <dir>/docs.
function safeDocPath(dir, rel) {
  const docsRoot = resolve(dir, 'docs');
  const decoded = decodeURIComponent(rel).replace(/^\/+/, '');
  if (decoded.includes('\0')) return null;
  // Rounds reference docs as "docs/foo.md" (relative to the interview dir)
  // or just "foo.md" (relative to docs/). Accept both.
  const stripped = decoded.replace(/^docs\//, '');
  const full = resolve(docsRoot, normalize(stripped));
  if (full !== docsRoot && !full.startsWith(docsRoot + sep)) return null;
  return full;
}

function validateAnswers(payload, n) {
  if (!payload || typeof payload !== 'object') return 'payload must be an object';
  if (payload.schema_version !== 1) return 'schema_version must be 1';
  if (payload.round !== n) return `round must be ${n}`;
  if (!Array.isArray(payload.answers)) return 'answers must be an array';
  for (const a of payload.answers) {
    if (!a || typeof a.decision_id !== 'string') return 'each answer needs a decision_id';
    if (!['answered', 'waived', 'skipped'].includes(a.status)) return `bad status on ${a.decision_id}`;
  }
  if (payload.questions !== undefined && !Array.isArray(payload.questions)) return 'questions must be an array';
  return null;
}

function startHttp(dir, port) {
  ensureLayout(dir);
  const sseClients = new Set();

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(frame);
  };

  // fs.watch is best-effort (no recursive on Linux < 20); the shell also polls.
  let debounce = null;
  const onChange = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => broadcast('state', buildState(dir)), 150);
  };
  for (const sub of ['rounds', 'answers']) {
    try { watch(join(dir, sub), onChange); } catch { /* polling covers it */ }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;

      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        if (!existsSync(SHELL_HTML)) return send(res, 500, { error: `shell missing at ${SHELL_HTML}` });
        return send(res, 200, readFileSync(SHELL_HTML), MIME['.html']);
      }

      if (req.method === 'GET' && path === '/api/state') return send(res, 200, buildState(dir));

      let m;
      if (req.method === 'GET' && (m = /^\/api\/rounds\/(\d+)$/.exec(path))) {
        const n = Number(m[1]);
        if (!existsSync(roundFile(dir, n))) return send(res, 404, { error: `round ${n} not found` });
        try { return send(res, 200, readJson(roundFile(dir, n))); }
        catch (e) { return send(res, 500, { error: `round ${n} is not valid JSON: ${e.message}` }); }
      }

      if (req.method === 'GET' && (m = /^\/api\/answers\/(\d+)$/.exec(path))) {
        const n = Number(m[1]);
        if (!existsSync(answersFile(dir, n))) return send(res, 404, { error: `answers for round ${n} not found` });
        return send(res, 200, readJson(answersFile(dir, n)));
      }

      if (req.method === 'POST' && (m = /^\/api\/answers\/(\d+)$/.exec(path))) {
        const n = Number(m[1]);
        if (!existsSync(roundFile(dir, n))) return send(res, 404, { error: `round ${n} not found` });
        let payload;
        try { payload = JSON.parse(await readBody(req)); }
        catch (e) { return send(res, 400, { error: `invalid JSON body: ${e.message}` }); }
        const problem = validateAnswers(payload, n);
        if (problem) return send(res, 400, { error: problem });
        payload.submitted_at = new Date().toISOString();
        writeJsonAtomic(answersFile(dir, n), payload);
        onChange();
        return send(res, 200, { ok: true, path: answersFile(dir, n) });
      }

      if (req.method === 'GET' && path.startsWith('/api/docs/')) {
        const full = safeDocPath(dir, path.slice('/api/docs/'.length));
        if (!full) return send(res, 403, { error: 'path escapes docs/' });
        if (!existsSync(full) || !statSync(full).isFile()) return send(res, 404, { error: 'doc not found' });
        res.writeHead(200, {
          'Content-Type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return createReadStream(full).pipe(res);
      }

      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(`event: state\ndata: ${JSON.stringify(buildState(dir))}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
        return undefined;
      }

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.on('error', reject);
    server.listen(port ?? 0, '127.0.0.1', () => {
      const { port: actual } = server.address();
      const url = `http://127.0.0.1:${actual}/`;
      writeJsonAtomic(join(dir, SERVER_FILE), { pid: process.pid, port: actual, url, started_at: new Date().toISOString() });
      resolvePromise({ server, url, port: actual });
    });
  });
}

// ───────────────────────── commands ─────────────────────────

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no desktop session — the printed URL is enough */ });
    child.unref();
  } catch { /* same */ }
}

async function cmdServe(opts) {
  const { url } = await startHttp(opts.dir, opts.port);
  console.log(`interview-ui serving ${opts.dir}\n${url}`);
  const cleanup = () => {
    try { unlinkSync(join(opts.dir, SERVER_FILE)); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

async function cmdStart(opts) {
  ensureLayout(opts.dir);
  const existing = readServerInfo(opts.dir);
  if (existing && pidAlive(existing.pid)) {
    console.log(`already running (pid ${existing.pid})\n${existing.url}`);
    if (opts.open) openBrowser(existing.url);
    return;
  }
  const args = [fileURLToPath(import.meta.url), 'serve', '--dir', opts.dir];
  if (opts.port) args.push('--port', String(opts.port));
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const info = readServerInfo(opts.dir);
    if (info && info.pid === child.pid && pidAlive(info.pid)) {
      console.log(`interview-ui started (pid ${info.pid})\n${info.url}`);
      if (opts.open) openBrowser(info.url);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error('server did not come up within 5s');
  process.exit(2);
}

function cmdStop(opts) {
  const info = readServerInfo(opts.dir);
  if (!info || !pidAlive(info.pid)) {
    console.log('not running');
    try { unlinkSync(join(opts.dir, SERVER_FILE)); } catch { /* fine */ }
    return;
  }
  process.kill(info.pid, 'SIGTERM');
  console.log(`stopped pid ${info.pid}`);
}

function cmdStatus(opts) {
  const info = readServerInfo(opts.dir);
  const state = buildState(opts.dir);
  console.log(JSON.stringify({
    server: info && pidAlive(info.pid) ? { ...info, alive: true } : { alive: false },
    ...state,
  }, null, 2));
}

async function cmdWait(opts) {
  if (!Number.isInteger(opts.round) || opts.round < 1) { console.error('--round N is required'); usage(1); }
  const target = answersFile(opts.dir, opts.round);
  if (!existsSync(roundFile(opts.dir, opts.round))) {
    console.error(`round file missing: ${roundFile(opts.dir, opts.round)}`);
    process.exit(1);
  }
  const info = readServerInfo(opts.dir);
  if (!info || !pidAlive(info.pid)) {
    console.error('server is not running — run `start` first');
    process.exit(1);
  }
  const timeoutMs = (opts.timeout ?? 3600) * 1000;
  const deadline = Date.now() + timeoutMs;
  console.error(`waiting for ${target}\nuser answers at ${info.url}`);

  const done = () => { console.log(target); process.exit(0); };
  if (existsSync(target)) return done();

  let watcher = null;
  try { watcher = watch(join(opts.dir, 'answers'), () => { if (existsSync(target)) done(); }); } catch { /* poll */ }
  const poll = setInterval(() => {
    if (existsSync(target)) { clearInterval(poll); watcher?.close(); done(); return; }
    if (Date.now() > deadline) {
      clearInterval(poll); watcher?.close();
      console.error(`timed out after ${opts.timeout ?? 3600}s`);
      process.exit(124);
    }
  }, 1000);
}

const opts = parseArgs(process.argv.slice(2));
const run = { serve: cmdServe, start: cmdStart, stop: cmdStop, status: cmdStatus, wait: cmdWait }[opts.cmd];
if (!run) { console.error(`unknown command: ${opts.cmd}`); usage(1); }
Promise.resolve(run(opts)).catch((e) => { console.error(e.stack || e.message); process.exit(2); });
