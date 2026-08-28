// element-picker.js — interactive "hide element" picker (isolated world).
// Armed remotely (via QKV1_ENTER_PICKER_MODE, sent from background.js's
// contextMenus.onClicked or the popup's "Pick element to hide" button). While armed:
// hovering highlights the element under the cursor, clicking opens a small
// confirm panel with the generated selector, confirming hides the element
// immediately (this tab) and persists the rule via SAVE_ELEMENT_RULE so it
// survives reload — background.js regenerates a direct_hide_selectors block
// from the elementRules map and reuses the existing customRulesText/
// RULES_CHANGED pipeline (same one already used by [host_patterns]-driven
// cosmetic hiding elsewhere in this codebase), no new apply-side code needed.
(function () {
if (window.__qkv1Picker) return;
window.__qkv1Picker = true;

var _picking = false;
var _hoveredEl = null;
var _styleEl = null;
var _boxEl = null;
var _panelEl = null;
var _badgeEl = null;

function _ownNode(el) {
  return !!(el && el.closest && el.closest('.qkv1-picker-ui'));
}

// ── selector generation ──────────────────────────────────────────────
// Not a full uBO-grade generator — good enough to be stable across reloads
// for typical ad containers (id, or a couple of non-hashy classes, or a
// short ancestor path), capped so it can never resolve to body/html alone.
function _looksHashy(cls) {
  // Long, no separators, mixed letters+digits — CSS-module/hash-generated
  // classnames that won't survive the site's next deploy.
  if (cls.length >= 10 && !/[-_]/.test(cls) && /[0-9]/.test(cls) && /[a-z]/i.test(cls)) return true;
  return false;
}
function _stableClasses(el) {
  var out = [];
  var list = el.classList ? Array.prototype.slice.call(el.classList) : [];
  for (var i = 0; i < list.length && out.length < 2; i++) {
    var c = list[i];
    if (!c || _looksHashy(c)) continue;
    out.push(c);
  }
  return out;
}
function _selfSelector(el) {
  if (el.id && !/^\d+$/.test(el.id) && el.id.length < 60) {
    try { return '#' + CSS.escape(el.id); } catch (e) {}
  }
  var tag = el.localName || 'div';
  var classes = _stableClasses(el);
  if (classes.length) {
    return tag + classes.map(function (c) { try { return '.' + CSS.escape(c); } catch (e) { return ''; } }).join('');
  }
  return tag;
}
function _isUnique(sel) {
  try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
}
function _generateSelector(el) {
  if (!el || el === document.body || el === document.documentElement) return '';
  var own = _selfSelector(el);
  if (_isUnique(own)) return own;
  var parts = [own];
  var node = el.parentElement;
  var depth = 0;
  while (node && node !== document.body && node !== document.documentElement && depth < 4) {
    parts.unshift(_selfSelector(node));
    var candidate = parts.join(' > ');
    if (_isUnique(candidate)) return candidate;
    node = node.parentElement;
    depth++;
  }
  // Fall back to the deepest candidate even if not provably unique — still
  // far more specific than a bare tag name, and _injectDirectStyle() (site-
  // block.js) already prefixes with "body " so it can never blank the page.
  return parts.join(' > ');
}

// ── UI ──────────────────────────────────────────────────────────────
function _ensureStyle() {
  if (_styleEl) return;
  _styleEl = document.createElement('style');
  _styleEl.className = 'qkv1-picker-ui';
  _styleEl.textContent =
    'html.qkv1-picking, html.qkv1-picking * { cursor: crosshair !important; }';
  document.documentElement.appendChild(_styleEl);
}
function _ensureBox() {
  if (_boxEl) return _boxEl;
  _boxEl = document.createElement('div');
  _boxEl.className = 'qkv1-picker-ui';
  _boxEl.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;' +
    'border:2px solid #2563eb;background:rgba(37,99,235,.15);' +
    'box-sizing:border-box;display:none;';
  document.documentElement.appendChild(_boxEl);
  return _boxEl;
}
function _ensureBadge() {
  if (_badgeEl) return;
  _badgeEl = document.createElement('div');
  _badgeEl.className = 'qkv1-picker-ui';
  _badgeEl.textContent = EXT.i18n.getMessage('picker_badge_active');
  _badgeEl.style.cssText =
    'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
    'background:#111827;color:#fff;font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;' +
    'padding:6px 14px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:none;';
  document.documentElement.appendChild(_badgeEl);
}
function _moveBoxTo(el) {
  var box = _ensureBox();
  if (!el) { box.style.display = 'none'; return; }
  var r = el.getBoundingClientRect();
  box.style.display = 'block';
  box.style.left = r.left + 'px';
  box.style.top = r.top + 'px';
  box.style.width = r.width + 'px';
  box.style.height = r.height + 'px';
}
function _removePanel() {
  if (_panelEl) { try { _panelEl.remove(); } catch (e) {} _panelEl = null; }
}
function _showConfirmPanel(el) {
  _removePanel();
  var selector = _generateSelector(el);
  var r = el.getBoundingClientRect();
  var panel = document.createElement('div');
  panel.className = 'qkv1-picker-ui';
  panel.style.cssText =
    'position:fixed;z-index:2147483647;max-width:320px;' +
    'background:#1e293b;color:#e2e8f0;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;' +
    'padding:10px 12px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.4);';
  var top = r.bottom + 8;
  if (top + 120 > window.innerHeight) top = Math.max(8, r.top - 128);
  panel.style.top = top + 'px';
  panel.style.left = Math.min(Math.max(8, r.left), window.innerWidth - 336) + 'px';

  var code = document.createElement('div');
  code.textContent = selector;
  code.style.cssText =
    'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f172a;' +
    'padding:6px 8px;border-radius:6px;margin-bottom:8px;word-break:break-all;max-height:60px;overflow:auto;';
  panel.appendChild(code);

  var row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
  function mkBtn(label, primary) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:inherit;font-weight:600;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;' +
      (primary ? 'background:#2563eb;color:#fff;' : 'background:#334155;color:#e2e8f0;');
    return b;
  }
  var hideBtn = mkBtn(EXT.i18n.getMessage('picker_btn_hide'), true);
  var broadenBtn = mkBtn(EXT.i18n.getMessage('picker_btn_broaden'), false);
  var cancelBtn = mkBtn(EXT.i18n.getMessage('common_cancel'), false);
  hideBtn.addEventListener('click', function () { _confirmHide(el, selector); });
  broadenBtn.addEventListener('click', function () {
    var parent = el.parentElement;
    if (parent && parent !== document.body && parent !== document.documentElement) {
      _hoveredEl = parent;
      _moveBoxTo(parent);
      _showConfirmPanel(parent);
    }
  });
  cancelBtn.addEventListener('click', _exitPickerMode);
  row.appendChild(broadenBtn);
  row.appendChild(cancelBtn);
  row.appendChild(hideBtn);
  panel.appendChild(row);

  document.documentElement.appendChild(panel);
  _panelEl = panel;
}

function _confirmHide(el, selector) {
  try { el.style.setProperty('display', 'none', 'important'); } catch (e) {}
  // '|' is this codebase's value separator (rule/site-rules.txt and the
  // customRulesText blob both split on it) — escape defensively even though
  // a generated selector is very unlikely to contain a bare one (only CSS
  // namespace syntax [ns|attr] could). Same escaping background.js applies
  // again before writing the rule text, so this is belt-and-suspenders.
  var safeSelector = selector.replace(/\|/g, '\\|');
  try {
    EXT.runtime.sendMessage({ type: 'SAVE_ELEMENT_RULE', host: location.hostname, selector: safeSelector }, function () {
      void EXT.runtime.lastError;
    });
  } catch (e) {}
  _exitPickerMode();
}

function _onMouseMove(ev) {
  if (!_picking) return;
  var el = document.elementFromPoint(ev.clientX, ev.clientY);
  if (!el || _ownNode(el)) return;
  if (el === _hoveredEl) return;
  _hoveredEl = el;
  _moveBoxTo(el);
}
function _onClick(ev) {
  if (!_picking) return;
  if (_ownNode(ev.target)) return; // let clicks on our own panel/buttons through
  ev.preventDefault();
  ev.stopPropagation();
  if (_hoveredEl) _showConfirmPanel(_hoveredEl);
}
function _onKeyDown(ev) {
  if (!_picking) return;
  if (ev.key === 'Escape') _exitPickerMode();
}

function _enterPickerMode() {
  if (_picking) return;
  _picking = true;
  _ensureStyle();
  _ensureBadge();
  document.documentElement.classList.add('qkv1-picking');
  document.addEventListener('mousemove', _onMouseMove, true);
  document.addEventListener('click', _onClick, true);
  document.addEventListener('keydown', _onKeyDown, true);
}
function _exitPickerMode() {
  _picking = false;
  _hoveredEl = null;
  document.removeEventListener('mousemove', _onMouseMove, true);
  document.removeEventListener('click', _onClick, true);
  document.removeEventListener('keydown', _onKeyDown, true);
  document.documentElement.classList.remove('qkv1-picking');
  _removePanel();
  if (_boxEl) { try { _boxEl.remove(); } catch (e) {} _boxEl = null; }
  if (_badgeEl) { try { _badgeEl.remove(); } catch (e) {} _badgeEl = null; }
  if (_styleEl) { try { _styleEl.remove(); } catch (e) {} _styleEl = null; }
}

try {
  EXT.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg && msg.type === 'QKV1_ENTER_PICKER_MODE') {
      _enterPickerMode();
      sendResponse({ ok: true });
    }
  });
} catch (e) {}
})();
