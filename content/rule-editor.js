// rule-editor.js — "edit rules for this site" picker (isolated world).
// Armed remotely (via QKV1_ENTER_RULE_EDITOR_MODE, sent from background.js's
// contextMenus.onClicked). Shows an on-page overlay with a reference list of
// every known site-rules.txt key + description, and a textarea where the
// user types raw "key = value | value2" lines for the CURRENT site directly
// — a scoped-down, on-page version of the dashboard's whole-file Custom
// Rules textarea. Saves via SAVE_SITE_RULE_TEXT; background.js regenerates
// a marker-delimited [siteKey] section from the siteRuleText map and reuses
// the existing customRulesText/RULES_CHANGED pipeline (same one element-
// picker.js and global-scanner.js already use), no new apply-side code.
(function () {
if (window.__qkv1RuleEditor) return;
window.__qkv1RuleEditor = true;

// ── Key reference (name -> one-line description) ────────────────────
// Grounded in this repo's own doc-comments (content/site-block.js,
// content/scriptlets.js) — kept here as a flat list rather than fetched
// live, since it describes the EXTENSION's own rule grammar, not anything
// page- or site-specific.
var COSMETIC_KEYS = [
  ['direct_hide_selectors', 'CSS selectors hidden unconditionally via an injected stylesheet — no heuristic check, just hide on sight.'],
  ['selectors', 'CSS selectors for CANDIDATE elements — only hidden if they also match labels/link_patterns below.'],
  ['feed_selectors', 'Same as selectors, scoped to feed/timeline-style containers.'],
  ['market_selectors', 'Same as selectors, scoped to marketplace/shopping-style containers.'],
  ['right_rail_selectors', 'Same as selectors, scoped to a sidebar/right-rail area.'],
  ['post_selectors', 'Same as selectors, scoped to individual post/article containers.'],
  ['ad_host_selectors', 'CSS selectors for "host" elements, checked the same way as selectors above.'],
  ['labels', 'Text labels (e.g. sponsored, promoted) matched against attributes/context text to confirm a candidate is really an ad.'],
  ['link_patterns', 'Substring patterns matched against a candidate’s own links/attributes to confirm it’s an ad.'],
  ['attr_keys', 'HTML attribute names scanned for label/link_pattern matches (default: aria-label, data-promoted, post-type, …).'],
  ['context_selectors', 'Child elements to pull text from for label matching (default: header, [role=heading], span, a).'],
  ['hide_closest', 'CSS selector(s) to walk up to via .closest() before hiding a matched candidate (hide the container, not just the label).'],
  ['strip_page_classes', 'Class names continuously stripped from <html>/<body> — defeats CSS-only takeover overlays driven by a root class.'],
  ['strip_inline_styles', 'CSS property names continuously cleared from <html>/<body> inline style — defeats JS-set scroll-lock, etc.'],
  ['close_popunder_tabs', '1/0 flag — auto-close popup/popunder tabs opened by clicks on this site.'],
];
var SCRIPTLET_KEYS_REF = [
  ['set_constant', '"chain value" — lock a window property permanently to a fixed value (undefined, true, false, noopFunc, …).'],
  ['abort_on_property_read', 'chain — throw when any script reads this window property.'],
  ['abort_on_property_write', 'chain — throw when any script writes this window property.'],
  ['abort_on_stack_trace', '"chain, needle" — throw only when the calling script’s own stack trace matches needle.'],
  ['abort_current_script', '"target, needle, ctx" — throw when a script whose source matches needle reads target.'],
  ['no_window_open_if', '"pattern, delayMs, decoy" — block or decoy-redirect window.open() calls matching pattern.'],
  ['prevent_fetch', 'propsToMatch — block fetch() calls matching criteria.'],
  ['prevent_xhr', 'propsToMatch — block XMLHttpRequest calls matching criteria.'],
  ['trusted_prevent_fetch', '"propsToMatch, directive" — block fetch, optionally returning a fixed fake response body.'],
  ['json_prune', '"prunePaths, needlePaths" — remove fields from any JSON.parse() result.'],
  ['json_prune_fetch', '"prunePaths, needlePaths[, propsToMatch]" — remove fields from a fetch() JSON response.'],
  ['json_prune_xhr', '"prunePaths, needlePaths[, propsToMatch]" — remove fields from an XHR JSON response.'],
  ['json_prune_on_set', '"chain, prunePaths, needlePaths" — prune an object a script assigns directly (not via JSON.parse).'],
  ['json_edit', 'jsonq — JSONPath-based field deletions in a fetch() JSON response.'],
  ['jsonl_edit_xhr', '"jsonq, urlPattern" — JSONPath-based field deletions in an XHR JSON-lines response.'],
  ['jspb_response_prune', 'Remove fields from a protobuf/jspb-encoded response.'],
  ['trusted_edit_request', '"jsonq, propsToMatch" — JSONPath edits (deletions AND value assignment) on an outgoing request body.'],
  ['trusted_edit_response', '"jsonq, propsToMatch" — JSONPath edits (deletions AND value assignment) on a response body.'],
  ['trusted_replace_fetch_response', '"pattern, replacement, propsToMatch" — regex find/replace on a fetch() response body.'],
  ['trusted_replace_xhr_response', '"pattern, replacement, propsToMatch" — regex find/replace on an XHR response body.'],
  ['trusted_replace_argument', '"propChain, argIndex, value" — replace one argument passed to a function.'],
  ['trusted_replace_outbound_text', '"propChain, pattern, replacement" — unconditional text substitution on outbound data (no URL scoping).'],
  ['trusted_replace_script_text', '"nodeName, pattern, replacement" — rewrite a <script> tag’s text before it runs.'],
  ['trusted_prune_inbound_object', '"propChain, prunePaths, needlePaths" — prune fields from an object passed INTO a native method call.'],
  ['trusted_suppress_native_method', '"methodPath, signature[, behavior, stack]" — abort or silently no-op a native method call matching a signature.'],
  ['trusted_suppress_setter', '"propChain, needle[, behavior]" — drop or throw on an accessor setter assignment (e.g. Element.prototype.innerHTML) whose value matches needle.'],
  ['m3u_prune', '"markers, propsToMatch" — remove ad segments from an HLS .m3u8 playlist response.'],
  ['prevent_element_src_loading', '"tagName, match" — fake-succeed a script/img/iframe/link load instead of the real network request.'],
  ['remove_attr', '"attrNames[, selector, behavior]" — remove HTML attributes from matching elements.'],
  ['remove_node_text', '"nodeName, pattern" — clear a DOM node’s text content.'],
  ['replace_node_text', '"nodeName, pattern, replacement" — rewrite a DOM node’s text content.'],
  ['refresh_defuser', 'delay — stop a <meta http-equiv="refresh"> auto-redirect.'],
  ['set_cookie', '"name, value" — set a cookie.'],
  ['remove_cookie', 'needle — remove cookies matching a name pattern.'],
  ['set_local_storage_item', '"key, value" — set a localStorage entry (restricted to safe literal values, or $remove$ to delete matching keys).'],
  ['href_sanitizer', '"selector, source" — rewrite a link’s href from its own text or another attribute.'],
  ['prevent_settimeout', 'propsToMatch — block setTimeout() calls matching criteria.'],
  ['prevent_setinterval', 'propsToMatch — block setInterval() calls matching criteria.'],
  ['prevent_raf', 'propsToMatch — block requestAnimationFrame() calls matching criteria.'],
  ['prevent_aeld', 'propsToMatch — block addEventListener() calls matching criteria.'],
  ['adjust_settimeout', '"needle, delay, boost" — speed up/slow down matching setTimeout() calls instead of blocking them.'],
  ['adjust_setinterval', '"needle, delay, boost" — speed up/slow down matching setInterval() calls instead of blocking them.'],
  ['no_eval_if', 'pattern — block eval() calls whose source matches pattern.'],
  ['no_webrtc', 'Disables RTCPeerConnection — blocks WebRTC-based popup/tracking tricks.'],
  ['prevent_bab', 'Defuses BlockAdBlock/FuckAdBlock-style anti-adblock detection scripts.'],
  ['disable_newtab_links', 'Strips target="_blank" from clicked links — blocks forced new-tab redirects.'],
];

function _ownNode(el) {
  return !!(el && el.closest && el.closest('.qkv1-editor-ui'));
}

// ── UI ──────────────────────────────────────────────────────────────
var _panelEl = null;
var _active = false;

function _mkBtn(label, primary) {
  var b = document.createElement('button');
  b.className = 'qkv1-editor-ui';
  b.textContent = label;
  b.style.cssText =
    'font:inherit;font-weight:600;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;' +
    (primary ? 'background:#2563eb;color:#fff;' : 'background:#334155;color:#e2e8f0;');
  return b;
}

function _refRow(key, desc) {
  var row = document.createElement('div');
  row.className = 'qkv1-editor-ui qkv1-ref-row';
  row.style.cssText = 'padding:4px 0;border-bottom:1px solid #263548;';
  var code = document.createElement('code');
  code.textContent = key;
  code.style.cssText = 'font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#93c5fd;display:block;cursor:pointer;';
  code.title = 'Click to insert into the textarea';
  var desc2 = document.createElement('div');
  desc2.textContent = desc;
  desc2.style.cssText = 'font:11px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#94a3b8;margin-top:1px;';
  row.appendChild(code);
  row.appendChild(desc2);
  code.addEventListener('click', function () {
    var ta = document.getElementById('qkv1-rule-textarea');
    if (!ta) return;
    var insert = key + ' = ';
    var start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    var end = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
    var before = ta.value.slice(0, start);
    var needsNewline = before.length && !/\n$/.test(before);
    var toInsert = (needsNewline ? '\n' : '') + insert;
    ta.value = before + toInsert + ta.value.slice(end);
    var pos = start + toInsert.length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
  });
  return row;
}

function _buildPanel(host, initialText, existingText) {
  _removePanel();
  var panel = document.createElement('div');
  panel.className = 'qkv1-editor-ui';
  panel.style.cssText =
    'position:fixed;top:0;right:0;bottom:0;width:400px;max-width:92vw;z-index:2147483647;' +
    'background:#1e293b;color:#e2e8f0;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;' +
    'box-shadow:-8px 0 24px rgba(0,0,0,.4);display:flex;flex-direction:column;';

  var header = document.createElement('div');
  header.className = 'qkv1-editor-ui';
  header.style.cssText = 'padding:12px 14px;border-bottom:1px solid #334155;display:flex;align-items:center;gap:8px;';
  var title = document.createElement('div');
  title.className = 'qkv1-editor-ui';
  title.textContent = 'Edit rules — ' + host;
  title.style.cssText = 'font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  var closeBtn = _mkBtn('✕', false);
  closeBtn.style.cssText += 'padding:4px 8px;';
  closeBtn.addEventListener('click', _exitEditorMode);
  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // ── Reference (collapsible, filterable) ──
  var refSection = document.createElement('div');
  refSection.className = 'qkv1-editor-ui';
  // flex-shrink:0 — panel is display:flex;flex-direction:column, and this
  // section's own natural height jumps a lot when expanded (filter input +
  // up to 220px of scrollable rows). Without this, flexbox's default
  // flex-shrink:1 can squeeze it back down on a short viewport once it
  // expands, which reads as "clicked but nothing shows" even though the
  // rows are genuinely in the DOM (verified via a Node/vm structural replay
  // of this exact file, both source and the obfuscated build — the JS
  // logic itself builds and toggles all 60 rows correctly either way).
  refSection.style.cssText = 'border-bottom:1px solid #334155;flex-shrink:0;';
  var refToggle = document.createElement('button');
  refToggle.className = 'qkv1-editor-ui';
  refToggle.textContent = '▸ Key reference (' + (COSMETIC_KEYS.length + SCRIPTLET_KEYS_REF.length) + ')';
  refToggle.style.cssText = 'width:100%;text-align:left;background:none;border:0;color:#e2e8f0;font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;font-weight:600;padding:8px 14px;cursor:pointer;';
  var refBody = document.createElement('div');
  refBody.className = 'qkv1-editor-ui';
  refBody.style.cssText = 'display:none;padding:0 14px 10px;';
  var refFilter = document.createElement('input');
  refFilter.className = 'qkv1-editor-ui';
  refFilter.type = 'text';
  refFilter.placeholder = 'Filter keys…';
  refFilter.style.cssText = 'width:100%;box-sizing:border-box;font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;' +
    'background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:5px 8px;margin-bottom:6px;';
  refBody.appendChild(refFilter);
  var refList = document.createElement('div');
  refList.className = 'qkv1-editor-ui';
  refList.style.cssText = 'max-height:220px;overflow-y:auto;';
  var cosmeticLabel = document.createElement('div');
  cosmeticLabel.className = 'qkv1-editor-ui';
  cosmeticLabel.textContent = 'COSMETIC / CANDIDATE MATCHING';
  cosmeticLabel.style.cssText = 'font:10px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#64748b;font-weight:700;letter-spacing:.4px;margin-top:6px;';
  refList.appendChild(cosmeticLabel);
  COSMETIC_KEYS.forEach(function (pair) { refList.appendChild(_refRow(pair[0], pair[1])); });
  var scriptletLabel = document.createElement('div');
  scriptletLabel.className = 'qkv1-editor-ui';
  scriptletLabel.textContent = 'SCRIPTLETS (ADVANCED)';
  scriptletLabel.style.cssText = 'font:10px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#64748b;font-weight:700;letter-spacing:.4px;margin-top:10px;';
  refList.appendChild(scriptletLabel);
  SCRIPTLET_KEYS_REF.forEach(function (pair) { refList.appendChild(_refRow(pair[0], pair[1])); });
  refBody.appendChild(refList);
  refToggle.addEventListener('click', function () {
    var open = refBody.style.display !== 'none';
    refBody.style.display = open ? 'none' : 'block';
    refToggle.textContent = (open ? '▸' : '▾') + ' Key reference (' + (COSMETIC_KEYS.length + SCRIPTLET_KEYS_REF.length) + ')';
  });
  refFilter.addEventListener('input', function () {
    var q = refFilter.value.trim().toLowerCase();
    Array.prototype.forEach.call(refList.querySelectorAll('.qkv1-ref-row'), function (row) {
      row.style.display = !q || row.textContent.toLowerCase().indexOf(q) !== -1 ? '' : 'none';
    });
  });
  refSection.appendChild(refToggle);
  refSection.appendChild(refBody);
  panel.appendChild(refSection);

  // ── Current rules for this site (read-only reference) ──
  // Shows the FULL resolved config for this host — built-in rule/site-
  // rules.txt content plus anything already added via any of the 3 picker
  // features (element picker / scan picker / this editor) — so the user
  // can see what's already active before typing more. Read-only: this is
  // NOT the thing that gets saved (that's the editable textarea below,
  // scoped to just this editor's own past additions) — editing a COPY of a
  // built-in rule here wouldn't remove the original anyway, see the merge
  // note below.
  var existingSection = document.createElement('div');
  existingSection.className = 'qkv1-editor-ui';
  existingSection.style.cssText = 'border-bottom:1px solid #334155;flex-shrink:0;';
  var existingKeyCount = existingText ? existingText.split('\n').filter(Boolean).length : 0;
  var existingToggle = document.createElement('button');
  existingToggle.className = 'qkv1-editor-ui';
  existingToggle.textContent = '▸ Current rules for this site (' + existingKeyCount + ')';
  existingToggle.style.cssText = 'width:100%;text-align:left;background:none;border:0;color:#e2e8f0;font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;font-weight:600;padding:8px 14px;cursor:pointer;';
  var existingBody = document.createElement('div');
  existingBody.className = 'qkv1-editor-ui';
  existingBody.style.cssText = 'display:none;padding:0 14px 10px;';
  var existingPre = document.createElement('pre');
  existingPre.className = 'qkv1-editor-ui';
  existingPre.textContent = existingText || '(no rules for this site yet — built-in or custom)';
  existingPre.style.cssText = 'margin:0;max-height:180px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;' +
    'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#cbd5e1;background:#0f172a;' +
    'border:1px solid #334155;border-radius:6px;padding:8px;';
  existingBody.appendChild(existingPre);
  existingToggle.addEventListener('click', function () {
    var open = existingBody.style.display !== 'none';
    existingBody.style.display = open ? 'none' : 'block';
    existingToggle.textContent = (open ? '▸' : '▾') + ' Current rules for this site (' + existingKeyCount + ')';
  });
  existingSection.appendChild(existingToggle);
  existingSection.appendChild(existingBody);
  panel.appendChild(existingSection);

  // ── Textarea ──
  var body = document.createElement('div');
  body.className = 'qkv1-editor-ui';
  body.style.cssText = 'flex:1;display:flex;flex-direction:column;padding:10px 14px;min-height:0;';
  var hint = document.createElement('div');
  hint.className = 'qkv1-editor-ui';
  hint.textContent = 'One "key = value | value2" per line. Click a key above to insert it. No [section] headers. ' +
    'Rules typed here are ADDED to any existing rules for this key (see above) — this cannot remove or override a ' +
    'built-in rule, and for single-value flag keys the built-in value usually still wins.';
  hint.style.cssText = 'font:10px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#64748b;margin-bottom:6px;';
  body.appendChild(hint);
  var textarea = document.createElement('textarea');
  textarea.className = 'qkv1-editor-ui';
  textarea.id = 'qkv1-rule-textarea';
  textarea.value = initialText || '';
  textarea.spellcheck = false;
  textarea.style.cssText = 'flex:1;width:100%;box-sizing:border-box;resize:none;' +
    'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f172a;color:#e2e8f0;' +
    'border:1px solid #334155;border-radius:6px;padding:8px;';
  body.appendChild(textarea);

  var status = document.createElement('div');
  status.className = 'qkv1-editor-ui';
  status.style.cssText = 'font:11px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#34d399;min-height:16px;margin-top:6px;';
  body.appendChild(status);

  var actions = document.createElement('div');
  actions.className = 'qkv1-editor-ui';
  actions.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;margin-top:4px;';
  var cancelBtn = _mkBtn('Close', false);
  var saveBtn = _mkBtn('Save', true);
  cancelBtn.addEventListener('click', _exitEditorMode);
  saveBtn.addEventListener('click', function () {
    var text = textarea.value;
    status.textContent = '';
    try {
      chrome.runtime.sendMessage({ type: 'SAVE_SITE_RULE_TEXT', host: host, text: text }, function (res) {
        void chrome.runtime.lastError;
        if (res && res.ok) {
          status.textContent = 'Saved — reload this page to see the rules applied.';
        } else {
          status.style.color = '#f87171';
          status.textContent = 'Save failed — check for a stray "[section]" line or a huge paste.';
        }
      });
    } catch (e) {}
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  body.appendChild(actions);

  panel.appendChild(body);
  document.documentElement.appendChild(panel);
  _panelEl = panel;
  textarea.focus();
}

function _removePanel() {
  if (_panelEl) { try { _panelEl.remove(); } catch (e) {} _panelEl = null; }
}

function _onKeyDown(ev) {
  if (!_active) return;
  if (ev.key === 'Escape' && !_ownNode(ev.target)) _exitEditorMode();
}

function _enterEditorMode() {
  if (_active) return;
  _active = true;
  document.addEventListener('keydown', _onKeyDown, true);
  var host = location.hostname;
  try {
    chrome.runtime.sendMessage({ type: 'GET_SITE_RULE_TEXT', host: host }, function (res) {
      void chrome.runtime.lastError;
      if (!_active) return; // cancelled before the round trip returned
      _buildPanel(host, res && res.ok ? res.text : '', res && res.ok ? res.existingText : '');
    });
  } catch (e) {
    _buildPanel(host, '', '');
  }
}
function _exitEditorMode() {
  _active = false;
  document.removeEventListener('keydown', _onKeyDown, true);
  _removePanel();
}

try {
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg && msg.type === 'QKV1_ENTER_RULE_EDITOR_MODE') {
      _enterEditorMode();
      sendResponse({ ok: true });
    }
  });
} catch (e) {}
})();
