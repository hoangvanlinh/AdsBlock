// yt-adblock.js — YouTube Ad Stripping + Fast Skipper (MAIN world)
// This file MUST NOT be obfuscated — it runs in the page's JS context.
if(window.__adblockYtInjected)throw new Error('');
window.__adblockYtInjected=true;
(function(){
if(location.hostname.indexOf('youtube.com')===-1)return;

// ── EARLIEST: Intercept ytcfg BEFORE any YouTube script runs ─────
// YouTube's inline scripts define window.ytcfg on first load.
// By trapping the property NOW (document_start), we intercept it.
(function(){
  var _ENFL=['ENABLE_ENFORCEMENT_HTML5_PLAYER_RESPONSE',
             'ENFORCEMENT_TRIGGER_URL','OPEN_ENFORCEMENT_TRIGGER',
             'HTML5_ENFORCE_ALTN_SIGNAL_DETECTION',
             'HTML5_AD_BLOCK_DETECTION_SIGNAL',
             'HTML5_ENABLE_AD_BLOCK_DETECTION'];
  var _BLOCK=['ad_blocker','adblock','enforcement','ad_break_heartbeat',
              'ad_block','adblock_detection'];

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
    if(!c||c.__yab)return;
    c.__yab=1;
    if(typeof c.set==='function'){
      var _s=c.set;
      c.set=function(k,v){
        try{typeof k==='object'?_patch(k):_patch({[k]:v});}catch(e){}
        return _s.apply(this,arguments);
      };
    }
    if(typeof c.get==='function'){
      var _g=c.get;
      c.get=function(k){
        if(typeof k==='string'){
          if(_ENFL.indexOf(k)!==-1)return false;
          var kl=k.toLowerCase();
          for(var i=0;i<_BLOCK.length;i++)if(kl.indexOf(_BLOCK[i])!==-1)return false;
        }
        return _g.apply(this,arguments);
      };
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
    if(!y||y.__yab)return;y.__yab=1;
    if(typeof y.setConfig==='function'){var _o=y.setConfig;y.setConfig=function(o){try{_patch(o);}catch(e){}return _o.apply(this,arguments);};}
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
css.id='__yt_ab_css__';
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
  'opacity:1!important;pointer-events:auto!important}';
(document.head||document.documentElement).prepend(css);

// ── 1. Fast ad skipper — direct player API access ────────────────
var _savedVol=1,_wasMuted=false;
function fastSkip(){
  var p=document.querySelector('.html5-video-player');
  if(!p)return;
  var isAd=p.classList.contains('ad-showing')||p.classList.contains('ad-interrupting');
  if(!isAd){
    // Ad ended — restore
    if(_wasMuted){
      var rv=p.querySelector('video');
      if(rv){rv.muted=false;rv.volume=_savedVol||1;try{rv.playbackRate=1;}catch(e){}}
      _wasMuted=false;
    }
    return;
  }
  var v=p.querySelector('video');
  if(v){
    if(!_wasMuted){_savedVol=v.volume;_wasMuted=true;}
    v.muted=true;v.volume=0;
    try{v.playbackRate=16;}catch(e){}
    var d=v.duration;
    if(d&&isFinite(d)&&d>0.1&&d<300){try{v.currentTime=d-0.1;}catch(e){}}
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
// Run fast skipper every 50ms
setInterval(fastSkip,50);
// Also observe player for instant reaction
function watchPlayer(){
  var p=document.querySelector('.html5-video-player');
  if(!p){setTimeout(watchPlayer,300);return;}
  new MutationObserver(function(){fastSkip();}).observe(p,{attributes:true,attributeFilter:['class']});
  fastSkip();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',watchPlayer);
else watchPlayer();

// ── 2. Strip ad data from objects ────────────────────────────────
var AK=['playerAds','adPlacements','adSlots','adBreakParams','adBreakHeartbeatParams'];

function stripObj(o){
  if(!o||typeof o!=='object')return o;
  for(var i=0;i<AK.length;i++){if(AK[i] in o)delete o[AK[i]];}
  if(o.playerConfig&&o.playerConfig.adRequestConfig)delete o.playerConfig.adRequestConfig;
  // Also strip adSlots from adBreakHeartbeatParams if present
  if(o.playerResponse){
    for(var i2=0;i2<AK.length;i2++){if(AK[i2] in o.playerResponse)delete o.playerResponse[AK[i2]];}
    if(o.playerResponse.playerConfig&&o.playerResponse.playerConfig.adRequestConfig)
      delete o.playerResponse.playerConfig.adRequestConfig;
  }
  return o;
}

// ── 1. Intercept JSON.parse — catches ALL data paths ─────────────
// YouTube's inline scripts, fetch responses, and XHR all go through
// JSON.parse. This is the most reliable interception point.
var _JP=JSON.parse;
JSON.parse=function(){
  var r=_JP.apply(this,arguments);
  if(r&&typeof r==='object'){
    // Only strip if it looks like a YouTube player response
    var hasAd=false;
    for(var i=0;i<AK.length;i++){if(AK[i] in r){hasAd=true;break;}}
    if(!hasAd&&r.playerResponse){
      for(var i2=0;i2<AK.length;i2++){if(AK[i2] in r.playerResponse){hasAd=true;break;}}
    }
    if(hasAd)stripObj(r);
  }
  return r;
};

// ── 2. Intercept Response.prototype.json — fetch API path ────────
var _RJ=Response.prototype.json;
Response.prototype.json=function(){
  return _RJ.apply(this,arguments).then(function(r){
    if(r&&typeof r==='object'){
      var hasAd=false;
      for(var i=0;i<AK.length;i++){if(AK[i] in r){hasAd=true;break;}}
      if(hasAd)stripObj(r);
    }
    return r;
  });
};

// ── 3. Intercept ytInitialPlayerResponse property ────────────────
// Belt-and-suspenders: also intercept the global variable assignment
// in case YouTube assigns it without going through JSON.parse.
var _pr=window.ytInitialPlayerResponse;
if(_pr)stripObj(_pr);
try{Object.defineProperty(window,'ytInitialPlayerResponse',{
  get:function(){return _pr;},
  set:function(v){if(v&&typeof v==='object')stripObj(v);_pr=v;},
  configurable:true,enumerable:true
});}catch(e){}

var _id=window.ytInitialData;
try{Object.defineProperty(window,'ytInitialData',{
  get:function(){return _id;},
  set:function(v){_id=v;},
  configurable:true,enumerable:true
});}catch(e){}

// ── 4. Intercept fetch() for player/next endpoints ──────────────
var _oF=window.fetch;
window.fetch=function(input,init){
  var url=(input instanceof Request)?input.url:String(input||'');
  if(url.indexOf('/youtubei/v1/player')===-1&&url.indexOf('/youtubei/v1/next')===-1)
    return _oF.apply(this,arguments);
  return _oF.apply(this,arguments).then(function(r){
    var c=r.clone();
    return c.text().then(function(t){
      try{
        var j=_JP.call(JSON,t);// use original JSON.parse, then strip
        stripObj(j);
        return new Response(JSON.stringify(j),{status:r.status,statusText:r.statusText,headers:r.headers});
      }catch(e){}
      return r;
    }).catch(function(){return r;});
  });
};

// ── 5. Intercept XMLHttpRequest for player/midroll ──────────────
var _xO=XMLHttpRequest.prototype.open,_xS=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,url){
  this._u=typeof url==='string'?url:'';
  return _xO.apply(this,arguments);
};
XMLHttpRequest.prototype.send=function(){
  if(this._u&&(this._u.indexOf('/youtubei/v1/player')!==-1||this._u.indexOf('/get_midroll_info')!==-1)){
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
};

// ── 6. Periodically strip from player instance ──────────────────
setInterval(function(){
  try{
    var p=document.querySelector('#movie_player');if(!p)return;
    var a=p.getPlayerResponse&&p.getPlayerResponse();if(a)stripObj(a);
    var c=p.getVideoData&&p.getVideoData();
    if(c&&c.playerResponse)stripObj(c.playerResponse);
  }catch(e){}
},1000);

// ── 7. Block ad-related script modules ──────────────────────────
var _cE=document.createElement.bind(document);
document.createElement=function(tag){
  var el=_cE(tag);
  if(tag.toLowerCase()==='script'){
    var _sA=el.setAttribute.bind(el);
    el.setAttribute=function(n,v){
      if(n==='src'&&typeof v==='string'&&
         (v.indexOf('/ad_')!==-1||v.indexOf('pagead')!==-1||
          v.indexOf('adservice')!==-1||v.indexOf('/ads/')!==-1))
        return _sA.call(this,n,'about:blank');
      return _sA.apply(this,arguments);
    };
  }
  return el;
};

// ── 8. Dismiss "Ad blocker detected" popup ──────────────────────
function dP(){
  // Remove enforcement overlay / dialog
  var rootSels=[
    'ytd-enforcement-message-view-model',
    'yt-playability-error-supported-renderers',
    'tp-yt-paper-dialog:has(#dismiss-button)',
    'ytd-popup-container tp-yt-paper-dialog',
    '#error-screen ytd-enforcement-message-view-model'
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
  try{
    var enf=document.querySelector('ytd-enforcement-message-view-model');
    if(enf){
      var anc=enf.closest('ytd-player-error-message-renderer,#error-screen,[class*="enforcement"]');
      if(anc)anc.remove();else enf.remove();
    }
  }catch(e){}
  try{
    var pl=document.querySelector('#movie_player,#player-container');
    if(pl){pl.style.removeProperty('display');pl.style.removeProperty('visibility');}
  }catch(e){}
}
setInterval(dP,500);

(function sObs(){
  var t=document.body||document.documentElement;
  if(!t){document.addEventListener('DOMContentLoaded',sObs);return;}
  new MutationObserver(function(ms){
    for(var i=0;i<ms.length;i++){
      var ns=ms[i].addedNodes;
      for(var j=0;j<ns.length;j++){
        if(ns[j].nodeType!==1)continue;
        var tag=ns[j].tagName;
        if(tag==='TP-YT-PAPER-DIALOG'||
           tag==='YTD-ENFORCEMENT-MESSAGE-VIEW-MODEL'||
           tag==='YT-PLAYABILITY-ERROR-SUPPORTED-RENDERERS')
          setTimeout(dP,50);
      }
    }
  }).observe(t,{childList:true,subtree:true});
})();
})();
