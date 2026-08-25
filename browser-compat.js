// browser-compat.js — one shared alias for every file instead of typing
// chrome. directly. self.EXT defaults to a pure reference to chrome (0
// behavior change) since live Firefox testing this session confirmed the
// chrome.* compat shim works fine for every API except storage.session —
// self.EXT_SESSION_STORAGE is the one deliberate exception, preferring the
// native browser.storage.session (Promise-based, feature-complete) over the
// shim, mirroring uBlock Origin Lite's ext-compat.js resolution order
// (platform/mv3/extension/js/ext-compat.js: `webext = self.browser || self.chrome`).
//
// Dual-loaded the same way config.js already is: background.js pulls it in
// via importScripts('browser-compat.js') on Chrome / lists it in
// manifest.firefox.json's background.scripts array on Firefox; content
// scripts get it from the content_scripts js array (isolated world only —
// content/scriptlets.js's MAIN-world entry has zero chrome.*/browser.*
// access by design and must never load this file); dashboard/popup/blocked
// pages get it from a <script> tag before their own .js.
if (!self.EXT) {
  self.EXT = chrome;
}
if (!self.EXT_SESSION_STORAGE) {
  self.EXT_SESSION_STORAGE = (typeof browser !== 'undefined' && browser.storage && browser.storage.session)
    ? browser.storage.session
    : (chrome.storage && chrome.storage.session);
}
