// dashboard.js — AdBlock Dashboard logic

/* ── Privacy score (mirrors background.js calculatePrivacyScore) ── */
function calculatePrivacyScore(domainStats = {}, settings = {}) {
  const total = domainStats.totalSeen || 0;
  const protectionActive = settings.enabled !== false && !settings.paused;

  let adsScore = protectionActive ? 50 : 0;
  if (total > 0) {
    const expected = Math.max(total * 0.15, 1);
    adsScore = protectionActive
      ? Math.min(100, Math.round(((domainStats.adsBlocked || 0) / expected) * 100))
      : 0;
  }

  let trackersScore = protectionActive ? 50 : 0;
  if (total > 0) {
    const expected = Math.max(total * 0.10, 1);
    trackersScore = protectionActive
      ? Math.min(100, Math.round(((domainStats.trackersBlocked || 0) / expected) * 100))
      : 0;
  }

  const referrerScore = settings.referrerAnonymization !== false ? 85 : 20;
  let malwareScore = protectionActive ? 70 : 0;
  if ((domainStats.malwareBlocked || 0) > 0) malwareScore = 100;

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
    aggregate.adsBlocked      += s.adsBlocked      || 0;
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
    ['stats', 'enabled', 'referrerAnonymization', 'dailyStats'],
    ({ stats = {}, enabled = true, referrerAnonymization = true, dailyStats = {} }) => {
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
      renderPrivacyScore(stats, { enabled, referrerAnonymization });
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
let activeRange = 7;

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
      days.push({ label, value: (dailyStats[key] && dailyStats[key].blocked) || 0 });
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
      tooltip.textContent = `${p.label}: ${p.value} blocked`;
      tooltip.style.display = 'block';
      tooltip.style.left = `${xPct}%`;
      tooltip.style.top = `${yPx}px`;
    });
    svg.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  });
}

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

  const allEntries = Object.entries(stats)
    .map(([domain, s]) => ({ domain, blocked: s.blocked ?? 0 }))
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

/* ── Rules page ───────────────────────────────── */
function renderRules(rules) {
  const tbody = document.getElementById('rulesBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!rules.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-4);padding:14px 10px">No custom rules yet.</td></tr>';
    return;
  }
  rules.forEach(rule => {
    const storedHits = Number(rule.hits || 0);
    const tr = document.createElement('tr');
    tr.dataset.id = rule.id;
    const _td1 = document.createElement('td');
    const _badge = document.createElement('span'); _badge.className = `rule-type-badge ${escHtml(rule.type)}`; _badge.textContent = rule.type;
    _td1.appendChild(_badge);
    const _td2 = document.createElement('td'); _td2.className = 'pattern-cell';
    const _pt = document.createElement('span'); _pt.className = 'pattern-text'; _pt.style.cssText = 'font-family:monospace;font-size:12px;color:var(--text-1)'; _pt.textContent = rule.pattern;
    const _pi = document.createElement('input'); _pi.className = 'pattern-input field-input hidden'; _pi.value = rule.pattern; _pi.style.cssText = 'font-family:monospace;font-size:12px;height:28px;padding:2px 8px';
    _td2.append(_pt, _pi);
    const _td3 = document.createElement('td'); _td3.textContent = rule.action;
    const _td4 = document.createElement('td'); _td4.style.color = 'var(--text-3)'; _td4.title = 'Stored value only; not live runtime rule telemetry'; _td4.textContent = storedHits.toLocaleString();
    const _td5 = document.createElement('td');
    const _toggleBtn = document.createElement('button'); _toggleBtn.className = `toggle-rule status-dot${rule.active ? '' : ' off'}`; _toggleBtn.dataset.id = rule.id; _toggleBtn.title = rule.active ? 'Disable rule' : 'Enable rule'; _toggleBtn.textContent = rule.active ? 'Active' : 'Disabled';
    _td5.appendChild(_toggleBtn);
    const _td6 = document.createElement('td'); _td6.style.cssText = 'display:flex;gap:4px;align-items:center';
    const _editBtn = document.createElement('button'); _editBtn.className = 'icon-btn-sm edit-rule'; _editBtn.dataset.id = rule.id; _editBtn.title = 'Edit pattern';
    const _svgNS = 'http://www.w3.org/2000/svg';
    const _svgIcon = document.createElementNS(_svgNS, 'svg'); _svgIcon.setAttribute('width','12'); _svgIcon.setAttribute('height','12'); _svgIcon.setAttribute('viewBox','0 0 24 24'); _svgIcon.setAttribute('fill','none'); _svgIcon.setAttribute('stroke','currentColor'); _svgIcon.setAttribute('stroke-width','2'); _svgIcon.setAttribute('stroke-linecap','round');
    const _sp1 = document.createElementNS(_svgNS, 'path'); _sp1.setAttribute('d','M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7');
    const _sp2 = document.createElementNS(_svgNS, 'path'); _sp2.setAttribute('d','M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z');
    _svgIcon.append(_sp1, _sp2); _editBtn.appendChild(_svgIcon);
    const _saveBtn = document.createElement('button'); _saveBtn.className = 'icon-btn-sm save-rule hidden'; _saveBtn.dataset.id = rule.id; _saveBtn.title = 'Save'; _saveBtn.style.color = 'var(--green)'; _saveBtn.textContent = '✓';
    const _delBtn = document.createElement('button'); _delBtn.className = 'icon-btn-sm delete-rule'; _delBtn.dataset.id = rule.id; _delBtn.title = 'Delete'; _delBtn.textContent = '✕';
    _td6.append(_editBtn, _saveBtn, _delBtn);
    tr.append(_td1, _td2, _td3, _td4, _td5, _td6);
    tbody.appendChild(tr);
  });
}

let currentRules = [];

function loadRules() {
  chrome.storage.local.get('rules', ({ rules }) => {
    currentRules = Array.isArray(rules) ? rules : [];
    renderRules(currentRules);
  });
}

document.getElementById('addRuleBtn')?.addEventListener('click', () => {
  document.getElementById('ruleForm')?.classList.toggle('hidden');
});

document.getElementById('cancelRule')?.addEventListener('click', () => {
  document.getElementById('ruleForm')?.classList.add('hidden');
});

document.getElementById('saveRule')?.addEventListener('click', () => {
  const type    = document.getElementById('ruleType')?.value;
  const pattern = document.getElementById('rulePattern')?.value.trim();
  const action  = document.getElementById('ruleAction')?.value;

  if (!pattern) return;
  const newRule = { id: Date.now(), type, pattern, action, hits: 0, active: true };
  currentRules.unshift(newRule);
  renderRules(currentRules);
  document.getElementById('ruleForm')?.classList.add('hidden');
  if (document.getElementById('rulePattern')) document.getElementById('rulePattern').value = '';
  chrome.storage.local.set({ rules: currentRules });
  chrome.runtime.sendMessage({ type: 'RULES_CHANGED' });
});

document.getElementById('rulesBody')?.addEventListener('click', e => {
  const id = parseInt(e.target.closest('[data-id]')?.dataset.id, 10);
  if (!id) return;
  const tr = e.target.closest('tr');

  // ── Delete ──────────────────────────────────
  if (e.target.closest('.delete-rule')) {
    currentRules = currentRules.filter(r => r.id !== id);
    renderRules(currentRules);
    chrome.storage.local.set({ rules: currentRules });
    chrome.runtime.sendMessage({ type: 'RULES_CHANGED' });
    return;
  }

  // ── Toggle active/disabled ───────────────────
  if (e.target.closest('.toggle-rule')) {
    const rule = currentRules.find(r => r.id === id);
    if (!rule) return;
    rule.active = !rule.active;
    renderRules(currentRules);
    chrome.storage.local.set({ rules: currentRules });
    chrome.runtime.sendMessage({ type: 'RULES_CHANGED' });
    return;
  }

  // ── Edit (enter edit mode) ───────────────────
  if (e.target.closest('.edit-rule')) {
    const patternText  = tr.querySelector('.pattern-text');
    const patternInput = tr.querySelector('.pattern-input');
    const editBtn      = tr.querySelector('.edit-rule');
    const saveBtn      = tr.querySelector('.save-rule');
    patternText.classList.add('hidden');
    patternInput.classList.remove('hidden');
    editBtn.classList.add('hidden');
    saveBtn.classList.remove('hidden');
    patternInput.focus();
    patternInput.select();
    return;
  }

  // ── Save (exit edit mode) ────────────────────
  if (e.target.closest('.save-rule')) {
    const patternInput = tr.querySelector('.pattern-input');
    const newPattern   = patternInput.value.trim();
    if (!newPattern) return;
    const rule = currentRules.find(r => r.id === id);
    if (!rule) return;
    rule.pattern = newPattern;
    renderRules(currentRules);
    chrome.storage.local.set({ rules: currentRules });
    chrome.runtime.sendMessage({ type: 'RULES_CHANGED' });
  }
});

document.getElementById('ruleSearch')?.addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  const filtered = currentRules.filter(r =>
    r.pattern.toLowerCase().includes(q) || r.type.includes(q));
  renderRules(filtered);
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

document.getElementById('saveAllow')?.addEventListener('click', () => {
  const val = document.getElementById('allowInput')?.value.trim().toLowerCase();
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
  { id: 'referrerToggle',    key: 'referrerAnonymization' },
];

function loadPrivacySettings() {
  chrome.storage.local.get(
    ['referrerAnonymization'],
    (data) => {
      for (const { id, key } of privacyToggles) {
        const el = document.getElementById(id);
        if (el) el.checked = data[key] ?? (key === 'referrerAnonymization');
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
  chrome.storage.local.clear(() => {
    alert('All data cleared. Reloading…');
    location.reload();
  });
});

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

/* ── Init ─────────────────────────────────────── */
loadOverviewStats();
loadRules();
loadAllowList();
loadBlockingSettings();
loadPrivacySettings();

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
  if (changes.referrerAnonymization) {
    loadPrivacySettings();
  }

  // Stats updated
  if (changes.stats) {
    loadOverviewStats();
  }
});
