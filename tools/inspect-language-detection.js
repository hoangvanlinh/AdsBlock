// inspect-language-detection.js — diagnostic script, NOT run via Node.
//
// How to run:
//   1. chrome://extensions → enable Developer mode → find this extension →
//      click "service worker" (Chrome) or "Inspect" (Firefox: about:debugging
//      → This Firefox → Inspect on this extension → Console).
//   2. Paste this whole file into the DevTools Console that opens and press
//      Enter. It only reads chrome.storage.local — no writes, safe to run
//      anytime.
//
// Answers "why did source X get auto-enabled?" — live-reported (2026-09-24):
// on a Windows machine, Vietnam + Thai + France Rule Sources all got
// auto-enabled at once, more than expected. Root cause: langCandidates()
// (shared/utils.js) used to push the WHOLE navigator.languages array (every
// language the OS/browser has configured, e.g. secondary keyboard layouts —
// Windows commonly accumulates more of these than macOS), not just the
// single primary navigator.language, and background.js's
// _autoEnableLangDefaultSources() is an ANY-candidate-matches consumer.
// FIXED the same day: langCandidates() now only reads navigator.language
// (+ EXT.i18n.getUILanguage()) — navigator.languages is intentionally no
// longer part of the signal. This script still shows exactly which signal
// (primary language or timezone) is responsible for each match, and
// cross-references against what's actually stored in
// defaultRuleSourceOverrides right now.
(async () => {
  function fnOrNote(name) {
    return typeof self[name] === 'function'
      ? self[name]
      : (() => { throw new Error(`${name} not in scope — paste this into the extension's OWN service worker console, not a page's.`); });
  }
  const candidateUILanguages = fnOrNote('_candidateUILanguages');
  const uiLanguageMatches = fnOrNote('_uiLanguageMatches');
  const entryLangs = fnOrNote('_entryLangs');
  const primaryUrl = fnOrNote('_primaryUrl');
  const tzCandidates = typeof timezoneLangCandidates === 'function' ? timezoneLangCandidates() : [];
  const langOnlyCandidates = typeof langCandidates === 'function' ? langCandidates() : [];

  console.log('=== Raw signals ===');
  console.log('navigator.language (primary — the only navigator.* signal langCandidates() reads):', typeof navigator !== 'undefined' ? navigator.language : '(n/a)');
  console.log('navigator.languages (full OS/browser \'Preferred languages\' list — shown for reference only, NOT used by langCandidates() anymore):', typeof navigator !== 'undefined' ? navigator.languages : '(n/a)');
  console.log('EXT.i18n.getUILanguage():', (typeof EXT !== 'undefined' && EXT.i18n && EXT.i18n.getUILanguage) ? EXT.i18n.getUILanguage() : '(n/a)');
  console.log('Intl timezone:', typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '(n/a)');
  console.log('timezoneLangCandidates() result:', tzCandidates.length ? tzCandidates : '(no TIMEZONE_LANG_MAP entry for this timezone)');

  console.log('\n=== Combined candidate list (langCandidates() + timezone, in this exact order — first match wins for the UI-language "Auto" picker, but NOT for the auto-enable check below, which accepts ANY match) ===');
  console.table(candidateUILanguages().map((c, i) => ({
    index: i,
    candidate: c,
    source: i < langOnlyCandidates.length
      ? (i === 0 && (typeof EXT !== 'undefined' && EXT.i18n && EXT.i18n.getUILanguage && EXT.i18n.getUILanguage()) ? 'EXT.i18n.getUILanguage()' : 'navigator.language')
      : 'timezoneLangCandidates()',
  })));

  const { defaultRuleSourceOverrides = {}, defaultRuleSourceEnabled } = await chrome.storage.local.get(['defaultRuleSourceOverrides', 'defaultRuleSourceEnabled']);
  const legacyAllDisabled = defaultRuleSourceEnabled === false;

  console.log('\n=== Every Rule Source with a `lang` field — does it match, and via which exact candidate? ===');
  const rows = [];
  for (const entry of RULES_REMOTE_URL) {
    const langs = entryLangs(entry);
    if (!langs.length) continue;
    const key = primaryUrl(entry);
    const matchedLangs = langs.filter(l => uiLanguageMatches(l));
    const matchedVia = [];
    if (matchedLangs.length) {
      const allCands = candidateUILanguages();
      for (const l of matchedLangs) {
        const target = String(l).toLowerCase();
        for (const cand of allCands) {
          const c = String(cand).toLowerCase();
          if (c === target || c.startsWith(target + '-')) matchedVia.push(`${l}←${cand}`);
        }
      }
    }
    const hasOverride = Object.prototype.hasOwnProperty.call(defaultRuleSourceOverrides, key);
    const currentlyEnabled = hasOverride ? defaultRuleSourceOverrides[key] : (entry.enable !== false && !legacyAllDisabled);
    rows.push({
      name: entry.name,
      langs: langs.join(','),
      matches: matchedLangs.length > 0,
      'matched via': matchedVia.join(', ') || '—',
      'currently enabled': currentlyEnabled,
      'override stored?': hasOverride ? (defaultRuleSourceOverrides[key] ? 'yes (true)' : 'yes (false — user disabled)') : 'no (using manifest default)',
    });
  }
  console.table(rows);

  console.log('\nNote: a match here only means _autoEnableLangDefaultSources() WOULD set an override to true the next time it runs AND no override key exists yet for that source (it never re-enables one you turned back off — see "override stored?" above). It does not retroactively disable anything; toggle unwanted sources off in the dashboard\'s Rule Sources page, and they stay off.');
})();
