// gal_folio front-end — talks to the local Node server, renders the portfolio.

const state = {
  holdings: [],
  quotes: {},
  errors: {},
  history: [],
  market: null, // { state: 'PRE'|'REGULAR'|'POST'|'CLOSED', label }
  currency: 'USD',
  hasApiKey: false,
  fxRate: null,
  fxUpdated: null,
  fxSource: null, // 'live' | 'manual'
  manualUsdIls: null,
};

// ------------------------------------------------------------- formatting

function money(n, { sign = false } = {}) {
  if (n == null || isNaN(n)) return '—';
  const opts = { style: 'currency', currency: state.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 };
  let s;
  try {
    s = new Intl.NumberFormat('en-US', opts).format(Math.abs(n));
  } catch {
    s = '$' + Math.abs(n).toFixed(2);
  }
  if (n < 0) return '-' + s;
  return sign ? '+' + s : s;
}

function pct(n) {
  if (n == null || isNaN(n)) return '';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function ils(n) {
  if (n == null || isNaN(n)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(n);
  } catch {
    return '₪' + Math.round(n).toLocaleString('en-US');
  }
}

function signClass(n) {
  if (n == null || isNaN(n) || n === 0) return '';
  return n > 0 ? 'pos' : 'neg';
}

// ------------------------------------------------------------- computation

function computeRow(h) {
  const q = state.quotes[h.symbol];
  const price = q && q.price ? q.price : null;
  const totalCost = h.cost * h.shares;
  const marketValue = price != null ? price * h.shares : null;
  const gain = marketValue != null ? marketValue - totalCost : null;
  const gainPct = gain != null && totalCost > 0 ? (gain / totalCost) * 100 : null;
  const dayChange = q && price != null ? q.change * h.shares : null;
  return { q, price, totalCost, marketValue, gain, gainPct, dayChange, dayPct: q ? q.changePercent : null };
}

function computeTotals() {
  let value = 0, costAll = 0, costValued = 0, day = 0, anyValued = false;
  for (const h of state.holdings) {
    const r = computeRow(h);
    costAll += r.totalCost;
    if (r.marketValue != null) {
      anyValued = true;
      value += r.marketValue;
      costValued += r.totalCost;
      if (r.dayChange != null) day += r.dayChange;
    }
  }
  const gain = anyValued ? value - costValued : null;
  const gainPct = costValued > 0 ? (gain / costValued) * 100 : null;
  const prevValue = value - day;
  const dayPct = prevValue > 0 ? (day / prevValue) * 100 : null;
  return { value: anyValued ? value : null, costAll, gain, gainPct, day: anyValued ? day : null, dayPct };
}

// ------------------------------------------------------------- sorting

let sortKey = null; // null = natural (insertion) order
let sortDir = 'desc';

// The value a column sorts by. Note "Today" sorts by % change (comparable across
// stocks) while "Today's G/L" and "Gain/Loss" sort by their dollar figure.
function sortValue(h, key) {
  const r = computeRow(h);
  switch (key) {
    case 'symbol': return h.symbol;
    case 'shares': return h.shares;
    case 'cost': return h.cost;
    case 'price': return r.price;
    case 'today': return r.q ? r.q.changePercent : null;
    case 'todayGl': return r.dayChange;
    case 'value': return r.marketValue;
    case 'gain': return r.gain;
    default: return null;
  }
}

function compareHoldings(a, b, key, dir) {
  const va = sortValue(a, key);
  const vb = sortValue(b, key);
  const na = va == null || (typeof va === 'number' && isNaN(va));
  const nb = vb == null || (typeof vb === 'number' && isNaN(vb));
  if (na && nb) return 0;
  if (na) return 1; // missing values always sink to the bottom
  if (nb) return -1;
  const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
  return dir === 'asc' ? cmp : -cmp;
}

function updateSortIndicators() {
  document.querySelectorAll('#holdingsTable th.sortable').forEach((th) => {
    const ind = th.querySelector('.sort-ind');
    if (th.dataset.sort === sortKey) {
      th.classList.add('active-sort');
      if (ind) ind.textContent = sortDir === 'asc' ? '▲' : '▼';
    } else {
      th.classList.remove('active-sort');
      if (ind) ind.textContent = '';
    }
  });
}

// ------------------------------------------------------------- rendering

function render() {
  const body = document.getElementById('holdingsBody');
  const empty = document.getElementById('emptyState');
  body.innerHTML = '';

  if (state.holdings.length === 0) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    const rows = sortKey
      ? [...state.holdings].sort((a, b) => compareHoldings(a, b, sortKey, sortDir))
      : state.holdings;
    for (const h of rows) {
      body.appendChild(renderRow(h));
    }
  }
  updateSortIndicators();

  const t = computeTotals();
  setCard('sumValue', money(t.value), '');
  const ilsSub = document.getElementById('sumValueIls');
  if (ilsSub) ilsSub.textContent = state.fxRate && t.value != null ? '≈ ' + ils(t.value * state.fxRate) : '';
  maybePrefillConverter();
  setCard('sumDay', t.day == null ? '—' : money(t.day, { sign: true }), signClass(t.day));
  document.getElementById('sumDayPct').textContent = pct(t.dayPct);
  document.getElementById('sumDayPct').className = 'card-sub ' + signClass(t.day);
  setCard('sumGain', t.gain == null ? '—' : money(t.gain, { sign: true }), signClass(t.gain));
  document.getElementById('sumGainPct').textContent = pct(t.gainPct);
  document.getElementById('sumGainPct').className = 'card-sub ' + signClass(t.gain);
  setCard('sumCost', money(t.costAll), '');

  renderBanner();
  renderAllocation();
  renderChart();
  renderGainChart();
}

function setCard(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'card-value ' + (cls || '');
}

function renderRow(h) {
  const r = computeRow(h);
  const tr = document.createElement('tr');
  const err = state.errors[h.symbol];

  // In pre/post the price IS the extended-hours print, so say so — and show
  // how far it has moved since the regular close.
  const ext = r.q && r.q.extPrice != null && (r.q.marketState === 'PRE' || r.q.marketState === 'POST')
    ? `<span class="ext-line ${signClass(r.q.extChange)}" title="${escapeHtml(
        (r.q.marketState === 'PRE' ? 'Pre-market' : 'After hours') +
          ' price' + (r.q.extTime ? ' at ' + r.q.extTime : '') +
          ' — regular close ' + money(r.q.regularPrice)
      )}">${r.q.marketState === 'PRE' ? 'Pre' : 'Aft'} ${pct(r.q.extChangePercent)}</span>`
    : '';

  // A stale price means the feed didn't answer this round and we're showing the
  // last one we got — worth saying, quietly.
  const staleTip = r.q && r.q.stale
    ? ` class="stale" title="${escapeHtml(
        'Last known price' +
          (r.q.asOf ? ' from ' + new Date(r.q.asOf).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '') +
          " — the price feed didn't respond just now"
      )}"`
    : '';

  const priceCell = r.price != null ? `<span${staleTip}>${money(r.price)}</span>` + ext
    : err ? `<span class="quote-missing" title="${escapeHtml(err)}">error</span>`
    : `<span class="quote-missing">—</span>`;

  const dayCell = r.q && r.price != null
    ? `<span class="${signClass(r.q.change)}">${money(r.q.change, { sign: true })}<br><span class="pct">${pct(r.q.changePercent)}</span></span>`
    : '—';

  const todayGlCell = r.dayChange != null
    ? `<span class="${signClass(r.dayChange)}">${money(r.dayChange, { sign: true })}</span>`
    : '—';

  const glCell = r.gain != null
    ? `<div class="gl-cell"><span class="${signClass(r.gain)}">${money(r.gain, { sign: true })}</span><span class="pct ${signClass(r.gain)}">${pct(r.gainPct)}</span></div>`
    : '—';

  tr.innerHTML = `
    <td class="left">
      <div class="sym-cell">
        <span class="ticker">${escapeHtml(h.symbol)}</span>
        <span class="name">${escapeHtml(h.name || '')}</span>
      </div>
    </td>
    <td class="num">${trimNum(h.shares)}</td>
    <td class="num">${money(h.cost)}</td>
    <td class="num">${priceCell}</td>
    <td class="num">${dayCell}</td>
    <td class="num">${todayGlCell}</td>
    <td class="num">${r.marketValue != null ? money(r.marketValue) : '—'}</td>
    <td class="num">${glCell}</td>
    <td class="actions-col"><span class="row-menu" title="Edit">✎</span></td>
  `;
  tr.querySelector('.row-menu').addEventListener('click', () => openEdit(h));
  return tr;
}

function renderBanner() {
  const banner = document.getElementById('banner');
  if (!state.hasApiKey) {
    banner.innerHTML =
      'ℹ️ Live prices (including pre-market and after hours) work without a key. ' +
      'Add a free Finnhub key in ⚙ Settings to enable ticker search when adding holdings.';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function trimNum(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ------------------------------------------------------------- data loading

async function loadPortfolio() {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');
  btn.textContent = '↻ …';
  try {
    const res = await fetch('/api/portfolio');
    if (res.status === 401) {
      location.href = '/login'; // session expired
      return;
    }
    const data = await res.json();
    state.holdings = data.holdings || [];
    state.quotes = data.quotes || {};
    state.errors = data.errors || {};
    state.history = data.history || [];
    state.market = data.market || null;
    state.currency = data.settings.currency || 'USD';
    state.hasApiKey = data.settings.hasApiKey;
    document.getElementById('logoutBtn').classList.toggle('hidden', !data.settings.authEnabled);
    state.manualUsdIls = data.settings.usdIls || null;
    // Use the manual rate unless we've already got a live one this session.
    if (state.fxSource !== 'live' && state.manualUsdIls) {
      state.fxRate = state.manualUsdIls;
      state.fxSource = 'manual';
    }
    render();
    renderMarketState();
    stampUpdated();
  } catch (e) {
    document.getElementById('banner').textContent = 'Could not reach the server: ' + e.message;
    document.getElementById('banner').classList.remove('hidden');
  } finally {
    btn.classList.remove('spinning');
    btn.textContent = '↻ Refresh';
  }
}

// Badge in the top bar naming the session the prices came from.
function renderMarketState() {
  const el = document.getElementById('marketState');
  if (!el) return;
  const m = state.market;
  if (!m || !m.state) {
    el.classList.add('hidden');
    return;
  }
  el.textContent = m.label || '';
  el.className =
    'mkt-badge ' +
    (m.state === 'REGULAR' ? 'open' : m.state === 'PRE' || m.state === 'POST' ? 'ext' : '');
  el.classList.remove('hidden');
}

function stampUpdated() {
  const now = new Date();
  document.getElementById('lastUpdated').textContent =
    'Updated ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ------------------------------------------------------------- add holding

const addForm = document.getElementById('addForm');
const symbolInput = document.getElementById('symbolInput');
const sharesInput = document.getElementById('sharesInput');
const costInput = document.getElementById('costInput');
let pendingName = '';

let addNoteTimer = null;
function showAddNote(msg) {
  const el = document.getElementById('addNote');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(addNoteTimer);
  addNoteTimer = setTimeout(() => el.classList.add('hidden'), 6000);
}

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = document.getElementById('addError');
  errBox.classList.add('hidden');
  document.getElementById('addNote').classList.add('hidden');
  const symbol = symbolInput.value.trim().toUpperCase();
  const shares = Number(sharesInput.value);
  const cost = Number(costInput.value);
  if (!symbol || !(shares > 0) || !(cost >= 0)) {
    errBox.textContent = 'Enter a symbol, shares greater than 0, and a cost.';
    errBox.classList.remove('hidden');
    return;
  }
  const btn = document.getElementById('addBtn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/holdings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, shares, cost, name: pendingName }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || 'Failed to add');
    addForm.reset();
    pendingName = '';
    hideSearch();
    await loadPortfolio();
    if (result.merged) {
      showAddNote(
        `Merged into ${result.symbol} — now ${trimNum(result.shares)} shares at avg cost ${money(result.cost)}.`
      );
    }
  } catch (e2) {
    errBox.textContent = e2.message;
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------- symbol search

const searchBox = document.getElementById('searchResults');
let searchTimer = null;

symbolInput.addEventListener('input', () => {
  pendingName = '';
  const q = symbolInput.value.trim();
  clearTimeout(searchTimer);
  if (!q || !state.hasApiKey) return hideSearch();
  searchTimer = setTimeout(() => runSearch(q), 280);
});

symbolInput.addEventListener('blur', () => setTimeout(hideSearch, 150));

async function runSearch(q) {
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    if (!res.ok) return hideSearch();
    const { results } = await res.json();
    if (!results || !results.length) return hideSearch();
    searchBox.innerHTML = '';
    for (const r of results) {
      const div = document.createElement('div');
      div.className = 'search-item';
      div.innerHTML = `<span class="sym">${escapeHtml(r.displaySymbol)}</span> <span class="desc">${escapeHtml(r.description)}</span>`;
      div.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        symbolInput.value = r.symbol;
        pendingName = r.description;
        hideSearch();
        sharesInput.focus();
      });
      searchBox.appendChild(div);
    }
    searchBox.classList.remove('hidden');
  } catch {
    hideSearch();
  }
}

function hideSearch() {
  searchBox.classList.add('hidden');
  searchBox.innerHTML = '';
}

// ------------------------------------------------------------- edit / delete

const editModal = document.getElementById('editModal');

function openEdit(h) {
  document.getElementById('editId').value = h.id;
  document.getElementById('editTitle').textContent = h.symbol + (h.name ? ' — ' + h.name : '');
  document.getElementById('editShares').value = h.shares;
  document.getElementById('editCost').value = h.cost;
  openModal(editModal);
}

document.getElementById('saveEditBtn').addEventListener('click', async () => {
  const id = document.getElementById('editId').value;
  const shares = Number(document.getElementById('editShares').value);
  const cost = Number(document.getElementById('editCost').value);
  if (!(shares > 0) || !(cost >= 0)) return;
  await fetch('/api/holdings/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shares, cost }),
  });
  closeModals();
  await loadPortfolio();
});

document.getElementById('deleteHoldingBtn').addEventListener('click', async () => {
  const id = document.getElementById('editId').value;
  const title = document.getElementById('editTitle').textContent;
  if (!confirm('Delete ' + title + '?')) return;
  await fetch('/api/holdings/' + encodeURIComponent(id), { method: 'DELETE' });
  closeModals();
  await loadPortfolio();
});

// ------------------------------------------------------------- settings

const settingsModal = document.getElementById('settingsModal');

document.getElementById('settingsBtn').addEventListener('click', async () => {
  const res = await fetch('/api/settings');
  const s = await res.json();
  document.getElementById('apiKeyInput').value = '';
  document.getElementById('apiKeyInput').placeholder = s.hasApiKey
    ? 'Key saved — paste a new one to replace it'
    : 'Paste your free API key';
  document.getElementById('currencyInput').value = s.currency || 'USD';
  document.getElementById('usdIlsInput').value = s.usdIls || '';
  openModal(settingsModal);
});

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const apiKey = document.getElementById('apiKeyInput').value.trim();
  const currency = document.getElementById('currencyInput').value;
  const usdIlsVal = parseFloat(document.getElementById('usdIlsInput').value);
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, currency, usdIls: isFinite(usdIlsVal) ? usdIlsVal : undefined }),
  });
  // A manually-set rate should take effect immediately, even over a cached live one.
  state.fxSource = null;
  closeModals();
  await loadPortfolio();
  await loadFxRate();
});

// Import: pick a backup file, validate it, then replace current data.
document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // allow re-selecting the same file later
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert('That file is not valid JSON.');
    return;
  }
  if (!data || !Array.isArray(data.holdings)) {
    alert("That doesn't look like a gal_folio backup (no holdings found).");
    return;
  }
  const n = data.holdings.length;
  if (!confirm(`Import ${n} holding${n === 1 ? '' : 's'}?\n\nThis REPLACES your current holdings, history and settings. A backup of the current data is saved first.`)) {
    return;
  }

  const res = await fetch('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert('Import failed: ' + (result.error || 'unknown error'));
    return;
  }
  state.fxSource = null;
  fxPrefilled = false;
  closeModals();
  await loadPortfolio();
  await loadFxRate();
  showAddNote(`Imported ${result.holdings} holding${result.holdings === 1 ? '' : 's'} from backup.`);
});

// ------------------------------------------------------------- modal plumbing

function openModal(m) { m.classList.remove('hidden'); }
function closeModals() {
  document.querySelectorAll('.modal-overlay').forEach((m) => m.classList.add('hidden'));
}
document.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModals));
document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModals(); });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

document.getElementById('refreshBtn').addEventListener('click', () => {
  loadPortfolio().then(scheduleRefresh); // manual refresh restarts the clock
});

// ------------------------------------------------------------- allocation donut

const ALLOC_PALETTE = [
  '#4c8dff', '#3fb950', '#f0883e', '#a371f7', '#f85149', '#2dd4bf',
  '#e3b341', '#ec6cb9', '#56d364', '#79c0ff', '#ff7b72', '#d2a8ff',
];

// Group holdings by symbol (so multiple lots of the same ticker form one slice)
// and total their market value.
function computeAllocation() {
  const bySym = new Map();
  for (const h of state.holdings) {
    const r = computeRow(h);
    if (r.marketValue == null || r.marketValue <= 0) continue;
    const cur = bySym.get(h.symbol) || { symbol: h.symbol, value: 0 };
    cur.value += r.marketValue;
    bySym.set(h.symbol, cur);
  }
  const arr = [...bySym.values()].sort((a, b) => b.value - a.value);
  const total = arr.reduce((s, x) => s + x.value, 0);
  return { arr, total };
}

function ptOnCircle(cx, cy, radius, angleDeg) {
  const rad = (Math.PI / 180) * (angleDeg - 90);
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

function donutSegment(cx, cy, R, r, startAngle, endAngle) {
  const p1 = ptOnCircle(cx, cy, R, startAngle);
  const p2 = ptOnCircle(cx, cy, R, endAngle);
  const p3 = ptOnCircle(cx, cy, r, endAngle);
  const p4 = ptOnCircle(cx, cy, r, startAngle);
  const large = endAngle - startAngle > 180 ? 1 : 0;
  return (
    `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} ` +
    `A ${R} ${R} 0 ${large} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)} ` +
    `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)} ` +
    `A ${r} ${r} 0 ${large} 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)} Z`
  );
}

function renderAllocation() {
  const donut = document.getElementById('allocDonut');
  const legend = document.getElementById('allocLegend');
  if (!donut || !legend) return;

  const { arr, total } = computeAllocation();
  if (!arr.length || total <= 0) {
    donut.innerHTML = '';
    legend.innerHTML =
      '<div class="chart-empty" style="height:auto;padding:12px 4px">' +
      (state.hasApiKey
        ? 'Add holdings to see how your money is split across them.'
        : 'Add your Finnhub key so live prices can size the breakdown.') +
      '</div>';
    return;
  }

  const cx = 120, cy = 120, R = 104, r = 66;
  let angle = 0;
  let paths = '';
  let legendHtml = '';

  arr.forEach((slice, i) => {
    const frac = slice.value / total;
    const color = ALLOC_PALETTE[i % ALLOC_PALETTE.length];
    const pctStr = (frac * 100).toFixed(1) + '%';
    if (frac >= 0.9999) {
      paths +=
        `<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="${color}" ` +
        `stroke-width="${R - r}" data-sym="${escapeHtml(slice.symbol)}" data-pct="100.0" />`;
    } else {
      const start = angle;
      const end = angle + frac * 360;
      angle = end;
      paths +=
        `<path class="alloc-slice" d="${donutSegment(cx, cy, R, r, start, end)}" fill="${color}" ` +
        `data-sym="${escapeHtml(slice.symbol)}" data-pct="${(frac * 100).toFixed(1)}" />`;
    }
    legendHtml +=
      `<div class="legend-row" data-sym="${escapeHtml(slice.symbol)}">` +
      `<span class="legend-dot" style="background:${color}"></span>` +
      `<span class="legend-sym">${escapeHtml(slice.symbol)}</span>` +
      `<span class="legend-pct">${pctStr}</span>` +
      `<span class="legend-val">${money(slice.value)}</span>` +
      `</div>`;
  });

  const center =
    `<text x="${cx}" y="${cy - 6}" text-anchor="middle" class="donut-center-label">Total</text>` +
    `<text x="${cx}" y="${cy + 16}" text-anchor="middle" class="donut-center-val">${money(total)}</text>`;

  donut.innerHTML = paths + center;
  legend.innerHTML = legendHtml;
  attachAllocHover(donut, legend, total);
}

// Hovering a slice or legend row highlights it and shows its share in the center.
function attachAllocHover(donut, legend, total) {
  const slices = [...donut.querySelectorAll('[data-sym]')];
  const rows = [...legend.querySelectorAll('.legend-row')];
  const label = donut.querySelector('.donut-center-label');
  const val = donut.querySelector('.donut-center-val');
  const defLabel = label.textContent;
  const defVal = val.textContent;

  function focus(sym) {
    slices.forEach((s) => (s.style.opacity = s.getAttribute('data-sym') === sym ? '1' : '0.28'));
    rows.forEach((row) => row.classList.toggle('active', row.getAttribute('data-sym') === sym));
    const s = slices.find((x) => x.getAttribute('data-sym') === sym);
    if (s) {
      label.textContent = sym;
      val.textContent = s.getAttribute('data-pct') + '%';
    }
  }
  function clear() {
    slices.forEach((s) => (s.style.opacity = '1'));
    rows.forEach((row) => row.classList.remove('active'));
    label.textContent = defLabel;
    val.textContent = defVal;
  }

  slices.forEach((s) => {
    s.addEventListener('mouseenter', () => focus(s.getAttribute('data-sym')));
    s.addEventListener('mouseleave', clear);
  });
  rows.forEach((row) => {
    row.addEventListener('mouseenter', () => focus(row.getAttribute('data-sym')));
    row.addEventListener('mouseleave', clear);
  });
}

// ------------------------------------------------------------- chart

let currentRange = 'all';
let chartPoints = [];
let gainRange = 'all';
let gainChartPoints = [];

function ymd(d) {
  return (
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  );
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function currencySymbol() {
  try {
    return (0).toLocaleString('en-US', { style: 'currency', currency: state.currency }).replace(/[\d.,\s]/g, '') || '$';
  } catch {
    return '$';
  }
}

function shortMoney(n) {
  const sym = currencySymbol();
  const a = Math.abs(n);
  const s = n < 0 ? '-' : '';
  if (a >= 1e6) return s + sym + (a / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return s + sym + (a / 1e3).toFixed(1) + 'k';
  return s + sym + Math.round(a);
}

function filterByRange(history, range) {
  if (range === 'all') return history.slice();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Number(range));
  const cut = ymd(cutoff);
  return history.filter((h) => h.date >= cut);
}

function renderChart() {
  const body = document.getElementById('chartBody');
  if (!body) return;
  const points = filterByRange(state.history, currentRange);

  if (points.length === 0) {
    body.innerHTML =
      '<div class="chart-empty">📈 Your value chart builds automatically as you use gal_folio.<br>' +
      (state.hasApiKey
        ? "Today's value is being recorded — check back tomorrow to see the line start."
        : 'Add your Finnhub key in ⚙ Settings to start recording daily values.') +
      '</div>';
    return;
  }
  if (points.length === 1) {
    body.innerHTML =
      '<div class="chart-empty">Only one day recorded so far — ' +
      money(points[0].value) + ' on ' + fmtDate(points[0].date) +
      '.<br>The line appears once there are at least two days of history.</div>';
    return;
  }

  const W = Math.max(body.clientWidth || 800, 320);
  const H = 280;
  const padL = 64, padR = 18, padT = 18, padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const values = points.map((p) => p.value);
  const costs = points.map((p) => (p.cost != null ? p.cost : p.value));
  let min = Math.min(...values, ...costs);
  let max = Math.max(...values, ...costs);
  if (min === max) { min -= 1; max += 1; }
  const rpad = (max - min) * 0.08;
  min -= rpad;
  max += rpad;

  const n = points.length;
  const X = (i) => padL + (i / (n - 1)) * plotW;
  const Y = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;

  const up = points[n - 1].value >= points[0].value;
  const lineColor = up ? 'var(--green)' : 'var(--red)';
  const fillColor = up ? 'rgba(63,185,80,0.14)' : 'rgba(248,81,73,0.12)';

  let linePath = '';
  let costPath = '';
  chartPoints = [];
  points.forEach((p, i) => {
    const px = X(i), py = Y(p.value);
    chartPoints.push({ px, py, date: p.date, value: p.value, cost: p.cost });
    linePath += (i === 0 ? 'M' : 'L') + px.toFixed(1) + ' ' + py.toFixed(1) + ' ';
    const cy = Y(p.cost != null ? p.cost : p.value);
    costPath += (i === 0 ? 'M' : 'L') + px.toFixed(1) + ' ' + cy.toFixed(1) + ' ';
  });
  const baseY = (padT + plotH).toFixed(1);
  const areaPath = linePath + 'L' + X(n - 1).toFixed(1) + ' ' + baseY + ' L' + X(0).toFixed(1) + ' ' + baseY + ' Z';

  const GRID = 4;
  let grid = '';
  for (let g = 0; g <= GRID; g++) {
    const v = min + (g / GRID) * (max - min);
    const gy = Y(v).toFixed(1);
    grid += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '" class="grid-line" />';
    grid += '<text x="' + (padL - 8) + '" y="' + gy + '" class="axis-label" dominant-baseline="middle" text-anchor="end">' + shortMoney(v) + '</text>';
  }

  const xIdx = n <= 2 ? [0, n - 1] : [0, Math.floor((n - 1) / 2), n - 1];
  let xlabels = '';
  xIdx.forEach((i) => {
    xlabels += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 8) + '" class="axis-label" text-anchor="middle">' + fmtDate(points[i].date) + '</text>';
  });

  body.innerHTML =
    '<svg id="chartSvg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
    grid + xlabels +
    '<path d="' + areaPath + '" fill="' + fillColor + '" stroke="none" />' +
    '<path d="' + costPath + '" fill="none" stroke="var(--text-dim)" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.7" />' +
    '<path d="' + linePath + '" fill="none" stroke="' + lineColor + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />' +
    '<line id="crosshair" class="crosshair hidden" y1="' + padT + '" y2="' + (padT + plotH) + '" />' +
    '<circle id="hoverDot" class="hover-dot hidden" r="4.5" />' +
    '<rect id="chartOverlay" x="' + padL + '" y="' + padT + '" width="' + plotW + '" height="' + plotH + '" fill="transparent" />' +
    '</svg>' +
    '<div class="chart-legend"><span class="lg-value" style="color:' + (up ? '#3fb950' : '#f85149') + '">— Value</span><span>- - Invested</span></div>' +
    '<div id="chartTip" class="chart-tip hidden"></div>';

  attachChartHover(body);
}

function attachChartHover(body) {
  const svg = document.getElementById('chartSvg');
  const overlay = document.getElementById('chartOverlay');
  const dot = document.getElementById('hoverDot');
  const cross = document.getElementById('crosshair');
  const tip = document.getElementById('chartTip');
  if (!svg || !overlay) return;

  overlay.addEventListener('mousemove', (e) => {
    // Map the mouse position into SVG user-space via the element's own transform
    // matrix. This is robust to CSS scaling and avoids dividing by a measured
    // width (which some renderers report as 0).
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const loc = pt.matrixTransform(ctm.inverse());
    const mx = loc.x;
    let best = Infinity, sel = null;
    for (const p of chartPoints) {
      const d = Math.abs(p.px - mx);
      if (d < best) { best = d; sel = p; }
    }
    if (!sel) return;

    dot.setAttribute('cx', sel.px);
    dot.setAttribute('cy', sel.py);
    dot.classList.remove('hidden');
    cross.setAttribute('x1', sel.px);
    cross.setAttribute('x2', sel.px);
    cross.classList.remove('hidden');

    // Map the selected point back to screen coords, then to body-relative px.
    const bodyRect = body.getBoundingClientRect();
    const back = svg.createSVGPoint();
    back.x = sel.px;
    back.y = sel.py;
    const screenPos = back.matrixTransform(ctm);
    const cssX = screenPos.x - bodyRect.left;
    const cssY = screenPos.y - bodyRect.top;
    const gain = sel.cost != null ? sel.value - sel.cost : null;
    tip.innerHTML =
      '<div class="tip-date">' + fmtDate(sel.date) + '</div>' +
      '<div class="tip-val">' + money(sel.value) + '</div>' +
      (gain != null ? '<div class="tip-gain ' + signClass(gain) + '">' + money(gain, { sign: true }) + ' vs invested</div>' : '');
    tip.style.left = cssX + 'px';
    tip.style.top = cssY - 14 + 'px';
    tip.classList.remove('hidden');
  });

  overlay.addEventListener('mouseleave', () => {
    dot.classList.add('hidden');
    cross.classList.add('hidden');
    tip.classList.add('hidden');
  });
}

// Gain/loss over time = value - cost basis at each snapshot. Unlike the value
// chart, buying more doesn't move this line (value and cost rise together), so
// it shows real profit/loss. Green above the zero line, red below.
function renderGainChart() {
  const body = document.getElementById('gainChartBody');
  if (!body) return;

  const points = filterByRange(state.history, gainRange)
    .map((p) => {
      const gain = p.value != null && p.cost != null ? p.value - p.cost : null;
      const pctVal = gain != null && p.cost > 0 ? (gain / p.cost) * 100 : null;
      return { date: p.date, gain, pct: pctVal };
    })
    .filter((p) => p.gain != null);

  if (points.length === 0) {
    body.innerHTML =
      '<div class="chart-empty">📈 Your profit/loss curve builds automatically as you use gal_folio.<br>' +
      (state.hasApiKey ? "Today's figure is recorded — check back tomorrow for the line." : 'Add your Finnhub key to start recording.') +
      '</div>';
    return;
  }
  if (points.length === 1) {
    body.innerHTML =
      '<div class="chart-empty">Only one day recorded so far — ' +
      money(points[0].gain, { sign: true }) + ' on ' + fmtDate(points[0].date) +
      '.<br>The line appears once there are at least two days.</div>';
    return;
  }

  const W = Math.max(body.clientWidth || 800, 320);
  const H = 280;
  const padL = 64, padR = 18, padT = 18, padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const gains = points.map((p) => p.gain);
  let dataMin = Math.min(0, ...gains); // always keep the zero line in view
  let dataMax = Math.max(0, ...gains);
  if (dataMin === dataMax) { dataMin -= 1; dataMax += 1; }
  const rpad = (dataMax - dataMin) * 0.1;
  const min = dataMin - rpad;
  const max = dataMax + rpad;

  const n = points.length;
  const X = (i) => padL + (i / (n - 1)) * plotW;
  const Y = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;
  const zeroY = Y(0);

  let linePath = '';
  gainChartPoints = [];
  points.forEach((p, i) => {
    const px = X(i), py = Y(p.gain);
    gainChartPoints.push({ px, py, date: p.date, gain: p.gain, pct: p.pct });
    linePath += (i === 0 ? 'M' : 'L') + px.toFixed(1) + ' ' + py.toFixed(1) + ' ';
  });
  const areaPath =
    linePath + 'L' + X(n - 1).toFixed(1) + ' ' + zeroY.toFixed(1) + ' L' + X(0).toFixed(1) + ' ' + zeroY.toFixed(1) + ' Z';

  let grid = '';
  const GRID = 4;
  for (let g = 0; g <= GRID; g++) {
    const v = min + (g / GRID) * (max - min);
    const gy = Y(v).toFixed(1);
    grid += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '" class="grid-line" />';
    grid += '<text x="' + (padL - 8) + '" y="' + gy + '" class="axis-label" dominant-baseline="middle" text-anchor="end">' + shortMoney(v) + '</text>';
  }
  const xIdx = n <= 2 ? [0, n - 1] : [0, Math.floor((n - 1) / 2), n - 1];
  let xlabels = '';
  xIdx.forEach((i) => {
    xlabels += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 8) + '" class="axis-label" text-anchor="middle">' + fmtDate(points[i].date) + '</text>';
  });

  // Clip the fill/line into an above-zero (green) and below-zero (red) half —
  // this two-tones the chart without computing zero-crossings by hand.
  const defs =
    '<defs>' +
    '<clipPath id="gainPos"><rect x="0" y="' + padT + '" width="' + W + '" height="' + Math.max(0, zeroY - padT).toFixed(1) + '"/></clipPath>' +
    '<clipPath id="gainNeg"><rect x="0" y="' + zeroY.toFixed(1) + '" width="' + W + '" height="' + Math.max(0, padT + plotH - zeroY).toFixed(1) + '"/></clipPath>' +
    '</defs>';

  body.innerHTML =
    '<svg id="gainSvg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
    defs + grid + xlabels +
    '<path d="' + areaPath + '" fill="#3fb950" fill-opacity="0.15" clip-path="url(#gainPos)" />' +
    '<path d="' + areaPath + '" fill="#f85149" fill-opacity="0.13" clip-path="url(#gainNeg)" />' +
    '<line x1="' + padL + '" y1="' + zeroY.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + zeroY.toFixed(1) + '" class="zero-line" />' +
    '<path d="' + linePath + '" fill="none" stroke="#3fb950" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#gainPos)" />' +
    '<path d="' + linePath + '" fill="none" stroke="#f85149" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#gainNeg)" />' +
    '<line id="gainCross" class="crosshair hidden" y1="' + padT + '" y2="' + (padT + plotH) + '" />' +
    '<circle id="gainDot" class="hover-dot hidden" r="4.5" />' +
    '<rect id="gainOverlay" x="' + padL + '" y="' + padT + '" width="' + plotW + '" height="' + plotH + '" fill="transparent" />' +
    '</svg>' +
    '<div id="gainTip" class="chart-tip hidden"></div>';

  attachGainHover(body);
}

function attachGainHover(body) {
  const svg = document.getElementById('gainSvg');
  const overlay = document.getElementById('gainOverlay');
  const dot = document.getElementById('gainDot');
  const cross = document.getElementById('gainCross');
  const tip = document.getElementById('gainTip');
  if (!svg || !overlay) return;

  overlay.addEventListener('mousemove', (e) => {
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const mx = pt.matrixTransform(ctm.inverse()).x;
    let best = Infinity, sel = null;
    for (const p of gainChartPoints) {
      const d = Math.abs(p.px - mx);
      if (d < best) { best = d; sel = p; }
    }
    if (!sel) return;

    dot.setAttribute('cx', sel.px);
    dot.setAttribute('cy', sel.py);
    dot.classList.remove('hidden');
    cross.setAttribute('x1', sel.px);
    cross.setAttribute('x2', sel.px);
    cross.classList.remove('hidden');

    const bodyRect = body.getBoundingClientRect();
    const back = svg.createSVGPoint();
    back.x = sel.px;
    back.y = sel.py;
    const screenPos = back.matrixTransform(ctm);
    tip.innerHTML =
      '<div class="tip-date">' + fmtDate(sel.date) + '</div>' +
      '<div class="tip-val ' + signClass(sel.gain) + '">' + money(sel.gain, { sign: true }) + '</div>' +
      (sel.pct != null ? '<div class="tip-gain ' + signClass(sel.gain) + '">' + pct(sel.pct) + '</div>' : '');
    tip.style.left = screenPos.x - bodyRect.left + 'px';
    tip.style.top = screenPos.y - bodyRect.top - 14 + 'px';
    tip.classList.remove('hidden');
  });

  overlay.addEventListener('mouseleave', () => {
    dot.classList.add('hidden');
    cross.classList.add('hidden');
    tip.classList.add('hidden');
  });
}

document.getElementById('rangeToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if (!btn) return;
  currentRange = btn.dataset.range;
  document.querySelectorAll('#rangeToggle button').forEach((b) => b.classList.toggle('active', b === btn));
  renderChart();
});

document.getElementById('gainRangeToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if (!btn) return;
  gainRange = btn.dataset.range;
  document.querySelectorAll('#gainRangeToggle button').forEach((b) => b.classList.toggle('active', b === btn));
  renderGainChart();
});

// Click a column header to sort. Same header again flips direction; text sorts
// ascending first, numbers descending first (largest at the top).
document.querySelector('#holdingsTable thead').addEventListener('click', (e) => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const key = th.dataset.sort;
  if (sortKey === key) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey = key;
    sortDir = key === 'symbol' ? 'asc' : 'desc';
  }
  render();
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderChart();
    renderGainChart();
  }, 150);
});

// ------------------------------------------------------------- fx converter

const usdInput = document.getElementById('usdInput');
const ilsInput = document.getElementById('ilsInput');
let fxPrefilled = false;

async function loadFxRate() {
  try {
    const res = await fetch('/api/fxrate?from=USD&to=ILS');
    if (!res.ok) throw new Error('unavailable');
    const j = await res.json();
    if (!j.rate) throw new Error('unavailable');
    state.fxRate = j.rate;
    state.fxUpdated = j.updated;
    state.fxSource = 'live';
  } catch {
    // Live rate blocked or unavailable — fall back to the manual rate.
    if (state.manualUsdIls) {
      state.fxRate = state.manualUsdIls;
      state.fxSource = 'manual';
    }
  }
  renderFx();
  render(); // refresh the ILS sub-line under Total Value
}

function fxDate(s) {
  try {
    return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function renderFx() {
  const el = document.getElementById('fxRate');
  if (!state.fxRate) {
    el.textContent = 'USD → ILS · set a rate in ⚙ Settings';
    return;
  }
  const suffix =
    state.fxSource === 'live'
      ? ' · live' + (state.fxUpdated ? ', updated ' + fxDate(state.fxUpdated) : '')
      : ' · manual (edit in ⚙)';
  el.innerHTML = 'USD → ILS · <b>1 USD = ₪' + state.fxRate.toFixed(3) + '</b>' + suffix;
  maybePrefillConverter();
  syncFromUsd();
}

function syncFromUsd() {
  if (!state.fxRate) return;
  const usd = parseFloat(usdInput.value);
  ilsInput.value = isFinite(usd) ? (usd * state.fxRate).toFixed(2) : '';
}

function syncFromIls() {
  if (!state.fxRate) return;
  const v = parseFloat(ilsInput.value);
  usdInput.value = isFinite(v) ? (v / state.fxRate).toFixed(2) : '';
}

// Prefill the USD box with the current portfolio value the first time we can,
// so ILS immediately shows what the whole portfolio is worth in shekels.
function maybePrefillConverter() {
  if (fxPrefilled || !state.fxRate) return;
  const t = computeTotals();
  if (t.value == null) return;
  usdInput.value = t.value.toFixed(2);
  fxPrefilled = true;
}

usdInput.addEventListener('input', syncFromUsd);
ilsInput.addEventListener('input', syncFromIls);

// ------------------------------------------------------------- boot

loadPortfolio();
loadFxRate();
// Auto-refresh prices. Pre-market, regular hours and after hours all move, so
// poll every 60s through all three; once the market is fully shut there's
// nothing new to fetch, so back off to 5 minutes.
function refreshDelay() {
  const st = state.market && state.market.state;
  return st === 'CLOSED' ? 5 * 60_000 : 60_000;
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await loadPortfolio();
    scheduleRefresh(); // re-read the state each time — sessions change under us
  }, refreshDelay());
}
scheduleRefresh();

// Phones freeze timers in a backgrounded tab, so a re-opened home-screen app
// would otherwise show whatever the price was when you last looked. Re-fetch
// the moment it comes back to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadPortfolio().then(scheduleRefresh);
});

setInterval(loadFxRate, 60 * 60 * 1000);
