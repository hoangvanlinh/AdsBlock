// shared/focus-mode.js — Pomodoro phase state machine, focus-session
// stats/streak, and per-site daily time-limit tracking for Focus Mode.
// Everything NEW added to Focus Mode lives here (by explicit user request:
// don't keep growing the already-large background.js) — background.js
// keeps only: the onMessage switch-case glue, the chrome.alarms dispatch
// table, and the two browser-event listeners that feed this module (tabs
// activation/update, window focus). There is deliberately NO DNR rule
// builder for Focus Mode anymore (removed 2026-09-18, see git history for
// buildFocusRules()/buildSiteLimitRules()): actual blocking is now a
// client-side overlay drawn over the real page — content/focus-block-
// overlay.js, its own file for the same "new logic, new file" reason as
// this one — which reads this file's storage keys directly instead of
// going through any background.js rule pipeline.
//
// This file NEVER calls into background.js (no applyNetworkRules(), no
// forward references to anything background.js defines) — everything here
// is pure state + storage reads/writes + return values that the CALLER
// (background.js) acts on. That's not a style preference: this file is
// dual-loaded BEFORE background.js on both browsers (see the loading story
// below), so background.js's private top-level functions plain don't exist
// yet at the point any of this file's top-level code could run.
//
// Existing Focus Mode keys this file reads/writes but does NOT own the
// definition of: `focusMode` (bool), `focusEndTime` (epoch ms),
// `focusDuration` (minutes), `distractionDomains` (string[]) — all seeded
// by background.js's onInstalled handler. This file leaves those alone
// except for `focusEndTime`, which startSession()/onPhaseAlarm() below
// advance from phase to phase.
//
// New keys this file owns entirely:
//   pomodoroEnabled            bool, default false
//   focusBreakDuration         minutes, default 5
//   focusLongBreakDuration     minutes, default 15
//   focusCyclesBeforeLongBreak int, default 4
//   focusPhase                 'work' | 'shortBreak' | 'longBreak' | null
//   focusCycleCount            int — completed WORK phases this run
//   focusStats                 { [dateKey]: {completed}, streak: {current, longest, lastCompletedDate} }
//   siteTimeLimits             { [domain]: minutesPerDay }
//   siteTimeSpent              { [dateKey]: { [domain]: minutesSpentThatDay } }
//   siteLimitsExceededToday    { date: 'YYYY-MM-DD', domains: string[] } — the derived key
//                               content/focus-block-overlay.js reads (via its own
//                               storage.onChanged listener) to know which sites to cover.
//
// Dual-loaded the same way shared/session-storage.js/shared/local-storage.js
// already are: Chrome pulls this in via importScripts() near the top of
// background.js (after local-storage.js, which this file's own storage
// reads/writes go through); Firefox lists "shared/focus-mode.js" in
// manifest.firefox.json's background.scripts array, after
// shared/session-storage.js and before shared/background.js. Either way,
// self.LocalStorage and self.EXT must already exist by the time this file's
// top-level code runs — it never touches storage at load time (only inside
// exported functions, called later), so the exact load order relative to
// this file's own body doesn't matter, only that it's satisfied before any
// exported function is actually CALLED, which background.js's own loading
// order already guarantees.
(function () {
if (self.FocusMode) return; // idempotent if ever loaded twice

var LocalStorage = self.LocalStorage;

// ── Constants (single source of truth — dashboard.js/popup.js/background.js
// all read these off self.FocusMode.* instead of each hardcoding their own
// copy, closing the 3-way duplication this feature's own design doc flagged
// in the pre-existing code: DISTRACTION_DEFAULTS lived separately in both
// background.js and dashboard.js, and the default 25-minute duration was a
// bare literal in three different files.) ──
var DISTRACTION_DEFAULTS = [
  'x.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'reddit.com',
  'twitch.tv', 'netflix.com', 'pinterest.com', 'snapchat.com', 'tumblr.com', '9gag.com', 'threads.net',
];
var DEFAULT_FOCUS_DURATION_MIN = 25;
var DEFAULT_BREAK_MIN = 5;
var DEFAULT_LONG_BREAK_MIN = 15;
var DEFAULT_CYCLES_BEFORE_LONG_BREAK = 4;

function _pad2(n) { return String(n).padStart(2, '0'); }
// Local-calendar-day key — deliberately NOT background.js's own todayKey()
// (that function is never exported to `self`, and this file loads before
// background.js anyway — see this file's own header comment for why a
// small duplicate is the right call here, same reasoning as content.js's
// own copy of _domainSetMatches()).
function _dateKey(d) {
  return d.getFullYear() + '-' + _pad2(d.getMonth() + 1) + '-' + _pad2(d.getDate());
}
function _todayKey() { return _dateKey(new Date()); }
function _yesterdayKey() {
  var d = new Date();
  d.setDate(d.getDate() - 1);
  return _dateKey(d);
}

// ── Auto-close tabs already open on a distracting/limit-exceeded site ──
// A browser extension has no API to hide Chrome's own tab strip/address
// bar (raised and explicitly declined earlier as a feature — not
// possible), but the DNR redirect rules above only stop FUTURE navigation
// attempts: a tab that was ALREADY sitting open on twitter.com before the
// focus session started, or before a site's daily limit ticked over, keeps
// showing that page indefinitely since nothing re-navigates it. Closing
// those tabs outright is the closest real equivalent to "hide it" an
// extension can do. Deliberately a ONE-TIME sweep at the moment a trigger
// fires (session start / a site newly crossing its limit) — NOT re-run on
// every tick or navigation, which would mean yanking a tab out from under
// the user mid-click; the blocked.html redirect already covers every
// attempt after this sweep runs once.
function _hostMatchesAnyDomain(host, domains) {
  var h = host;
  while (h) {
    if (domains.indexOf(h) !== -1) return true;
    var dot = h.indexOf('.');
    if (dot === -1) break;
    h = h.slice(dot + 1);
  }
  return false;
}

// Errors are swallowed internally either way (a single already-closed tab
// or a permission hiccup on one tab must never abort the rest of the
// sweep, or the caller that triggered it) — startSession() awaits this
// call, recomputeExceededToday()'s own call further down does NOT (that
// one fires off the per-minute tick's hot path, where the DNR rebuild it
// triggered is already the part that matters for correctness).
async function closeTabsForDomains(domains) {
  if (!domains || !domains.length || !EXT.tabs || !EXT.tabs.query) return;
  try {
    var tabs = await EXT.tabs.query({});
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      if (!tab.url) continue;
      var host;
      try { host = new URL(tab.url).hostname.toLowerCase(); } catch (e) { continue; }
      if (_hostMatchesAnyDomain(host, domains)) {
        try { await EXT.tabs.remove(tab.id); } catch (e) {}
      }
    }
  } catch (e) {}
}

// ── Pomodoro phase state machine ─────────────────────────────────────
// startSession()/stopSession() are called from background.js's FOCUS_MODE
// message handler. They intentionally do NOT compute focusEndTime
// themselves — dashboard.js/popup.js already compute and write
// focusEndTime/focusDuration to storage BEFORE sending the message (this
// predates this file and is left unchanged), so this just arms the
// 'focus-end' alarm against whatever's already there and resets the
// per-run phase/cycle counters to a fresh work phase.
//
// Note: an earlier version of this feature also force-switched the current
// window to fullscreen here (chrome.windows.update state:'fullscreen') as
// the closest extension-API equivalent to "hide the tab strip/address bar/
// bookmarks bar" — removed by explicit user request (2026-09-18): the
// OS-taskbar-hiding, single-window side effects weren't worth it, and site
// blocking + closeTabsForDomains() + the input guard already cover the
// actual distraction surface without touching window chrome at all.
async function startSession() {
  await LocalStorage.set({ focusPhase: 'work', focusCycleCount: 0 });
  var res = await LocalStorage.get(['focusEndTime', 'distractionDomains']);
  var focusEndTime = res.focusEndTime;
  if (focusEndTime && focusEndTime > Date.now()) {
    try { EXT.alarms.create('focus-end', { when: focusEndTime }); } catch (e) {}
  }
  // Awaited (unlike recomputeExceededToday()'s own sweep below, which is
  // fire-and-forget off the per-minute tick's hot path) — this only runs
  // once, right when the user deliberately starts a session, so there is
  // no hot path to protect, and the FOCUS_MODE message's sendResponse
  // should reflect tabs actually being gone, not "probably gone soon".
  await closeTabsForDomains(res.distractionDomains || DISTRACTION_DEFAULTS);
}

async function stopSession() {
  await LocalStorage.set({ focusPhase: null, focusCycleCount: 0 });
  try { EXT.alarms.clear('focus-end'); } catch (e) {}
}

// onPhaseAlarm() — called by background.js's onAlarm listener when
// alarm.name === 'focus-end'. Two shapes, both driven by the SAME alarm
// name (no new alarm needed for Pomodoro — see this file's own design doc):
//   - pomodoroEnabled:false (today's ORIGINAL single-session behavior,
//     byte-for-byte unchanged): the one work phase that just ended
//     completes naturally -> record it -> fully disable.
//   - pomodoroEnabled:true: alternate work -> short break -> work -> ... ->
//     long break every `focusCyclesBeforeLongBreak` completed work phases,
//     forever, until the user manually calls stopSession() (there is no
//     "total N pomodoros then stop" concept — matches how most Pomodoro
//     tools behave, and avoids a second duration-like setting nobody asked
//     for). A completed work phase (never a break) is what
//     recordSessionCompleted() credits — an early manual stop mid-phase
//     never reaches this function at all, so it never gets credited,
//     deliberately (see recordSessionCompleted()'s own comment).
// Deliberately does NOT unblock distraction sites during a break: this
// feature's whole scope is "block distracting sites while focusing" —
// breaks are for resting, not for opening Twitter — so content/focus-
// block-overlay.js needs zero changes for breaks at all: it only ever
// checks `focusMode` (stays true through every phase) and
// `distractionDomains` (unchanged), so the overlay stays up identically
// across work/break phases.
async function onPhaseAlarm() {
  var s = await LocalStorage.get([
    'pomodoroEnabled', 'focusPhase', 'focusCycleCount',
    'focusDuration', 'focusBreakDuration', 'focusLongBreakDuration', 'focusCyclesBeforeLongBreak',
  ]);
  var pomodoroEnabled = !!s.pomodoroEnabled;

  if (!pomodoroEnabled) {
    await recordSessionCompleted();
    await LocalStorage.set({ focusMode: false, focusEndTime: null, focusPhase: null, focusCycleCount: 0 });
    try { EXT.alarms.clear('focus-end'); } catch (e) {}
    return { done: true };
  }

  var phase = s.focusPhase || 'work';
  var cyclesBeforeLongBreak = s.focusCyclesBeforeLongBreak || DEFAULT_CYCLES_BEFORE_LONG_BREAK;
  var cycleCount = s.focusCycleCount || 0;
  var nextPhase, durationMin;

  if (phase === 'work') {
    await recordSessionCompleted();
    cycleCount += 1;
    if (cycleCount % cyclesBeforeLongBreak === 0) {
      nextPhase = 'longBreak';
      durationMin = s.focusLongBreakDuration || DEFAULT_LONG_BREAK_MIN;
    } else {
      nextPhase = 'shortBreak';
      durationMin = s.focusBreakDuration || DEFAULT_BREAK_MIN;
    }
  } else {
    // shortBreak or longBreak just ended -> back to work.
    nextPhase = 'work';
    durationMin = s.focusDuration || DEFAULT_FOCUS_DURATION_MIN;
  }

  var focusEndTime = Date.now() + durationMin * 60000;
  await LocalStorage.set({ focusEndTime: focusEndTime, focusPhase: nextPhase, focusCycleCount: cycleCount });
  try { EXT.alarms.create('focus-end', { when: focusEndTime }); } catch (e) {}
  return { done: false, phase: nextPhase, cycle: cycleCount, focusEndTime: focusEndTime };
}

// ── Session stats / streak ───────────────────────────────────────────
// Own serialized write queue (background.js's own _statsWriteChain guards
// a DISJOINT key set — 'stats'/'dailyStats' — so there's no cross-key race
// to share a queue over even if this file COULD reach into that variable,
// which it can't: this file loads before background.js, see the header).
var _focusWriteChain = Promise.resolve();
function _enqueueFocusWrite(fn) {
  _focusWriteChain = _focusWriteChain.then(fn).catch(function (e) {
    console.warn('[AdBlock][FocusMode] stats write error:', e);
  });
  return _focusWriteChain;
}

var FOCUS_STATS_KEY = 'focusStats';
var FOCUS_STATS_MAX_DAYS = 30; // same retention as background.js's own dailyStats

// Only ever called when a WORK phase completes naturally via onPhaseAlarm()
// above (either single-session mode's one phase, or one cycle of a running
// Pomodoro) — an early manual stop (stopSession(), called from the
// FOCUS_MODE{enabled:false} handler) never calls this. Deliberate
// definition: credit only a session that actually ran its full course,
// matching typical Pomodoro-app gamification and not rewarding abandonment.
async function recordSessionCompleted() {
  return _enqueueFocusWrite(async function () {
    var res = await LocalStorage.get(FOCUS_STATS_KEY);
    var stats = res[FOCUS_STATS_KEY] || {};
    var today = _todayKey();
    if (!stats[today]) stats[today] = { completed: 0 };
    stats[today].completed += 1;

    var dateKeys = Object.keys(stats).filter(function (k) { return k !== 'streak'; }).sort();
    while (dateKeys.length > FOCUS_STATS_MAX_DAYS) { delete stats[dateKeys.shift()]; }

    var streak = stats.streak || { current: 0, longest: 0, lastCompletedDate: null };
    if (streak.lastCompletedDate === today) {
      // Already credited once today — streak itself doesn't change on a 2nd+ session same day.
    } else if (streak.lastCompletedDate === _yesterdayKey()) {
      streak.current = (streak.current || 0) + 1;
    } else {
      streak.current = 1;
    }
    streak.longest = Math.max(streak.longest || 0, streak.current);
    streak.lastCompletedDate = today;
    stats.streak = streak;

    await LocalStorage.set((function () { var o = {}; o[FOCUS_STATS_KEY] = stats; return o; })());
  });
}

// ── Per-site daily time limits ───────────────────────────────────────
// Resolution floor: MV3 service workers can't hold a persistent
// setInterval (killed after ~30s idle) — chrome.alarms is the only thing
// that survives that, and Chrome clamps alarm periods to a ~1-minute
// floor. So this can never do better than ±1 minute resolution. Design
// choice, stated plainly: this ALWAYS undercounts relative to real usage,
// NEVER overcounts —
//   - minimized/no window focused: setWindowFocused(false) (from
//     background.js's windows.onFocusChanged) makes onSiteLimitTick()
//     attribute ZERO time while that holds, not an estimate.
//   - multiple windows: only ONE hostname is ever held in _activeHostname
//     at a time (whichever tab is active in the OS-focused window) —
//     background windows structurally cannot contribute.
//   - the same limited domain open in two tabs at once: still only ONE
//     hostname in _activeHostname at a time, so this cannot double-count
//     no matter how many other tabs on that domain sit in the background.
//   - the computer sleeping: chrome.alarms simply don't fire during sleep,
//     and this never back-fills/extrapolates a wall-clock delta on wake —
//     the next tick just attributes exactly 1 more minute, like any other
//     tick. No code path here ever computes anything from a Date.now()
//     delta, only "did one whole alarm period elapse while focused on this
//     domain", so overcounting on wake is not possible by construction.
var _activeHostname = null;
var _windowFocused = true; // no signal yet at SW cold-start is the common case; assume focused rather than silently under-tracking from minute one

function setActiveTab(hostname) { _activeHostname = hostname || null; }
function setWindowFocused(focused) { _windowFocused = !!focused; }

// Walks host's own registrable-domain suffixes looking for a configured
// limit — same technique/shape as background.js's own _walkDomainMatches(),
// reimplemented (not imported) for the same reason as every other small
// duplicate in this codebase across a load-order boundary: this file loads
// BEFORE background.js, so that function doesn't exist yet even if it were
// exported (it isn't). Takes a plain object (siteTimeLimits' own shape,
// {domain: minutes}), not a Map, unlike the background.js original.
function _walkLimitMatch(limits, host) {
  var h = host;
  while (h) {
    if (Object.prototype.hasOwnProperty.call(limits, h)) return h;
    var dot = h.indexOf('.');
    if (dot === -1) break;
    h = h.slice(dot + 1);
  }
  return null;
}

var SITE_TIME_SPENT_MAX_DAYS = 8; // only "today" is ever read for enforcement; a short trailing history is kept cheaply in case of a future "this week" display, no more

// Called by background.js's onAlarm listener for the 'focus-site-limit-tick'
// alarm (armed once via background.js's existing _ensureAlarm() helper,
// periodInMinutes:1). Returns {changed:bool} so the caller knows whether a
// DNR rebuild is actually warranted — most ticks (no limited site focused,
// or a limited site focused but still under budget) change nothing.
async function onSiteLimitTick() {
  if (!_windowFocused || !_activeHostname) return { changed: false };

  var stored = await LocalStorage.get(['siteTimeLimits', 'siteTimeSpent']);
  var limits = stored.siteTimeLimits || {};
  var matchedKey = _walkLimitMatch(limits, _activeHostname);
  if (!matchedKey) return { changed: false };

  var today = _todayKey();
  var spent = stored.siteTimeSpent || {};
  if (!spent[today]) spent[today] = {};
  spent[today][matchedKey] = (spent[today][matchedKey] || 0) + 1;

  var dateKeys = Object.keys(spent).sort();
  while (dateKeys.length > SITE_TIME_SPENT_MAX_DAYS) { delete spent[dateKeys.shift()]; }

  await LocalStorage.set({ siteTimeSpent: spent });
  return recomputeExceededToday();
}

// Recomputes siteLimitsExceededToday from the CURRENT siteTimeLimits +
// siteTimeSpent without attributing any additional time — called both by
// onSiteLimitTick() above (after a tick moves a site's spent-today count)
// and by background.js's SITE_LIMITS_CHANGED handler (after the user
// edits/removes a limit in the dashboard, which can immediately un-exceed
// a site with no need to wait for the next minute's tick). Only WRITES
// siteLimitsExceededToday when the exceeded set (or the date) actually
// changed — this is the one key background.js's RULE_INPUT_KEYS watches
// (see this file's own header comment), so writing it unconditionally on
// every single tick would defeat the whole point: a rebuild would only
// ever be worth triggering at the moment a crossing (or un-crossing)
// actually happens, never on every no-op minute in between.
async function recomputeExceededToday() {
  var stored = await LocalStorage.get(['siteTimeLimits', 'siteTimeSpent', 'siteLimitsExceededToday']);
  var limits = stored.siteTimeLimits || {};
  var today = _todayKey();
  var spentToday = (stored.siteTimeSpent && stored.siteTimeSpent[today]) || {};

  var exceeded = [];
  for (var domain in limits) {
    if (!Object.prototype.hasOwnProperty.call(limits, domain)) continue;
    var limitMin = limits[domain];
    var usedMin = spentToday[domain] || 0;
    if (limitMin > 0 && usedMin >= limitMin) exceeded.push(domain);
  }
  exceeded.sort();

  var prev = stored.siteLimitsExceededToday;
  var prevDomains = (prev && prev.date === today) ? (prev.domains || []).slice().sort() : [];
  var changed = !prev || prev.date !== today || JSON.stringify(exceeded) !== JSON.stringify(prevDomains);

  if (changed) {
    await LocalStorage.set({ siteLimitsExceededToday: { date: today, domains: exceeded } });
    // Only the domains that are NEWLY exceeded (not the whole list every
    // time) — a domain already exceeded since an earlier tick already had
    // its chance to be swept, and re-sweeping it on every later no-op
    // change would just be pointless repeated tab-close attempts. On the
    // very first computation of the day (prev undefined) prevDomains is
    // [], but exceeded is normally [] too at that point (a site can't
    // already be over budget before its first tick recorded any time), so
    // this does not fire a surprise sweep at day-start in the common case.
    var newlyExceeded = exceeded.filter(function (d) { return prevDomains.indexOf(d) === -1; });
    if (newlyExceeded.length) closeTabsForDomains(newlyExceeded);
  }
  return { changed: changed };
}

// Read-only accessor — currently unused internally (content/focus-block-
// overlay.js reads siteLimitsExceededToday from storage directly instead,
// via its own storage.onChanged listener), kept exported for any future
// background.js/dashboard.js caller that wants today's exceeded list
// without re-deriving the date-rollover check below. Returns [] (not the
// stale prior day's list) once the calendar day has rolled over but the
// tick alarm hasn't fired yet this minute to notice; the very next tick
// self-heals this within at most 1 minute either way.
async function getExceededDomainsToday() {
  var res = await LocalStorage.get('siteLimitsExceededToday');
  var entry = res.siteLimitsExceededToday;
  if (!entry || entry.date !== _todayKey()) return [];
  return entry.domains || [];
}

self.FocusMode = {
  DISTRACTION_DEFAULTS: DISTRACTION_DEFAULTS,
  DEFAULT_FOCUS_DURATION_MIN: DEFAULT_FOCUS_DURATION_MIN,
  DEFAULT_BREAK_MIN: DEFAULT_BREAK_MIN,
  DEFAULT_LONG_BREAK_MIN: DEFAULT_LONG_BREAK_MIN,
  DEFAULT_CYCLES_BEFORE_LONG_BREAK: DEFAULT_CYCLES_BEFORE_LONG_BREAK,

  startSession: startSession,
  stopSession: stopSession,
  onPhaseAlarm: onPhaseAlarm,

  recordSessionCompleted: recordSessionCompleted,

  setActiveTab: setActiveTab,
  setWindowFocused: setWindowFocused,
  onSiteLimitTick: onSiteLimitTick,
  recomputeExceededToday: recomputeExceededToday,
  getExceededDomainsToday: getExceededDomainsToday,

  closeTabsForDomains: closeTabsForDomains,
};
})();
