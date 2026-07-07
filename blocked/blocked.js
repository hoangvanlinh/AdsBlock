// blocked.js — malware/phishing warning page.
// The DNR main_frame redirect rule lands here with ?h=<blocked hostname>;
// report it to the service worker so "Malware blocked" stats include
// navigation blocks (no content script ever runs on the blocked site).
'use strict';

const host = (new URLSearchParams(location.search).get('h') || '').toLowerCase();
document.getElementById('host').textContent = host || 'unknown site';

// sessionStorage guard: a reload of this page must not count the block twice
const countedKey = 'adblock-malware-counted:' + host;
if (host && !sessionStorage.getItem(countedKey)) {
  sessionStorage.setItem(countedKey, '1');
  try {
    chrome.runtime.sendMessage({ type: 'MALWARE_PAGE_BLOCKED', host }, () => {
      void chrome.runtime.lastError; // ignore — counting is best-effort
    });
  } catch { /* extension context gone */ }
}

document.getElementById('back').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else window.close();
});
