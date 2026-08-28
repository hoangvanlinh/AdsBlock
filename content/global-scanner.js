// global-scanner.js — "scan page globals" picker (isolated world).
// Armed remotely (via QKV1_ENTER_SCANNER_MODE, sent from background.js's
// contextMenus.onClicked). While active: asks content/scriptlets.js's
// MAIN-world code to enumerate page-added `window` properties (the actual
// scan can only run in MAIN world — this isolated-world script has no
// visibility into the page's real window at all), lists them in an overlay
// panel, and lets the user Block/Edit/Delete each one. Persists via
// SAVE_GLOBAL_RULE, same pipeline shape as element-picker.js's
// SAVE_ELEMENT_RULE (background.js regenerates a marker-delimited block
// from the globalScopeRules map, reusing the existing customRulesText/
// RULES_CHANGED pipeline and the ALREADY-WIRED set_constant/
// abort_on_property_read scriptlet keys — no new apply-side code needed
// for reapplication on future visits, only for this on-demand scan/apply
// round trip itself).
(function () {
if (window.__qkv1Scanner) return;
window.__qkv1Scanner = true;

// Substituted with a random string at build time (_build-lib.sh) — must
// match content/scriptlets.js's own copy of the same placeholder exactly.
var _QKV1_TOKEN = '__QKV1_BUILD_TOKEN__';
var _EVT_SCANREQ  = '__' + _QKV1_TOKEN + '_scanreq__';
var _EVT_SCANRES  = '__' + _QKV1_TOKEN + '_scanres__';
var _EVT_APPLYREQ = '__' + _QKV1_TOKEN + '_applyreq__';

var _active = false;
var _panelEl = null;
var _pendingScans = {}; // requestId -> {resolve, timer}

function _ownNode(el) {
  return !!(el && el.closest && el.closest('.qkv1-scanner-ui'));
}

// ── MAIN-world round trip ────────────────────────────────────────────
function _requestScan() {
  return new Promise(function (resolve) {
    var requestId = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : 'r' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    var timer = setTimeout(function () {
      delete _pendingScans[requestId];
      resolve([]);
    }, 3000);
    _pendingScans[requestId] = { resolve: resolve, timer: timer };
    try { window.dispatchEvent(new CustomEvent(_EVT_SCANREQ, { detail: requestId })); }
    catch (e) { clearTimeout(timer); delete _pendingScans[requestId]; resolve([]); }
  });
}

window.addEventListener(_EVT_SCANRES, function (ev) {
  var payload;
  try { payload = JSON.parse(ev.detail); } catch (e) { return; }
  if (!payload || !payload.requestId) return;
  var pending = _pendingScans[payload.requestId];
  if (!pending) return;
  clearTimeout(pending.timer);
  delete _pendingScans[payload.requestId];
  pending.resolve(payload.results || []);
});

function _applyNow(chain, action, value) {
  try {
    window.dispatchEvent(new CustomEvent(_EVT_APPLYREQ, {
      detail: JSON.stringify({ chain: chain, action: action, value: value }),
    }));
  } catch (e) {}
}

// ── Value grammar (mirrors scriptlets.js's _parseVal — presentational
// only; the real value is parsed again, authoritatively, in MAIN world
// when the persisted rule is actually applied) ──────────────────────────
// First 5 labels echo a raw JS keyword/literal (not translatable prose);
// the rest are real descriptive labels, looked up via EXT.i18n at use time.
var QUICK_VALUES = [
  ['undefined', 'undefined'],
  ['null', 'null'],
  ['true', 'true'],
  ['false', 'false'],
  ['0', '0'],
  ['""', 'scanner_value_emptyString'],
  ['[]', 'scanner_value_emptyArray'],
  ['{}', 'scanner_value_emptyObject'],
  ['noopFunc', 'scanner_value_noopFunc'],
  ['trueFunc', 'scanner_value_trueFunc'],
  ['falseFunc', 'scanner_value_falseFunc'],
];
var QUICK_VALUES_I18N_KEYS = {
  'scanner_value_emptyString': 1, 'scanner_value_emptyArray': 1, 'scanner_value_emptyObject': 1,
  'scanner_value_noopFunc': 1, 'scanner_value_trueFunc': 1, 'scanner_value_falseFunc': 1,
};
function _quickValueLabel(raw) {
  return QUICK_VALUES_I18N_KEYS[raw] ? EXT.i18n.getMessage(raw) : raw;
}

// ── UI ──────────────────────────────────────────────────────────────
function _mkBtn(label, primary) {
  var b = document.createElement('button');
  b.className = 'qkv1-scanner-ui';
  b.textContent = label;
  b.style.cssText =
    'font:inherit;font-weight:600;border:0;border-radius:6px;padding:5px 10px;cursor:pointer;' +
    (primary ? 'background:#2563eb;color:#fff;' : 'background:#334155;color:#e2e8f0;');
  return b;
}

function _row(entry, host) {
  var row = document.createElement('div');
  row.className = 'qkv1-scanner-ui';
  row.style.cssText = 'border-bottom:1px solid #334155;padding:10px 4px;';

  var head = document.createElement('div');
  head.className = 'qkv1-scanner-ui';
  head.style.cssText = 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;';
  var name = document.createElement('span');
  name.className = 'qkv1-scanner-ui';
  name.textContent = entry.name;
  name.style.cssText = 'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e2e8f0;font-weight:600;';
  var type = document.createElement('span');
  type.className = 'qkv1-scanner-ui';
  type.textContent = entry.type;
  type.style.cssText = 'font:10px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#94a3b8;' +
    'background:#334155;border-radius:4px;padding:1px 6px;';
  head.appendChild(name);
  head.appendChild(type);
  row.appendChild(head);

  if (entry.preview) {
    var preview = document.createElement('div');
    preview.className = 'qkv1-scanner-ui';
    preview.textContent = entry.preview;
    preview.style.cssText = 'font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#64748b;' +
      'margin-top:3px;word-break:break-all;max-height:36px;overflow:hidden;';
    row.appendChild(preview);
  }

  var actions = document.createElement('div');
  actions.className = 'qkv1-scanner-ui';
  actions.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
  var blockBtn = _mkBtn(EXT.i18n.getMessage('scanner_btn_block'), false);
  var editBtn = _mkBtn(EXT.i18n.getMessage('scanner_btn_edit'), false);
  var deleteBtn = _mkBtn(EXT.i18n.getMessage('scanner_btn_delete'), false);
  actions.appendChild(blockBtn);
  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);
  row.appendChild(actions);

  var expando = document.createElement('div');
  expando.className = 'qkv1-scanner-ui';
  expando.style.cssText = 'margin-top:8px;display:none;';
  row.appendChild(expando);

  function closeExpando() { expando.style.display = 'none'; expando.textContent = ''; }

  function persist(action, value) {
    _applyNow(entry.name, action, value);
    try {
      EXT.runtime.sendMessage(
        { type: 'SAVE_GLOBAL_RULE', host: host, chain: entry.name, action: action, value: value },
        function () { void EXT.runtime.lastError; }
      );
    } catch (e) {}
    row.style.opacity = '.5';
    row.style.pointerEvents = 'none';
    var doneLabel = document.createElement('div');
    doneLabel.className = 'qkv1-scanner-ui';
    var _appliedKeys = { block: 'scanner_status_blockApplied', edit: 'scanner_status_editApplied', delete: 'scanner_status_deleteApplied' };
    doneLabel.textContent = EXT.i18n.getMessage(_appliedKeys[action] || 'scanner_status_editApplied');
    doneLabel.style.cssText = 'font:11px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#34d399;margin-top:6px;';
    row.appendChild(doneLabel);
  }

  blockBtn.addEventListener('click', function () {
    closeExpando();
    expando.style.display = 'block';
    var warn = document.createElement('div');
    warn.className = 'qkv1-scanner-ui';
    warn.textContent = EXT.i18n.getMessage('scanner_block_warning');
    warn.style.cssText = 'font:11px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#fca5a5;' +
      'background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3);border-radius:6px;padding:8px;margin-bottom:6px;';
    expando.appendChild(warn);
    var row2 = document.createElement('div');
    row2.className = 'qkv1-scanner-ui';
    row2.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
    var confirmBtn = _mkBtn(EXT.i18n.getMessage('scanner_btn_blockAnyway'), true);
    var cancelBtn = _mkBtn(EXT.i18n.getMessage('common_cancel'), false);
    confirmBtn.style.background = '#dc2626';
    confirmBtn.addEventListener('click', function () { persist('block', undefined); });
    cancelBtn.addEventListener('click', closeExpando);
    row2.appendChild(cancelBtn);
    row2.appendChild(confirmBtn);
    expando.appendChild(row2);
  });

  editBtn.addEventListener('click', function () {
    closeExpando();
    expando.style.display = 'block';
    var select = document.createElement('select');
    select.className = 'qkv1-scanner-ui';
    select.style.cssText = 'width:100%;font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;' +
      'background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:4px;margin-bottom:6px;';
    QUICK_VALUES.forEach(function (pair) {
      var opt = document.createElement('option');
      opt.value = pair[0];
      opt.textContent = _quickValueLabel(pair[1]) + ' (' + pair[0] + ')';
      select.appendChild(opt);
    });
    var customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = EXT.i18n.getMessage('scanner_edit_customOption');
    select.appendChild(customOpt);
    expando.appendChild(select);

    var customInput = document.createElement('input');
    customInput.className = 'qkv1-scanner-ui';
    customInput.type = 'text';
    customInput.placeholder = EXT.i18n.getMessage('scanner_edit_customPlaceholder');
    customInput.style.cssText = 'width:100%;box-sizing:border-box;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:4px 6px;margin-bottom:6px;display:none;';
    expando.appendChild(customInput);

    var hint = document.createElement('div');
    hint.className = 'qkv1-scanner-ui';
    hint.style.cssText = 'font:10px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#64748b;margin-bottom:6px;';
    expando.appendChild(hint);

    function syncHint() {
      var isCustom = select.value === '__custom__';
      customInput.style.display = isCustom ? 'block' : 'none';
      if (!isCustom) { hint.textContent = ''; return; }
      var v = customInput.value.trim();
      if (!v) { hint.textContent = EXT.i18n.getMessage('scanner_edit_hintEmpty'); return; }
      if (/\s/.test(v)) { hint.textContent = EXT.i18n.getMessage('scanner_edit_hintNoSpaces'); return; }
      hint.textContent = EXT.i18n.getMessage('scanner_edit_hintPreview', [v]);
    }
    select.addEventListener('change', syncHint);
    customInput.addEventListener('input', syncHint);
    syncHint();

    var row2 = document.createElement('div');
    row2.className = 'qkv1-scanner-ui';
    row2.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
    var saveBtn = _mkBtn(EXT.i18n.getMessage('common_save'), true);
    var cancelBtn = _mkBtn(EXT.i18n.getMessage('common_cancel'), false);
    saveBtn.addEventListener('click', function () {
      var value = select.value === '__custom__' ? customInput.value.trim() : select.value;
      if (!value || /\s/.test(value)) return;
      persist('edit', value);
    });
    cancelBtn.addEventListener('click', closeExpando);
    row2.appendChild(cancelBtn);
    row2.appendChild(saveBtn);
    expando.appendChild(row2);
  });

  deleteBtn.addEventListener('click', function () { persist('delete', undefined); });

  return row;
}

function _buildPanel(host, results) {
  _removePanel();
  var panel = document.createElement('div');
  panel.className = 'qkv1-scanner-ui';
  panel.style.cssText =
    'position:fixed;top:0;right:0;bottom:0;width:380px;max-width:92vw;z-index:2147483647;' +
    'background:#1e293b;color:#e2e8f0;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;' +
    'box-shadow:-8px 0 24px rgba(0,0,0,.4);display:flex;flex-direction:column;';

  var header = document.createElement('div');
  header.className = 'qkv1-scanner-ui';
  header.style.cssText = 'padding:12px 14px;border-bottom:1px solid #334155;display:flex;align-items:center;gap:8px;';
  var title = document.createElement('div');
  title.className = 'qkv1-scanner-ui';
  title.textContent = EXT.i18n.getMessage('scanner_panel_title', [String(results.length)]);
  title.style.cssText = 'font-weight:700;flex:1;';
  var closeBtn = _mkBtn('✕', false);
  closeBtn.style.cssText += 'padding:4px 8px;';
  closeBtn.addEventListener('click', _exitScannerMode);
  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  var filterWrap = document.createElement('div');
  filterWrap.className = 'qkv1-scanner-ui';
  filterWrap.style.cssText = 'padding:8px 14px;border-bottom:1px solid #334155;';
  var filter = document.createElement('input');
  filter.className = 'qkv1-scanner-ui';
  filter.type = 'text';
  filter.placeholder = EXT.i18n.getMessage('scanner_filter_placeholder');
  filter.style.cssText = 'width:100%;box-sizing:border-box;font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;' +
    'background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:5px 8px;';
  filterWrap.appendChild(filter);
  panel.appendChild(filterWrap);

  var list = document.createElement('div');
  list.className = 'qkv1-scanner-ui';
  list.style.cssText = 'flex:1;overflow-y:auto;padding:4px 14px;';
  if (!results.length) {
    var empty = document.createElement('div');
    empty.className = 'qkv1-scanner-ui';
    empty.textContent = EXT.i18n.getMessage('scanner_empty');
    empty.style.cssText = 'color:#64748b;padding:16px 0;text-align:center;';
    list.appendChild(empty);
  } else {
    results.forEach(function (entry) { list.appendChild(_row(entry, host)); });
  }
  panel.appendChild(list);

  filter.addEventListener('input', function () {
    var q = filter.value.trim().toLowerCase();
    Array.prototype.forEach.call(list.children, function (child) {
      if (!child.textContent) return;
      var nameEl = child.querySelector ? child.querySelector('span') : null;
      var n = nameEl ? nameEl.textContent.toLowerCase() : child.textContent.toLowerCase();
      child.style.display = !q || n.indexOf(q) !== -1 ? '' : 'none';
    });
  });

  var footer = document.createElement('div');
  footer.className = 'qkv1-scanner-ui';
  footer.textContent = EXT.i18n.getMessage('scanner_footer_limitation');
  footer.style.cssText = 'padding:10px 14px;border-top:1px solid #334155;font-size:10px;line-height:1.5;color:#64748b;';
  panel.appendChild(footer);

  document.documentElement.appendChild(panel);
  _panelEl = panel;
}

function _removePanel() {
  if (_panelEl) { try { _panelEl.remove(); } catch (e) {} _panelEl = null; }
}

function _showLoading() {
  _removePanel();
  var panel = document.createElement('div');
  panel.className = 'qkv1-scanner-ui';
  panel.style.cssText =
    'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
    'background:#111827;color:#fff;font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;' +
    'padding:6px 14px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.35);';
  panel.textContent = EXT.i18n.getMessage('scanner_loading');
  document.documentElement.appendChild(panel);
  _panelEl = panel;
}

function _onKeyDown(ev) {
  if (!_active) return;
  if (ev.key === 'Escape') _exitScannerMode();
}

function _enterScannerMode() {
  if (_active) return;
  _active = true;
  document.addEventListener('keydown', _onKeyDown, true);
  _showLoading();
  var host = location.hostname;
  _requestScan().then(function (results) {
    if (!_active) return; // cancelled while scanning
    results.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    _buildPanel(host, results);
  });
}
function _exitScannerMode() {
  _active = false;
  document.removeEventListener('keydown', _onKeyDown, true);
  _removePanel();
}

try {
  EXT.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg && msg.type === 'QKV1_ENTER_SCANNER_MODE') {
      _enterScannerMode();
      sendResponse({ ok: true });
    }
  });
} catch (e) {}
})();
