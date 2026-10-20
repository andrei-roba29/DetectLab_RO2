// Source + behaviour tests for the iOS install walkthrough video on phones.
//
// Context: tapping "iOS App" on an iPhone/iPad in Safari used to show a
// one-line toast and return early, so the walkthrough modal — the only place
// the install demo video lives — never opened on a phone. The video was
// therefore reachable only from a laptop/PC. The walkthrough must now open on
// every device, and on a phone viewport the video must be ordered before the
// (long) step list so it is on screen without scrolling.
//
// Usage: node test-ios-install-video-mobile.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function read(rel) {
    return fs.readFileSync(path.join(__dirname, rel), 'utf8');
}

const html = read('index.html');
const swSrc = read('sw.js');

console.log('[Test] iOS install walkthrough video on mobile...\n');

// -------------------------------------------------------------
// Test 1: the inline PWA install script
// -------------------------------------------------------------
console.log('[1] Inline install script');

let installScript = null;
const scriptRe = /<script>([\s\S]*?)<\/script>/g;
let match;
while ((match = scriptRe.exec(html)) !== null) {
    if (match[1].includes('function showIOSInstructions')) {
        installScript = match[1];
        break;
    }
}
assert(installScript, 'index.html must contain the inline PWA install script');

// The old iOS Safari branch returned before the modal opened.
assert(!/if \(isIOS && isSafari\) \{\s*showPWAToast\(msg\);\s*return;/.test(installScript),
    'showIOSInstructions must not short-circuit to a toast on iOS Safari — that hid the video on phones');
assert(/openIOSInstallModal\(\)/.test(installScript), 'the iOS button must open the walkthrough modal');
console.log('  ✔ no iOS-Safari early return; the modal is the single entry point');

// -------------------------------------------------------------
// Test 2: tapping "iOS App" on an iPhone in Safari opens the modal + video
// -------------------------------------------------------------
console.log('\n[2] iPhone Safari tap');

function makeEl(id) {
    const classes = new Set();
    const el = {
        id: id,
        innerHTML: '',
        textContent: '',
        paused: false,
        _children: {},
        scrollIntoView() {},
        pause() { this.paused = true; },
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c),
        },
        querySelector(sel) {
            if (!this._children[sel]) this._children[sel] = makeEl(sel);
            return this._children[sel];
        },
    };
    return el;
}

function createSandbox(userAgent) {
    const elements = {
        'pwa-install-help': makeEl('pwa-install-help'),
        'pwa-install-banner': makeEl('pwa-install-banner'),
        'pwa-install-toast': makeEl('pwa-install-toast'),
        'ios-install-modal': makeEl('ios-install-modal'),
        'iosInstallVideo': makeEl('iosInstallVideo'),
    };

    const documentStub = {
        addEventListener: () => {},
        removeEventListener: () => {},
        getElementById: (id) => elements[id] || null,
        querySelector: () => null,
        querySelectorAll: () => [],
    };

    const windowStub = {
        location: {
            origin: 'https://detectlab.ro',
            protocol: 'https:',
            host: 'detectlab.ro',
            pathname: '/',
            search: '',
            hash: '',
            href: '',
        },
        history: { replaceState() {} },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        navigator: { userAgent: userAgent, standalone: false, platform: '' },
        addEventListener: () => {},
        removeEventListener: () => {},
        requestAnimationFrame: (fn) => setTimeout(fn, 0),
    };

    const sandbox = {
        window: windowStub,
        document: documentStub,
        navigator: windowStub.navigator,
        console: console,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        clearInterval: clearInterval,
        URLSearchParams: URLSearchParams,
        Promise: Promise,
        elements: elements,
    };
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(installScript, sandbox, { filename: 'index.html#pwa-install' });
    return sandbox;
}

const UA_IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const UA_IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.100 Mobile/15E148 Safari/604.1';
const UA_ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

[['iPhone Safari', UA_IOS_SAFARI], ['iPhone Chrome', UA_IOS_CHROME],
 ['Android Chrome', UA_ANDROID_CHROME], ['desktop', UA_DESKTOP]].forEach(([label, ua]) => {
    const sandbox = createSandbox(ua);
    sandbox.showIOSInstructions();
    const modal = sandbox.elements['ios-install-modal'];
    assert(modal.classList.contains('visible'),
        label + ': tapping "iOS App" must open the walkthrough modal (video included)');
    assert(!sandbox.elements['pwa-install-toast'].classList.contains('visible'),
        label + ': the toast must not replace the walkthrough');
    assert(/iosInstallVideo/.test(html), 'the modal must contain the install video');
    // The modal body is filled from the same render pass that opens it.
    assert(modal._children['.ios-modal-steps'].innerHTML.indexOf('<li>') === 0,
        label + ': the walkthrough steps must be rendered into the modal');
});
console.log('  ✔ modal + video open on iPhone Safari, iPhone Chrome, Android and desktop');

// -------------------------------------------------------------
// Test 3: closing the modal still pauses the video
// -------------------------------------------------------------
console.log('\n[3] Closing the walkthrough');

const closing = createSandbox(UA_IOS_SAFARI);
closing.openIOSInstallModal();
closing.closeIOSInstallModal();
assert(!closing.elements['ios-install-modal'].classList.contains('visible'), 'close must hide the modal');
assert(closing.elements['iosInstallVideo'].paused === true, 'close must pause the install video');
console.log('  ✔ close hides the modal and pauses the video');

// -------------------------------------------------------------
// Test 4: markup — a phone-playable video element
// -------------------------------------------------------------
console.log('\n[4] Video markup');

const videoTag = (html.match(/<video id="iosInstallVideo"[^>]*>/) || [])[0] || '';
assert(videoTag, 'index.html must keep the #iosInstallVideo element');
assert(/\bcontrols\b/.test(videoTag), 'the video needs native controls');
assert(/\bplaysinline\b/.test(videoTag), 'the video must play inline instead of full-screen takeover on iOS');
assert(/webkit-playsinline/.test(videoTag), 'legacy iOS WebViews need webkit-playsinline too');
assert(/preload="metadata"/.test(videoTag), 'preload="metadata" keeps the mobile data cost low');
assert(/\.mp4/.test(videoTag), 'the walkthrough video must stay an MP4 (H.264 plays everywhere)');
assert(/class="ios-modal-video-link"/.test(html),
    'a direct link must be offered when a phone browser refuses inline MP4 playback');
console.log('  ✔ controls, playsinline (+webkit), preload=metadata and a direct-open fallback');

// -------------------------------------------------------------
// Test 5: CSS — the video comes first on a phone
// -------------------------------------------------------------
console.log('\n[5] Mobile layout');

const modalStyle = (html.match(/\.ios-modal \{[\s\S]*?@media \(max-width: 860px\) \{[\s\S]*?\n        \}/) || [])[0] || '';
assert(modalStyle, 'the iOS modal styles must stay in index.html');

const mobileBlock = (modalStyle.match(/@media \(max-width: 860px\) \{([\s\S]*)$/) || [])[1] || '';
assert(/\.ios-modal-body \{ flex-direction: column/.test(mobileBlock),
    'the walkthrough must stack on phones');
assert(/\.ios-modal-video \{ order: -1/.test(mobileBlock),
    'on phones the video must be ordered BEFORE the long step list, or it sits below the fold');
assert(/max-height: 88dvh/.test(modalStyle),
    'the card must use dvh so iOS toolbars do not clip it');
assert(/env\(safe-area-inset-bottom/.test(mobileBlock),
    'the modal needs the iOS safe-area inset at the bottom');
console.log('  ✔ stacked layout with the video first, dvh height and safe-area padding');

// -------------------------------------------------------------
// Test 6: service worker bump so installed clients re-fetch the shell
// -------------------------------------------------------------
console.log('\n[6] Service worker');

const cacheName = (swSrc.match(/const CACHE_NAME = '([^']+)'/) || [])[1] || '';
const cacheVersion = Number((cacheName.match(/-v(\d+)-/) || [])[1] || 0);
assert(cacheVersion >= 246,
    'service worker cache must be bumped past v246 so the new walkthrough reaches clients (found ' +
    (cacheName || '<none>') + ')');
console.log('  ✔ sw.js cache bumped (' + cacheName + ')');

console.log('\n✅ ALL iOS INSTALL VIDEO TESTS PASSED\n');

process.exit(0);
