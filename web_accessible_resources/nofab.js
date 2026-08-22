// Inert stand-in for the FuckAdBlock/BlockAdBlock adblock-detection library
// — pages construct `new FuckAdBlock(options)`, then chain
// .onDetected(fn).onNotDetected(fn), or call .check() directly. The
// constructor is expected to auto-run detection and fire one of those two
// callbacks; here it's hardwired to always report "not detected" and to
// return `this` from every chainable method so the fluent-call pattern
// keeps working.
(function () {
  'use strict';

  function FuckAdBlock() {
    this._notDetectedHandler = null;
  }

  FuckAdBlock.prototype.onDetected = function () { return this; };
  FuckAdBlock.prototype.onNotDetected = function (fn) {
    this._notDetectedHandler = fn;
    if (typeof fn === 'function') fn();
    return this;
  };
  FuckAdBlock.prototype.check = function () { return false; };
  FuckAdBlock.prototype.setOption = function () { return this; };
  FuckAdBlock.prototype.clearEvent = function () { return this; };
  FuckAdBlock.prototype.emitEvent = function () { return this; };

  window.FuckAdBlock = FuckAdBlock;
  window.BlockAdBlock = FuckAdBlock;
  window.fuckAdBlock = new FuckAdBlock();
})();
