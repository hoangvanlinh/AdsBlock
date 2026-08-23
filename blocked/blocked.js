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
document.getElementById('host').textContent = host || 'unknown site';

if (isAdPopup) {
  document.getElementById('icon').textContent = '🛑';
  document.getElementById('title').textContent = 'Popup/new-tab ad blocked';
  document.getElementById('hint').textContent =
    'A click on the page you came from tried to open this ad/popup network in a new tab. ' +
    'You can safely close this tab.';
}

// sessionStorage guard: a reload of this page must not count the block twice
const countedKey = 'adblock-block-counted:' + host;
if (host && !sessionStorage.getItem(countedKey)) {
  sessionStorage.setItem(countedKey, '1');
  try {
    chrome.runtime.sendMessage({ type: isAdPopup ? 'AD_POPUP_PAGE_BLOCKED' : 'MALWARE_PAGE_BLOCKED', host }, () => {
      void chrome.runtime.lastError; // ignore — counting is best-effort
    });
  } catch { /* extension context gone */ }
}

// "Don't warn me again about this site" is a standalone preference, not
// tied to which button is pressed — its label makes no mention of
// proceeding, so ticking it and then clicking "Go back"/"Close this
// window" should still be remembered, not silently dropped just because
// the user chose not to visit the site right now.
//
// MUST be awaited by the caller before window.close()/history.back() run —
// sendMessage() returning does not mean the message has actually reached
// the service worker yet (it's still an async round trip under the hood,
// especially if the worker was asleep and needs to spin up). Fire-and-forget
// here would let window.close() tear down this page's JS context, and with
// it the in-flight request, before delivery — the "close this window" case
// specifically, where the tab (and this whole message) can vanish within a
// tick of the click, is exactly where that race was actually observed
// silently dropping the preference.
function _persistDontWarnIfChecked() {
  if (!host || !document.getElementById('dontWarn')?.checked) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'PROCEED_BLOCKED_HOST', host, permanent: true }, () => {
        void chrome.runtime.lastError;
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
(async () => {
  let canGoBack = history.length > 1;
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab) {
      currentTabId = tab.id;
      if (tab.openerTabId !== undefined) canGoBack = false;
    }
  } catch { /* chrome.tabs.getCurrent unavailable — fall back to history.length */ }
  backBtn.textContent = canGoBack ? 'Go back' : 'Close this window';
  backBtn.addEventListener('click', async () => {
    backBtn.disabled = true;
    await _persistDontWarnIfChecked();
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
      try {
        await chrome.tabs.remove(currentTabId);
        return;
      } catch { /* fall through to window.close() as a last resort */ }
    }
    window.close();
  });
})();

// "Proceed anyway" — mirrors uBlock Origin's own document-blocked page: a
// Proceed button plus a "Don't warn me again about this site" checkbox.
// Unchecked, the bypass only lasts this browser session (chrome.storage.
// session, cleared on restart); checked, it's added to the permanent
// allowlist (same list/UI as the dashboard's Allowlist page — same message
// as _persistDontWarnIfChecked() above, just also awaited here since,
// unlike Go back/Close, this path needs SOME exclusion (session or
// permanent) actually in effect before navigating, or the very same DNR
// rule would just redirect right back here.
const proceedBtn = document.getElementById('proceed');
if (!host) {
  proceedBtn.disabled = true;
} else {
  proceedBtn.addEventListener('click', async () => {
    const permanent = !!document.getElementById('dontWarn')?.checked;
    proceedBtn.disabled = true;
    proceedBtn.textContent = 'Proceeding…';
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'PROCEED_BLOCKED_HOST', host, permanent }, () => {
          void chrome.runtime.lastError; // best-effort — navigate regardless
          resolve();
        });
      });
    } catch { /* extension context gone — still try to navigate */ }
    location.href = 'https://' + host;
  });
}
