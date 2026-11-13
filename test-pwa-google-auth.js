'use strict';
// Run with node test-pwa-google-auth.js. Browser/OS handoff still needs devices.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('js/pwa-google-auth.js', 'utf8');
const auth = fs.readFileSync('js/auth.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');
const callback = fs.readFileSync('google-auth-callback.html', 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const HANDOFF_KEY = 'detectlab-google-handoff';
const ATTEMPT_KEY = 'detectlab-google-attempt';
const callbackUrl = 'https://detectlab.ro/google-auth-callback.html';
const attemptNonce = storage => JSON.parse(storage.getItem(ATTEMPT_KEY) || 'null').nonce;

function store() {
  const values = new Map();
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    dump: () => Object.fromEntries(values)
  };
}

function harness(opts = {}) {
  let listeners = {}, docListeners = {}, timer, watcher, opened = 0, oauth, exchanged, installed, successes = 0;
  const messages = [];
  const storage = opts.storage || store();
  const popup = { closed: false, location: { replace(url) { this.url = url; } },
    postMessage(data, origin) { this.ack = {data, origin}; }, close() { this.closed = true; } };
  const client = { auth: {
    async signInWithOAuth(args) { oauth = args; return opts.startError ? {error: {}} : {data: {url: 'https://supabase.example/authorize?code_challenge_method=s256&code_challenge=challenge'}}; },
    async exchangeCodeForSession(code) { exchanged = code; return opts.exchangeError ? {error: {}} : {data: {session: {access_token: 'a', refresh_token: 'r'}}}; }
  }};
  const window = { navigator: { standalone: !!opts.ios },
    matchMedia: q => ({matches: !!opts.android && q.includes('standalone')}),
    location: {origin: opts.origin || 'https://detectlab.ro', assign(url) { this.navigatedTo = url; }}, crypto: {subtle:{digest(){}}, getRandomValues(bytes) {bytes.fill(4);}},
    open(url) { opened++; popup.openedWith = url; if (url !== 'about:blank') popup.location.url = url; return opts.blocked ? null : popup; },
    createGooglePopupClient() {return client;},
    localStorage: storage,
    supabaseClient: {auth: { async setSession(tokens) { installed = tokens; return opts.sessionError ? {error: {}} : {data: {session: tokens}}; }}},
    addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener(type) { delete listeners[type]; } };
  const document = { hidden: false, getElementById: () => null,
    addEventListener(type, fn) { docListeners[type] = fn; }, removeEventListener(type) { delete docListeners[type]; } };
  const context = {window, document, URL, Uint8Array, Date,
    setTimeout(fn) {timer = fn; return 1;}, clearTimeout() {timer = null;},
    setInterval(fn) {watcher = fn; return 2;}, clearInterval() {watcher = null;}};
  if (opts.origins) window.DetectLabOAuthOrigins = opts.origins;
  vm.runInNewContext(source, context);
  return { window, document, popup, storage, messages,
    get opened(){return opened;}, get oauth(){return oauth;},
    get exchanged(){return exchanged;}, get installed(){return installed;}, get successes(){return successes;},
    start() {return window.DetectLabGooglePopup.start((msg, type) => messages.push({msg, type}), () => successes++);},
    deliver(event) {if (listeners.message) listeners.message(event);},
    storageEvent(event) {if (listeners.storage) listeners.storage(event);},
    wake() {if (listeners.focus) listeners.focus();},
    pageShow() {if (listeners.pageshow) listeners.pageshow();},
    visible() {document.hidden = false; if (docListeners.visibilitychange) docListeners.visibilitychange();},
    tickWatcher() {if (watcher) watcher();},
    expire() {if (timer) timer();} };
}
async function readyHarness(opts) {
  const h = harness(opts);
  await h.window.DetectLabGooglePopup.prepare();
  return h;
}
function callbackHarness(url, withOpener, seed) {
  const elements = {status:{textContent:''}};
  const timers = [], sent = {count: 0}, storage = store();
  Object.entries(seed || {}).forEach(([key, value]) => storage.setItem(key, value));
  let listener, replaced;
  const opener = withOpener ? {postMessage(data, origin) {sent.data = data; sent.origin = origin; sent.count++;}} : null;
  const location = new URL(url);
  const window = {opener, addEventListener(type, fn) {listener = fn;}, close() {window.closedByPage = true;}};
  const context = {window, location, URLSearchParams, localStorage: storage,
    history:{replaceState(_a, _b, path){replaced=path;}},
    document:{getElementById(id){return elements[id];}},
    setTimeout(fn){timers.push(fn);},
    Date};
  vm.runInNewContext(callback.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return {elements, opener, window, storage, sent,
    get replaced(){return replaced;},
    flush(){while (timers.length) timers.shift()();},
    deliver(event){if (listener) listener(event);}};
}

async function run() {
  // ── The paste-a-code UI is gone from both documents ──
  assert.doesNotMatch(html, /googlePopupHelp|googlePopupCode|finishGooglePopupCode|One-time sign-in code/);
  assert.doesNotMatch(callback, /One-time sign-in code|id="code"|value = code|<textarea/);

  let h = await readyHarness({ios:true});
  assert.equal(h.window.DetectLabGooglePopup.isStandalone(), true);
  const start = h.start();
  assert.equal(h.opened, 1, 'iOS opens Google without replacing the app');
  assert.equal(h.popup.openedWith,
    'https://supabase.example/authorize?code_challenge_method=s256&code_challenge=challenge');
  await start;
  assert.equal(h.oauth.options.skipBrowserRedirect, true);
  assert.equal(h.oauth.options.redirectTo, callbackUrl);
  h.deliver({origin:'https://detectlab.ro', source:h.popup,
    data:{type:'detectlab-google-callback', nonce:attemptNonce(h.storage), code:'ios-code'}});
  await tick();
  assert.equal(h.exchanged, 'ios-code');
  assert.equal(h.successes, 1, 'the original app installs the session');

  h = harness({android:true}); await h.start();
  assert.equal(h.popup.openedWith, 'about:blank', 'Android keeps the existing popup flow');
  const nonce = attemptNonce(h.storage);
  assert.match(nonce, /^[0-9a-f]{32}$/, 'the attempt nonce lives in same-origin storage');
  const data = {type:'detectlab-google-callback', nonce, code:'one-time-code'};
  h.deliver({origin:'https://evil.example', source:h.popup, data});
  h.deliver({origin:'https://detectlab.ro', source:{}, data});
  h.deliver({origin:'https://detectlab.ro', source:h.popup, data:{...data, nonce:'wrong'}});
  assert.equal(h.exchanged, undefined, 'reject unrelated messages');
  h.deliver({origin:'https://detectlab.ro', source:h.popup, data});
  await tick();
  assert.equal(h.exchanged, 'one-time-code');
  assert.equal(h.installed.refresh_token, 'r');
  assert.equal(h.successes, 1);
  assert.equal(h.popup.closed, true);

  // Preparation may still be in progress on the first tap.
  h = harness({ios:true});
  await h.start();
  assert.equal(h.opened, 0);
  assert.match(h.messages.at(-1).msg, /tap Continue with Google again/);
  await h.window.DetectLabGooglePopup.prepare();
  await h.start();
  assert.equal(h.opened, 1);
  assert.match(h.popup.openedWith, /^https:\/\/supabase/);

  h = await readyHarness({ios:true, blocked:true});
  await h.start();
  assert.match(h.messages.at(-1).msg, /blocked/);
  assert.equal(h.storage.getItem(ATTEMPT_KEY), null);

  // ── Handoff record left by the callback window (opener severed) ──
  h = harness({android:true});
  assert.equal(h.window.DetectLabGooglePopup.isStandalone(), true);
  await h.start();
  let hNonce = attemptNonce(h.storage);
  h.storage.setItem(HANDOFF_KEY, JSON.stringify({nonce:'someone-else', code:'nope', at:Date.now()}));
  h.wake(); await tick();
  assert.equal(h.exchanged, undefined, 'foreign handoff ignored');
  h.storage.setItem(HANDOFF_KEY, JSON.stringify({nonce:hNonce, code:'stored-code', at:Date.now()}));
  h.storageEvent({key: HANDOFF_KEY}); await tick(); await tick();
  assert.equal(h.exchanged, 'stored-code');
  assert.equal(h.successes, 1);
  assert.equal(h.storage.getItem(HANDOFF_KEY), null, 'handoff record consumed');
  assert.equal(h.storage.getItem(ATTEMPT_KEY), null, 'attempt record cleared');

  // Picked up when the installed app comes back to the front.
  h = await readyHarness({ios:true}); await h.start();
  hNonce = attemptNonce(h.storage);
  h.storage.setItem(HANDOFF_KEY, JSON.stringify({nonce:hNonce, code:'focus-code', at:Date.now()}));
  h.visible(); await tick(); await tick();
  assert.equal(h.exchanged, 'focus-code'); assert.equal(h.successes, 1);
  h = await readyHarness({ios:true}); await h.start();
  hNonce = attemptNonce(h.storage);
  h.storage.setItem(HANDOFF_KEY, JSON.stringify({nonce:hNonce, code:'poll-code', at:Date.now()}));
  h.tickWatcher(); await tick(); await tick();
  assert.equal(h.exchanged, 'poll-code');

  // Expired handoff record is not used.
  h = await readyHarness({ios:true}); await h.start();
  hNonce = attemptNonce(h.storage);
  h.storage.setItem(HANDOFF_KEY, JSON.stringify({nonce:hNonce, code:'old-code', at:Date.now() - 11 * 60 * 1000}));
  h.wake(); await tick();
  assert.equal(h.exchanged, undefined);

  // A cancelled/failed consent ends the attempt without a code.
  h = await readyHarness({ios:true}); await h.start();
  hNonce = attemptNonce(h.storage);
  h.storage.setItem(HANDOFF_KEY, JSON.stringify({nonce:hNonce, error:true, at:Date.now()}));
  h.wake(); await tick();
  assert.equal(h.exchanged, undefined); assert.match(h.messages.at(-1).msg, /cancelled or failed/);
  h = harness({android:true}); await h.start();
  hNonce = attemptNonce(h.storage);
  h.deliver({origin:'https://detectlab.ro', source:h.popup, data:{type:'detectlab-google-callback', nonce:hNonce, error:true}});
  assert.equal(h.exchanged, undefined); assert.match(h.messages.at(-1).msg, /cancelled or failed/);

  // ── Failures stay in the form, with nothing to paste ──
  h = harness({blocked:true, android:true}); await h.start();
  assert.match(h.messages.at(-1).msg, /blocked/);
  h = harness({android:true, startError:true}); await h.start();
  assert.equal(h.popup.closed, true); assert.match(h.messages.at(-1).msg, /Could not open/);
  h = harness({android:true, exchangeError:true}); await h.start();
  hNonce = attemptNonce(h.storage);
  h.deliver({origin:'https://detectlab.ro', source:h.popup, data:{type:'detectlab-google-callback', nonce:hNonce, code:'bad'}});
  await tick();
  assert.equal(h.successes, 0); assert.equal(h.installed, undefined); assert.match(h.messages.at(-1).msg, /could not be completed/);
  h = harness({android:true, sessionError:true}); await h.start();
  hNonce = attemptNonce(h.storage);
  h.deliver({origin:'https://detectlab.ro', source:h.popup, data:{type:'detectlab-google-callback', nonce:hNonce, code:'bad'}});
  await tick();
  assert.equal(h.successes, 0); assert.match(h.messages.at(-1).msg, /could not be completed/);

  // One attempt at a time; an abandoned one is replaced after the grace period.
  h = await readyHarness({ios:true}); await h.start(); await h.start();
  assert.equal(h.opened, 1); assert.match(h.messages.at(-1).msg, /already in progress/);
  h = await readyHarness({ios:true}); await h.start();
  h.window.DetectLabGooglePopup.cancel();
  assert.equal(h.storage.getItem(ATTEMPT_KEY), null, 'iOS cancellation clears the attempt');
  h = await readyHarness({ios:true}); await h.start(); h.expire();
  assert.match(h.messages.at(-1).msg, /expired/);

  // ── Callback window ──
  // The nonce is read from the attempt record the app left in same-origin
  // storage, never from the redirect URL (Supabase may rewrite that URL).
  let cb = callbackHarness('https://detectlab.ro/google-auth-callback.html?code=secret', false,
    {[ATTEMPT_KEY]: JSON.stringify({nonce: 'abc', origin: 'https://detectlab.ro', at: Date.now()})});
  assert.equal(cb.replaced, '/google-auth-callback.html');
  const stored = JSON.parse(cb.storage.getItem(HANDOFF_KEY));
  assert.equal(stored.nonce, 'abc'); assert.equal(stored.code, 'secret');
  cb.flush();
  assert.match(cb.elements.status.textContent, /Return to the original DetectLab/);
  assert.equal(cb.window.closedByPage, true, 'closing is attempted');
  cb = callbackHarness('https://detectlab.ro/google-auth-callback.html?code=secret', true,
    {[ATTEMPT_KEY]: JSON.stringify({nonce: 'abc', origin: 'https://detectlab.ro', at: Date.now()})});
  assert.equal(cb.sent.origin, 'https://detectlab.ro');
  assert.equal(cb.sent.data.nonce, 'abc', 'the callback echoes the stored attempt nonce');
  assert.equal(cb.sent.data.type, 'detectlab-google-callback');
  cb.deliver({origin:'https://evil.example', source:cb.opener, data:{type:'detectlab-google-ack',nonce:'abc'}});
  cb.flush();
  assert.match(cb.elements.status.textContent, /Sign-in result sent/);
  cb = callbackHarness('https://detectlab.ro/google-auth-callback.html?code=secret', true,
    {[ATTEMPT_KEY]: JSON.stringify({nonce: 'abc', origin: 'https://detectlab.ro', at: Date.now()})});
  cb.deliver({origin:'https://detectlab.ro', source:cb.opener, data:{type:'detectlab-google-ack',nonce:'abc'}});
  cb.flush();
  assert.match(cb.elements.status.textContent, /Signed in/);
  cb = callbackHarness('https://detectlab.ro/google-auth-callback.html#error=access_denied', false);
  assert.equal(JSON.parse(cb.storage.getItem(HANDOFF_KEY)).error, true);
  cb.flush();
  assert.match(cb.elements.status.textContent, /cancelled or failed/);
  cb = callbackHarness('https://detectlab.ro/google-auth-callback.html', false);
  cb.flush();
  assert.match(cb.elements.status.textContent, /No sign-in result/);
  assert.equal(cb.storage.getItem(HANDOFF_KEY), null);

  // ── Only an allow-listed origin may start Google OAuth ──
  // Supabase sends an unknown redirect_to to the project Site URL
  // (detectlab.ro), which is what moved a detectlab.eu sign-in to the other
  // domain, inside a browser window.
  h = await readyHarness({ios:true, origin: 'https://deploy-preview-12--detectlab.netlify.app'});
  await h.start();
  assert.equal(h.opened, 0, 'no popup on an unlisted origin');
  assert.equal(h.oauth, undefined, 'the OAuth request must not be started');
  assert.match(h.messages.at(-1).msg, /not configured for this address/);
  h = harness({origin: 'https://deploy-preview-12--detectlab.netlify.app',
    origins: ['https://detectlab.ro', 'https://detectlab.eu', 'https://deploy-preview-12--detectlab.netlify.app']});
  await h.start();
  assert.equal(h.oauth.options.redirectTo, 'https://deploy-preview-12--detectlab.netlify.app/google-auth-callback.html',
    'an explicitly listed origin keeps its own callback');
  h = await readyHarness({ios:true, origin: 'https://detectlab.eu'});
  await h.start();
  assert.equal(h.oauth.options.redirectTo, 'https://detectlab.eu/google-auth-callback.html',
    'the .eu market stays on .eu');

  // A callback that could not read the attempt record hands the code over
  // without a nonce; with exactly one attempt open that is still the answer.
  h = await readyHarness({ios:true}); await h.start();
  h.storage.setItem(HANDOFF_KEY, JSON.stringify({nonce:null, code:'anonymous-code', at:Date.now()}));
  h.wake(); await tick(); await tick();
  assert.equal(h.exchanged, 'anonymous-code');

  // ── Wiring ──
  assert.match(auth, /provider === 'google' && window\.DetectLabGooglePopup/);
  assert.match(auth, /auth\.signInWithOAuth\(\{/); // ordinary browser path remains
  assert.match(auth, /signInWithPassword\(/);
  assert.match(auth, /detectLabOAuthOriginAllowed/, 'the browser path checks the origin list too');
  assert.match(auth, /DetectLabOAuthOrigins/, 'the allow-list can be extended per deployment');
  assert.match(html, /js\/pwa-google-auth\.js\?v=20261102-ios-popup-return/);
  assert.match(sw, /js\/pwa-google-auth\.js\?v=20261102-ios-popup-return/);
  assert.match(html, /js\/auth\.js\?v=20261101-safari-direct-oauth/);
  assert.match(sw, /js\/auth\.js\?v=20261101-safari-direct-oauth/);
  assert.match(sw, /pathname === '\/google-auth-callback\.html'[\s\S]*pathname === '\/google-auth-callback'/);
  assert.match(sw, /CACHE_NAME = 'detectlab-v402-google-callback-bypass'/);
  assert.match(callback, /history\.replaceState\(null, '', location\.pathname\)/);
  assert.match(callback, /event\.origin !== location\.origin/);
  assert.match(callback, /Close and return to DetectLab/);
  console.log('Google PWA OAuth regression tests passed');
}
run().catch(err => {console.error(err); process.exitCode = 1;});
