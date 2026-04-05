// yt-adblock.js — YouTube Ad Stripping + Fast Skipper (MAIN world)
// This file MUST NOT be obfuscated — it runs in the page's JS context.
(function(){
if(location.hostname.indexOf('youtube.com')===-1)return;

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
  var ss=['ytd-enforcement-message-view-model',
          'tp-yt-paper-dialog:has(#dismiss-button)',
          'ytd-popup-container tp-yt-paper-dialog'];
  for(var i=0;i<ss.length;i++){
    try{
      var p=document.querySelector(ss[i]);if(!p)continue;
      var b=p.querySelector('#dismiss-button,.dismiss-button,button[aria-label*="dismiss"],button[aria-label*="Dismiss"],yt-button-renderer button,tp-yt-paper-button');
      if(b){b.click();return;}
      p.remove();
    }catch(e){}
  }
  try{var o=document.querySelector('ytd-enforcement-message-view-model');if(o)o.remove();}catch(e){}
}
setInterval(dP,2000);

(function sObs(){
  var t=document.body||document.documentElement;
  if(!t){document.addEventListener('DOMContentLoaded',sObs);return;}
  new MutationObserver(function(ms){
    for(var i=0;i<ms.length;i++){
      var ns=ms[i].addedNodes;
      for(var j=0;j<ns.length;j++){
        if(ns[j].nodeType!==1)continue;
        if(ns[j].tagName==='TP-YT-PAPER-DIALOG'||ns[j].tagName==='YTD-ENFORCEMENT-MESSAGE-VIEW-MODEL')
          setTimeout(dP,100);
      }
    }
  }).observe(t,{childList:true,subtree:true});
})();
})();
