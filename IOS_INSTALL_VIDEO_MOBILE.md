# iOS install video missing on mobile (web app in the browser)

## Symptom

On a phone, the **iOS App** button opened no walkthrough: the install demo video
could only be seen from a laptop/PC. On desktop the modal with the steps and the
video appeared exactly as expected.

## Cause

`showIOSInstructions()` in `index.html` had two different behaviours:

```js
if (isIOS && isSafari) {
    showPWAToast(msg);   // one-line toast
    return;              // ← never reaches openIOSInstallModal()
}
openIOSInstallModal();
```

The walkthrough modal — the only place `#iosInstallVideo` lives — was reached
only by devices that are **not** an iPhone/iPad in Safari. A real iPhone in
Safari (the device the video is *about*) got a toast, so the video never
rendered there. Desktop and Android went through the modal, which is why the
clip looked "desktop only".

A second, smaller problem affected the phones that did get the modal (Android
and iOS Chrome/Firefox): at `max-width: 860px` the modal body stacked
**text first, video second**. The four-step list plus the tip is taller than the
scrollable card on a phone, so the video started below the fold and read as
"missing" unless the user scrolled.

## Fix

1. **One entry point.** `openIOSInstallModal()` is now called on every device,
   iPhone/iPad Safari included; the toast is only a fallback if the modal markup
   is absent. `openIOSInstallModal()` returns the modal element (or `null`) so
   the caller can fall back cleanly.
2. **Video first on phones.** In the `@media (max-width: 860px)` block,
   `.ios-modal-video { order: -1 }` puts the clip above the step list, so it is
   on screen the moment the modal opens. The steps remain below it.
3. **Phone-friendly geometry.** The card caps at `88dvh` (with `88vh` as the
   fallback) so iOS toolbars cannot clip it, the modal pads itself with
   `env(safe-area-inset-*)`, the card scrolls with `-webkit-overflow-scrolling:
   touch` + `overscroll-behavior: contain`, and the video caps at `46dvh` on
   phones.
4. **Playback hardening.** The element keeps `controls` + `preload="metadata"`
   and now also declares `webkit-playsinline` / `x5-playsinline` (old iOS
   WebViews and some Android OEM browsers ignore plain `playsinline` and would
   take the clip full-screen on tap). A `Deschide videoclipul / Open the video`
   link under the player opens the same MP4 in its own tab for any browser that
   still refuses inline MP4 playback — the native player always takes over
   there.

`sw.js` is bumped to `detectlab-v246-ios-install-video-mobile` so installed
clients re-fetch the new `index.html` shell.

## Tests

`node test-ios-install-video-mobile.js` covers:

* no iOS-Safari early return in `showIOSInstructions()`;
* tapping **iOS App** opens the modal (and renders the steps) for iPhone Safari,
  iPhone Chrome, Android Chrome and desktop, without falling back to the toast;
* closing the modal hides it and pauses the video;
* the video markup keeps `controls`, `playsinline`/`webkit-playsinline`,
  `preload="metadata"`, an `.mp4` source and the direct-open fallback link;
* the `≤860px` block stacks the body, orders the video first, uses `dvh` and
  the safe-area inset;
* the service-worker cache version is ≥ v246.
