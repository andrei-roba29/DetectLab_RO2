/* Run: node test-pin-style.js */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('js/translations.js', 'utf8');
// Only evaluate the translation dictionary, not the browser language handlers.
const end = source.indexOf('\n', source.lastIndexOf('            et: {'));
const dictionaryEnd = source.indexOf('\n        };', end);
assert(dictionaryEnd > 0, 'translation dictionary boundary exists');
const context = {};
vm.runInNewContext(source.slice(0, dictionaryEnd + '\n        };'.length) + '\nthis.words = translations;', context);
assert.strictEqual(Object.keys(context.words).length, 25);
for (const [lang, words] of Object.entries(context.words)) {
    for (const key of ['pin_title', 'pin_notes', 'pin_create_event', 'pin_delete', 'pin_save']) {
        assert(words[key] && words[key].trim(), `${lang}: ${key}`);
    }
}
assert.strictEqual(context.words.en.pin_create_event, 'Create event');
assert.strictEqual(context.words.ro.pin_title, 'Titlu');
const map = fs.readFileSync('js/map-app.js', 'utf8');
const popup = map.slice(map.indexOf('function createCoordPopupContent'), map.indexOf('function copyCoordinates'));
assert(!/[📍📅🗑]/u.test(popup), 'draft popup has no decorative emoji');
assert(!popup.includes('coord-popup-save-icon'), 'save button is text only');
assert(map.includes('translatePinPopup(popupContainer)'), 'saved popup is translated');
assert(map.includes('document.querySelectorAll(\'.pin-popup\').forEach(translatePinPopup)'), 'open popups update on language change');
const css = fs.readFileSync('css/styles.css', 'utf8');
assert(css.includes('.saved-location-marker::after'), 'pin has a central dot');
assert(!css.includes('border-radius: 50% 50% 50% 0'), 'no teardrop pin shape');
console.log('Pin styling and all 25 translations passed.');
