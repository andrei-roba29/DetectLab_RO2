/* Shared bottom drawer for minimized map configuration windows. */
(function (root) {
    'use strict';
    var dock, list, tab, entries = Object.create(null);
    function ensure() {
        if (dock) return;
        var host = document.querySelector('#map-section .map-frame') || document.querySelector('.map-frame') || document.body;
        dock = document.createElement('div'); dock.className = 'apm-dock'; dock.hidden = true;
        tab = document.createElement('button'); tab.type = 'button'; tab.className = 'apm-dock-tab';
        tab.setAttribute('aria-label', 'Show minimized windows'); tab.setAttribute('aria-expanded', 'false');
        tab.setAttribute('aria-controls', 'mapMinimizedWindows');
        tab.innerHTML = '<svg width="16" height="10" viewBox="0 0 16 10" fill="none" aria-hidden="true"><path d="M2 7L8 2L14 7" stroke="#B8D8F0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        list = document.createElement('div'); list.className = 'apm-dock-list'; list.id = 'mapMinimizedWindows'; list.hidden = true;
        tab.addEventListener('click', function () {
            list.hidden = !list.hidden;
            tab.setAttribute('aria-expanded', String(!list.hidden));
        });
        dock.appendChild(tab); dock.appendChild(list); host.appendChild(dock);
    }
    function remove(id) {
        var entry = entries[id];
        if (!entry) return;
        entry.remove(); delete entries[id];
        if (!Object.keys(entries).length) {
            dock.hidden = true; list.hidden = true; tab.setAttribute('aria-expanded', 'false');
        }
    }
    root.DetectLabWindowDock = {
        minimize: function (id, label, restore) {
            ensure();
            if (entries[id]) { entries[id].textContent = label; return; }
            var item = document.createElement('button'); item.type = 'button'; item.className = 'apm-dock-item';
            item.textContent = label; item.addEventListener('click', function () { remove(id); restore(); });
            entries[id] = item; list.appendChild(item); dock.hidden = false;
        },
        remove: remove
    };
})(window);
