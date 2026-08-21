// gal_folio — personal stock portfolio tracker
// A tiny zero-dependency Node server: serves the web UI, stores holdings in
// data.json on disk, and proxies live price lookups (so your API key never
// leaves your machine and there are no browser CORS headaches). Prices come
// from CNBC's key-less quote service, which covers pre-market and after-hours
// trading; Finnhub is the fallback and powers ticker search.

import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PORT = Number(process.env.PORT) || 5178;

// Password protection turns on only when GAL_PASSWORD is set — that's for
// internet-facing deployments. A plain local run stays password-free.
const PASSWORD = process.env.GAL_PASSWORD || '';
const AUTH_ENABLED = !!PASSWORD;
const SESSION_SECRET = process.env.GAL_SESSION_SECRET || PASSWORD || 'gal_folio_local';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // stay signed in for 30 days

// Optional cloud storage via Upstash Redis (REST). When these are set, data is
// stored there instead of a local file — needed on hosts with no persistent
// disk (e.g. Render's free tier). Unset locally → plain file storage.
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);
const UPSTASH_KEY = process.env.UPSTASH_KEY || 'gal_folio_data';

const DEFAULT_DATA = {
  settings: { apiKey: '', provider: 'finnhub', currency: 'USD', usdIls: 3.7 },
  holdings: [],
  history: [], // daily value snapshots: { date, value, cost, realized }
  realized: [], // completed sales: { id, date, symbol, shares, price, cost, proceeds, gain }
};

// ---------------------------------------------------------------- data store

function normalize(d) {
  return {
    settings: { ...DEFAULT_DATA.settings, ...((d && d.settings) || {}) },
    holdings: Array.isArray(d && d.holdings) ? d.holdings : [],
    history: Array.isArray(d && d.history) ? d.history : [],
    realized: Array.isArray(d && d.realized) ? d.realized : [],
  };
}

// Run one Redis command against Upstash's REST API (command as a JSON array).
async function upstashCmd(cmd) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`Upstash returned ${res.status}`);
  return res.json(); // { result: ... } or { error: ... }
}

async function loadData() {
  if (USE_UPSTASH) {
    try {
      const { result } = await upstashCmd(['GET', UPSTASH_KEY]);
      return result ? normalize(JSON.parse(result)) : structuredClone(DEFAULT_DATA);
    } catch (e) {
      console.error('Upstash load failed:', e.message);
      return structuredClone(DEFAULT_DATA);
    }
  }
  try {
    return normalize(JSON.parse(await readFile(DATA_FILE, 'utf8')));
  } catch {
    return structuredClone(DEFAULT_DATA);
  }
}

async function saveData(data) {
  if (USE_UPSTASH) {
    await upstashCmd(['SET', UPSTASH_KEY, JSON.stringify(data)]);
    return;
  }
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Every mutation is a read-modify-write of one whole document, so they have to
// run one at a time. Without this, a /api/portfolio poll that loaded before a
// sell would write its stale copy back afterwards — resurrecting the shares you
// just sold and dropping the sale from the books. Single process, so an
// in-memory promise chain is enough; the lock must span load → modify → save.
let dataLock = Promise.resolve();
function withData(fn) {
  const run = dataLock.then(async () => fn(await loadData()));
  dataLock = run.then(
    () => {},
    () => {} // a failed handler must not wedge the queue
  );
  return run;
}

// Save a backup of the current data before a destructive op (import). Storage-aware.
async function backupCurrent() {
  try {
    if (USE_UPSTASH) {
      const { result } = await upstashCmd(['GET', UPSTASH_KEY]);
      if (result) await upstashCmd(['SET', UPSTASH_KEY + ':bak', result]);
    } else {
      await writeFile(DATA_FILE + '.bak', await readFile(DATA_FILE, 'utf8'), 'utf8');
    }
  } catch {
    /* best effort — never block the operation on a failed backup */
  }
}

// The Finnhub key can live in the saved settings or in an env var (handy on a
// host where you'd rather keep the secret out of the data file).
function effectiveKey(data) {
  return (data.settings && data.settings.apiKey) || process.env.FINNHUB_API_KEY || '';
}

// Trim float noise off a share count for display (7.5 stays 7.5, 7.5000001 doesn't).
function trimShares(n) {
  return String(Math.round(Number(n) * 1e6) / 1e6);
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function todayStr() {
  const d = new Date();
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

// Everything locked in from past sales, all-time.
function realizedTotal(data) {
  let t = 0;
  for (const r of data.realized) t += Number(r.gain) || 0;
  return Math.round(t * 100) / 100;
}

// Record (or update) today's portfolio-value snapshot. We only count holdings
// that have a live quote, so `value` and `cost` stay comparable. One point per
// calendar day — repeated refreshes just update today's latest value.
function recordSnapshot(data, quotes) {
  let value = 0;
  let cost = 0;
  let valued = false;
  for (const h of data.holdings) {
    const q = quotes[h.symbol];
    if (q && q.price) {
      value += q.price * h.shares;
      cost += h.cost * h.shares;
      valued = true;
    }
  }
  if (!valued) {
    // Nothing got priced. If holdings exist, that's a feed problem and writing
    // a zero would punch a hole in the chart. But a genuinely empty portfolio
    // with past sales still has a story to tell, so let that one through.
    if (data.holdings.length || !data.realized.length) return false;
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  // `realized` is cumulative to date, so the profit curve stays continuous
  // across a sale instead of dropping by whatever you just cashed out.
  const entry = {
    date: todayStr(),
    value: round2(value),
    cost: round2(cost),
    realized: realizedTotal(data),
  };
  const last = data.history[data.history.length - 1];
  if (last && last.date === entry.date) {
    data.history[data.history.length - 1] = entry;
  } else {
    data.history.push(entry);
  }
  return true;
}

// -------------------------------------------------------------- price source

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const round4 = (n) => (n == null ? null : Math.round(n * 10000) / 10000);

// CNBC hands numbers back as display strings — "316.83", "226,030.00", "+6.80",
// "+2.19%", and sometimes "" or "N/A". Strip the decoration; null means "no
// value" (distinct from a genuine zero).
function parseNum(v) {
  if (v == null) return null;
  const s = String(v).replace(/[,$%\s]/g, '').replace(/^\+/, '');
  if (!s || s === 'N/A' || s === '--') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

// 'PRE' | 'REGULAR' | 'POST' | 'CLOSED'
function mapState(s) {
  const t = String(s || '').toUpperCase();
  if (t.includes('PRE')) return 'PRE';
  if (t.includes('POST') || t.includes('AFTER')) return 'POST';
  if (t.includes('REG') || t.includes('OPEN')) return 'REGULAR';
  return 'CLOSED';
}

// Where the US market clock stands right now, straight from Eastern time.
// Only a fallback: the feed's own status is preferred because it knows about
// market holidays and this does not.
function clockState() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const day = get('weekday');
  if (day === 'Sat' || day === 'Sun') return 'CLOSED';
  const mins = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return 'PRE'; // 04:00–09:30 ET
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return 'REGULAR'; // 09:30–16:00 ET
  if (mins >= 16 * 60 && mins < 20 * 60) return 'POST'; // 16:00–20:00 ET
  return 'CLOSED';
}

const MARKET_LABEL = {
  PRE: 'Pre-market',
  REGULAR: 'Market open',
  POST: 'After hours',
  CLOSED: 'Market closed',
};

const quoteCache = new Map(); // SYMBOL -> { ts, data }
const QUOTE_TTL = 30_000; // 30s — avoids hammering the API on refreshes

// ---- primary source: CNBC (key-less, batched, covers extended hours) -------
// Finnhub's free /quote only moves during the regular session, so pre-market
// and after-hours prices come from CNBC's public quote service instead. It
// takes the whole portfolio in one request and reports the extended-hours
// print next to the regular one.
const CNBC_ENDPOINT = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';
const CNBC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function buildCnbcQuote(r) {
  const regular = parseNum(r.last); // during PRE/POST this is the last regular close
  const prevDay = parseNum(r.previous_day_closing);
  const ext = r.ExtendedMktQuote || null;

  // `curmktstatus` is the authority on which session we're in. The extended
  // block is NOT: CNBC leaves the pre-market print in place, frozen at 9:30am,
  // for the whole regular session (and likewise after the close). Trusting it
  // would price a live stock off a stale morning quote and, worse, measure the
  // day's change against today's own price. So only use the extended print
  // when the symbol's own status agrees we're actually in that session.
  const state = mapState(r.curmktstatus);
  const isPre = state === 'PRE';
  const useExt = !!ext && (isPre || state === 'POST') && mapState(ext.type) === state;
  const extPrice = useExt ? parseNum(ext.last) : null;

  // Before the open, today's move is measured from yesterday's close — which is
  // exactly what `last` still holds. Once the session starts, `last` becomes
  // today's price and the baseline shifts to previous_day_closing.
  const prevClose = isPre ? regular : prevDay != null ? prevDay : regular;

  const price = extPrice != null && extPrice > 0 ? extPrice : regular;
  if (!(price > 0)) return null;

  const change = prevClose != null ? price - prevClose : 0;
  const regularChange = isPre || prevClose == null || regular == null ? 0 : regular - prevClose;

  return {
    // Same shape the app has always consumed — `price` is simply live now.
    price: round4(price),
    change: round4(change),
    changePercent: round4(prevClose ? (change / prevClose) * 100 : 0),
    prevClose: round4(prevClose != null ? prevClose : 0),
    high: parseNum(r.high) || 0,
    low: parseNum(r.low) || 0,
    open: parseNum(r.open) || 0,
    // Extended-hours detail, so the UI can label where the price came from.
    marketState: state,
    regularPrice: round4(regular != null ? regular : 0),
    regularChange: round4(regularChange),
    regularChangePercent: round4(prevClose ? (regularChange / prevClose) * 100 : 0),
    extPrice: round4(extPrice),
    extChange: useExt ? parseNum(ext.change) : null,
    extChangePercent: useExt ? parseNum(ext.change_pct) : null,
    extTime: useExt ? ext.last_timedate || null : null,
    currency: r.currencyCode || null,
    source: 'cnbc',
  };
}

async function fetchCnbcQuotes(symbols) {
  if (!symbols.length) return {};
  const url =
    `${CNBC_ENDPOINT}?symbols=${symbols.map(encodeURIComponent).join('%7C')}` +
    '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1';

  // One retry: a single dropped request shouldn't blank out the whole
  // portfolio when we're polling every minute.
  let res;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': CNBC_UA, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Extended-hours service returned ${res.status}`);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      res = null;
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastErr) throw lastErr;
  const j = await res.json();
  const rows = [].concat((j && j.FormattedQuoteResult && j.FormattedQuoteResult.FormattedQuote) || []);

  const out = {};
  for (const r of rows) {
    if (!r || r.code !== 0 || !r.symbol) continue; // code 1 = symbol not recognised
    const q = buildCnbcQuote(r);
    if (q) out[String(r.symbol).toUpperCase()] = q;
  }
  return out;
}

// ---- fallback source: Finnhub (regular session only) -----------------------

async function getFinnhubQuote(symbol, apiKey) {
  const key = symbol.toUpperCase();
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(key)}&token=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (res.status === 401 || res.status === 403) throw new Error('Invalid API key');
  if (res.status === 429) throw new Error('Rate limit reached — try again shortly');
  if (!res.ok) throw new Error(`Price service returned ${res.status}`);
  const j = await res.json();
  if (!(num(j.c) > 0)) throw new Error('No price available for this symbol');

  return {
    price: num(j.c),
    change: num(j.d),
    changePercent: num(j.dp),
    prevClose: num(j.pc),
    high: num(j.h),
    low: num(j.l),
    open: num(j.o),
    marketState: null, // Finnhub doesn't say, and it never moves out of hours
    regularPrice: num(j.c),
    regularChange: num(j.d),
    regularChangePercent: num(j.dp),
    extPrice: null,
    extChange: null,
    extChangePercent: null,
    extTime: null,
    currency: null,
    source: 'finnhub',
  };
}

// ---- the one entry point the routes use ------------------------------------

// Quote a batch of symbols: cache first, then one CNBC call for whatever's
// stale, then Finnhub one-by-one for anything CNBC didn't recognise.
async function getQuotes(symbols, apiKey) {
  const now = Date.now();
  const quotes = {};
  const errors = {};
  const stale = [];

  for (const s of symbols) {
    const key = String(s).toUpperCase();
    if (quotes[key] || stale.includes(key)) continue; // de-dupe
    const cached = quoteCache.get(key);
    if (cached && now - cached.ts < QUOTE_TTL) quotes[key] = cached.data;
    else stale.push(key);
  }
  if (!stale.length) return { quotes, errors };

  let fresh = {};
  try {
    fresh = await fetchCnbcQuotes(stale);
  } catch (e) {
    console.error('Extended-hours quotes unavailable:', e.message);
  }
  for (const [k, v] of Object.entries(fresh)) {
    quoteCache.set(k, { ts: now, data: v });
    quotes[k] = v;
  }

  const missing = stale.filter((s) => !quotes[s]);
  if (!missing.length) return { quotes, errors };

  if (!apiKey) {
    for (const s of missing) errors[s] = 'No price available';
    fillFromStaleCache(quotes, errors);
    return { quotes, errors };
  }
  await Promise.all(
    missing.map(async (s) => {
      try {
        const q = await getFinnhubQuote(s, apiKey);
        quoteCache.set(s, { ts: now, data: q });
        quotes[s] = q;
      } catch (e) {
        errors[s] = e.message;
      }
    })
  );
  fillFromStaleCache(quotes, errors);
  return { quotes, errors };
}

// Last resort: if a symbol couldn't be priced this round but we quoted it
// successfully earlier, show that price rather than an error. A slightly old
// number beats a blank row when the upstream feed blips.
function fillFromStaleCache(quotes, errors) {
  for (const s of Object.keys(errors)) {
    const cached = quoteCache.get(s);
    if (cached && cached.data) {
      quotes[s] = { ...cached.data, stale: true, asOf: cached.ts };
      delete errors[s];
    }
  }
}

// Which session the UI badge should show. Trust the feed (it knows holidays)
// using the USD-quoted symbols, and fall back to the Eastern-time clock.
function marketStatus(quotes) {
  const tally = {};
  for (const q of Object.values(quotes)) {
    if (q && q.marketState && q.currency === 'USD') {
      tally[q.marketState] = (tally[q.marketState] || 0) + 1;
    }
  }
  const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  const state = best ? best[0] : clockState();
  return { state, label: MARKET_LABEL[state] || MARKET_LABEL.CLOSED };
}

async function getName(symbol, apiKey) {
  try {
    const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) return '';
    const j = await res.json();
    return j.name || '';
  } catch {
    return '';
  }
}

// Exchange rate (e.g. USD -> ILS). Uses a free, key-less FX API and caches for
// an hour — currency rates don't move fast enough to fetch more often.
const fxCache = new Map(); // "USD_ILS" -> { ts, rate, updated }
const FX_TTL = 60 * 60 * 1000;

async function getFxRate(from, to) {
  const key = from + '_' + to;
  const cached = fxCache.get(key);
  const now = Date.now();
  if (cached && now - cached.ts < FX_TTL) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  let res;
  try {
    res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`FX service returned ${res.status}`);
  const j = await res.json();
  const rate = j && j.rates ? j.rates[to] : null;
  if (!rate) throw new Error(`No exchange rate available for ${to}`);
  const entry = { ts: now, rate, updated: j.time_last_update_utc || null };
  fxCache.set(key, entry);
  return entry;
}

async function searchSymbols(q, apiKey) {
  const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Search service returned ${res.status}`);
  const j = await res.json();
  return (j.result || [])
    .filter((r) => r.symbol && !r.symbol.includes('.')) // keep it to common tickers
    .slice(0, 8)
    .map((r) => ({
      symbol: r.symbol,
      displaySymbol: r.displaySymbol || r.symbol,
      description: r.description || '',
      type: r.type || '',
    }));
}

// ------------------------------------------------------------------ http i/o

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

// -------------------------------------------------------------------- auth

// Signed, HttpOnly cookie session. Single shared password (no user accounts) —
// right-sized for a personal tool. Uses only Node's built-in crypto.
function hmac(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}
function makeToken() {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return exp + '.' + hmac(exp);
}
function verifyToken(tok) {
  if (!tok) return false;
  const i = tok.lastIndexOf('.');
  if (i <= 0) return false;
  const sig = Buffer.from(tok.slice(i + 1));
  const expected = Buffer.from(hmac(tok.slice(0, i)));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return false;
  return Number(tok.slice(0, i)) > Date.now();
}
function isAuthed(req) {
  const cookie = req.headers.cookie || '';
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === 'gal_session') {
      return verifyToken(decodeURIComponent(part.slice(eq + 1).trim()));
    }
  }
  return false;
}
function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function checkPassword(pw) {
  if (!PASSWORD) return false;
  const a = crypto.createHash('sha256').update(String(pw)).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b); // constant-time compare
}
async function handleLogin(req, res) {
  const body = await readBody(req);
  if (checkPassword(body.password)) {
    const secure = isHttps(req) ? '; Secure' : '';
    res.writeHead(200, {
      'Set-Cookie': `gal_session=${makeToken()}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax${secure}`,
      'Content-Type': 'application/json; charset=utf-8',
    });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
  return res.end(JSON.stringify({ error: 'Incorrect password' }));
}
function handleLogout(res) {
  res.writeHead(302, {
    'Set-Cookie': 'gal_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax',
    Location: '/login',
  });
  res.end();
}
function serveLoginPage(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(LOGIN_HTML);
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>gal_folio — sign in</title>
<meta name="theme-color" content="#0e1116"/>
<link rel="apple-touch-icon" href="/icon-180.png"/>
<style>
 *{box-sizing:border-box}
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0e1116;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
 .card{background:#161b22;border:1px solid #2a3441;border-radius:14px;padding:28px 26px;width:min(360px,90vw);box-shadow:0 8px 30px rgba(0,0,0,.4)}
 .logo{font-size:26px;font-weight:700;margin-bottom:4px}
 .sub{color:#8b98a9;font-size:13px;margin-bottom:20px}
 label{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#8b98a9}
 input{width:100%;margin-top:6px;background:#0e1116;border:1px solid #2a3441;border-radius:9px;padding:12px;color:#e6edf3;font-size:16px}
 input:focus{outline:none;border-color:#4c8dff}
 button{width:100%;margin-top:16px;background:#4c8dff;color:#fff;border:none;border-radius:9px;padding:12px;font-size:15px;font-weight:600;cursor:pointer}
 button:hover{background:#5c99ff}
 .err{color:#f85149;font-size:13px;margin-top:12px;min-height:16px}
</style></head>
<body>
 <div class="card">
  <div class="logo">📈 gal_folio</div>
  <div class="sub">Enter your password to continue</div>
  <form id="f">
   <label for="pw">Password</label>
   <input id="pw" type="password" autocomplete="current-password" autofocus/>
   <button type="submit">Sign in</button>
   <div class="err" id="err"></div>
  </form>
 </div>
 <script>
  const f=document.getElementById('f'),err=document.getElementById('err');
  f.addEventListener('submit',async(e)=>{e.preventDefault();err.textContent='';
   const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
   if(r.ok){location.href='/';}else{err.textContent='Incorrect password';document.getElementById('pw').select();}});
 </script>
</body></html>`;

// -------------------------------------------------------------------- routes

async function handleApi(req, res, url, pathname, method) {
  // Portfolio: holdings + a live quote for each symbol
  if (method === 'GET' && pathname === '/api/portfolio') {
    const snapshot = await loadData();
    const apiKey = effectiveKey(snapshot);
    // Prices no longer need the Finnhub key — the extended-hours source is
    // key-less — so quote every holding regardless of whether one is set.
    const { quotes, errors } = await getQuotes(
      snapshot.holdings.map((h) => h.symbol),
      apiKey
    );
    // Quoting just took a network round trip. Re-read under the lock so a sell
    // or edit that landed meanwhile isn't overwritten, and so we report what's
    // actually on disk now.
    const data = await withData(async (d) => {
      if (recordSnapshot(d, quotes)) await saveData(d);
      return d;
    });
    return sendJson(res, 200, {
      holdings: data.holdings,
      quotes,
      errors,
      history: data.history,
      realized: data.realized,
      realizedTotal: realizedTotal(data),
      market: marketStatus(quotes),
      settings: {
        hasApiKey: !!apiKey,
        provider: data.settings.provider,
        currency: data.settings.currency,
        usdIls: data.settings.usdIls,
        authEnabled: AUTH_ENABLED,
      },
    });
  }

  // Add a holding — or, if this symbol is already held, merge into that row
  // using a share-weighted average cost so each ticker appears only once.
  if (method === 'POST' && pathname === '/api/holdings') {
    const body = await readBody(req);
    const symbol = String(body.symbol || '').trim().toUpperCase();
    const shares = Number(body.shares);
    const cost = Number(body.cost);
    if (!symbol || !(shares > 0) || !(cost >= 0)) {
      return sendJson(res, 400, { error: 'Need a symbol, shares > 0, and a cost >= 0.' });
    }
    const out = await withData(async (data) => {
    const apiKey = effectiveKey(data);

    const existing = data.holdings.find((h) => h.symbol === symbol);
    if (existing) {
      const totalShares = existing.shares + shares;
      const avgCost = (existing.shares * existing.cost + shares * cost) / totalShares;
      existing.shares = totalShares;
      existing.cost = Math.round(avgCost * 10000) / 10000; // keep some precision
      const nm = String(body.name || '').trim();
      if (!existing.name && nm) existing.name = nm;
      await saveData(data);
      return { status: 200, body: { ...existing, merged: true } };
    }

    let name = String(body.name || '').trim();
    if (!name && apiKey) name = await getName(symbol, apiKey);
    const holding = { id: genId(), symbol, name, shares, cost };
    data.holdings.push(holding);
    await saveData(data);
    return { status: 201, body: { ...holding, merged: false } };
    });
    return sendJson(res, out.status, out.body);
  }

  // Sell shares out of a holding. Reduces the position at its average cost and
  // books what was realised; selling the lot removes the row but keeps the sale
  // on the record. Deleting a holding stays a different thing — that's for
  // fixing a row you never should have added.
  const sellMatch = pathname.match(/^\/api\/holdings\/([^/]+)\/sell$/);
  if (sellMatch && method === 'POST') {
    const id = decodeURIComponent(sellMatch[1]);
    const body = await readBody(req);
    const out = await withData(async (data) => {
    const h = data.holdings.find((x) => x.id === id);
    if (!h) return { status: 404, body: { error: 'Holding not found' } };

    const shares = Number(body.shares);
    const price = Number(body.price);
    if (!(shares > 0)) return { status: 400, body: { error: 'Enter how many shares you sold.' } };
    if (shares > h.shares + 1e-9) {
      return { status: 400, body: { error: `You only hold ${trimShares(h.shares)} shares.` } };
    }
    if (!(price >= 0)) return { status: 400, body: { error: 'Enter the price you sold at.' } };

    const round2 = (n) => Math.round(n * 100) / 100;
    const sale = {
      id: genId(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? body.date : todayStr(),
      symbol: h.symbol,
      name: h.name || '',
      shares,
      price,
      cost: h.cost, // average cost basis — unchanged by a partial sale
      proceeds: round2(price * shares),
      gain: round2((price - h.cost) * shares),
    };
    data.realized.push(sale);

    const left = h.shares - shares;
    const soldOut = left <= 1e-9;
    if (soldOut) data.holdings = data.holdings.filter((x) => x.id !== id);
    else h.shares = Math.round(left * 1e6) / 1e6;

    await saveData(data);
    return {
      status: 200,
      body: { ok: true, sale, soldOut, sharesLeft: soldOut ? 0 : h.shares, realizedTotal: realizedTotal(data) },
    };
    });
    return sendJson(res, out.status, out.body);
  }

  // Update / delete a holding by id
  const holdingMatch = pathname.match(/^\/api\/holdings\/([^/]+)$/);
  if (holdingMatch) {
    const id = decodeURIComponent(holdingMatch[1]);
    const body = method === 'PUT' ? await readBody(req) : null;
    const out = await withData(async (data) => {
    const h = data.holdings.find((x) => x.id === id);

    if (method === 'PUT') {
      if (!h) return { status: 404, body: { error: 'Holding not found' } };
      if (body.symbol != null) h.symbol = String(body.symbol).trim().toUpperCase();
      if (body.name != null) h.name = String(body.name).trim();
      if (body.shares != null) {
        const s = Number(body.shares);
        if (s > 0) h.shares = s;
      }
      if (body.cost != null) {
        const c = Number(body.cost);
        if (c >= 0) h.cost = c;
      }
      await saveData(data);
      return { status: 200, body: h };
    }

    if (method === 'DELETE') {
      const before = data.holdings.length;
      data.holdings = data.holdings.filter((x) => x.id !== id);
      if (data.holdings.length === before) return { status: 404, body: { error: 'Holding not found' } };
      await saveData(data);
      return { status: 200, body: { ok: true } };
    }
    return null; // method not handled here — fall through below
    });
    if (out) return sendJson(res, out.status, out.body);
  }

  // Single quote (used by the add form preview)
  if (method === 'GET' && pathname === '/api/quote') {
    const symbol = url.searchParams.get('symbol');
    if (!symbol) return sendJson(res, 400, { error: 'Missing symbol' });
    const data = await loadData();
    const { quotes, errors } = await getQuotes([symbol], effectiveKey(data));
    const key = String(symbol).toUpperCase();
    if (quotes[key]) return sendJson(res, 200, quotes[key]);
    return sendJson(res, 502, { error: errors[key] || 'No price available' });
  }

  // Symbol search (autocomplete in the add form)
  if (method === 'GET' && pathname === '/api/search') {
    const q = url.searchParams.get('q');
    const data = await loadData();
    const apiKey = effectiveKey(data);
    if (!apiKey) return sendJson(res, 400, { error: 'No API key set' });
    if (!q || q.trim().length < 1) return sendJson(res, 200, { results: [] });
    try {
      return sendJson(res, 200, { results: await searchSymbols(q.trim(), apiKey) });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  // Exchange rate (no API key required — uses a free FX source)
  if (method === 'GET' && pathname === '/api/fxrate') {
    const from = (url.searchParams.get('from') || 'USD').toUpperCase();
    const to = (url.searchParams.get('to') || 'ILS').toUpperCase();
    try {
      const { rate, updated } = await getFxRate(from, to);
      return sendJson(res, 200, { from, to, rate, updated });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  // Export the whole data file as a download (backup / move to another machine)
  if (method === 'GET' && pathname === '/api/export') {
    const data = await loadData();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="gal_folio-backup-${todayStr()}.json"`,
    });
    return res.end(JSON.stringify(data, null, 2));
  }

  // Import a previously-exported file, replacing current data. The current file
  // is backed up to data.json.bak first so an import is recoverable.
  if (method === 'POST' && pathname === '/api/import') {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.holdings)) {
      return sendJson(res, 400, { error: 'Invalid backup file — no holdings found.' });
    }
    const holdings = body.holdings
      .filter((h) => h && String(h.symbol || '').trim() && Number(h.shares) > 0 && Number(h.cost) >= 0)
      .map((h) => ({
        id: (h.id && String(h.id)) || genId(),
        symbol: String(h.symbol).trim().toUpperCase(),
        name: String(h.name || '').trim(),
        shares: Number(h.shares),
        cost: Number(h.cost),
      }));
    const history = Array.isArray(body.history)
      ? body.history
          .filter((p) => p && typeof p.date === 'string' && isFinite(Number(p.value)))
          .map((p) => ({ date: p.date, value: Number(p.value), cost: Number(p.cost) || 0 }))
      : [];
    const realized = Array.isArray(body.realized)
      ? body.realized
          .filter((r) => r && String(r.symbol || '').trim() && Number(r.shares) > 0)
          .map((r) => ({
            id: (r.id && String(r.id)) || genId(),
            date: String(r.date || todayStr()),
            symbol: String(r.symbol).trim().toUpperCase(),
            name: String(r.name || '').trim(),
            shares: Number(r.shares),
            price: Number(r.price) || 0,
            cost: Number(r.cost) || 0,
            proceeds: Number(r.proceeds) || 0,
            gain: Number(r.gain) || 0,
          }))
      : [];
    const settings = { ...DEFAULT_DATA.settings, ...(body.settings && typeof body.settings === 'object' ? body.settings : {}) };

    await withData(async () => {
      await backupCurrent(); // safety backup (file .bak or Upstash :bak key)
      await saveData({ settings, holdings, history, realized });
    });
    quoteCache.clear();
    return sendJson(res, 200, {
      ok: true,
      holdings: holdings.length,
      history: history.length,
      realized: realized.length,
    });
  }

  // Settings
  if (pathname === '/api/settings') {
    if (method === 'GET') {
      const data = await loadData();
      return sendJson(res, 200, {
        hasApiKey: !!effectiveKey(data),
        provider: data.settings.provider,
        currency: data.settings.currency,
        usdIls: data.settings.usdIls,
        authEnabled: AUTH_ENABLED,
      });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      return await withData(async (data) => {
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
        data.settings.apiKey = body.apiKey.trim();
        quoteCache.clear(); // new key — re-fetch fresh
      }
      if (typeof body.currency === 'string' && body.currency.trim()) {
        data.settings.currency = body.currency.trim().toUpperCase();
      }
      if (body.usdIls != null) {
        const r = Number(body.usdIls);
        if (r > 0) data.settings.usdIls = r;
      }
      await saveData(data);
      return sendJson(res, 200, {
        ok: true,
        hasApiKey: !!effectiveKey(data),
        currency: data.settings.currency,
        usdIls: data.settings.usdIls,
      });
      });
    }
  }

  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

// -------------------------------------------------------------------- server

// Paths reachable without a session (login flow + icons so the login page and
// home-screen install work).
const PUBLIC_PATHS = new Set([
  '/login', '/logout', '/manifest.webmanifest', '/icon-180.png', '/icon-512.png', '/apple-touch-icon.png', '/favicon.ico',
]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (AUTH_ENABLED) {
      if (pathname === '/login') {
        if (req.method === 'POST') return await handleLogin(req, res);
        if (isAuthed(req)) {
          res.writeHead(302, { Location: '/' });
          return res.end();
        }
        return serveLoginPage(res);
      }
      if (pathname === '/logout') return handleLogout(res);
      if (!PUBLIC_PATHS.has(pathname) && !isAuthed(req)) {
        if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Not authenticated' });
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
    }

    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, url, pathname, req.method);
    }
    return await serveStatic(res, pathname);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const url = `http://localhost:${PORT}`;
  console.log('\n  📈  gal_folio is running');
  console.log(`      →  ${url}`);
  console.log(`      password protection: ${AUTH_ENABLED ? 'ON' : 'off (set GAL_PASSWORD to enable)'}\n`);
  console.log('  Press Ctrl+C to stop.\n');
  if (process.env.NO_OPEN !== '1' && process.platform === 'win32') {
    exec(`start "" "${url}"`); // pop open the browser on Windows
  }
});
