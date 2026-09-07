// ==UserScript==
// @name         Admiral / Consent AntiAdblock Killer
// @version      1.2.0
// @description  Userscript-only blocker for Admiral-style consent anti-adblock overlays
// @author       Zekfad / updated
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const BAD_URL = /(?:^|\/\/|\.)(?:getadmiral|eventexistence|merequartz)\.com\b|:\/\/consent\.[^/?#]+\/\?pid=|:\/\/consent\.wegotthiscovered\.com\b|:\/\/cdn\.privacy-mgmt\.com\/unified\/wrapperMessagingWithoutDetection\.js\b/i;

    const BAD_TEXT = /\b(?:admiral|adblock|ad blocker|anti-adblock|using an adblocker|disable your adblocker|turn off your adblocker|whitelist|allow ads|support our site|support our journalism)\b/i;

    const BAD_ATTR = /(?:admiral|adblock|anti-adblock|antiadblock|sp_message|sourcepoint|privacy-manager)/i;

    const log = (...args) => console.info('[AntiAdblock Killer]', ...args);

    function isEl(x) {
        return x && x.nodeType === 1;
    }

    function getUrl(el) {
        if (!isEl(el)) return '';
        return String(
            el.getAttribute('src') ||
            el.getAttribute('href') ||
            el.getAttribute('data-src') ||
            el.src ||
            el.href ||
            ''
        );
    }

    function isBadUrl(url) {
        return BAD_URL.test(String(url || ''));
    }

    function isBadResource(el) {
        if (!isEl(el)) return false;
        const tag = el.tagName.toLowerCase();
        if (!['script', 'iframe', 'link', 'img', 'source'].includes(tag)) return false;
        return isBadUrl(getUrl(el));
    }

    function killNode(node, why) {
        try {
            if (isEl(node) && node.parentNode) {
                node.remove();
                log('removed', why || node.tagName.toLowerCase(), getUrl(node));
                return true;
            }
        } catch (_) {}
        return false;
    }

    function killBadResource(node) {
        if (isBadResource(node)) return killNode(node, 'bad resource');

        if (isEl(node) && node.querySelectorAll) {
            node.querySelectorAll('script[src],iframe[src],link[href],img[src],source[src]').forEach(el => {
                if (isBadResource(el)) killNode(el, 'nested bad resource');
            });
        }

        return false;
    }

    function restorePage() {
        for (const el of [document.documentElement, document.body]) {
            if (!el) continue;
            el.style.removeProperty('overflow');
            el.style.removeProperty('overflow-y');
            el.style.removeProperty('position');
            el.style.removeProperty('top');
            el.style.removeProperty('left');
            el.style.removeProperty('right');
            el.style.removeProperty('width');
            el.style.removeProperty('height');
            el.style.removeProperty('touch-action');
            el.style.removeProperty('pointer-events');
        }
    }

    function overlayLike(el) {
        if (!isEl(el)) return false;

        let cs;
        let rect;

        try {
            cs = getComputedStyle(el);
            rect = el.getBoundingClientRect();
        } catch (_) {
            return false;
        }

        const z = parseInt(cs.zIndex, 10);
        const highZ = Number.isFinite(z) && z >= 999;
        const fixedish = /^(fixed|absolute|sticky)$/.test(cs.position);
        const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity || 1) > 0.01;
        const large = rect.width >= innerWidth * 0.35 && rect.height >= innerHeight * 0.18;

        return fixedish && visible && large && (highZ || rect.height >= innerHeight * 0.55);
    }

    function hasBadTextOrAttrs(el) {
        if (!isEl(el)) return false;

        const attrs = [
            el.id,
            typeof el.className === 'string' ? el.className : '',
            el.getAttribute('aria-label'),
            el.getAttribute('role'),
            el.getAttribute('data-testid'),
            el.getAttribute('data-test-id'),
            el.getAttribute('data-sp-message-id')
        ].join(' ');

        if (BAD_ATTR.test(attrs)) return true;

        const text = String(el.innerText || el.textContent || '').slice(0, 6000);
        return BAD_TEXT.test(text);
    }

    function topRemovalTarget(el) {
        let node = el;
        let best = el;

        for (let i = 0; node && node !== document.body && node !== document.documentElement && i < 15; i++) {
            if (overlayLike(node)) best = node;
            node = node.parentElement;
        }

        if (best !== el) return best;

        node = el;
        while (
            node.parentElement &&
            node.parentElement !== document.body &&
            node.parentElement !== document.documentElement
        ) {
            node = node.parentElement;
        }

        return node || el;
    }

    function killOverlays(root) {
        root = root || document;
        if (!root.querySelectorAll) return;

        let killed = false;

        root.querySelectorAll('script[src],iframe[src],link[href],img[src],source[src]').forEach(el => {
            if (isBadResource(el)) {
                killNode(el, 'bad resource scan');
                killed = true;
            }
        });

        root.querySelectorAll([
            '[id*="admiral" i]',
            '[class*="admiral" i]',
            '[id*="adblock" i]',
            '[class*="adblock" i]',
            '[id*="sp_message" i]',
            '[class*="sp_message" i]',
            '[id*="sourcepoint" i]',
            '[class*="sourcepoint" i]',
            '[aria-modal="true"]',
            '[role="dialog"]',
            'dialog',
            'body > iframe',
            'body > div',
            'body > section',
            'body > aside'
        ].join(',')).forEach(el => {
            if (!isEl(el)) return;

            const badFrame = el.tagName.toLowerCase() === 'iframe' && isBadUrl(getUrl(el));
            const badOverlay = hasBadTextOrAttrs(el) && (overlayLike(el) || document.body?.style.overflow === 'hidden' || document.documentElement?.style.overflow === 'hidden');

            if (badFrame || badOverlay) {
                killNode(topRemovalTarget(el), 'overlay');
                killed = true;
            }
        });

        if (killed) restorePage();
    }

    function neuterGlobals() {
        const names = [
            'admiral',
            '__admiral',
            'admiralOptions',
            'admiralConfig',
            'Admiral',
            '_admiral',
            '_sp_queue'
        ];

        for (const name of names) {
            try {
                Object.defineProperty(window, name, {
                    configurable: true,
                    get() {
                        return name === '_sp_queue' ? [] : undefined;
                    },
                    set() {
                        return true;
                    }
                });
            } catch (_) {
                try {
                    window[name] = name === '_sp_queue' ? [] : undefined;
                } catch (_) {}
            }
        }
    }

    function patchSrcProperty(proto, propName) {
        const desc = Object.getOwnPropertyDescriptor(proto, propName);
        if (!desc || !desc.set || !desc.get) return;

        Object.defineProperty(proto, propName, {
            configurable: true,
            enumerable: desc.enumerable,
            get: desc.get,
            set(value) {
                if (isBadUrl(value)) {
                    log('blocked property URL', value);
                    try {
                        this.type = 'javascript/blocked';
                    } catch (_) {}
                    return;
                }

                return desc.set.call(this, value);
            }
        });
    }

    function patchInsertionMethod(proto, name) {
        const native = proto[name];
        if (typeof native !== 'function') return;

        proto[name] = function (...args) {
            for (const arg of args) {
                if (killBadResource(arg)) return arg;
            }

            return native.apply(this, args);
        };
    }

    function patchDom() {
        const nativeCreateElement = Document.prototype.createElement;
        Document.prototype.createElement = function (...args) {
            const el = nativeCreateElement.apply(this, args);
            const tag = String(args[0] || '').toLowerCase();

            if (tag === 'script') {
                try {
                    el.type = 'text/javascript';
                    Object.defineProperty(el, 'src', {
                        configurable: true,
                        get() {
                            return this.getAttribute('src') || '';
                        },
                        set(value) {
                            if (isBadUrl(value)) {
                                this.type = 'javascript/blocked';
                                this.setAttribute('data-blocked-src', value);
                                log('blocked created script', value);
                                return;
                            }
                            this.setAttribute('src', value);
                        }
                    });
                } catch (_) {}
            }

            return el;
        };

        const nativeSetAttribute = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (name, value) {
            if (/^(src|href|data-src)$/i.test(String(name)) && isBadUrl(value)) {
                log('blocked setAttribute URL', value);
                if (this.tagName && this.tagName.toLowerCase() === 'script') {
                    nativeSetAttribute.call(this, 'type', 'javascript/blocked');
                    nativeSetAttribute.call(this, 'data-blocked-src', String(value));
                }
                return;
            }

            return nativeSetAttribute.call(this, name, value);
        };

        patchSrcProperty(HTMLScriptElement.prototype, 'src');
        patchSrcProperty(HTMLIFrameElement.prototype, 'src');
        patchSrcProperty(HTMLImageElement.prototype, 'src');
        patchSrcProperty(HTMLLinkElement.prototype, 'href');

        ['appendChild', 'insertBefore', 'replaceChild'].forEach(name => patchInsertionMethod(Node.prototype, name));
        ['append', 'prepend', 'before', 'after', 'replaceWith'].forEach(name => patchInsertionMethod(Element.prototype, name));

        const nativeInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
        Element.prototype.insertAdjacentHTML = function (position, html) {
            html = String(html || '').replace(/<script\b[^>]*src=["'][^"']*(?:consent\.[^"']+\/\?pid=|getadmiral|eventexistence|merequartz|wrapperMessagingWithoutDetection)[^"']*["'][^>]*>\s*<\/script>/gi, '');
            return nativeInsertAdjacentHTML.call(this, position, html);
        };

        const nativeWrite = Document.prototype.write;
        Document.prototype.write = function (...args) {
            const cleaned = args.map(x => String(x || '').replace(/<script\b[^>]*src=["'][^"']*(?:consent\.[^"']+\/\?pid=|getadmiral|eventexistence|merequartz|wrapperMessagingWithoutDetection)[^"']*["'][^>]*>\s*<\/script>/gi, ''));
            return nativeWrite.apply(this, cleaned);
        };

        const nativeWriteln = Document.prototype.writeln;
        Document.prototype.writeln = function (...args) {
            const cleaned = args.map(x => String(x || '').replace(/<script\b[^>]*src=["'][^"']*(?:consent\.[^"']+\/\?pid=|getadmiral|eventexistence|merequartz|wrapperMessagingWithoutDetection)[^"']*["'][^>]*>\s*<\/script>/gi, ''));
            return nativeWriteln.apply(this, cleaned);
        };
    }

    function patchNetworkAPIs() {
        const nativeFetch = window.fetch;
        if (typeof nativeFetch === 'function') {
            window.fetch = function (input, init) {
                const url = typeof input === 'string' ? input : input && input.url;
                if (isBadUrl(url)) {
                    log('blocked fetch', url);
                    return Promise.reject(new TypeError('blocked anti-adblock fetch'));
                }

                return nativeFetch.apply(this, arguments);
            };
        }

        const nativeOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
            if (isBadUrl(url)) {
                log('blocked xhr', url);
                arguments[1] = 'about:blank';
            }

            return nativeOpen.apply(this, arguments);
        };

        if (navigator.sendBeacon) {
            const nativeBeacon = navigator.sendBeacon.bind(navigator);
            navigator.sendBeacon = function (url, data) {
                if (isBadUrl(url)) {
                    log('blocked beacon', url);
                    return true;
                }

                return nativeBeacon(url, data);
            };
        }
    }

    function patchShadowDOM() {
        const nativeAttachShadow = Element.prototype.attachShadow;
        if (typeof nativeAttachShadow !== 'function') return;

        Element.prototype.attachShadow = function (...args) {
            const root = nativeAttachShadow.apply(this, args);
            watch(root);
            queueMicrotask(() => killOverlays(root));
            return root;
        };
    }

    function watch(root) {
        if (!root || !root.observeTargetPatched) {
            try {
                Object.defineProperty(root, 'observeTargetPatched', {
                    value: true,
                    configurable: false
                });
            } catch (_) {}
        } else {
            return;
        }

        const mo = new MutationObserver(mutations => {
            for (const m of mutations) {
                if (m.type === 'attributes' && isEl(m.target)) {
                    if (isBadResource(m.target)) killNode(m.target, 'bad attr mutation');
                }

                for (const node of m.addedNodes) {
                    if (!isEl(node)) continue;

                    killBadResource(node);

                    if (node.shadowRoot) watch(node.shadowRoot);

                    if (hasBadTextOrAttrs(node) || overlayLike(node)) {
                        killOverlays(root);
                    }
                }
            }

            restorePage();
        });

        try {
            mo.observe(root, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src', 'href', 'data-src', 'style', 'class', 'id', 'aria-modal', 'role']
            });
        } catch (_) {}
    }

    function initialScan() {
        killBadResource(document.documentElement);
        killOverlays(document);
        restorePage();
    }

    function boot() {
        neuterGlobals();
        patchDom();
        patchNetworkAPIs();
        patchShadowDOM();

        watch(document);

        const fast = setInterval(() => {
            neuterGlobals();
            initialScan();
        }, 50);

        setTimeout(() => clearInterval(fast), 10000);

        const slow = setInterval(() => {
            neuterGlobals();
            initialScan();
        }, 500);

        setTimeout(() => clearInterval(slow), 60000);
    }

    document.addEventListener('beforescriptexecute', e => {
        if (isBadResource(e.target)) {
            e.preventDefault();
            killNode(e.target, 'before execute');
        }
    }, true);

    boot();

    document.addEventListener('DOMContentLoaded', initialScan, { once: true });
    window.addEventListener('load', initialScan, { once: true });
})();