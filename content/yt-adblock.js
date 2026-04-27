// yt-adblock.js — YouTube Ad Stripping + Fast Skipper (MAIN world)
// This file MUST NOT be obfuscated — it runs in the page's JS context.
var _YK=Symbol.for('_yt_pb');
if(window[_YK])throw new Error('');
window[_YK]=1;
// _ytEnabled: starts true, flipped by _ytpb_off/_ytpb_on events from content.js
var _ytEnabled=true;
(function(){
if(location.hostname.indexOf('youtube.com')===-1)return;

// ── Anti-detection: spoof Function.prototype.toString ──────────
var _nTS=Function.prototype.toString;
var _nMap=new WeakMap();
var _newTS=function(){if(_nMap.has(this))return _nMap.get(this);return _nTS.call(this);};
_nMap.set(_newTS,_nTS.call(_nTS));
Function.prototype.toString=_newTS;
function _n(fn,orig){_nMap.set(fn,_nTS.call(orig));return fn;}

// ── EARLIEST: Intercept ytcfg BEFORE any YouTube script runs ─────
// YouTube's inline scripts define window.ytcfg on first load.
// By trapping the property NOW (document_start), we intercept it.
(function(){
  var _sy=Symbol();
  var _ENFL=['ENABLE_ENFORCEMENT_HTML5_PLAYER_RESPONSE',
             'ENFORCEMENT_TRIGGER_URL','OPEN_ENFORCEMENT_TRIGGER',
             'HTML5_ENFORCE_ALTN_SIGNAL_DETECTION',
             'HTML5_AD_BLOCK_DETECTION_SIGNAL',
             'HTML5_ENABLE_AD_BLOCK_DETECTION',
             'HTML5_PLAYER_NETWORK_THIRD_PARTY_AD_BLOCK_DETECTION',
             'PLAYER_HEARTBEAT_AD_BLOCK_DETECTION_API',
             'HTML5_AD_BLOCK_DETECTION_SIGNAL_ENABLED',
             'ENABLE_AD_BLOCK_DETECTION_SIGNAL',
             'HTML5_ENABLE_CLIENT_SIDE_AD_BLOCK_DETECTION',
             'WEB_ENABLE_AD_BLOCK_DETECTION',
             'ENFORCEMENT_DIALOG_V2'];
  var _BLOCK=['ad_blocker','adblock','enforcement','ad_break_heartbeat',
              'ad_block','adblock_detection','bowser_interruption',
              'interruption_dialog','ad_break_notification'];

  function _patch(obj){
    if(!obj||typeof obj!=='object')return;
    _ENFL.forEach(function(k){try{delete obj[k];}catch(e){try{obj[k]=false;}catch(ee){}}});
    if(obj.EXPERIMENT_FLAGS&&typeof obj.EXPERIMENT_FLAGS==='object'){
      Object.keys(obj.EXPERIMENT_FLAGS).forEach(function(k){
        var kl=k.toLowerCase();
        for(var i=0;i<_BLOCK.length;i++)if(kl.indexOf(_BLOCK[i])!==-1){obj.EXPERIMENT_FLAGS[k]=false;break;}
      });
    }
  }

  // Intercept ytcfg before it's ever assigned
  var _cfg=window.ytcfg;
  function _applyHooks(c){
    if(!c||c[_sy])return;
    c[_sy]=1;
    if(typeof c.set==='function'){
      var _s=c.set;
      c.set=_n(function(k,v){
        if(_ytEnabled)try{typeof k==='object'?_patch(k):_patch({[k]:v});}catch(e){}
        return _s.apply(this,arguments);
      },_s);
    }
    if(typeof c.get==='function'){
      var _g=c.get;
      c.get=_n(function(k){
        if(_ytEnabled&&typeof k==='string'){
          if(_ENFL.indexOf(k)!==-1)return false;
          var kl=k.toLowerCase();
          for(var i=0;i<_BLOCK.length;i++)if(kl.indexOf(_BLOCK[i])!==-1)return false;
        }
        return _g.apply(this,arguments);
      },_g);
    }
  }
  if(_cfg)_applyHooks(_cfg);
  try{Object.defineProperty(window,'ytcfg',{
    configurable:true,enumerable:true,
    get:function(){return _cfg;},
    set:function(v){_cfg=v;_applyHooks(v);}
  });}catch(e){}

  // Also intercept yt.setConfig (alternate API)
  var _yt=window.yt;
  function _hookYt(y){
    if(!y||y[_sy])return;y[_sy]=1;
    if(typeof y.setConfig==='function'){var _o=y.setConfig;y.setConfig=_n(function(o){if(_ytEnabled)try{_patch(o);}catch(e){}return _o.apply(this,arguments);},_o);}
  }
  if(_yt)_hookYt(_yt);
  try{Object.defineProperty(window,'yt',{
    configurable:true,enumerable:true,
    get:function(){return _yt;},
    set:function(v){_yt=v;_hookYt(v);}
  });}catch(e){}
})();

// ── 0. IMMEDIATELY inject CSS to hide ads — before any rendering ──
var css=document.createElement('style');
css.id='_ytpbs';
css.textContent=
  '.html5-video-player.ad-showing video,'+
  '.html5-video-player.ad-interrupting video{opacity:0!important}'+
  '.html5-video-player.ad-showing .ytp-ad-player-overlay,'+
  '.html5-video-player.ad-showing .ytp-ad-overlay-container,'+
  '.html5-video-player.ad-interrupting .ytp-ad-player-overlay,'+
  '.html5-video-player.ad-interrupting .ytp-ad-overlay-container,'+
  '.ytp-ad-text-overlay,.ytp-ad-image-overlay,'+
  '.ytp-ad-message-container,.ytp-ad-visit-advertiser-button,'+
  '.ytp-ad-feedback-dialog-container,.ytp-ad-duration-remaining,'+
  '.ytp-ad-simple-ad-badge,.ytp-ad-preview-container,'+
  '.ytp-ad-preview-text,.ytp-ad-text,.ytp-ad-badge-text,'+
  '.ytp-ad-badge,.ytp-ad-player-overlay-instream-info,'+
  '.ytp-ad-hover-text-container,[class*="ytp-ad-preview"],'+
  '[class*="ytp-ad-badge"],[class*="ytp-ad-duration"]{'+
  'opacity:0!important;pointer-events:none!important}'+
  '.html5-video-player.ad-showing .ytp-chrome-bottom,'+
  '.html5-video-player.ad-interrupting .ytp-chrome-bottom{'+
  'opacity:0!important;pointer-events:none!important}'+
  '.ytp-ad-skip-button-container,.ytp-ad-skip-button-container *{'+
  'opacity:1!important;pointer-events:auto!important}'+
  'ytd-rich-item-renderer:has(ytd-in-feed-ad-layout-renderer,ytd-ad-slot-renderer,ytd-promoted-sparkles-web-renderer,ytd-promoted-video-renderer,ytd-display-ad-renderer,ytd-compact-promoted-video-renderer),'+
  'ytd-rich-item-renderer[is-ad],ytd-video-renderer[is-ad],ytd-reel-item-renderer[is-ad],'+
  '#player-ads,#masthead-ad,ytd-banner-promo-renderer,ytd-statement-banner-renderer,'+
  'ytd-rich-section-renderer:has(ytd-statement-banner-renderer,ytd-banner-promo-renderer,ytd-in-feed-ad-layout-renderer,ytd-ad-slot-renderer),'+
  'ytd-rich-grid-row:has(ytd-in-feed-ad-layout-renderer,ytd-ad-slot-renderer){'+
  'display:none!important;visibility:hidden!important}';
(document.head||document.documentElement).prepend(css);
function _removeCss(){var el=document.getElementById('_ytpbs');if(el)el.remove();}
function _addCss(){if(!document.getElementById('_ytpbs'))(document.head||document.documentElement).prepend(css);}

// ── 1. Fast ad skipper — direct player API access ────────────────
var _savedVol=1,_wasMuted=false;
var _reportedCurrentAd=false;
var _blockedPayloadMarkers=Object.create(null);

function reportAdSkipped(){
  try{
    document.dispatchEvent(new CustomEvent('_ytpb1',{
      detail:{domain:location.hostname,url:location.href}
    }));
  }catch(e){}
}

function _cleanupBlockedPayloadMarkers(now){
  for(var key in _blockedPayloadMarkers){
    if(now-_blockedPayloadMarkers[key]>15000)delete _blockedPayloadMarkers[key];
  }
}

function _hasAdPayload(o){
  if(!o||typeof o!=='object')return false;
  for(var i=0;i<AK.length;i++)if(AK[i] in o)return true;
  return false;
}

function _buildBlockedPayloadMarker(o){
  var source=o&&o.playerResponse&&typeof o.playerResponse==='object'?o.playerResponse:o;
  var parts=[location.pathname,location.search],i;
  for(i=0;i<AK.length;i++){
    if(!(AK[i] in source))continue;
    var value=source[AK[i]];
    if(Array.isArray(value))parts.push(AK[i]+':'+value.length);
    else if(value&&typeof value==='object')parts.push(AK[i]+':'+Object.keys(value).sort().slice(0,6).join(','));
    else parts.push(AK[i]+':1');
  }
  return parts.join('|');
}

function reportBlockedPayload(o){
  try{
    var now=Date.now();
    _cleanupBlockedPayloadMarkers(now);
    var marker=_buildBlockedPayloadMarker(o);
    if(_blockedPayloadMarkers[marker])return;
    _blockedPayloadMarkers[marker]=now;
    document.dispatchEvent(new CustomEvent('_ytpb2',{
      detail:{domain:location.hostname,url:location.href}
    }));
  }catch(e){}
}

function fastSkip(){
  if(!_ytEnabled)return;
  var p=document.querySelector('.html5-video-player');
  if(!p)return;
  var isAd=p.classList.contains('ad-showing')||p.classList.contains('ad-interrupting');
  if(!isAd){
    _reportedCurrentAd=false;
    // Ad ended — restore
    if(_wasMuted){
      var rv=p.querySelector('video');
      if(rv){rv.muted=false;rv.volume=_savedVol||1;try{rv.playbackRate=1;}catch(e){}}
      _wasMuted=false;
    }
    return;
  }
  if(!_reportedCurrentAd){
    _reportedCurrentAd=true;
    reportAdSkipped();
  }
  var v=p.querySelector('video');
  if(v){
    if(!_wasMuted){_savedVol=v.volume;_wasMuted=true;}
    v.muted=true;v.volume=0;
    try{v.playbackRate = Math.min(8, v.playbackRate + 2);}catch(e){}
    var d=v.duration;
    if(d&&isFinite(d)&&d>0.1&&d<300){try{v.currentTime=d-0.1;}catch(e){}}
    // If no valid duration (ad media didn't load), dispatch 'ended' to unblock player
    if(!d||!isFinite(d)||d<=0){
      try{v.dispatchEvent(new Event('ended',{bubbles:true}));}catch(e){}
      try{var _mp0=document.querySelector('#movie_player');if(_mp0&&_mp0.cancelAd)_mp0.cancelAd();}catch(e){}
    }
  }
  // Click skip button
  var sels=['.ytp-skip-ad-button','.ytp-ad-skip-button','.ytp-ad-skip-button-modern',
    'button.ytp-ad-skip-button-text','.ytp-ad-skip-button-container button',
    '.ytp-ad-skip-button-slot button','button[class*="skip"][class*="ad"]',
    '[id^="skip-button"] button','button[data-button-action="skip"]',
    '.ytp-ad-overlay-close-button'];
  for(var i=0;i<sels.length;i++){
    try{var b=document.querySelector(sels[i]);
      if(b){b.style.setProperty('pointer-events','auto','important');
        b.click();b.dispatchEvent(new MouseEvent('pointerup',{bubbles:true}));break;}
    }catch(e){}
  }
  // Fallback: text-based skip
  try{var btns=p.querySelectorAll('button,[role="button"]');
    for(var j=0;j<btns.length;j++){var t=(btns[j].textContent||'').toLowerCase();
      if(t.indexOf('skip')!==-1||t.indexOf('bỏ qua')!==-1){btns[j].click();break;}}
  }catch(e){}
}
// Observe player class changes for instant ad detection
var _playerObserver=null;

// ── Stuck-ad recovery ─────────────────────────────────────────────
// For long videos (>1hr), midroll ads may be triggered but not load any
// media (because we stripped adPlacements). The player stays in ad-showing
// state with duration=NaN, while our CSS holds opacity:0 → black screen.
// This timer detects the stuck state and force-exits it.
var _stuckAdTimer=null, _stuckAdStart=0, _stuckAdLastTime=-1;
function _clearStuckTimer(){
  if(_stuckAdTimer){clearTimeout(_stuckAdTimer);_stuckAdTimer=null;}
  _stuckAdStart=0;_stuckAdLastTime=-1;
}
function _checkStuckAd(){
  _stuckAdTimer=null;
  var p=document.querySelector('.html5-video-player');
  if(!p){return;}
  var isAd=p.classList.contains('ad-showing')||p.classList.contains('ad-interrupting');
  if(!isAd){_clearStuckTimer();return;}
  var v=p.querySelector('video');
  var d=v?v.duration:NaN;
  var ct=v?v.currentTime:0;
  // If ad has valid duration and currentTime is progressing, not stuck
  if(d&&isFinite(d)&&d>0.5&&ct!==_stuckAdLastTime){
    _stuckAdLastTime=ct;
    _stuckAdTimer=setTimeout(_checkStuckAd,2000);
    return;
  }
  _stuckAdLastTime=ct;
  var now=Date.now();
  if(!_stuckAdStart)_stuckAdStart=now;
  if(now-_stuckAdStart>300){
    // Force-exit stuck ad
    try{var mp=document.querySelector('#movie_player');if(mp&&mp.cancelAd)mp.cancelAd();}catch(e){}
    if(v){
      try{v.dispatchEvent(new Event('ended',{bubbles:true}));}catch(e){}
      if(d&&isFinite(d)&&d>0){try{v.currentTime=d;}catch(e){}}
    }
    // Immediately bypass our own opacity:0 CSS if still stuck
    var p2=document.querySelector('.html5-video-player');
    if(p2&&(p2.classList.contains('ad-showing')||p2.classList.contains('ad-interrupting'))){
      var v2=p2.querySelector('video');
      if(v2){
        v2.style.setProperty('opacity','1','important');
        v2.muted=false;v2.volume=_savedVol||1;
        try{v2.playbackRate=1;}catch(e){}
        var _cleanOp=setInterval(function(){
          var p3=document.querySelector('.html5-video-player');
          if(!p3||(!p3.classList.contains('ad-showing')&&!p3.classList.contains('ad-interrupting'))){
            if(v2)v2.style.removeProperty('opacity');
            clearInterval(_cleanOp);
          }
        },150);
      }
    }
    _stuckAdStart=0;
  }
  _stuckAdTimer=setTimeout(_checkStuckAd,300);
}

function watchPlayer(){
  var p=document.querySelector('.html5-video-player');
  if(!p){setTimeout(watchPlayer,300);return;}
  if(_playerObserver)return; // already attached
  _playerObserver=new MutationObserver(function(){
    fastSkip();
    var isAd=p.classList.contains('ad-showing')||p.classList.contains('ad-interrupting');
    if(isAd&&!_stuckAdTimer){
      if(!_stuckAdStart)_stuckAdStart=Date.now();
      _stuckAdTimer=setTimeout(_checkStuckAd,400);
    } else if(!isAd){
      _clearStuckTimer();
    }
  });
  _playerObserver.observe(p,{attributes:true,attributeFilter:['class']});
  fastSkip();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',watchPlayer);
else watchPlayer();

// ── 2. Strip ad data from objects ────────────────────────────────
// Use [] / {} instead of delete so YouTube's player code doesn't crash
// when it tries to iterate over these fields and finds undefined.
var AK=['playerAds','adPlacements','adSlots','adBreakParams','adBreakHeartbeatParams'];
var AK_ARR=['playerAds','adPlacements','adSlots'];
var AK_OBJ=['adBreakParams','adBreakHeartbeatParams'];

function _stripEnforcement(pr){
  if(!pr||typeof pr!=='object')return;
  if(pr.playabilityStatus){
    var ps=pr.playabilityStatus;
    var isEnforcement=ps.errorScreen&&(
      ps.errorScreen.enforcementMessageRenderer||
      ps.errorScreen.playerErrorMessageRenderer
    );
    // Only strip enforcement overlays, not legitimate playability errors.
    // Also require streamingData to exist before marking as OK —
    // without streams, setting OK causes "video interrupted".
    if(isEnforcement&&pr.streamingData){
      delete ps.errorScreen;
      if(ps.status==='ERROR'||ps.status==='UNPLAYABLE')ps.status='OK';
      delete ps.reason;
    } else if(isEnforcement){
      // No streamingData: just remove the UI overlay, don't touch status
      delete ps.errorScreen;
      delete ps.reason;
    }
  }
  // Do NOT touch heartbeatParams — YouTube uses it to keep video session alive
  // Do NOT touch daiConfig — affects video delivery for live/premium content
  if(pr.adBreakLockupViewModel)delete pr.adBreakLockupViewModel;
  if(pr.playerConfig&&pr.playerConfig.adRequestConfig)pr.playerConfig.adRequestConfig={};
}

function stripObj(o){
  if(!o||typeof o!=='object')return o;
  if(_hasAdPayload(o)||(o.playerResponse&&_hasAdPayload(o.playerResponse)))reportBlockedPayload(o);
  var i;
  for(i=0;i<AK_ARR.length;i++){if(AK_ARR[i] in o)o[AK_ARR[i]]=[];}
  for(i=0;i<AK_OBJ.length;i++){if(AK_OBJ[i] in o)o[AK_OBJ[i]]={};}
  _stripEnforcement(o);
  if(o.playerResponse){
    for(i=0;i<AK_ARR.length;i++){if(AK_ARR[i] in o.playerResponse)o.playerResponse[AK_ARR[i]]=[];}
    for(i=0;i<AK_OBJ.length;i++){if(AK_OBJ[i] in o.playerResponse)o.playerResponse[AK_OBJ[i]]={};}
    _stripEnforcement(o.playerResponse);
  }
  return o;
}

// ── 1. Intercept JSON.parse — catches ALL data paths ─────────────
// YouTube's inline scripts, fetch responses, and XHR all go through
// JSON.parse. This is the most reliable interception point.
var _JP=JSON.parse;
JSON.parse=_n(function(){
  var r=_JP.apply(this,arguments);
  if(r&&typeof r==='object'){
    // Only strip if it looks like a YouTube player response
    var hasAd=false;
    for(var i=0;i<AK.length;i++){if(AK[i] in r){hasAd=true;break;}}
    if(!hasAd&&r.playerResponse){
      for(var i2=0;i2<AK.length;i2++){if(AK[i2] in r.playerResponse){hasAd=true;break;}}
    }
    if(hasAd&&_ytEnabled)stripObj(r);
  }
  return r;
},_JP);

// ── 2. Intercept Response.prototype.json — fetch API path ────────
var _RJ=Response.prototype.json;
Response.prototype.json=_n(function(){
  return _RJ.apply(this,arguments).then(function(r){
    if(r&&typeof r==='object'){
      var hasAd=false;
      for(var i=0;i<AK.length;i++){if(AK[i] in r){hasAd=true;break;}}
      if(hasAd&&_ytEnabled)stripObj(r);
    }
    return r;
  });
},_RJ);

// ── 3. Intercept ytInitialPlayerResponse property ────────────────
// Belt-and-suspenders: also intercept the global variable assignment
// in case YouTube assigns it without going through JSON.parse.
var _pr=window.ytInitialPlayerResponse;
if(_pr)stripObj(_pr);
try{Object.defineProperty(window,'ytInitialPlayerResponse',{
  get:function(){return _pr;},
  set:function(v){if(v&&typeof v==='object'&&_ytEnabled)stripObj(v);_pr=v;},
  configurable:true,enumerable:true
});}catch(e){}

var _id=window.ytInitialData;
try{Object.defineProperty(window,'ytInitialData',{
  get:function(){return _id;},
  set:function(v){_id=v;},
  configurable:true,enumerable:true
});}catch(e){}

// ── 3b. Block navigator.sendBeacon for ad/enforcement pings ─────
var _oSB=navigator.sendBeacon.bind(navigator);
navigator.sendBeacon=_n(function(url,data){
  if(!_ytEnabled)return _oSB.apply(navigator,arguments);
  var s=typeof url==='string'?url:'';
  if(s.indexOf('pagead')!==-1||s.indexOf('doubleclick')!==-1||
     s.indexOf('adservice')!==-1)return true;
  if(s.indexOf('/log_event')!==-1||s.indexOf('/ptracking')!==-1){
    try{
      var raw=typeof data==='string'?data:null;
      if(!raw&&data instanceof Blob){return _oSB.apply(navigator,arguments);}
      var d=raw?JSON.parse(raw):data;
      if(d&&d.eventType&&typeof d.eventType==='string'&&
         d.eventType.toLowerCase().indexOf('ad')!==-1)return true;
    }catch(e){}
  }
  return _oSB.apply(navigator,arguments);
},navigator.sendBeacon);

// ── 4. Intercept fetch() for player/next/midroll endpoints ──────
var _AD_TRACK_RE=/\/pagead\/|viewthroughconversion|doubleclick\.net|adservice\.google|\/ptracking|\/ad_status/;
var _FAKE_OK=new Response(null,{status:204,statusText:'No Content'});
var _oF=window.fetch;
window.fetch=_n(function(input,init){
  var url=(input instanceof Request)?input.url:String(input||'');
  // Silently succeed ad tracking/conversion pings — prevents CORS errors
  // and prevents YouTube's catch() handler from detecting ad block.
  if(_ytEnabled&&_AD_TRACK_RE.test(url))return Promise.resolve(_FAKE_OK.clone?_FAKE_OK.clone():new Response(null,{status:204,statusText:'No Content'}));
  if(url.indexOf('/youtubei/v1/player')===-1&&
     url.indexOf('/youtubei/v1/next')===-1&&
     url.indexOf('/get_midroll_info')===-1)
    return _oF.apply(this,arguments);
  if(!_ytEnabled)return _oF.apply(this,arguments);
  return _oF.apply(this, arguments).then(function(r){
    var ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return r;

    return r.json().then(function(j){
      if (j && typeof j === 'object') {
        var hasAd = false;
        for (var i = 0; i < AK.length; i++) {
          if (AK[i] in j || (j.playerResponse && AK[i] in j.playerResponse)) {
            hasAd = true;
            break;
          }
        }
        if (hasAd) stripObj(j);
      }
      var newRes = new Response(JSON.stringify(j), {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers
      });
      try { Object.defineProperty(newRes, 'url', { value: r.url }); } catch(e){}

      return newRes;
    }).catch(function(){
      return r;
    });
  });

},_oF);

// ── 5. Intercept XMLHttpRequest for player/midroll ──────────────
var _xO=XMLHttpRequest.prototype.open,_xS=XMLHttpRequest.prototype.send;
var _xhrU=new WeakMap();
XMLHttpRequest.prototype.open=_n(function(m,url){
  _xhrU.set(this,typeof url==='string'?url:'');
  return _xO.apply(this,arguments);
},_xO);
XMLHttpRequest.prototype.send=_n(function(){
  var _u=_xhrU.get(this)||'';
  if(_ytEnabled&&_u&&(_u.indexOf('/youtubei/v1/player')!==-1||_u.indexOf('/get_midroll_info')!==-1)){
    this.addEventListener('readystatechange',function(){
      if(this.readyState===4&&this.status===200){
        try{
          var j=_JP.call(JSON,this.responseText);
          stripObj(j);
          var s=JSON.stringify(j);
          Object.defineProperty(this,'responseText',{get:function(){return s;}});
          Object.defineProperty(this,'response',{get:function(){return s;}});
        }catch(e){}
      }
    });
  }
  return _xS.apply(this,arguments);
},_xS);

// ── 6. Strip from player instance — only while ad is active ─────
// Sections 1-5 already cover all upstream data paths.
// This is a fallback for ad data set directly on the player object.
// Runs only when ad-showing class is present, stops otherwise.
var _stripInterval=null;
function _startStripInterval(){
  if(_stripInterval)return;
  _stripInterval=setInterval(function(){
    try{
      var p=document.querySelector('#movie_player');if(!p)return;
      var isAd=p.classList&&(p.classList.contains('ad-showing')||p.classList.contains('ad-interrupting'));
      if(!isAd){clearInterval(_stripInterval);_stripInterval=null;return;}
      var a=p.getPlayerResponse&&p.getPlayerResponse();if(a)stripObj(a);
      var c=p.getVideoData&&p.getVideoData();
      if(c&&c.playerResponse)stripObj(c.playerResponse);
    }catch(e){}
  },500);
}
// Start strip interval whenever ad begins (piggybacking on _playerObserver trigger)
var _origFastSkip=fastSkip;
fastSkip=function(){
  _origFastSkip();
  var p=document.querySelector('.html5-video-player');
  if(p&&(p.classList.contains('ad-showing')||p.classList.contains('ad-interrupting'))){
    _startStripInterval();
  }
};

// ── 7. Block ad-related script modules ──────────────────────────
var _cE_orig=document.createElement;
var _cE=_cE_orig.bind(document);
document.createElement=_n(function(tag){
  var el=_cE(tag);
  if(tag.toLowerCase()==='script'){
    var _sA=el.setAttribute.bind(el);
    el.setAttribute=_n(function(n,v){
      if(_ytEnabled&&n==='src'&&typeof v==='string'&&
         (v.indexOf('/ad_')!==-1||v.indexOf('pagead')!==-1||
          v.indexOf('adservice')!==-1||v.indexOf('/ads/')!==-1))
        return _sA.call(this,n,'about:blank');
      return _sA.apply(this,arguments);
    },Element.prototype.setAttribute);
  }
  return el;
},_cE_orig);

// ── 8. Dismiss "Ad blocker detected" popup ──────────────────────
function dP(){
  if(!_ytEnabled)return;
  var rootSels=[
    'ytd-enforcement-message-view-model',
    'yt-playability-error-supported-renderers',
    'tp-yt-paper-dialog:has(#dismiss-button)',
    'ytd-popup-container tp-yt-paper-dialog',
    '#error-screen ytd-enforcement-message-view-model',
    'yt-upsell-dialog-renderer',
    'ytd-mealbar-promo-renderer',
    '[component-name="EnforcementMessageViewModel"]',
    'ytd-player-error-message-renderer'
  ];
  for(var i=0;i<rootSels.length;i++){
    try{
      var el=document.querySelector(rootSels[i]);if(!el)continue;
      var b=el.querySelector(
        '#dismiss-button,.dismiss-button,'+
        'button[aria-label*="dismiss"],button[aria-label*="Dismiss"],'+
        'yt-button-renderer button,tp-yt-paper-button'
      );
      if(b){b.click();}else{el.remove();}
    }catch(e){}
  }
 // ── Confirm dialog ("Are you having issues?") ─────────────────
  // YouTube shows yt-confirm-dialog-renderer with Yes/No buttons.
  // Click the cancel/No button to dismiss without triggering detection.
  try{
    var cd=document.querySelector('yt-confirm-dialog-renderer,ytd-confirm-dialog-renderer');
    if(cd){
      // Try cancel button first (second button = "Không"/No/Cancel)
      var btns=cd.querySelectorAll('yt-button-renderer,tp-yt-paper-button,button');
       // Cancel is typically the last button on the right
      var dismissed=false;
      for(var bi=btns.length-1;bi>=0;bi--){
        var bt=btns[bi];
        var txt=(bt.textContent||'').trim().toLowerCase();
        if(txt==='không'||txt==='no'||txt==='cancel'||txt==='dismiss'||
           bt.id==='cancel-button'||bt.getAttribute('id')==='cancel'){
          bt.click();dismissed=true;break;
        }
      }
      // If no cancel found, remove the whole dialog container
      if(!dismissed){
        var ancd=cd.closest('ytd-popup-container,tp-yt-paper-dialog,.ytd-popup-container')||cd;
        ancd.remove();
      }
    }
  }catch(e){}
  try{
    var enf=document.querySelector('ytd-enforcement-message-view-model,[component-name="EnforcementMessageViewModel"]');
    if(enf){
      var anc=enf.closest('ytd-player-error-message-renderer,#error-screen,[class*="enforcement"],ytd-popup-container');
      if(anc)anc.remove();else enf.remove();
    }
  }catch(e){}
  try{
    // Hide the #error-screen overlay inside player if it contains enforcement
    var es=document.querySelector('#error-screen');
    if(es&&es.querySelector('ytd-enforcement-message-view-model,[component-name="EnforcementMessageViewModel"]'))
      es.style.setProperty('display','none','important');
  }catch(e){}
  try{
    var pl=document.querySelector('#movie_player,#player-container');
    if(pl){
      pl.style.removeProperty('display');pl.style.removeProperty('visibility');
      var pv=pl.querySelector('video');
      if(pv&&!pl.classList.contains('ad-showing')&&!pl.classList.contains('ad-interrupting'))
        pv.style.removeProperty('opacity');
    }
  }catch(e){}
}
// No interval needed — sObs observer below triggers dP() when popup appears.
// Run once immediately in case popup is already in DOM at inject time.
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',dP);
else dP();

(function sObs(){
  var t=document.body||document.documentElement;
  if(!t){document.addEventListener('DOMContentLoaded',sObs);return;}
  var _dPt=0;
  new MutationObserver(function(ms){
    outer:for(var i=0;i<ms.length;i++){
      var ns=ms[i].addedNodes;
      for(var j=0;j<ns.length;j++){
        if(ns[j].nodeType!==1)continue;
        var tag=ns[j].tagName;
        if(tag==='TP-YT-PAPER-DIALOG'||
           tag==='YTD-ENFORCEMENT-MESSAGE-VIEW-MODEL'||
           tag==='YT-PLAYABILITY-ERROR-SUPPORTED-RENDERERS'||
           tag==='YT-UPSELL-DIALOG-RENDERER'||
           tag==='YTD-MEALBAR-PROMO-RENDERER'||
           tag==='YTD-PLAYER-ERROR-MESSAGE-RENDERER'||
           tag==='YT-CONFIRM-DIALOG-RENDERER'||
           tag==='YTD-CONFIRM-DIALOG-RENDERER'||
           (ns[j].getAttribute&&ns[j].getAttribute('component-name')==='EnforcementMessageViewModel')){
          if(!_dPt)_dPt=setTimeout(function(){_dPt=0;dP();},50);
          break outer;
        }
      }
    }
  }).observe(t,{childList:true,subtree:true});
})();

// ── 9. Intercept player enforcement API (belt-and-suspenders) ───
(function(){
  var _mpSym=Symbol.for('_yt_pb_mp');
  function _hookMP(mp){
    if(!mp||mp[_mpSym])return;
    mp[_mpSym]=1;
    ['setPlayabilityStatus','updatePlayabilityStatus'].forEach(function(fn){
      if(typeof mp[fn]!=='function')return;
      var _orig=mp[fn];
      mp[fn]=function(s){
        if(!_ytEnabled)return _orig.apply(this,arguments);
        if(s&&typeof s==='object'&&
           (s.status==='ERROR'||s.status==='UNPLAYABLE')&&
           s.errorScreen&&(s.errorScreen.enforcementMessageRenderer||
             s.errorScreen.playerErrorMessageRenderer))return;
        return _orig.apply(this,arguments);
      };
    });
  }
  var _mpT=document.body||document.documentElement;
  function _startMpObs(t){
    new MutationObserver(function(){
      var mp=document.querySelector('#movie_player');
      if(mp)_hookMP(mp);
    }).observe(t,{childList:true,subtree:true});
  }
  if(_mpT)_startMpObs(_mpT);
  else document.addEventListener('DOMContentLoaded',function(){
    _startMpObs(document.body||document.documentElement);
  });
})();

// ── 10. Toggle ON/OFF from content.js ────────────────────────────
function _teardown(){
  // Stop observers and intervals
  if(_playerObserver){_playerObserver.disconnect();_playerObserver=null;}
  _clearStuckTimer();
  if(_stripInterval){clearInterval(_stripInterval);_stripInterval=null;}
  // Restore video opacity/volume in case we muted/hid it
  try{
    var p=document.querySelector('.html5-video-player');
    if(p){
      var v=p.querySelector('video');
      if(v){v.muted=false;v.volume=_savedVol||1;v.style.removeProperty('opacity');try{v.playbackRate=1;}catch(e){}}
    }
  }catch(e){}
  _removeCss();
}
function _restart(){
  _addCss();
  watchPlayer();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',dP);
  else dP();
}
document.addEventListener('_ytpb_off',function(){
  _ytEnabled=false;
  _teardown();
});
document.addEventListener('_ytpb_on',function(){
  _ytEnabled=true;
  _restart();
});
// ── 11. Re-attach after YouTube SPA navigation ──────────────────
// YouTube fires yt-navigate-finish on every SPA page transition.
// The old .html5-video-player element is replaced — _playerObserver
// is attached to the detached element and fires nothing. Must reset.
// CRITICAL: YouTube strips injected <style> tags from <head> during
// SPA navigation. _addCss() must be called to re-inject the hide rules.
var _lastNavTs=0;
function _onNavFinish(){
  if(!_ytEnabled)return;
  var t=Date.now();if(t-_lastNavTs<200)return;_lastNavTs=t;
  _addCss();
  if(_playerObserver){_playerObserver.disconnect();_playerObserver=null;}
  _clearStuckTimer();
  _reportedCurrentAd=false;
  _wasMuted=false;
  _stuckAdStart=0;
  watchPlayer();
  dP();
}
document.addEventListener('yt-navigate-finish',_onNavFinish);
window.addEventListener('yt-navigate-finish',_onNavFinish);
document.addEventListener('yt-page-data-updated',function(){if(_ytEnabled)_addCss();});
// ── Guard: re-inject _ytpbs if YouTube strips it from <head> ─────
(function(){
  function _gH(){
    if(!document.head)return;
    new MutationObserver(function(){
      if(_ytEnabled&&!document.getElementById('_ytpbs'))
        (document.head||document.documentElement).prepend(css);
    }).observe(document.head,{childList:true});
  }
  if(document.head)_gH();
  else new MutationObserver(function(ms,obs){
    if(document.head){obs.disconnect();_gH();}
  }).observe(document.documentElement,{childList:true});
})();
})();
