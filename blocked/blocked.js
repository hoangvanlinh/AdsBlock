// blocked.js — malware/phishing and ad-popup warning page.
// The DNR main_frame redirect rules land here with ?h=<blocked hostname>
// and, for ad-network/popunder hits, &t=ad; report it to the service worker
// so stats include navigation blocks (no content script ever runs on the
// blocked site, so this message is the only way they get counted).
'use strict';

const params = new URLSearchParams(location.search);
// The DNR redirect rules are supposed to capture a bare hostname only
// (MALWARE_REDIRECT_REGEX in background.js stops at the first '/' or ':'),
// but a defensive strip here too — split off any path/query/fragment/port
// that leaks through — matters a lot more now than it looks: an unstripped
// value doesn't just show ugly text, it's also what gets persisted by
// "Don't warn me again" (PROCEED_BLOCKED_HOST) into the allowedDomains
// exception list. A value like "example.com/AbC123" is not a valid domain,
// so the DNR requestDomains condition built from it never matches anything
// — the checkbox silently does nothing and the warning keeps coming back,
// live-reported 2026-08-23.
const host = (params.get('h') || '').toLowerCase().split(/[/?#]/)[0].split(':')[0];
const isAdPopup = params.get('t') === 'ad';
document.getElementById('host').textContent = host || EXT.i18n.getMessage('blocked_host_unknown');

if (isAdPopup) {
  document.getElementById('icon').textContent = '🛑';
  document.getElementById('title').textContent = EXT.i18n.getMessage('blocked_title_adPopup');
  document.getElementById('hint').textContent = EXT.i18n.getMessage('blocked_hint_adPopup');
}

// sessionStorage guard: a reload of this page must not count the block twice
const countedKey = 'adblock-block-counted:' + host;
if (host && !sessionStorage.getItem(countedKey)) {
  sessionStorage.setItem(countedKey, '1');
  try {
    EXT.runtime.sendMessage({ type: isAdPopup ? 'AD_POPUP_PAGE_BLOCKED' : 'MALWARE_PAGE_BLOCKED', host }, () => {
      void EXT.runtime.lastError; // ignore — counting is best-effort
    });
  } catch { /* extension context gone */ }
}

// Two DIFFERENT meanings for "Don't warn me again", depending on which
// button it's paired with — these are NOT the same mechanism:
//   - Go back / Close + checked  -> AUTO-DECLINE next time: still shows
//     nothing and still doesn't visit the site, just skips asking again —
//     silently repeats the same close/back action on future encounters.
//     Pure local storage (autoDeclineHosts), no DNR/network change at all:
//     the block itself still fires exactly as before, only blocked.html's
//     OWN on-load behavior changes (see the auto-decline check below).
//   - Proceed + checked -> PERMANENT ALLOW next time: the site loads
//     directly, blocked.html never shows again at all — this is the
//     PROCEED_BLOCKED_HOST / allowedDomains mechanism (DNR allowAllRequests
//     override), unchanged from before.
// Corrected 2026-08-23 after initially building Go back/Close + checked to
// ALSO permanently allow the site — that's wrong: declining and silencing
// the warning are two separate decisions, and "I don't want to be asked
// again" must not quietly mean "let me through anyway".
const AUTO_DECLINE_KEY = 'autoDeclineHosts';

// MUST be awaited by the caller before the tab actually closes/navigates
// back — chrome.storage.local.set()'s callback firing is the only proof
// the write landed; closing (or even just navigating this frame away) any
// sooner risks tearing down this page's JS context mid-write, exactly the
// race that silently dropped the PROCEED_BLOCKED_HOST version of this same
// bug (2026-08-23).
function _saveAutoDeclineIfChecked() {
  if (!host || !document.getElementById('dontWarn')?.checked) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      EXT.storage.local.get(AUTO_DECLINE_KEY, (res) => {
        const list = (res && res[AUTO_DECLINE_KEY]) || [];
        if (list.includes(host)) { resolve(); return; }
        EXT.storage.local.set({ [AUTO_DECLINE_KEY]: [...list, host] }, () => {
          void EXT.runtime.lastError;
          resolve();
        });
      });
    } catch { resolve(); /* extension context gone */ }
  });
}

// PROACTIVE complement to autoDeclineHosts above: instead of only reacting
// after this exact popup already opened, block window.open() calls to this
// EXACT ad domain from firing at all on future visits to the site that
// spawned it (via no_window_open_if, scoped to the opener's own siteKey —
// background.js's SAVE_NO_WINDOW_OPEN_RULE / _applyNoWindowOpenRules).
// Only meaningful for the ad-popup case with a resolvable opener — see
// where openerHost gets set below. Only covers the window.open() vector,
// same limitation as the scriptlet itself; autoDeclineHosts still catches
// target="_blank" click-hijacks this can't.
function _saveNoWindowOpenRuleIfChecked() {
  if (!host || !openerHost || !isAdPopup || !document.getElementById('dontWarn')?.checked) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      EXT.runtime.sendMessage({ type: 'SAVE_NO_WINDOW_OPEN_RULE', openerHost, adHost: host }, () => {
        void EXT.runtime.lastError;
        resolve();
      });
    } catch { resolve(); /* extension context gone */ }
  });
}

// Two distinct cases share this one button: a malware/phishing hit that
// redirected the CURRENT tab (has real browsing history to go back to) vs.
// an ad-popup/click-hijack that opened a brand-new tab. history.length
// alone is NOT reliable for telling these apart: a spawned popup tab can
// still rack up history.length > 1 if the ad network bounced it through an
// internal redirect chain (landing page -> another redirect -> here) before
// this DNR rule ever caught it — "Go back" would then just return to that
// intermediate ad-funnel page instead of closing, which is wrong for a tab
// the user never actually asked to open. openerTabId is the reliable
// signal instead: Chrome sets it once, at tab-CREATION time, and it stays
// set no matter how many navigations happen inside that tab afterward — so
// it can't be fooled by a redirect chain the way history.length can.
const backBtn = document.getElementById('back');
let currentTabId;
let openerHost = '';
(async () => {
  let canGoBack = history.length > 1;
  let openerTabId;
  try {
    const tab = await EXT.tabs.getCurrent();
    if (tab) {
      currentTabId = tab.id;
      openerTabId = tab.openerTabId;
      if (tab.openerTabId !== undefined) canGoBack = false;
    }
  } catch { /* chrome.tabs.getCurrent unavailable — fall back to history.length */ }

  // Resolve the opener's hostname for _saveNoWindowOpenRuleIfChecked()
  // above — only meaningful for the ad-popup case (a same-tab malware
  // redirect has no "site that spawned a popup" to speak of). Best-effort:
  // an opener tab that's already closed, or whose URL this extension
  // doesn't have host permission for, just means that extra layer doesn't
  // fire for this decline — autoDeclineHosts still fully covers it either way.
  if (isAdPopup && openerTabId !== undefined) {
    try {
      const openerTab = await EXT.tabs.get(openerTabId);
      if (openerTab && openerTab.url) openerHost = new URL(openerTab.url).hostname.toLowerCase();
    } catch { /* opener already gone, or URL unavailable — skip */ }
  }

  const doClose = async () => {
    if (canGoBack) { history.back(); return; }
    // window.close() only works on a tab the PAGE ITSELF opened via
    // window.open() — Chrome silently no-ops it otherwise. A lot of
    // ad-network click-hijacks deliberately spawn their popup via a native
    // `target="_blank"` anchor click instead of window.open() specifically
    // to dodge window.open()-based popup blockers, and that same tab is
    // exactly the kind window.close() can't touch from in here — reported
    // live as "I clicked Close this window/Go back many times and nothing
    // happened" (2026-08-23). chrome.tabs.remove() is a privileged
    // extension API, not subject to that same-origin-opener restriction,
    // so it reliably closes the tab regardless of how it was opened.
    if (currentTabId !== undefined) {
      try { await EXT.tabs.remove(currentTabId); return; }
      catch { /* fall through to window.close() as a last resort */ }
    }
    window.close();
  };

  // This host was already declined-with-checkbox on an earlier visit —
  // skip the interactive warning entirely and just repeat the same
  // close/back action immediately, no click needed.
  if (host) {
    try {
      const declined = await new Promise((resolve) => {
        EXT.storage.local.get(AUTO_DECLINE_KEY, (res) => resolve((res && res[AUTO_DECLINE_KEY]) || []));
      });
      if (declined.includes(host)) { await doClose(); return; }
    } catch { /* fall through to the normal interactive flow */ }
  }

  backBtn.textContent = canGoBack ? EXT.i18n.getMessage('blocked_btn_goBack') : EXT.i18n.getMessage('blocked_btn_closeWindow');
  // The "Don't warn me again" checkbox is shared with the Proceed button
  // below, where it means the OPPOSITE thing (permanent allow, not
  // auto-decline) — ticking it while about to click Go back/Close instead
  // is disabled outright, rather than left ambiguous, so there's no path to
  // accidentally saving the wrong one of the two mutually-exclusive
  // outcomes for the same checkbox state.
  const dontWarnCheckbox = document.getElementById('dontWarn');
  if (dontWarnCheckbox) {
    const syncBackBtnDisabled = () => { backBtn.disabled = dontWarnCheckbox.checked; };
    dontWarnCheckbox.addEventListener('change', syncBackBtnDisabled);
    syncBackBtnDisabled();
  }
  backBtn.addEventListener('click', async () => {
    backBtn.disabled = true;
    await Promise.all([_saveAutoDeclineIfChecked(), _saveNoWindowOpenRuleIfChecked()]);
    await doClose();
  });
})();

// Proceed button plus a "Don't warn me again about this site" checkbox.
// Unchecked, the bypass only lasts this browser session (chrome.storage.
// session, cleared on restart); checked, it's added to the PERMANENT
// allowlist (same list/UI as the dashboard's Allowlist page) — a
// completely separate mechanism from the Go back/Close auto-decline list
// above (see the big comment near AUTO_DECLINE_KEY for why they must not
// be conflated). Always awaited: unlike Go back/Close, this path needs
// SOME exclusion (session or permanent) actually in effect before
// navigating, or the very same DNR rule would just redirect right back here.
const proceedBtn = document.getElementById('proceed');
if (!host) {
  proceedBtn.disabled = true;
} else {
  proceedBtn.addEventListener('click', async () => {
    const permanent = !!document.getElementById('dontWarn')?.checked;
    proceedBtn.disabled = true;
    proceedBtn.textContent = EXT.i18n.getMessage('blocked_btn_proceeding');
    try {
      await new Promise((resolve) => {
        EXT.runtime.sendMessage({ type: 'PROCEED_BLOCKED_HOST', host, permanent }, () => {
          void EXT.runtime.lastError; // best-effort — navigate regardless
          resolve();
        });
      });
    } catch { /* extension context gone — still try to navigate */ }
    location.href = 'https://' + host;
  });
}
