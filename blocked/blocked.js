// blocked.js — malware/phishing and ad-popup warning page.
// The DNR main_frame redirect rules land here with ?h=<blocked hostname>
// and, for ad-network/popunder hits, &t=ad; report it to the service worker
// so stats include navigation blocks (no content script ever runs on the
// blocked site, so this message is the only way they get counted).
'use strict';

const params = new URLSearchParams(location.search);
const host = (params.get('h') || '').toLowerCase();
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

document.getElementById('back').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else window.close();
});
