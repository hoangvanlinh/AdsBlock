// Inert stand-in for Google's IMA3 SDK (window.google.ima), used by many
// video players for ad bidding/placement (often alongside GPT/Prebid).
// Without a stub, pages calling into this API throw and the video player
// area is left as a black box instead of rendering the actual content
// video — this implements just enough of the real, documented IMA3
// surface (class/method/event names are Google's public API contract, not
// an implementation detail) so player code proceeds past ad setup straight
// to content playback.
(function () {
  'use strict';

  if (window.google && window.google.ima && window.google.ima.VERSION) return;

  const VERSION = '3.764.0';

  const noop = function () {};
  const returnsNull = function () { return null; };
  const returnsEmptyArray = function () { return []; };
  const returnsEmptyString = function () { return ''; };
  const returnsFalse = function () { return false; };

  // ── Minimal event target — every "class" below that needs to dispatch
  // IMA events (AdsLoader, AdsManager) composes this in via Object.assign
  // onto its prototype rather than a shared base class.
  function makeEventTarget() {
    const byType = new Map();
    return {
      addEventListener: function (types, handler, _options, context) {
        for (const type of Array.isArray(types) ? types : [types]) {
          if (!byType.has(type)) byType.set(type, new Map());
          byType.get(type).set(handler, context ? handler.bind(context) : handler);
        }
      },
      removeEventListener: function (types, handler) {
        for (const type of Array.isArray(types) ? types : [types]) {
          const forType = byType.get(type);
          if (forType) forType.delete(handler);
        }
      },
      _dispatch: function (event) {
        const forType = byType.get(event.type);
        if (!forType) return;
        for (const bound of Array.from(forType.values())) {
          try { bound(event); } catch (e) { console.error(e); }
        }
      },
    };
  }

  function AdDisplayContainer(containerEl) {
    // Real IMA renders ad creatives into a child div it manages; matching
    // that shape (rather than leaving containerEl untouched) keeps player
    // code that expects a child node to inspect/size from working.
    const placeholder = document.createElement('div');
    placeholder.style.setProperty('display', 'none', 'important');
    placeholder.style.setProperty('visibility', 'collapse', 'important');
    containerEl.appendChild(placeholder);
  }
  AdDisplayContainer.prototype.destroy = noop;
  AdDisplayContainer.prototype.initialize = noop;

  function ImaSdkSettings() {
    this._cookiesEnabled = true;
    this._featureFlags = {};
    this._iosCustomPlaybackDisabled = false;
    this._locale = '';
    this._playerType = '';
    this._playerVersion = '';
    this._ppid = '';
    this._numRedirects = 0;
  }
  Object.assign(ImaSdkSettings.prototype, {
    getCompanionBackfill: noop,
    getDisableCustomPlaybackForIOS10Plus: function () { return this._iosCustomPlaybackDisabled; },
    getDisableFlashAds: noop,
    getFeatureFlags: function () { return this._featureFlags; },
    getLocale: function () { return this._locale; },
    getNumRedirects: function () { return this._numRedirects; },
    getPlayerType: function () { return this._playerType; },
    getPlayerVersion: function () { return this._playerVersion; },
    getPpid: function () { return this._ppid; },
    isCookiesEnabled: function () { return this._cookiesEnabled; },
    setAutoPlayAdBreaks: noop,
    setCompanionBackfill: noop,
    setCookiesEnabled: function (v) { this._cookiesEnabled = !!v; },
    setDisableCustomPlaybackForIOS10Plus: function (v) { this._iosCustomPlaybackDisabled = !!v; },
    setDisableFlashAds: noop,
    setFeatureFlags: function (v) { this._featureFlags = v; },
    setLocale: function (v) { this._locale = v; },
    setNumRedirects: function (v) { this._numRedirects = v; },
    setPlayerType: function (v) { this._playerType = v; },
    setPlayerVersion: function (v) { this._playerVersion = v; },
    setPpid: function (v) { this._ppid = v; },
    setSessionId: noop,
    setVpaidAllowed: noop,
    setVpaidMode: noop,
  });
  ImaSdkSettings.CompanionBackfillMode = { ALWAYS: 'always', ON_MASTER_AD: 'on_master_ad' };
  ImaSdkSettings.VpaidMode = { DISABLED: 0, ENABLED: 1, INSECURE: 2 };

  function AdPodInfo() {}
  Object.assign(AdPodInfo.prototype, {
    getAdPosition: function () { return 1; },
    getIsBumper: returnsFalse,
    getMaxDuration: function () { return -1; },
    getPodIndex: function () { return 1; },
    getTimeOffset: function () { return 0; },
    getTotalAds: function () { return 1; },
  });

  function UniversalAdIdInfo() {}
  UniversalAdIdInfo.prototype.getAdIdRegistry = returnsEmptyString;
  UniversalAdIdInfo.prototype.getAdIdValue = returnsEmptyString;

  function Ad() {
    this._podInfo = new AdPodInfo();
  }
  Object.assign(Ad.prototype, {
    getAdId: returnsEmptyString,
    getAdPodInfo: function () { return this._podInfo; },
    getAdSystem: returnsEmptyString,
    getAdvertiserName: returnsEmptyString,
    getApiFramework: returnsNull,
    getCompanionAds: returnsEmptyArray,
    getContentType: returnsEmptyString,
    getCreativeAdId: returnsEmptyString,
    getCreativeId: returnsEmptyString,
    getDealId: returnsEmptyString,
    getDescription: returnsEmptyString,
    getDuration: function () { return 8.5; },
    getHeight: function () { return 0; },
    getMediaUrl: returnsNull,
    getMinSuggestedDuration: function () { return -2; },
    getSkipTimeOffset: function () { return -1; },
    getSurveyUrl: returnsNull,
    getTitle: returnsEmptyString,
    getTraffickingParameters: function () { return {}; },
    getTraffickingParametersString: returnsEmptyString,
    getUiElements: function () { return ['']; },
    getUniversalAdIdRegistry: function () { return 'unknown'; },
    getUniversalAdIds: function () { return [new UniversalAdIdInfo()]; },
    getUniversalAdIdValue: function () { return 'unknown'; },
    getVastMediaBitrate: function () { return 0; },
    getVastMediaHeight: function () { return 0; },
    getVastMediaWidth: function () { return 0; },
    getWidth: function () { return 0; },
    getWrapperAdIds: function () { return ['']; },
    getWrapperAdSystems: function () { return ['']; },
    getWrapperCreativeIds: function () { return ['']; },
    isLinear: function () { return true; },
    isSkippable: function () { return true; },
  });

  function CompanionAd() {}
  Object.assign(CompanionAd.prototype, {
    getAdSlotId: returnsEmptyString,
    getContent: returnsEmptyString,
    getContentType: returnsEmptyString,
    getHeight: function () { return 1; },
    getWidth: function () { return 1; },
  });

  function AdError(type, code, vastCode, message, request, context) {
    this.errorCode = code;
    this.message = message;
    this.type = type;
    this.adsRequest = request;
    this.userRequestContext = context;
    this.vastErrorCode = vastCode;
  }
  Object.assign(AdError.prototype, {
    getErrorCode: function () { return this.errorCode; },
    getInnerError: returnsNull,
    getMessage: function () { return this.message; },
    getType: function () { return this.type; },
    getVastErrorCode: function () { return this.vastErrorCode; },
    toString: function () { return 'AdError ' + this.errorCode + ': ' + this.message; },
  });
  AdError.ErrorCode = {};
  AdError.Type = {};

  const AD_EVENT_TYPE = {
    AD_BREAK_READY: 'adBreakReady',
    AD_BUFFERING: 'adBuffering',
    AD_CAN_PLAY: 'adCanPlay',
    AD_METADATA: 'adMetadata',
    AD_PROGRESS: 'adProgress',
    ALL_ADS_COMPLETED: 'allAdsCompleted',
    CLICK: 'click',
    COMPLETE: 'complete',
    CONTENT_PAUSE_REQUESTED: 'contentPauseRequested',
    CONTENT_RESUME_REQUESTED: 'contentResumeRequested',
    DURATION_CHANGE: 'durationChange',
    EXPANDED_CHANGED: 'expandedChanged',
    FIRST_QUARTILE: 'firstQuartile',
    IMPRESSION: 'impression',
    INTERACTION: 'interaction',
    LINEAR_CHANGE: 'linearChange',
    LINEAR_CHANGED: 'linearChanged',
    LOADED: 'loaded',
    LOG: 'log',
    MIDPOINT: 'midpoint',
    PAUSED: 'pause',
    RESUMED: 'resume',
    SKIPPABLE_STATE_CHANGED: 'skippableStateChanged',
    SKIPPED: 'skip',
    STARTED: 'start',
    THIRD_QUARTILE: 'thirdQuartile',
    USER_CLOSE: 'userClose',
    VIDEO_CLICKED: 'videoClicked',
    VIDEO_ICON_CLICKED: 'videoIconClicked',
    VIEWABLE_IMPRESSION: 'viewable_impression',
    VOLUME_CHANGED: 'volumeChange',
    VOLUME_MUTED: 'mute',
  };

  // A single shared placeholder "ad" — real IMA hands the AdEvent a
  // reference to whichever creative is currently playing; we only ever
  // simulate one, so every LOADED/STARTED/... event carries the same one.
  const placeholderAd = new Ad();

  function AdEvent(type) {
    this.type = type;
  }
  AdEvent.prototype.getAd = function () { return placeholderAd; };
  AdEvent.prototype.getAdData = function () { return {}; };
  AdEvent.Type = AD_EVENT_TYPE;

  function AdErrorEvent(error) {
    this.type = 'adError';
    this.error = error;
  }
  AdErrorEvent.prototype.getError = function () { return this.error; };
  AdErrorEvent.prototype.getUserRequestContext = function () {
    return (this.error && this.error.userRequestContext) || {};
  };
  AdErrorEvent.Type = { AD_ERROR: 'adError' };

  function AdsManagerLoadedEvent(type, request, context) {
    this.type = type;
    this.adsRequest = request;
    this.userRequestContext = context;
  }
  AdsManagerLoadedEvent.prototype.getAdsManager = function (_contentPlayer, settings) {
    if (settings && settings.enablePreloading) sharedAdsManager._preloadingEnabled = true;
    return sharedAdsManager;
  };
  AdsManagerLoadedEvent.prototype.getUserRequestContext = function () {
    return this.userRequestContext || {};
  };
  AdsManagerLoadedEvent.Type = { ADS_MANAGER_LOADED: 'adsManagerLoaded' };

  function CustomContentLoadedEvent() {}
  CustomContentLoadedEvent.Type = { CUSTOM_CONTENT_LOADED: 'deprecated-event' };

  function CompanionAdSelectionSettings() {}
  CompanionAdSelectionSettings.CreativeType = { ALL: 'All', FLASH: 'Flash', IMAGE: 'Image' };
  CompanionAdSelectionSettings.ResourceType = { ALL: 'All', HTML: 'Html', IFRAME: 'IFrame', STATIC: 'Static' };
  CompanionAdSelectionSettings.SizeCriteria = {
    IGNORE: 'IgnoreSize',
    SELECT_EXACT_MATCH: 'SelectExactMatch',
    SELECT_NEAR_MATCH: 'SelectNearMatch',
  };

  function AdCuePoints() {}
  AdCuePoints.prototype.getCuePoints = returnsEmptyArray;

  function AdProgressData() {}
  function AdsRenderingSettings() {}
  function AdsRequest() {}
  Object.assign(AdsRequest.prototype, {
    setAdWillAutoPlay: noop,
    setAdWillPlayMuted: noop,
    setContinuousPlayback: noop,
  });

  // ── AdsLoader: real player code calls requestAds() and expects either an
  // ADS_MANAGER_LOADED event (success path) or an AD_ERROR (failure path).
  // We always take the failure path — "browser prevented autoplay" is the
  // one every real player already has fallback handling for, so it falls
  // straight through to playing its own content instead of getting stuck.
  function AdsLoader() {
    Object.assign(this, makeEventTarget());
    this.settings = new ImaSdkSettings();
  }
  Object.assign(AdsLoader.prototype, {
    contentComplete: noop,
    destroy: noop,
    getSettings: function () { return this.settings; },
    getVersion: function () { return VERSION; },
    requestAds: function (request, context) {
      requestAnimationFrame(() => {
        this._dispatch(new AdsManagerLoadedEvent(
          AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, request, context));
      });
      const error = new AdError(
        'adPlayError', 1205, 1205,
        'The browser prevented playback initiated without user interaction.',
        request, context);
      requestAnimationFrame(() => {
        this._dispatch(new AdErrorEvent(error));
      });
    },
  });

  // ── AdsManager: player code that DOES wire up ADS_MANAGER_LOADED calls
  // start() on what this returns, expecting the usual lifecycle events —
  // fire them all in one batch so playback proceeds immediately.
  function AdsManager() {
    Object.assign(this, makeEventTarget());
    this.volume = 1;
    this._preloadingEnabled = false;
  }
  Object.assign(AdsManager.prototype, {
    collapse: noop,
    configureAdsManager: noop,
    destroy: noop,
    discardAdBreak: noop,
    expand: noop,
    focus: noop,
    getAdSkippableState: returnsFalse,
    getCuePoints: function () { return [0]; },
    getCurrentAd: function () { return placeholderAd; },
    getCurrentAdCuePoints: returnsEmptyArray,
    getRemainingTime: function () { return 0; },
    getVolume: function () { return this.volume; },
    init: function () {
      if (this._preloadingEnabled) this._dispatch(new AdEvent(AD_EVENT_TYPE.LOADED));
    },
    isCustomClickTrackingUsed: returnsFalse,
    isCustomPlaybackUsed: returnsFalse,
    pause: noop,
    requestNextAdBreak: noop,
    resize: noop,
    resume: noop,
    setVolume: function (v) { this.volume = v; },
    skip: noop,
    start: function () {
      requestAnimationFrame(() => {
        for (const type of [
          AD_EVENT_TYPE.LOADED, AD_EVENT_TYPE.STARTED,
          AD_EVENT_TYPE.CONTENT_PAUSE_REQUESTED, AD_EVENT_TYPE.AD_BUFFERING,
          AD_EVENT_TYPE.FIRST_QUARTILE, AD_EVENT_TYPE.MIDPOINT,
          AD_EVENT_TYPE.THIRD_QUARTILE, AD_EVENT_TYPE.COMPLETE,
          AD_EVENT_TYPE.ALL_ADS_COMPLETED, AD_EVENT_TYPE.CONTENT_RESUME_REQUESTED,
        ]) {
          try { this._dispatch(new AdEvent(type)); } catch (e) { console.error(e); }
        }
      });
    },
    stop: noop,
    updateAdsRenderingSettings: noop,
  });

  const sharedAdsManager = new AdsManager();

  window.google = window.google || {};
  window.google.ima = {
    AdCuePoints,
    AdDisplayContainer,
    AdError,
    AdErrorEvent,
    AdEvent,
    AdPodInfo,
    AdProgressData,
    AdsLoader,
    AdsManager: sharedAdsManager,
    AdsManagerLoadedEvent,
    AdsRenderingSettings,
    AdsRequest,
    CompanionAd,
    CompanionAdSelectionSettings,
    CustomContentLoadedEvent,
    gptProxyInstance: {},
    ImaSdkSettings,
    OmidAccessMode: { DOMAIN: 'domain', FULL: 'full', LIMITED: 'limited' },
    OmidVerificationVendor: { 1: 'OTHER', 2: 'GOOGLE', GOOGLE: 2, OTHER: 1 },
    settings: new ImaSdkSettings(),
    UiElements: { AD_ATTRIBUTION: 'adAttribution', COUNTDOWN: 'countdown' },
    UniversalAdIdInfo,
    VERSION,
    ViewMode: { FULLSCREEN: 'fullscreen', NORMAL: 'normal' },
  };
})();
