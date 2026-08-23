// dashboard.js — AdBlock Dashboard logic

/* ── Privacy score (mirrors background.js calculatePrivacyScore) ── */
function calculatePrivacyScore(domainStats = {}, settings = {}) {
  const total = domainStats.totalSeen || 0;
  const protectionActive = settings.enabled !== false;
  // Respect individual feature toggles (default ON if not set)
  const adsActive      = protectionActive && settings.blockAds      !== false;
  const trackersActive = protectionActive && settings.blockTrackers !== false;
  const malwareActive  = protectionActive && settings.blockMalware  !== false;

  let adsScore = adsActive ? 50 : 0;
  if (total > 0) {
    const expected = Math.max(total * 0.15, 1);
    adsScore = adsActive
      ? Math.min(100, Math.round(((domainStats.adsBlocked || 0) / expected) * 100))
      : 0;
  }

  let trackersScore = trackersActive ? 50 : 0;
  if (total > 0) {
    const expected = Math.max(total * 0.10, 1);
    trackersScore = trackersActive
      ? Math.min(100, Math.round(((domainStats.trackersBlocked || 0) / expected) * 100))
      : 0;
  }

  const referrerScore = settings.referrerAnonymization !== false ? 85 : 20;
  // Malware: reflects protection status — active = fully protected (100%), off = 0%.
  // No threats found means protection is working perfectly, not partially.
  const malwareScore = malwareActive ? 100 : 0;

  const score = Math.round(
    adsScore * 0.30 + trackersScore * 0.25 + malwareScore * 0.20 + referrerScore * 0.25
  );
  return {
    score: Math.max(0, Math.min(100, score)),
    components: {
      ads:         Math.min(100, Math.round(adsScore)),
      trackers:    Math.min(100, Math.round(trackersScore)),
      malware:     Math.min(100, Math.round(malwareScore)),
      referrer:    referrerScore,
    },
  };
}

/* ── Render privacy score bars ─────────────────── */
function renderPrivacyScore(stats, settings) {
  // Aggregate across all domains
  const aggregate = {
    adsBlocked:      0,
    trackersBlocked: 0,
    malwareBlocked:  0,
    totalSeen:       0,
  };
  const domainEntries = Object.values(stats);
  for (const s of domainEntries) {
    // stats stores ad blocks as `blocked`, not `adsBlocked`
    aggregate.adsBlocked      += s.blocked         || 0;
    aggregate.trackersBlocked += s.trackersBlocked || 0;
    aggregate.malwareBlocked  += s.malwareBlocked  || 0;
    aggregate.totalSeen       += s.totalSeen       || 0;
  }

  const { score, components } = calculatePrivacyScore(aggregate, settings);

  // Overall badge
  const el = document.getElementById('overallScore');
  if (el) {
    el.textContent = score;
    el.style.color = score >= 70 ? 'var(--green)' : score >= 40 ? 'var(--blue)' : 'var(--red)';
  }

  // Individual bars
  const bars = {
    ads:         components.ads,
    trackers:    components.trackers,
    malware:     components.malware,
    referrer:    components.referrer,
  };
  for (const [key, val] of Object.entries(bars)) {
    const fill = document.getElementById(`scoreFill-${key}`);
    const pct  = document.getElementById(`scorePct-${key}`);
    if (fill) fill.style.width = `${val}%`;
    if (pct)  pct.textContent  = `${val}%`;
  }
}

/* ── "Scan page globals" — hidden outside debug builds ─────────────── */
// Matches background.js's contextMenus gate (qkv1-scan-globals only
// created when DEBUG_LOCAL): the nav entry point stays hidden too so
// there's no dashboard page for a feature the user can't actually reach
// from any page. Storage/removal (REMOVE_GLOBAL_RULE) is untouched — this
// only hides discovery, not the ability to clean up rules saved during an
// earlier debug session.
if (!self.ADBLOCK_CONFIG.DEBUG_LOCAL) {
  document.querySelector('.nav-item[data-page="globalrules"]')?.remove();
  document.getElementById('page-globalrules')?.remove();
}

/* ── Navigation ───────────────────────────────── */
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault();
    const page = item.dataset.page;

    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

    item.classList.add('active');
    document.getElementById(`page-${page}`)?.classList.add('active');
  });
});

/* ── Date chip ────────────────────────────────── */
const dateChip = document.getElementById('dateChip');
if (dateChip) {
  dateChip.textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  });
}

/* ── Global toggle ────────────────────────────── */
const globalToggle = document.getElementById('globalToggle');
const globalLabel  = document.getElementById('globalLabel');
const sidebarBadge = document.getElementById('sidebarBadge');

function syncProtectionUI(enabled) {
  if (globalLabel) globalLabel.textContent = enabled ? 'ON' : 'OFF';
  globalLabel && (globalLabel.style.color = enabled ? 'var(--green)' : 'var(--red)');
  sidebarBadge && sidebarBadge.classList.toggle('off', !enabled);
  sidebarBadge && (sidebarBadge.textContent = `Protection ${enabled ? 'ON' : 'OFF'}`);
  if (sidebarBadge) {
    const dot = document.createElement('span');
    dot.className = 'badge-dot';
    sidebarBadge.innerHTML = '';
    sidebarBadge.appendChild(dot);
    sidebarBadge.append(` Protection ${enabled ? 'ON' : 'OFF'}`);
  }
}

globalToggle?.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: globalToggle.checked });
  syncProtectionUI(globalToggle.checked);
  chrome.runtime.sendMessage({ type: 'TOGGLE', enabled: globalToggle.checked });
});

/* ── Load overview stats ──────────────────────── */
function loadOverviewStats() {
  chrome.storage.local.get(
    ['stats', 'enabled', 'referrerAnonymization', 'dailyStats', 'blockAds', 'blockTrackers', 'blockMalware'],
    ({ stats = {}, enabled = true, referrerAnonymization = true, dailyStats = {},
       blockAds = true, blockTrackers = true, blockMalware = true }) => {
      globalToggle && (globalToggle.checked = enabled);
      syncProtectionUI(enabled);

      // aggregate across all domains
      let blocked = 0, trackers = 0, malware = 0, bandwidth = 0, timeSec = 0;
      for (const s of Object.values(stats)) {
        blocked   += s.blocked            ?? 0;
        trackers  += s.trackersBlocked    ?? 0;
        malware   += s.malwareBlocked     ?? 0;
        bandwidth += s.bandwidth          ?? 0;
        timeSec   += s.timeSaved          ?? 0;
      }

      setText('kpiBandwidth', formatBytes(bandwidth));
      setText('kpiTime',      formatTime(timeSec));

      // Real deltas from dailyStats — KPI main numbers show TODAY's counts
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const yd = new Date(now); yd.setDate(yd.getDate() - 1);
      const yesterdayKey = `${yd.getFullYear()}-${String(yd.getMonth() + 1).padStart(2, '0')}-${String(yd.getDate()).padStart(2, '0')}`;
      let today = dailyStats[todayKey] || { blocked: 0, trackers: 0, malware: 0 };
      // Fallback: if dailyStats is empty but we have aggregate stats, use them for today
      if (today.blocked === 0 && blocked > 0 && Object.keys(dailyStats).length === 0) {
        today = { blocked, trackers, malware };
      }
      const yesterday = dailyStats[yesterdayKey] || { blocked: 0, trackers: 0, malware: 0 };

      // Override KPI main numbers with today's values
      setText('kpiBlocked',  today.blocked.toLocaleString());
      setText('kpiTrackers', today.trackers.toLocaleString());
      setText('kpiMalware',  today.malware.toLocaleString());

      function deltaText(todayVal, yesterdayVal) {
        if (yesterdayVal === 0) return todayVal > 0 ? `+${todayVal} today` : '— today';
        const pct = Math.round(((todayVal - yesterdayVal) / yesterdayVal) * 100);
        const sign = pct >= 0 ? '+' : '';
        return `${sign}${pct}% vs yesterday`;
      }

      setText('kpiBlockedDelta',  deltaText(today.blocked, yesterday.blocked));
      setText('kpiTrackersDelta', deltaText(today.trackers, yesterday.trackers));
      setText('kpiMalwareDelta',  malware > 0
        ? deltaText(today.malware, yesterday.malware)
        : '0 threats today');

      // Show which malware domains were blocked (only if today has real malware)
      const malwareDomains = Object.entries(stats)
        .filter(([, s]) => (s.malwareBlocked || 0) > 0)
        .sort(([, a], [, b]) => b.malwareBlocked - a.malwareBlocked);
      const malwareDetail = document.getElementById('kpiMalwareDetail');
      if (malwareDetail) {
        if (today.malware === 0 || malwareDomains.length === 0) {
          malwareDetail.textContent = 'No threats detected';
          malwareDetail.title = '';
        } else {
          const top = malwareDomains[0][0];
          const rest = malwareDomains.length - 1;
          malwareDetail.textContent = rest > 0 ? `${top} +${rest} more` : top;
          malwareDetail.title = malwareDomains.map(([d, s]) => `${d} (${s.malwareBlocked})`).join('\n');
        }
      }

      renderChart();
      renderDomainList(stats);
      renderPrivacyScore(stats, { enabled, referrerAnonymization, blockAds, blockTrackers, blockMalware });
    }
  );
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

/* ── Bar chart ────────────────────────────────── */
let activeRange = 7;let activeMetric = 'blocked';
const METRIC_CONFIG = {
  blocked:  { chartTitle: 'Blocked requests',   domainTitle: 'Top blocked domains',  dailyKey: 'blocked',  domainKey: 'blocked',        tooltip: 'blocked'  },
  trackers: { chartTitle: 'Tracker requests',    domainTitle: 'Top tracker domains',  dailyKey: 'trackers', domainKey: 'trackersBlocked', tooltip: 'trackers' },
  malware:  { chartTitle: 'Malware detections',  domainTitle: 'Top malware domains',  dailyKey: 'malware',  domainKey: 'malwareBlocked',  tooltip: 'malware'  },
};
function renderChart() {
  const svg = document.getElementById('chartSvg');
  const labelsEl = document.getElementById('chartLabels');
  const tooltip = document.getElementById('chartTooltip');
  if (!svg || !labelsEl) return;

  chrome.storage.local.get(['dailyStats', 'stats'], ({ dailyStats = {}, stats = {} }) => {
    // If dailyStats has no data for today, seed today's entry from aggregate stats
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (!dailyStats[todayKey] || dailyStats[todayKey].blocked === 0) {
      let totalBlocked = 0;
      for (const s of Object.values(stats)) totalBlocked += s.blocked ?? 0;
      if (totalBlocked > 0 && Object.keys(dailyStats).length === 0) {
        // No daily history at all — put all existing stats under today as baseline
        dailyStats[todayKey] = { blocked: totalBlocked, ads: 0, trackers: 0, malware: 0 };
      }
    }

    const days = [];
    for (let i = activeRange - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const label = d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
      const _mcfg = METRIC_CONFIG[activeMetric];
      days.push({ label, value: (dailyStats[key] && dailyStats[key][_mcfg.dailyKey]) || 0 });
    }

    const max = Math.max(...days.map(d => d.value), 1);
    const w = 500;
    const h = 130;
    const pad = 16;
    const chartW = w - pad * 2;
    const chartH = h - pad * 2;
    const n = days.length;

    // Compute points
    const points = days.map((d, i) => ({
      x: pad + (n > 1 ? (i / (n - 1)) * chartW : chartW / 2),
      y: pad + chartH - (d.value / max) * chartH,
      value: d.value,
      label: d.label,
    }));

    // Smooth cubic bezier path
    function smoothPath(pts) {
      if (pts.length < 2) return `M${pts[0].x},${pts[0].y}`;
      let path = `M${pts[0].x},${pts[0].y}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const cp = (pts[i + 1].x - pts[i].x) * 0.35;
        path += ` C${pts[i].x + cp},${pts[i].y} ${pts[i + 1].x - cp},${pts[i + 1].y} ${pts[i + 1].x},${pts[i + 1].y}`;
      }
      return path;
    }

    const linePath = smoothPath(points);
    const areaPath = linePath + ` L${points[n - 1].x},${h} L${points[0].x},${h} Z`;

    // Update chart title
    const _chartTitleEl = document.getElementById('chartTitle');
    if (_chartTitleEl) _chartTitleEl.textContent = METRIC_CONFIG[activeMetric].chartTitle;

    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const _NS = 'http://www.w3.org/2000/svg';
    const _mkEl = (tag, attrs) => { const el = document.createElementNS(_NS, tag); Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k, v)); return el; };
    const defs1 = document.createElementNS(_NS, 'defs');
    const areaGrad = _mkEl('linearGradient', {id:'areaGrad',x1:'0',y1:'0',x2:'0',y2:'1'});
    areaGrad.append(_mkEl('stop',{'offset':'0%','stop-color':'rgba(129,140,248,.35)'}), _mkEl('stop',{'offset':'100%','stop-color':'rgba(6,182,212,.02)'}));
    defs1.append(areaGrad);
    const pathArea = _mkEl('path', {d: areaPath, fill:'url(#areaGrad)'});
    const pathLine = _mkEl('path', {d: linePath, fill:'none', stroke:'url(#lineGrad)', 'stroke-width':'2.5', 'stroke-linecap':'round', 'stroke-linejoin':'round'});
    const defs2 = document.createElementNS(_NS, 'defs');
    const lineGrad = _mkEl('linearGradient', {id:'lineGrad',x1:'0',y1:'0',x2:'1',y2:'0'});
    lineGrad.append(_mkEl('stop',{'offset':'0%','stop-color':'#818cf8'}), _mkEl('stop',{'offset':'100%','stop-color':'#06b6d4'}));
    defs2.append(lineGrad);
    svg.append(defs1, pathArea, pathLine, defs2);
    points.forEach((p, i) => {
      const c = _mkEl('circle', {cx:p.x, cy:p.y, r:'3.5', fill:'#818cf8', stroke:'#0d0e14', 'stroke-width':'2', opacity:'.7'});
      c.classList.add('chart-dot');
      c.dataset.i = i;
      svg.append(c);
    });

    // Labels — show subset to avoid crowding
    labelsEl.innerHTML = '';
    const step = n <= 7 ? 1 : n <= 14 ? 2 : Math.ceil(n / 7);
    for (let i = 0; i < n; i++) {
      const span = document.createElement('span');
      span.className = 'chart-label';
      span.textContent = i % step === 0 || i === n - 1 ? days[i].label : '';
      labelsEl.appendChild(span);
    }

    // Tooltip on hover
    svg.addEventListener('mouseover', e => {
      const dot = e.target.closest('.chart-dot');
      if (!dot) { tooltip.style.display = 'none'; return; }
      const idx = +dot.dataset.i;
      const p = points[idx];
      const rect = svg.getBoundingClientRect();
      const xPct = (p.x / w) * 100;
      const yPx = (p.y / h) * rect.height;
      tooltip.textContent = `${p.label}: ${p.value} ${METRIC_CONFIG[activeMetric].tooltip}`;
      tooltip.style.display = 'block';
      tooltip.style.left = `${xPct}%`;
      tooltip.style.top = `${yPx}px`;
    });
    svg.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  });
}

// KPI card click — switch active metric
document.querySelectorAll('.kpi-card[data-metric]').forEach(card => {
  card.addEventListener('click', () => {
    activeMetric = card.dataset.metric;
    document.querySelectorAll('.kpi-card[data-metric]').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    renderChart();
    chrome.storage.local.get('stats', ({ stats = {} }) => renderDomainList(stats));
  });
});

document.getElementById('chartRange')?.addEventListener('click', e => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  document.querySelectorAll('#chartRange .chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  activeRange = parseInt(btn.dataset.range, 10);
  renderChart();
});

/* ── Domain list ──────────────────────────────── */
let domainListExpanded = false;

function renderDomainList(stats) {
  const list = document.getElementById('domainList');
  if (!list) return;

  const _dcfg = METRIC_CONFIG[activeMetric];
  const _domTitleEl = document.getElementById('domainListTitle');
  if (_domTitleEl) _domTitleEl.textContent = _dcfg.domainTitle;
  const allEntries = Object.entries(stats)
    .map(([domain, s]) => ({ domain, blocked: (s[_dcfg.domainKey] ?? 0) }))
    .sort((a, b) => b.blocked - a.blocked);

  const entries = domainListExpanded ? allEntries : allEntries.slice(0, 7);

  const btn = document.getElementById('seeAllDomains');
  if (btn) {
    btn.textContent = domainListExpanded ? 'Show less' : `See all (${allEntries.length})`;
    btn.style.display = allEntries.length <= 7 ? 'none' : '';
  }

  if (!entries.length) {
    list.innerHTML = '<li style="color:var(--text-4);font-size:12px;padding:8px 0">No data yet.</li>';
    return;
  }

  const maxVal = allEntries[0].blocked || 1;
  list.innerHTML = '';
  entries.forEach(({ domain, blocked }, i) => {
    const pct = (blocked / maxVal) * 100;
    const li = document.createElement('li');
    li.className = 'domain-item';
    const _rank = document.createElement('span'); _rank.className = 'domain-rank'; _rank.textContent = i + 1;
    const _name = document.createElement('span'); _name.className = 'domain-name'; _name.textContent = domain;
    const _barMini = document.createElement('div'); _barMini.className = 'domain-bar-mini';
    const _barFill = document.createElement('div'); _barFill.className = 'domain-bar-fill'; _barFill.style.width = `${pct}%`;
    _barMini.appendChild(_barFill);
    const _cnt = document.createElement('span'); _cnt.className = 'domain-count'; _cnt.textContent = blocked;
    li.append(_rank, _name, _barMini, _cnt);
    list.appendChild(li);
  });
}

document.getElementById('seeAllDomains')?.addEventListener('click', () => {
  domainListExpanded = !domainListExpanded;
  chrome.storage.local.get('stats', ({ stats = {} }) => renderDomainList(stats));
});

/* ── Custom Rules page (plain-text editor) ───── */
const CUSTOM_RULES_DEFAULT = `# Custom rules — same format as site-rules.txt
# Values are MERGED with the built-in rules (not replaced).
#
# ── Map a new domain to a rule section ──────────────────────────────────
# [host_patterns]
# example.com = example          ← subdomains matched automatically
#
# ── Add extra domains to block globally ─────────────────────────────────
# [global]
# ad_network_patterns = new-ad-network.com
# tracker_network_patterns = new-tracker.com
# direct_hide_selectors = .new-ad-class
# no_window_open_if = /new-ad\.com/ 0 blank
#
# ── Per-site cosmetic rules ──────────────────────────────────────────────
# [example]
# direct_hide_selectors = .ad-unit | #sidebar-ad
# no_window_open_if = /.*/ 0 blank
# labels = sponsored | promoted
# json_prune_fetch = adData adSlots
`;

function loadCustomRules() {
  chrome.storage.local.get('customRulesText', ({ customRulesText }) => {
    const el = document.getElementById('customRulesEditor');
    if (el) el.value = customRulesText != null ? customRulesText : CUSTOM_RULES_DEFAULT;
  });
}

document.getElementById('saveCustomRules')?.addEventListener('click', () => {
  const text = document.getElementById('customRulesEditor')?.value || '';
  chrome.storage.local.set({ customRulesText: text }, () => {
    chrome.runtime.sendMessage({ type: 'RULES_CHANGED' });
  });
});

document.getElementById('resetCustomRules')?.addEventListener('click', () => {
  if (!confirm('Clear all custom rules?')) return;
  const el = document.getElementById('customRulesEditor');
  if (el) el.value = CUSTOM_RULES_DEFAULT;
  chrome.storage.local.set({ customRulesText: '' }, () => {
    chrome.runtime.sendMessage({ type: 'RULES_CHANGED' });
  });
});

/* ── Allowlist page ───────────────────────────── */
let allowedDomains = [];

function loadAllowList() {
  chrome.storage.local.get('allowedDomains', ({ allowedDomains: stored }) => {
    allowedDomains = stored || [];
    renderAllowList();
  });
}

function renderAllowList() {
  const list = document.getElementById('allowList');
  if (!list) return;
  list.innerHTML = '';
  allowedDomains.forEach(domain => {
    const li = document.createElement('li');
    li.className = 'allow-item';
    const _ds = document.createElement('span'); _ds.className = 'allow-domain'; _ds.textContent = domain;
    const _rb = document.createElement('button'); _rb.className = 'icon-btn-sm remove-allow'; _rb.dataset.domain = domain; _rb.textContent = '✕';
    li.append(_ds, _rb);
    list.appendChild(li);
  });
}

document.getElementById('addAllowBtn')?.addEventListener('click', () => {
  document.getElementById('allowForm')?.classList.toggle('hidden');
});

// The DNR allowAllRequests rule this list feeds (buildActiveRulesFromStorage(),
// background.js) matches on `requestDomains: [domain]` — a bare hostname,
// not a URL. Pasting a full URL here ("https://example.com/path?x=1")
// used to save literally that whole string, which never matches any real
// request's domain — the entry looked saved but silently did nothing.
// new URL(...) needs a scheme to parse at all; a bare "example.com" throws
// on the first attempt, so retry with "https://" prepended before falling
// back to a plain strip for anything neither form can parse.
function _extractHostname(input) {
  const val = (input || '').trim();
  if (!val) return '';
  try { return new URL(val).hostname.toLowerCase(); } catch { /* no scheme — try again below */ }
  try { return new URL('https://' + val).hostname.toLowerCase(); } catch { /* fall through */ }
  return val.toLowerCase().split(/[/?#]/)[0].split(':')[0];
}

document.getElementById('saveAllow')?.addEventListener('click', () => {
  const val = _extractHostname(document.getElementById('allowInput')?.value);
  if (!val || allowedDomains.includes(val)) return;
  allowedDomains.push(val);
  renderAllowList();
  chrome.storage.local.set({ allowedDomains });
  chrome.runtime.sendMessage({ type: 'ALLOWLIST_CHANGED' });
  if (document.getElementById('allowInput')) document.getElementById('allowInput').value = '';
});

document.getElementById('allowList')?.addEventListener('click', e => {
  const btn = e.target.closest('.remove-allow');
  if (!btn) return;
  allowedDomains = allowedDomains.filter(d => d !== btn.dataset.domain);
  renderAllowList();
  chrome.storage.local.set({ allowedDomains });
  chrome.runtime.sendMessage({ type: 'ALLOWLIST_CHANGED' });
});

/* ── Element rules page ("hide element" picker) ──── */
function loadElementRulesList() {
  chrome.storage.local.get('elementRules', ({ elementRules = {} }) => {
    renderElementRulesList(elementRules);
  });
}

function renderElementRulesList(elementRules) {
  const list = document.getElementById('elementRulesList');
  const empty = document.getElementById('elementRulesEmpty');
  if (!list) return;
  list.innerHTML = '';
  const hosts = Object.keys(elementRules || {});
  if (empty) empty.style.display = hosts.length ? 'none' : '';
  hosts.forEach(host => {
    const selectors = elementRules[host] || [];
    const li = document.createElement('li');
    li.className = 'allow-item';
    li.style.flexDirection = 'column';
    li.style.alignItems = 'stretch';
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    const label = document.createElement('span');
    label.className = 'allow-domain';
    label.textContent = `${host} (${selectors.length})`;
    const removeHostBtn = document.createElement('button');
    removeHostBtn.className = 'icon-btn-sm remove-element-host';
    removeHostBtn.dataset.host = host;
    removeHostBtn.textContent = '✕';
    header.append(label, removeHostBtn);
    li.appendChild(header);
    selectors.forEach(sel => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:2px 0;';
      const code = document.createElement('code');
      code.textContent = sel;
      code.style.cssText = 'font-size:12px;word-break:break-all;';
      const rm = document.createElement('button');
      rm.className = 'icon-btn-sm remove-element-selector';
      rm.dataset.host = host;
      rm.dataset.selector = sel;
      rm.textContent = '✕';
      row.append(code, rm);
      li.appendChild(row);
    });
    list.appendChild(li);
  });
}

document.getElementById('elementRulesList')?.addEventListener('click', e => {
  const hostBtn = e.target.closest('.remove-element-host');
  const selBtn = e.target.closest('.remove-element-selector');
  const btn = hostBtn || selBtn;
  if (!btn) return;
  const payload = { type: 'REMOVE_ELEMENT_RULE', host: btn.dataset.host };
  if (selBtn) payload.selector = btn.dataset.selector;
  chrome.runtime.sendMessage(payload, () => { void chrome.runtime.lastError; loadElementRulesList(); });
});

/* ── Global rules page ("scan page for scripts/variables" picker) ──── */
// Block installs a permanent configurable:false read-trap (see
// background.js's _buildGlobalRulesBlock comment) — visually distinct
// (red) from Edit/Delete since it's the highest-risk, hardest-to-undo
// action: this remove button is the ONLY way to revert it short of the
// page never running the affected code path again.
const GLOBAL_RULE_ACTION_COLORS = { block: '#f87171', edit: '#60a5fa', delete: '#fbbf24' };

function loadGlobalRulesList() {
  chrome.storage.local.get('globalScopeRules', ({ globalScopeRules = {} }) => {
    renderGlobalRulesList(globalScopeRules);
  });
}

function renderGlobalRulesList(globalScopeRules) {
  const list = document.getElementById('globalRulesList');
  const empty = document.getElementById('globalRulesEmpty');
  if (!list) return;
  list.innerHTML = '';
  const hosts = Object.keys(globalScopeRules || {});
  if (empty) empty.style.display = hosts.length ? 'none' : '';
  hosts.forEach(host => {
    const rules = globalScopeRules[host] || [];
    const li = document.createElement('li');
    li.className = 'allow-item';
    li.style.flexDirection = 'column';
    li.style.alignItems = 'stretch';
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    const label = document.createElement('span');
    label.className = 'allow-domain';
    label.textContent = `${host} (${rules.length})`;
    const removeHostBtn = document.createElement('button');
    removeHostBtn.className = 'icon-btn-sm remove-global-host';
    removeHostBtn.dataset.host = host;
    removeHostBtn.textContent = '✕';
    header.append(label, removeHostBtn);
    li.appendChild(header);
    rules.forEach(rule => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:2px 0;';
      const left = document.createElement('div');
      left.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0;';
      const badge = document.createElement('span');
      badge.textContent = rule.action;
      badge.style.cssText = `font-size:10px;font-weight:600;color:#0f172a;background:${GLOBAL_RULE_ACTION_COLORS[rule.action] || '#94a3b8'};border-radius:4px;padding:1px 6px;flex-shrink:0;`;
      const code = document.createElement('code');
      code.textContent = rule.action === 'edit' ? `${rule.chain} = ${rule.value}` : rule.chain;
      code.style.cssText = 'font-size:12px;word-break:break-all;';
      left.append(badge, code);
      const rm = document.createElement('button');
      rm.className = 'icon-btn-sm remove-global-rule';
      rm.dataset.host = host;
      rm.dataset.chain = rule.chain;
      rm.textContent = '✕';
      row.append(left, rm);
      li.appendChild(row);
    });
    list.appendChild(li);
  });
}

document.getElementById('globalRulesList')?.addEventListener('click', e => {
  const hostBtn = e.target.closest('.remove-global-host');
  const ruleBtn = e.target.closest('.remove-global-rule');
  const btn = hostBtn || ruleBtn;
  if (!btn) return;
  const payload = { type: 'REMOVE_GLOBAL_RULE', host: btn.dataset.host };
  if (ruleBtn) payload.chain = btn.dataset.chain;
  chrome.runtime.sendMessage(payload, () => { void chrome.runtime.lastError; loadGlobalRulesList(); });
});

/* ── Focus mode page ──────────────────────────── */
let focusInterval = null;
let focusRemaining = 25 * 60; // seconds
let focusDuration  = 25 * 60;
let distractionDomains = [];

const DISTRACTION_DEFAULTS_DASH = ['twitter.com', 'youtube.com', 'reddit.com', 'instagram.com', 'tiktok.com'];

const focusTimerEl = document.querySelector('.focus-timer');
const focusSubEl   = document.querySelector('.focus-sub');

function updateTimerDisplay() {
  const m = Math.floor(focusRemaining / 60).toString().padStart(2, '0');
  const s = (focusRemaining % 60).toString().padStart(2, '0');
  if (focusTimerEl) focusTimerEl.textContent = `${m}:${s}`;
}

function renderDistractionList() {
  const ul = document.getElementById('distractionList');
  if (!ul) return;
  ul.replaceChildren(...distractionDomains.map(d => {
    const _li = document.createElement('li'); _li.className = 'allow-item';
    const _sp = document.createElement('span'); _sp.className = 'allow-domain'; _sp.textContent = d;
    const _btn = document.createElement('button'); _btn.className = 'icon-btn-sm remove-distraction'; _btn.dataset.domain = d; _btn.textContent = '✕';
    _li.append(_sp, _btn);
    return _li;
  }));
}

function saveDistractionDomains() {
  chrome.storage.local.set({ distractionDomains });
}

function disableFocusMode() {
  clearInterval(focusInterval);
  focusInterval = null;
  focusRemaining = focusDuration;
  updateTimerDisplay();
  if (focusSubEl) focusSubEl.textContent = 'Session paused';
  const toggle = document.getElementById('focusToggle');
  if (toggle) toggle.checked = false;
  chrome.storage.local.set({ focusMode: false, focusEndTime: null });
  chrome.runtime.sendMessage({ type: 'FOCUS_MODE', enabled: false });
}

function startFocusTimer(remaining) {
  clearInterval(focusInterval);
  focusRemaining = remaining;
  updateTimerDisplay();
  if (focusSubEl) focusSubEl.textContent = 'Session running…';
  focusInterval = setInterval(() => {
    focusRemaining--;
    updateTimerDisplay();
    if (focusRemaining <= 0) {
      if (focusSubEl) focusSubEl.textContent = 'Session complete!';
      disableFocusMode();
    }
  }, 1000);
}

// Restore focus state on load
chrome.storage.local.get(['focusMode', 'focusDuration', 'distractionDomains', 'focusEndTime'], result => {
  // Restore distraction list
  distractionDomains = result.distractionDomains ?? DISTRACTION_DEFAULTS_DASH;
  renderDistractionList();

  // Restore duration
  const savedMin = result.focusDuration ?? 25;
  focusDuration = savedMin * 60;
  focusRemaining = focusDuration;
  updateTimerDisplay();
  const presets = [25, 45, 60, 90];
  const isPreset = presets.includes(savedMin);
  document.querySelectorAll('.dur-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.min, 10) === savedMin);
  });
  const cInput = document.getElementById('customMin');
  if (!isPreset && cInput) {
    cInput.value = savedMin;
    cInput.classList.add('active');
  }

  // Restore running timer from saved end time
  const toggle = document.getElementById('focusToggle');
  if (toggle && result.focusMode && result.focusEndTime) {
    const remaining = Math.round((result.focusEndTime - Date.now()) / 1000);
    if (remaining > 0) {
      toggle.checked = true;
      startFocusTimer(remaining);
    } else {
      // Timer already expired while page was closed
      if (focusSubEl) focusSubEl.textContent = 'Session complete!';
      disableFocusMode();
    }
  }
});

document.getElementById('focusToggle')?.addEventListener('change', e => {
  if (e.target.checked) {
    const endTime = Date.now() + focusDuration * 1000;
    chrome.storage.local.set({ focusMode: true, focusEndTime: endTime });
    chrome.runtime.sendMessage({ type: 'FOCUS_MODE', enabled: true });
    startFocusTimer(focusDuration);
  } else {
    disableFocusMode();
  }
});

const customMinInput = document.getElementById('customMin');

function setDuration(min) {
  focusDuration = min * 60;
  focusRemaining = focusDuration;
  updateTimerDisplay();
  chrome.storage.local.set({ focusDuration: min });
  if (focusInterval) {
    const endTime = Date.now() + focusDuration * 1000;
    chrome.storage.local.set({ focusEndTime: endTime });
    startFocusTimer(focusDuration);
  }
}

function clearDurActive() {
  document.querySelectorAll('.dur-btn').forEach(b => b.classList.remove('active'));
  if (customMinInput) customMinInput.classList.remove('active');
}

document.querySelectorAll('.dur-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    clearDurActive();
    btn.classList.add('active');
    if (customMinInput) customMinInput.value = '';
    setDuration(parseInt(btn.dataset.min, 10));
  });
});

customMinInput?.addEventListener('change', () => {
  const val = parseInt(customMinInput.value, 10);
  if (!val || val < 1) return;
  const min = Math.min(val, 480);
  customMinInput.value = min;
  clearDurActive();
  customMinInput.classList.add('active');
  setDuration(min);
});

customMinInput?.addEventListener('focus', () => {
  clearDurActive();
  customMinInput.classList.add('active');
});

document.getElementById('addDistraction')?.addEventListener('click', () => {
  const d = prompt('Enter domain to block during focus (e.g. twitter.com):');
  if (!d) return;
  const domain = d.trim().toLowerCase();
  if (!domain || distractionDomains.includes(domain)) return;
  distractionDomains.push(domain);
  renderDistractionList();
  saveDistractionDomains();
  // Re-apply focus rules if focus is currently active
  chrome.storage.local.get('focusMode', ({ focusMode }) => {
    if (focusMode) chrome.runtime.sendMessage({ type: 'FOCUS_MODE', enabled: true });
  });
});

document.getElementById('distractionList')?.addEventListener('click', e => {
  const btn = e.target.closest('.remove-distraction');
  if (!btn) return;
  const domain = btn.dataset.domain;
  distractionDomains = distractionDomains.filter(d => d !== domain);
  renderDistractionList();
  saveDistractionDomains();
  // Re-apply focus rules if focus is currently active
  chrome.storage.local.get('focusMode', ({ focusMode }) => {
    if (focusMode) chrome.runtime.sendMessage({ type: 'FOCUS_MODE', enabled: true });
  });
});

/* ── Settings page ────────────────────────────── */
// Blocking toggles
const blockingToggles = [
  { id: 'blockAdsToggle',      key: 'blockAds' },
  { id: 'blockTrackersToggle', key: 'blockTrackers' },
  { id: 'cosmeticToggle',      key: 'cosmeticFiltering' },
  { id: 'blockMalwareToggle',  key: 'blockMalware' },
];

function loadBlockingSettings() {
  const keys = blockingToggles.map(t => t.key);
  chrome.storage.local.get(keys, (data) => {
    for (const { id, key } of blockingToggles) {
      const el = document.getElementById(id);
      if (el) el.checked = data[key] ?? true; // default ON
    }
  });
}

for (const { id, key } of blockingToggles) {
  document.getElementById(id)?.addEventListener('change', (e) => {
    chrome.storage.local.set({ [key]: e.target.checked });
    chrome.runtime.sendMessage({ type: 'SET_BLOCKING', setting: key, value: e.target.checked });
  });
}

// Privacy toggles
const privacyToggles = [
  { id: 'referrerToggle', key: 'referrerAnonymization' },
  { id: 'gpcToggle',      key: 'gpcSignal' },
  { id: 'dntToggle',      key: 'dntHeader' },
];

function loadPrivacySettings() {
  chrome.storage.local.get(
    privacyToggles.map(t => t.key),
    (data) => {
      for (const { id, key } of privacyToggles) {
        const el = document.getElementById(id);
        // All three default to true when unset.
        if (el) el.checked = data[key] ?? true;
      }
    }
  );
}

for (const { id, key } of privacyToggles) {
  document.getElementById(id)?.addEventListener('change', (e) => {
    chrome.runtime.sendMessage({ type: 'SET_PRIVACY', setting: key, value: e.target.checked });
  });
}

// Stats collection toggle
const statsToggle = document.getElementById('statsToggle');
chrome.storage.local.get('collectStats', ({ collectStats = true }) => {
  if (statsToggle) statsToggle.checked = collectStats;
});
statsToggle?.addEventListener('change', (e) => {
  chrome.storage.local.set({ collectStats: e.target.checked });
});

document.getElementById('resetBtn')?.addEventListener('click', () => {
  if (!confirm('Reset all AdBlock data? This cannot be undone.')) return;
  chrome.storage.local.clear(async () => {
    // chrome.storage.local.clear() only touches extension storage — it
    // can't reach the scriptlet rules cache, which content/scriptlets.js
    // keeps in each site's OWN localStorage. Broadcast to every open tab so
    // each can drop its copy; tabs not currently open self-correct next
    // visit once fresh rules land.
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_SCRIPTLET_CACHE' }).catch(() => {});
      }
    } catch (e) { /* best-effort */ }
    alert('All data cleared. Reloading…');
    location.reload();
  });
});

/* ── About / version + update check ─────────────────────────────── */
// Shared with popup.js via config.js's ADBLOCK_CONFIG.STORE_URLS (single
// source — see that file's own comment for why two independently-hand-
// maintained copies of this map used to drift out of sync with each other).
function _detectUpdateStoreUrl() {
  const urls = self.ADBLOCK_CONFIG.STORE_URLS;
  const ua = navigator.userAgent;
  if (ua.includes('Firefox/')) return urls.firefox;
  if (ua.includes('Edg/'))     return urls.edge;
  return urls.chrome;
}
function _renderUpdateStatus(res) {
  const versionDesc = document.getElementById('aboutVersionDesc');
  const updateRow = document.getElementById('aboutUpdateRow');
  const updateDesc = document.getElementById('aboutUpdateDesc');
  if (!versionDesc) return;
  const current = res?.currentVersion || chrome.runtime.getManifest().version;
  if (!res || chrome.runtime.lastError) {
    versionDesc.textContent = `v${current}`;
    return;
  }
  const checkedText = res.lastChecked
    ? `Last checked ${new Date(res.lastChecked).toLocaleString()}${res.lastCheckOk === false ? ' (failed — offline?)' : ''}`
    : 'Never checked yet';
  versionDesc.textContent = `v${current} · ${checkedText}`;
  if (updateRow) updateRow.style.display = res.available ? '' : 'none';
  if (res.available && updateDesc) {
    updateDesc.textContent = `v${res.latestVersion} is available (you have v${current})`;
  }
}
function loadUpdateStatus() {
  chrome.runtime.sendMessage({ type: 'GET_UPDATE_STATUS' }, _renderUpdateStatus);
}
document.getElementById('checkUpdateBtn')?.addEventListener('click', (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Checking…';
  chrome.runtime.sendMessage({ type: 'CHECK_FOR_UPDATE_NOW' }, (res) => {
    _renderUpdateStatus(res);
    btn.disabled = false;
    btn.textContent = original;
  });
});
document.getElementById('aboutUpdateLink')?.addEventListener('click', () => {
  chrome.tabs.create({ url: _detectUpdateStoreUrl() });
});
loadUpdateStatus();

document.getElementById('seedYesterdayBtn')?.addEventListener('click', () => {
  const yd = new Date(); yd.setDate(yd.getDate() - 1);
  const key = `${yd.getFullYear()}-${String(yd.getMonth() + 1).padStart(2, '0')}-${String(yd.getDate()).padStart(2, '0')}`;
  chrome.storage.local.get('dailyStats', ({ dailyStats = {} }) => {
    dailyStats[key] = {
      blocked:  Math.floor(Math.random() * 300) + 100,
      ads:      Math.floor(Math.random() * 200) + 50,
      trackers: Math.floor(Math.random() * 100) + 20,
      malware:  Math.floor(Math.random() * 10),
    };
    chrome.storage.local.set({ dailyStats }, () => {
      alert(`Seeded fake data for ${key}:\n` + JSON.stringify(dailyStats[key], null, 2));
      loadOverviewStats();
    });
  });
});

/* ── Helpers ──────────────────────────────────── */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Rule Source constants — from shared config.js (loaded by dashboard.html) ── */
const RULES_CACHE_KEY_TEXT = self.ADBLOCK_CONFIG.RULES_CACHE_TEXT_KEY;
const RULES_CACHE_KEY_TIME = self.ADBLOCK_CONFIG.RULES_CACHE_TIME_KEY;
const RULE_SOURCE_ERRORS_KEY = self.ADBLOCK_CONFIG.RULE_SOURCE_ERRORS_KEY;
const RULE_SOURCE_STATS_KEY = self.ADBLOCK_CONFIG.RULE_SOURCE_STATS_KEY;

/* ── Init ─────────────────────────────────────── */
loadOverviewStats();
loadCustomRules();
loadAllowList();
loadElementRulesList();
loadGlobalRulesList();
loadBlockingSettings();
loadPrivacySettings();
loadRulesSourceSettings();

/* ── Donate ────────────────────────────────────── */
// Replace the URL with your actual PayPal.me or donate link
const PAYPAL_DONATE_URL = 'https://www.paypal.me/linhhvtt/5';
document.getElementById('donateBtnSidebar')?.addEventListener('click', () => {
  chrome.tabs.create({ url: PAYPAL_DONATE_URL });
});
updateTimerDisplay();

/* ── Live sync from popup / other pages ────────── */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  // Focus mode toggled from popup
  if (changes.focusMode) {
    const on = changes.focusMode.newValue;
    const toggle = document.getElementById('focusToggle');
    if (on) {
      if (toggle) toggle.checked = true;
      // Read endTime to resume timer
      chrome.storage.local.get('focusEndTime', ({ focusEndTime }) => {
        if (focusEndTime) {
          const remaining = Math.round((focusEndTime - Date.now()) / 1000);
          if (remaining > 0) {
            startFocusTimer(remaining);
          } else {
            disableFocusMode();
          }
        } else {
          // No endTime (legacy) — start full duration
          startFocusTimer(focusDuration);
        }
      });
    } else {
      clearInterval(focusInterval);
      focusInterval = null;
      focusRemaining = focusDuration;
      updateTimerDisplay();
      if (focusSubEl) focusSubEl.textContent = 'Session paused';
      if (toggle) toggle.checked = false;
    }
  }

  // Blocking / privacy settings changed from another page
  if (changes.blockAds || changes.blockTrackers || changes.cosmeticFiltering || changes.blockMalware) {
    loadBlockingSettings();
  }
  if (changes.referrerAnonymization || changes.gpcSignal || changes.dntHeader) {
    loadPrivacySettings();
  }

  // Stats updated
  if (changes.stats) {
    loadOverviewStats();
  }
});

/* ── Rule Source settings (multi-source) ─────── */
function makeSourceId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// A row's checkbox toggles `enabled` without removing the source — separate
// from the Remove button (permanent). Each built-in default (config.js's
// RULES_REMOTE_URL array) is rendered as its own row ahead of the
// user-added ones, toggleable via a per-URL entry in
// `defaultRuleSourceOverrides` since these aren't part of the `ruleSources`
// array and have no Remove button (they're not user-added).
function _sanitizeExportFileName(name) {
  return String(name || 'rule-source').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'rule-source';
}

// Re-fetches `url` and runs it through the SAME ABP-conversion background.js
// uses for the real merged rules, then downloads the result — lets the user
// inspect exactly what a source produced in this repo's own grammar (e.g.
// checking the "abp_"-prefixed [host_patterns] keys it minted) without
// digging through DevTools. Always fresh (no cache): background.js only
// ever keeps the full multi-source MERGED blob, never a per-URL one.
function _exportConvertedRuleSource(url, btn, label) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Exporting…';
  chrome.runtime.sendMessage({ type: 'EXPORT_CONVERTED_RULE_SOURCE', url }, (res) => {
    btn.disabled = false;
    btn.textContent = original;
    if (chrome.runtime.lastError || !res || !res.ok) {
      alert('Export failed: ' + ((res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'unknown error'));
      return;
    }
    const blob = new Blob([res.text], { type: 'text/plain' });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = _sanitizeExportFileName(label) + '.converted.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  });
}

function _makeSourceRow({ label, title, checked, onToggle, onRemove, error, stats, url }) {
  const row = document.createElement('div');
  row.className = 'rules-source-item';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = checked;
  toggle.className = 'source-toggle';
  toggle.addEventListener('change', () => onToggle(toggle.checked));
  const labelSpan = document.createElement('span');
  labelSpan.className = 'source-label';
  labelSpan.title = title || label;
  labelSpan.textContent = label;
  row.appendChild(toggle);
  row.appendChild(labelSpan);
  // Skip-stats, if any (RULE_SOURCE_STATS_KEY — only ever set for an
  // ABP-format source; a native one never gets an entry, so this is silent
  // for those). Answers "did this source's rules actually load, or did
  // some silently get skipped/parse-fail" — previously only visible by
  // manually diffing the source's raw text against the converted output.
  if (stats && stats.total) {
    const skipped = stats.total - stats.converted;
    const statSpan = document.createElement('span');
    statSpan.className = 'source-stats' + (skipped ? ' has-skips' : '');
    statSpan.title = `${stats.converted} converted, ${skipped} skipped of ${stats.total} rules` +
      (stats.exception ? `\n${stats.exception} exception rules (no cancellation model here)` : '') +
      (stats.procedural ? `\n${stats.procedural} procedural selectors (:has-text, :xpath, ...)` : '') +
      (stats.adguardExtended ? `\n${stats.adguardExtended} AdGuard-extended modifiers` : '') +
      (stats.unmappedScriptlet ? `\n${stats.unmappedScriptlet} unmapped scriptlet calls` : '') +
      (stats.complexNetwork ? `\n${stats.complexNetwork} unsupported network-rule modifiers` : '') +
      (stats.dedupSkipped ? `\n${stats.dedupSkipped} already curated by this repo's own site-rules.txt` : '') +
      (stats.unrecognized ? `\n${stats.unrecognized} unrecognized syntax` : '');
    statSpan.textContent = skipped ? `${stats.converted}/${stats.total} loaded` : `${stats.total} loaded`;
    row.appendChild(statSpan);
    // Only ever meaningful alongside the stats badge above — RULE_SOURCE_STATS_KEY
    // is set only for a source that WAS detected as ABP-format and actually
    // converted, so this is the same "has something to export" signal.
    if (url) {
      const exportBtn = document.createElement('button');
      exportBtn.className = 'btn-ghost btn-sm';
      exportBtn.textContent = 'Export';
      exportBtn.title = 'Download this source\'s rules converted to this repo\'s own grammar';
      exportBtn.addEventListener('click', () => _exportConvertedRuleSource(url, exportBtn, label));
      row.appendChild(exportBtn);
    }
  }
  // Fetch error, if any — always shown when present, no extra condition
  // (e.g. "only if the source is enabled"): an error here means the LAST
  // fetch attempt failed, which is worth knowing regardless of current state.
  if (error) {
    const errSpan = document.createElement('span');
    errSpan.className = 'source-error';
    errSpan.title = error;
    errSpan.textContent = '⚠ ' + error;
    row.appendChild(errSpan);
  }
  if (onRemove) {
    const btn = document.createElement('button');
    btn.className = 'btn-ghost btn-sm';
    btn.textContent = 'Remove';
    btn.addEventListener('click', onRemove);
    row.appendChild(btn);
  }
  return row;
}

// Built-in default sources (config.js RULES_REMOTE_URL) each carry a `group`
// field ('default' | 'easylist' | 'language') — grouping them here instead
// of one flat 44-row list, so enabling many language lists doesn't bury the
// user's own default/EasyList-family toggles in a wall of checkboxes.
const _RULE_SOURCE_GROUP_LABELS = { default: 'Default', easylist: 'EasyList family', language: 'By language', custom: 'Custom (your own URLs)' };
const _RULE_SOURCE_GROUP_ORDER = ['default', 'easylist', 'language'];
// Groups this large collapse behind a <details> (closed unless the user
// already has one of its entries enabled, so their own active choice is
// never hidden) — small groups (default, easylist) just get a plain label.
const _RULE_SOURCE_COLLAPSE_THRESHOLD = 6;

function _makeSourceGroupSection(groupKey, entries, anyEnabled) {
  const label = _RULE_SOURCE_GROUP_LABELS[groupKey] || groupKey;
  const rows = document.createElement('div');
  rows.className = 'rules-source-list rules-source-group-rows';
  for (const row of entries) rows.appendChild(row);

  if (entries.length >= _RULE_SOURCE_COLLAPSE_THRESHOLD) {
    const details = document.createElement('details');
    details.className = 'rules-source-group';
    details.open = anyEnabled;
    const summary = document.createElement('summary');
    summary.className = 'rules-source-group-summary';
    summary.textContent = `${label} (${entries.length})`;
    details.appendChild(summary);
    details.appendChild(rows);
    return details;
  }
  const wrap = document.createElement('div');
  wrap.className = 'rules-source-group';
  const header = document.createElement('div');
  header.className = 'rules-source-group-label';
  header.textContent = label;
  wrap.appendChild(header);
  wrap.appendChild(rows);
  return wrap;
}

function renderRulesSources(sources, defaultOverrides, sourceErrors, sourceStats) {
  const urlList  = document.getElementById('rulesUrlList');
  const fileList = document.getElementById('rulesFileList');
  if (!urlList || !fileList) return;
  const errors = sourceErrors || {};
  const stats = sourceStats || {};
  const overrides = defaultOverrides || {};

  const urlSources  = sources.filter(s => s.type === 'url');
  const fileSources = sources.filter(s => s.type === 'file');

  urlList.innerHTML = '';
  const byGroup = new Map(); // groupKey -> { rows: HTMLElement[], anyEnabled: bool }
  for (const entry of self.ADBLOCK_CONFIG.RULES_REMOTE_URL) {
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, entry.url);
    const checked = hasOverride ? overrides[entry.url] !== false : entry.enable !== false;
    const row = _makeSourceRow({
      label: `${entry.name}`,
      title: entry.url,
      checked,
      onToggle: (checked) => toggleDefaultRuleSource(entry.url, checked),
      error: errors[entry.url],
      stats: stats[entry.url],
      url: entry.url,
      // no onRemove — a built-in default can be turned off, not deleted.
    });
    const groupKey = entry.group || 'default';
    if (!byGroup.has(groupKey)) byGroup.set(groupKey, { rows: [], anyEnabled: false });
    const g = byGroup.get(groupKey);
    g.rows.push(row);
    if (checked) g.anyEnabled = true;
  }
  const orderedGroups = [
    ..._RULE_SOURCE_GROUP_ORDER.filter(g => byGroup.has(g)),
    ...[...byGroup.keys()].filter(g => !_RULE_SOURCE_GROUP_ORDER.includes(g)),
  ];
  for (const groupKey of orderedGroups) {
    const g = byGroup.get(groupKey);
    urlList.appendChild(_makeSourceGroupSection(groupKey, g.rows, g.anyEnabled));
  }

  if (urlSources.length) {
    const customRows = urlSources.map(src => _makeSourceRow({
      label: src.url,
      checked: src.enabled !== false,
      onToggle: (checked) => toggleRulesSource(src.id, checked),
      onRemove: () => removeRulesSource(src.id),
      error: errors[src.url],
      stats: stats[src.url],
      url: src.url,
    }));
    urlList.appendChild(_makeSourceGroupSection('custom', customRows, true));
  }

  fileList.innerHTML = '';
  for (const src of fileSources) {
    fileList.appendChild(_makeSourceRow({
      label: src.name,
      checked: src.enabled !== false,
      onToggle: (checked) => toggleRulesSource(src.id, checked),
      onRemove: () => removeRulesSource(src.id),
    }));
  }
}

function loadRulesSourceSettings() {
  chrome.storage.local.get(
    ['ruleSources', 'customRulesUrl', 'localRulesFileName', 'defaultRuleSourceEnabled', 'defaultRuleSourceOverrides', RULES_CACHE_KEY_TEXT, RULE_SOURCE_ERRORS_KEY, RULE_SOURCE_STATS_KEY],
    (data) => {
      let sources = data.ruleSources;
      if (!sources) {
        // Migrate from legacy single-source format
        sources = [];
        if (data.customRulesUrl) {
          sources.push({ id: makeSourceId(), type: 'url', url: data.customRulesUrl });
        }
        // typeof check: this legacy migration path predates the 2026-08-24
        // compressed-cache change, which stores {format,data} here instead
        // of a bare string — an install that never migrated off the old
        // single-source format AND upgrades past that change would
        // otherwise push the wrapper object in as if it were rule text.
        if (data.localRulesFileName && typeof data[RULES_CACHE_KEY_TEXT] === 'string' && data[RULES_CACHE_KEY_TEXT]) {
          sources.push({ id: makeSourceId(), type: 'file', name: data.localRulesFileName, text: data[RULES_CACHE_KEY_TEXT] });
        }
        if (sources.length) {
          chrome.storage.local.set({ ruleSources: sources });
          chrome.storage.local.remove(['customRulesUrl', 'localRulesFileName']);
        }
      }
      let overrides = data.defaultRuleSourceOverrides;
      // Migrate the legacy single "all built-in defaults" toggle into
      // per-URL overrides now that RULES_REMOTE_URL can hold more than one
      // built-in source — otherwise a pre-existing "default off" choice
      // would silently re-enable every default source on next load.
      if (data.defaultRuleSourceEnabled !== undefined) {
        if (data.defaultRuleSourceEnabled === false && !overrides) {
          overrides = {};
          for (const entry of self.ADBLOCK_CONFIG.RULES_REMOTE_URL) overrides[entry.url] = false;
          chrome.storage.local.set({ defaultRuleSourceOverrides: overrides });
        }
        chrome.storage.local.remove('defaultRuleSourceEnabled');
      }
      renderRulesSources(sources || [], overrides, data[RULE_SOURCE_ERRORS_KEY] || {}, data[RULE_SOURCE_STATS_KEY] || {});
    }
  );
}

function toggleDefaultRuleSource(url, enabled) {
  chrome.storage.local.get('defaultRuleSourceOverrides', ({ defaultRuleSourceOverrides = {} }) => {
    const updated = { ...defaultRuleSourceOverrides, [url]: enabled };
    chrome.storage.local.set(
      { defaultRuleSourceOverrides: updated, [RULES_CACHE_KEY_TEXT]: '', [RULES_CACHE_KEY_TIME]: 0 },
      () => chrome.runtime.sendMessage({ type: 'RULES_CHANGED' }).catch(() => {})
    );
  });
}

function toggleRulesSource(id, enabled) {
  chrome.storage.local.get('ruleSources', ({ ruleSources = [] }) => {
    const updated = ruleSources.map(s => s.id === id ? { ...s, enabled } : s);
    chrome.storage.local.set(
      { ruleSources: updated, [RULES_CACHE_KEY_TEXT]: '', [RULES_CACHE_KEY_TIME]: 0 },
      () => chrome.runtime.sendMessage({ type: 'RULES_CHANGED' }).catch(() => {})
    );
  });
}

function removeRulesSource(id) {
  chrome.storage.local.get('ruleSources', ({ ruleSources = [] }) => {
    const updated = ruleSources.filter(s => s.id !== id);
    chrome.storage.local.set(
      { ruleSources: updated, [RULES_CACHE_KEY_TEXT]: '', [RULES_CACHE_KEY_TIME]: 0 },
      () => {
        chrome.runtime.sendMessage({ type: 'RULES_CHANGED' }).catch(() => {});
        loadRulesSourceSettings();
      }
    );
  });
}

document.getElementById('addRulesUrl')?.addEventListener('click', () => {
  const input = document.getElementById('rulesUrlInput');
  const url = input?.value.trim();
  if (!url) return;
  chrome.storage.local.get('ruleSources', ({ ruleSources = [] }) => {
    if (ruleSources.some(s => s.type === 'url' && s.url === url)) return;
    const updated = [...ruleSources, { id: makeSourceId(), type: 'url', url }];
    chrome.storage.local.set(
      { ruleSources: updated, [RULES_CACHE_KEY_TEXT]: '', [RULES_CACHE_KEY_TIME]: 0 },
      () => {
        chrome.runtime.sendMessage({ type: 'RULES_CHANGED' }).catch(() => {});
        if (input) input.value = '';
        loadRulesSourceSettings();
      }
    );
  });
});

document.getElementById('rulesFileBtn')?.addEventListener('click', () => {
  document.getElementById('rulesFileInput')?.click();
});

document.getElementById('rulesFileInput')?.addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  chrome.storage.local.get('ruleSources', ({ ruleSources = [] }) => {
    let pending = files.length;
    const newSources = [];
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result;
        if (text) newSources.push({ id: makeSourceId(), type: 'file', name: file.name, text });
        if (--pending === 0) {
          const updated = [...ruleSources, ...newSources];
          chrome.storage.local.set(
            { ruleSources: updated, [RULES_CACHE_KEY_TEXT]: '', [RULES_CACHE_KEY_TIME]: 0 },
            () => {
              chrome.runtime.sendMessage({ type: 'RULES_CHANGED' }).catch(() => {});
              loadRulesSourceSettings();
            }
          );
        }
      };
      reader.onerror = () => {
        if (--pending === 0 && newSources.length) {
          const updated = [...ruleSources, ...newSources];
          chrome.storage.local.set(
            { ruleSources: updated, [RULES_CACHE_KEY_TEXT]: '', [RULES_CACHE_KEY_TIME]: 0 },
            () => {
              chrome.runtime.sendMessage({ type: 'RULES_CHANGED' }).catch(() => {});
              loadRulesSourceSettings();
            }
          );
        }
      };
      reader.readAsText(file);
    });
  });
  e.target.value = '';
});
