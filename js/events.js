/* ══════════════════════════════════════════════
   DetectLab Events System ('events'/'evenimente')
   - Pin location -> Create event
   - Warrior helmet markers colored by expiration (Red <3d, Yellow 4-7d, Green >7d)
   - Manage Account -> Events / Events Panel
   - 1 event per day attendance limit check
   - 1-year creation limit check
   - Inquiries with 100-word text
   - In-app / windows notification for creator with accept/decline
   - Automatic chat creation on accept, with timer, photo/video attachments, and add-to-calendar (.ics)
   - Creator delete event & kick out attendees
══════════════════════════════════════════════ */
(function () {
    let eventsLayer = null;
    let eventsData = [];
    let activeChatEventId = null;
    let activeChatDeadlineTimer = null;
    let activeChatRealtimeChannel = null;
    let activeChatRefreshTimer = null;
    let activeChatRefreshPromise = null;
    let activeChatRefreshEventId = null;
    let activeChatRefreshQueued = false;
    let activeChatRealtimeGeneration = 0;

    // ── CHAT LAST SEEN TRACKING ──
    function getChatLastSeenMap() {
        try { return JSON.parse(localStorage.getItem('detectlab_chat_last_seen') || '{}'); } catch (e) { return {}; }
    }
    function saveChatLastSeenMap(map) {
        try { localStorage.setItem('detectlab_chat_last_seen', JSON.stringify(map)); } catch (e) {}
    }
    function getLastSeen(eventId) {
        var map = getChatLastSeenMap();
        return map[eventId] || null;
    }
    function setLastSeen(eventId) {
        if (!eventId) return;
        var map = getChatLastSeenMap();
        map[eventId] = new Date().toISOString();
        saveChatLastSeenMap(map);
    }

    // ── INJECT BADGE + CALENDAR CSS ──
    (function injectEventsExtraStyles() {
        if (document.getElementById('detectlab-events-extra-style')) return;
        var style = document.createElement('style');
        style.id = 'detectlab-events-extra-style';
        style.textContent = `
        .event-notif-badge {
            position: absolute;
            top: -6px;
            right: -6px;
            background: #C42B2B;
            color: #fff;
            font-size: 0.62rem;
            font-weight: 800;
            min-width: 18px;
            height: 18px;
            border-radius: 9px;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0 4px;
            border: 2px solid rgba(10,20,42,0.95);
            z-index: 5;
            line-height: 1;
            pointer-events: none;
            box-shadow: 0 2px 8px rgba(0,0,0,0.45);
        }
        .event-notif-badge.hidden { display: none !important; }
        .event-notif-badge.pulse { animation: eventBadgePulse 1.4s infinite; }
        @keyframes eventBadgePulse { 0%{transform:scale(1)} 50%{transform:scale(1.18)} 100%{transform:scale(1)} }
        .user-trigger { position: relative !important; }
        .pwa-bar-trigger { position: relative !important; }
        #userMenu button[onclick*="openEvents"] { position: relative !important; }
        #pwaUserDropdown button[onclick*="openEvents"] { position: relative !important; }
        .pwa-dropdown-user button[onclick*="openEvents"] { position: relative !important; }

        /* Keep the creation form below the phone status bar, including PWAs
           that report a zero safe-area inset. Bound the scrollable card to
           the remaining viewport so centering cannot push its title above it. */
        #createEventModal {
            --ce-top-gap: calc(16px + env(safe-area-inset-top, 0px));
            --ce-bottom-gap: calc(16px + env(safe-area-inset-bottom, 0px));
            box-sizing: border-box;
            padding: var(--ce-top-gap) 16px var(--ce-bottom-gap);
        }
        html.is-pwa #createEventModal,
        body.is-pwa #createEventModal {
            --ce-top-gap: calc(16px + max(32px, env(safe-area-inset-top, 0px)));
        }
        #createEventModal > div {
            box-sizing: border-box;
            max-height: calc(100vh - var(--ce-top-gap) - var(--ce-bottom-gap));
            max-height: calc(100dvh - var(--ce-top-gap) - var(--ce-bottom-gap));
        }

        /* Calendar panel */
        #eventsManagerPanel {
            position: fixed;
            inset: 0;
            z-index: 3500;
            background: rgba(4,10,22,0.92);
            backdrop-filter: blur(14px);
            display: flex;
            flex-direction: column;
            padding: 16px;
            overflow-y: auto;
            color: #F5F0EB;
            font-family: 'Outfit', sans-serif;
            animation: pwaDropUp 0.22s ease;
        }
        /* Installed PWA only: the translucent phone status bar sits on top of
           the Events header and intercepts taps on Back / Today. Extra top
           padding (safe-area + a small fixed buffer) pushes those buttons
           below the bar; the inset itself is painted #060D1D. */
        html.is-pwa #eventsManagerPanel,
        body.is-pwa #eventsManagerPanel {
            padding-top: calc(16px + max(32px, env(safe-area-inset-top, 0px)));
            background: #060D1D;
        }
        #eventsManagerPanel .cal-wrap {
            max-width: 560px;
            width: 100%;
            margin: 0 auto;
            display: flex;
            flex-direction: column;
            gap: 14px;
            padding-bottom: 24px;
        }
        .cal-header-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 4px;
        }
        .cal-title {
            font-family: 'Cinzel', serif;
            font-size: 1.35rem;
            color: var(--sky, #B8D8F0);
            font-weight: 700;
        }
        .cal-nav {
            display: flex;
            gap: 8px;
        }
        .cal-nav button {
            width: 34px; height: 34px;
            border-radius: 8px;
            border: 1px solid rgba(184,216,240,0.18);
            background: rgba(255,255,255,0.06);
            color: rgba(245,240,235,0.85);
            cursor: pointer;
            font-size: 1rem;
            display: flex; align-items: center; justify-content: center;
            transition: background 0.18s, border-color 0.18s;
        }
        .cal-nav button:hover { background: rgba(107,63,160,0.28); border-color: rgba(196,160,240,0.5); }
        .cal-weekdays {
            display: grid;
            grid-template-columns: repeat(7, 1fr);
            gap: 4px;
            font-size: 0.72rem;
            font-weight: 600;
            color: rgba(184,216,240,0.55);
            text-transform: uppercase;
            letter-spacing: 0.04em;
            padding: 0 2px;
        }
        .cal-weekdays span { text-align: center; padding: 4px 0; }
        .cal-grid {
            display: grid;
            grid-template-columns: repeat(7, 1fr);
            gap: 6px;
        }
        .cal-day {
            aspect-ratio: 1;
            min-height: 44px;
            border-radius: 10px;
            border: 1px solid rgba(184,216,240,0.12);
            background: rgba(255,255,255,0.03);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: flex-start;
            padding: 6px 2px 4px;
            cursor: pointer;
            position: relative;
            transition: background 0.18s, border-color 0.18s, transform 0.12s;
            user-select: none;
        }
        .cal-day:hover { background: rgba(107,63,160,0.18); border-color: rgba(196,160,240,0.35); transform: translateY(-1px); }
        .cal-day.other-month { opacity: 0.28; }
        .cal-day.today { border-color: rgba(184,216,240,0.55); box-shadow: inset 0 0 0 1px rgba(184,216,240,0.25); }
        .cal-day.has-event { background: rgba(107,63,160,0.16); border-color: rgba(196,160,240,0.38); }
        .cal-day.has-event::after {
            content: '';
            position: absolute;
            bottom: 6px;
            left: 50%;
            transform: translateX(-50%);
            width: 6px; height: 6px;
            border-radius: 50%;
            background: #C4A0F0;
            box-shadow: 0 0 6px rgba(196,160,240,0.7);
        }
        .cal-day.has-event.attending::after { background: #2E9E4F; box-shadow: 0 0 6px rgba(46,158,79,0.6); }
        .cal-day.selected {
            background: linear-gradient(135deg, rgba(107,63,160,0.55), rgba(13,43,94,0.65)) !important;
            border-color: rgba(196,160,240,0.75) !important;
            color: #fff;
        }
        .cal-day-num { font-size: 0.88rem; font-weight: 600; line-height: 1; }
        .cal-day-count {
            font-size: 0.58rem;
            margin-top: 2px;
            color: rgba(245,240,235,0.6);
            background: rgba(0,0,0,0.18);
            border-radius: 6px;
            padding: 0 4px;
        }
        .cal-selected-events {
            margin-top: 6px;
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(184,216,240,0.12);
            border-radius: 12px;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            min-height: 48px;
        }
        .cal-selected-title {
            font-size: 0.82rem;
            font-weight: 700;
            color: rgba(184,216,240,0.9);
            display: flex; align-items: center; justify-content: space-between;
        }
        .cal-event-card {
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(184,216,240,0.14);
            border-radius: 9px;
            padding: 10px 12px;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .cal-event-card .cec-title { font-weight: 700; font-size: 0.92rem; }
        .cal-event-card .cec-meta { font-size: 0.72rem; opacity: 0.7; }
        .cal-footer {
            margin-top: 6px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .cal-chats-btn {
            width: 100%;
            padding: 12px 14px;
            border-radius: 10px;
            background: linear-gradient(135deg, #0D2B5E, #6B3FA0);
            border: 1px solid rgba(196,160,240,0.45);
            color: #fff;
            font-family: 'Outfit', sans-serif;
            font-weight: 700;
            font-size: 0.9rem;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            position: relative;
            box-shadow: 0 6px 18px rgba(0,0,0,0.35);
            transition: transform 0.15s, box-shadow 0.15s;
        }
        .cal-chats-btn:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(0,0,0,0.45); }
        .cal-chats-btn .event-notif-badge {
            position: absolute;
            top: -8px; right: -8px;
        }
        .cal-chats-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-top: 10px;
        }
        .cal-chat-card {
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(184,216,240,0.15);
            border-radius: 10px;
            padding: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
        }
        .cal-back-btn {
            background: none;
            border: none;
            color: var(--sky, #B8D8F0);
            font-weight: 600;
            font-size: 0.9rem;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 0;
            margin-bottom: 2px;
        }

        /* Event chat / message box */
        #eventChatModal {
            position: fixed;
            inset: 0;
            z-index: 4500;
            background: rgba(4,10,22,0.92);
            backdrop-filter: blur(12px);
            display: flex;
            flex-direction: column;
            padding: 16px;
        }
        /* Installed PWA only: the translucent phone status bar sits on top of
           the chat header and intercepts taps on Close / Add to Calendar.
           Extra top padding (safe-area + a small fixed buffer) pushes those
           buttons below the bar; the inset itself is painted #060D1D. */
        html.is-pwa #eventChatModal,
        body.is-pwa #eventChatModal {
            padding-top: calc(16px + max(32px, env(safe-area-inset-top, 0px)));
            background: #060D1D;
        }

        /* Join anonymous event bar (search-bar look) */
        .anon-join-bar {
            display: flex;
            flex-direction: column;
            gap: 6px;
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(184,216,240,0.14);
            border-radius: 12px;
            padding: 12px;
        }
        .anon-join-label {
            font-size: 0.78rem;
            font-weight: 700;
            color: rgba(184,216,240,0.9);
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .anon-join-row {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        .anon-join-input-wrap {
            flex: 1;
            display: flex;
            align-items: center;
            gap: 8px;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(184,216,240,0.25);
            border-radius: 999px;
            padding: 8px 14px;
            transition: border-color 0.18s, box-shadow 0.18s;
        }
        .anon-join-input-wrap:focus-within {
            border-color: rgba(196,160,240,0.7);
            box-shadow: 0 0 0 2px rgba(107,63,160,0.25);
        }
        .anon-join-input-wrap .anon-join-icon {
            opacity: 0.6;
            font-size: 0.85rem;
            flex-shrink: 0;
        }
        .anon-join-input {
            flex: 1;
            min-width: 0;
            background: none;
            border: none;
            outline: none;
            color: #F5F0EB;
            font-family: 'Outfit', sans-serif;
            font-size: 0.88rem;
            letter-spacing: 0.12em;
            text-transform: uppercase;
        }
        .anon-join-input::placeholder {
            letter-spacing: normal;
            text-transform: none;
            color: rgba(245,240,235,0.45);
        }
        .anon-join-btn {
            border: 1px solid rgba(196,160,240,0.5);
            background: linear-gradient(135deg, #0D2B5E, #6B3FA0);
            color: #fff;
            font-family: 'Outfit', sans-serif;
            font-weight: 800;
            font-size: 0.78rem;
            letter-spacing: 0.06em;
            border-radius: 999px;
            padding: 9px 18px;
            cursor: pointer;
            white-space: nowrap;
            transition: transform 0.15s, box-shadow 0.15s;
        }
        .anon-join-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(0,0,0,0.4); }
        .anon-join-btn:disabled { opacity: 0.6; cursor: default; transform: none; box-shadow: none; }
        .anon-join-error {
            font-size: 0.72rem;
            color: #ff8a8a;
            min-height: 0;
        }
        .anon-join-error:empty { display: none; }
        `;
        document.head.appendChild(style);
    })();


    // Helper: get current user
    function getCurrentUser() {
        return window._authUser ? window._authUser() : null;
    }

    // Helper: format date for display
    function formatDate(isoStr) {
        if (!isoStr) return '';
        try {
            var d = new Date(isoStr);
            return d.toLocaleString();
        } catch (e) {
            return isoStr;
        }
    }

    // Helper: get date string YYYY-MM-DD
    function getDateString(isoStr) {
        if (!isoStr) return '';
        try {
            var d = new Date(isoStr);
            return d.toISOString().split('T')[0];
        } catch (e) {
            return String(isoStr).substring(0, 10);
        }
    }

    // Storage fallback using localStorage if Supabase is offline/unconfigured
    function getLocalEvents() {
        try {
            return JSON.parse(localStorage.getItem('detectlab_events') || '[]');
        } catch (e) { return []; }
    }
    function saveLocalEvents(arr) {
        try { localStorage.setItem('detectlab_events', JSON.stringify(arr)); } catch (e) {}
    }

    function getLocalInquiries() {
        try { return JSON.parse(localStorage.getItem('detectlab_inquiries') || '[]'); } catch (e) { return []; }
    }
    function saveLocalInquiries(arr) {
        try { localStorage.setItem('detectlab_inquiries', JSON.stringify(arr)); } catch (e) {}
    }

    function getLocalAttendees() {
        try { return JSON.parse(localStorage.getItem('detectlab_attendees') || '[]'); } catch (e) { return []; }
    }
    function saveLocalAttendees(arr) {
        try { localStorage.setItem('detectlab_attendees', JSON.stringify(arr)); } catch (e) {}
    }

    function getLocalMessages() {
        try { return JSON.parse(localStorage.getItem('detectlab_chat_msgs') || '[]'); } catch (e) { return []; }
    }
    function saveLocalMessages(arr) {
        try { localStorage.setItem('detectlab_chat_msgs', JSON.stringify(arr)); } catch (e) {}
    }

    function getLocalChats() {
        try { return JSON.parse(localStorage.getItem('detectlab_event_chats') || '[]'); } catch (e) { return []; }
    }
    function saveLocalChats(arr) {
        try { localStorage.setItem('detectlab_event_chats', JSON.stringify(arr)); } catch (e) {}
    }

    function getLocalNotifications() {
        try { return JSON.parse(localStorage.getItem('detectlab_notifications') || '[]'); } catch (e) { return []; }
    }
    function saveLocalNotifications(arr) {
        try { localStorage.setItem('detectlab_notifications', JSON.stringify(arr)); } catch (e) {}
    }

    /* ══════════════════════════════════════════════════════════════════
       SERVER-AUTHORITATIVE MIRROR
       ------------------------------------------------------------------
       Everything above is a localStorage mirror of the Supabase tables so
       the feature keeps working offline. The mirror used to be *additive
       only*: whatever the server did not return was still merged back in
       (and local-only events were even re-uploaded). That made REMOVALS
       invisible across accounts:

         • an event deleted by its creator stayed on every other user's map,
           because their stale local copy was merged back in and re-synced;
         • a kicked attendee stayed a participant for himself and everyone
           else, because their cached event_attendees row was never dropped.

       The helpers below make the server win whenever it is reachable, while
       still protecting genuinely local (offline-created, never-synced) data.
       ══════════════════════════════════════════════════════════════════ */

    // Ids of events confirmed to exist on the server by the last successful
    // fetch, and whether that fetch reached the server at all.
    var serverEventIds = null;
    var serverReachable = false;

    // Events this device confirmed as saved on the server. If such an event
    // later disappears from the server it was deleted there — it must not be
    // resurrected, even when the event_deletions tombstone table is missing.
    function getSyncedEventIds() {
        try { return JSON.parse(localStorage.getItem('detectlab_events_synced') || '{}'); } catch (e) { return {}; }
    }
    function saveSyncedEventIds(map) {
        try { localStorage.setItem('detectlab_events_synced', JSON.stringify(map)); } catch (e) {}
    }
    function markEventSynced(eventId) {
        if (!eventId) return;
        var map = getSyncedEventIds();
        if (map[eventId]) return;
        map[eventId] = true;
        saveSyncedEventIds(map);
    }
    function forgetSyncedEvents(eventIds) {
        var map = getSyncedEventIds();
        var changed = false;
        (eventIds || []).forEach(function (id) {
            if (map[id]) { delete map[id]; changed = true; }
        });
        if (changed) saveSyncedEventIds(map);
    }

    function isEventOwnedByUser(ev, user) {
        if (!ev || !user) return false;
        if (ev.creator_id && user.id && ev.creator_id === user.id) return true;
        return !!(user.email && ev.creator_email && user.email === ev.creator_email);
    }

    // True when the server's answer about this event may be treated as complete:
    // the last fetch reached the server AND the event exists there, so any child
    // row (attendee, inquiry) missing from the response was genuinely removed.
    function canTrustServerFor(eventId) {
        return !!(serverReachable && serverEventIds && serverEventIds[eventId]);
    }

    // Drop every locally cached artifact of events that no longer exist.
    function purgeLocalEventArtifacts(eventIds) {
        var gone = {};
        (eventIds || []).forEach(function (id) { if (id) gone[id] = true; });
        var goneIds = Object.keys(gone);
        if (goneIds.length === 0) return;

        saveLocalEvents(getLocalEvents().filter(function (e) { return !(e && gone[e.id]); }));
        saveLocalAttendees(getLocalAttendees().filter(function (a) { return !(a && gone[a.event_id]); }));
        saveLocalInquiries(getLocalInquiries().filter(function (i) { return !(i && gone[i.event_id]); }));
        saveLocalNotifications(getLocalNotifications().filter(function (n) { return !(n && gone[n.event_id]); }));
        saveLocalChats(getLocalChats().filter(function (c) { return !(c && gone[c.event_id]); }));
        saveLocalMessages(getLocalMessages().filter(function (m) { return !(m && gone[m.event_id]); }));
        forgetSyncedEvents(goneIds);

        var seen = getChatLastSeenMap();
        var seenChanged = false;
        goneIds.forEach(function (id) { if (seen[id]) { delete seen[id]; seenChanged = true; } });
        if (seenChanged) saveChatLastSeenMap(seen);

        if (activeChatEventId && gone[activeChatEventId]) {
            window._closeEventChatModal();
        }
    }

    // Make the cached attendee rows of `eventIds` match the server's list.
    // Returns the removed rows as [{ event_id, user_id }].
    function reconcileLocalAttendees(eventIds, remoteRows) {
        var scope = {};
        (eventIds || []).forEach(function (id) { if (id && canTrustServerFor(id)) scope[id] = true; });
        if (Object.keys(scope).length === 0) return [];

        var keep = {};
        (remoteRows || []).forEach(function (row) {
            if (row && row.event_id && row.user_id) keep[row.event_id + '::' + row.user_id] = row;
        });

        var removed = [];
        var next = [];
        getLocalAttendees().forEach(function (att) {
            if (!att || !att.event_id) return;
            if (!scope[att.event_id]) { next.push(att); return; }
            var row = keep[att.event_id + '::' + att.user_id];
            if (row) {
                next.push(Object.assign({}, att, row));
            } else {
                // Gone on the server → kicked out by the creator.
                removed.push({ event_id: att.event_id, user_id: att.user_id });
            }
        });
        Object.keys(keep).forEach(function (key) {
            var row = keep[key];
            var present = next.some(function (a) {
                return a.event_id === row.event_id && a.user_id === row.user_id;
            });
            if (!present) next.push(row);
        });

        saveLocalAttendees(next);
        return removed;
    }

    // Same idea, but scoped to one user across all their events. Used to detect
    // that the *current* user was kicked out of an event on another device.
    function reconcileLocalAttendanceForUser(userId, remoteRows) {
        if (!userId) return [];
        var keep = {};
        (remoteRows || []).forEach(function (row) {
            if (row && row.event_id && row.user_id === userId) keep[row.event_id] = row;
        });

        var removed = [];
        var next = [];
        getLocalAttendees().forEach(function (att) {
            if (!att || att.user_id !== userId) { if (att) next.push(att); return; }
            if (keep[att.event_id]) { next.push(Object.assign({}, att, keep[att.event_id])); return; }
            if (canTrustServerFor(att.event_id)) {
                removed.push({ event_id: att.event_id, user_id: userId });
                return;
            }
            next.push(att); // unverifiable (offline / local-only event) → keep
        });
        Object.keys(keep).forEach(function (eventId) {
            var present = next.some(function (a) { return a.event_id === eventId && a.user_id === userId; });
            if (!present) next.push(keep[eventId]);
        });

        saveLocalAttendees(next);
        return removed;
    }

    // React to attendance rows that vanished server-side. Only the rows that
    // belong to the current user affect their UI (chat access, alert).
    function handleAttendanceRemovals(removedRows) {
        if (!removedRows || removedRows.length === 0) return;
        var user = getCurrentUser();
        if (!user || !user.id) return;
        var isRo = (window._currentLang && window._currentLang() === 'ro');

        removedRows.forEach(function (row) {
            if (!row || row.user_id !== user.id) return;
            var ev = getEventById(row.event_id);
            if (isEventOwnedByUser(ev, user)) return; // creators are never "kicked"
            removeLocalChatArtifacts(row.event_id);
            if (activeChatEventId === row.event_id) {
                window._closeEventChatModal();
                alert(isRo
                    ? 'Ai fost eliminat din acest eveniment de către organizator.'
                    : 'You were removed from this event by the organiser.');
            }
        });

        refreshEventsMap(true);
    }

    // Make the current user's cached inquiries match the server, so a request
    // that was withdrawn/removed there stops showing as "Request pending".
    async function reconcileMyLocalInquiries(userId) {
        if (!userId || !window.supabaseClient) return;
        var rows = null;
        try {
            var res = await window.supabaseClient.from('event_inquiries').select('*').eq('user_id', userId);
            if (res && !res.error && Array.isArray(res.data)) rows = res.data;
        } catch (e) {}
        if (!rows) return;

        var byId = {};
        rows.forEach(function (r) { if (r && r.id) byId[r.id] = r; });

        var next = [];
        getLocalInquiries().forEach(function (inq) {
            if (!inq || inq.user_id !== userId) { if (inq) next.push(inq); return; }
            if (byId[inq.id]) {
                next.push(Object.assign({}, inq, byId[inq.id]));
                delete byId[inq.id];
                return;
            }
            // Not on the server. Keep it only while we cannot verify the event
            // (offline / local-only), otherwise it is stale and would freeze the
            // popup on "Request pending" forever.
            if (!canTrustServerFor(inq.event_id)) next.push(inq);
        });
        Object.keys(byId).forEach(function (id) { next.push(byId[id]); });
        saveLocalInquiries(next);
    }

    // Pull the current user's own attendance + inquiries and mirror the server.
    // This is what makes a "kick out" visible on the kicked user's own device.
    async function syncMyEventStateFromServer() {
        var user = getCurrentUser();
        if (!user || !user.id || !window.supabaseClient) return;

        var removed = [];
        try {
            var attRes = await window.supabaseClient.from('event_attendees').select('*').eq('user_id', user.id);
            if (attRes && !attRes.error && Array.isArray(attRes.data)) {
                removed = reconcileLocalAttendanceForUser(user.id, attRes.data);
            }
        } catch (e) {}

        try { await reconcileMyLocalInquiries(user.id); } catch (e) {}

        if (removed.length > 0) handleAttendanceRemovals(removed);
        // Re-render even without removals: newly mirrored attendance rows can
        // make an anonymous event visible (translucent) on this device.
        else refreshEventsMap(true);
    }

    // ── ANONYMOUS EVENTS ──
    // Anonymous events never render on the map for outsiders. The creator and
    // anyone who joined via the event code see them with the same helmet
    // symbol, but translucent. Joining is instant (no inquiry/approval): the
    // user types the code in the "Join an anonymous event" bar in the Events
    // panel and is added directly as an attendee; the creator gets notified.

    function generateEventCode() {
        // 6 chars, unambiguous alphabet (no 0/O/1/I/L).
        var alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        var out = '';
        try {
            var buf = new Uint32Array(6);
            window.crypto.getRandomValues(buf);
            for (var i = 0; i < 6; i++) out += alphabet[buf[i] % alphabet.length];
            return out;
        } catch (e) {}
        for (var j = 0; j < 6; j++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
        return out;
    }

    function normalizeEventCode(raw) {
        return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    function isAnonymousEvent(ev) {
        return !!(ev && (ev.is_anonymous === true || ev.is_anonymous === 'true'));
    }

    function isLocalAttendeeOf(eventId, user) {
        if (!eventId || !user || !user.id) return false;
        return getLocalAttendees().some(function (a) {
            return a && a.event_id === eventId && a.user_id === user.id;
        });
    }

    // Visibility rule for map markers: anonymous events are only visible to
    // their creator and to users who already joined (via code).
    function canSeeEventOnMap(ev, user) {
        if (!isAnonymousEvent(ev)) return true;
        if (!user) return false;
        if (isEventOwnedByUser(ev, user)) return true;
        return isLocalAttendeeOf(ev.id, user);
    }

    function genUuid() {
        try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (e) {}
        // fallback uuid v4
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random()*16|0, v = c === 'x' ? r : (r&0x3|0x8);
            return v.toString(16);
        });
    }

    function getEventById(eventId) {
        var found = eventsData.find(function (e) { return e.id === eventId; });
        if (found) return found;
        var localEvents = getLocalEvents();
        for (var i = 0; i < localEvents.length; i++) {
            if (localEvents[i] && localEvents[i].id === eventId) return localEvents[i];
        }
        return null;
    }

    function isEventExpired(eventOrDate) {
        var iso = eventOrDate && eventOrDate.event_date ? eventOrDate.event_date : eventOrDate;
        if (!iso) return false;
        var deadline = new Date(iso).getTime();
        return !isNaN(deadline) && deadline <= Date.now();
    }

    function isActiveEventChat(chat) {
        return !!(chat && chat.event_id && chat.status !== 'expired' && !isEventExpired(chat.expires_at));
    }

    function upsertLocalChat(chat) {
        if (!chat || !chat.event_id) return;
        var chats = getLocalChats();
        var idx = chats.findIndex(function (item) { return item.event_id === chat.event_id; });
        if (idx === -1) {
            chats.push(chat);
        } else {
            chats[idx] = Object.assign({}, chats[idx], chat);
        }
        saveLocalChats(chats);
    }

    function removeLocalChatArtifacts(eventId) {
        if (!eventId) return;
        saveLocalChats(getLocalChats().filter(function (chat) { return chat.event_id !== eventId; }));
        saveLocalMessages(getLocalMessages().filter(function (msg) { return msg.event_id !== eventId; }));
    }

    function cleanupExpiredLocalEvents() {
        var expiredMap = {};
        var knownEvents = eventsData.slice();
        getLocalEvents().forEach(function (ev) {
            if (!knownEvents.some(function (existing) { return existing.id === ev.id; })) {
                knownEvents.push(ev);
            }
        });
        knownEvents.forEach(function (ev) {
            if (ev && ev.id && isEventExpired(ev.event_date)) expiredMap[ev.id] = true;
        });

        var expiredEventIds = Object.keys(expiredMap);
        if (expiredEventIds.length === 0) return expiredEventIds;

        // Remove the event itself and every cached child row. This also prevents
        // an expired offline event from being uploaded on the next fetch.
        eventsData = eventsData.filter(function (ev) {
            return !(ev && expiredMap[ev.id]);
        });
        purgeLocalEventArtifacts(expiredEventIds);
        return expiredEventIds;
    }

    function cleanupExpiredLocalChats() {
        var expiredMap = {};
        getLocalChats().forEach(function (chat) {
            if (!isActiveEventChat(chat)) expiredMap[chat.event_id] = true;
        });

        var expiredEventIds = Object.keys(expiredMap);
        if (expiredEventIds.length === 0) return expiredEventIds;

        saveLocalChats(getLocalChats().filter(function (chat) {
            return expiredEventIds.indexOf(chat.event_id) === -1;
        }));
        saveLocalMessages(getLocalMessages().filter(function (msg) {
            return expiredEventIds.indexOf(msg.event_id) === -1;
        }));

        if (activeChatEventId && expiredEventIds.indexOf(activeChatEventId) !== -1) {
            window._closeEventChatModal();
        }

        return expiredEventIds;
    }

    function formatChatCountdown(targetIso, isRo) {
        var remaining = Math.max(0, new Date(targetIso).getTime() - Date.now());
        var totalSeconds = Math.floor(remaining / 1000);
        var days = Math.floor(totalSeconds / 86400);
        var hours = Math.floor((totalSeconds % 86400) / 3600);
        var minutes = Math.floor((totalSeconds % 3600) / 60);
        var seconds = totalSeconds % 60;
        var parts = [];
        if (days > 0) parts.push(days + (isRo ? 'z' : 'd'));
        if (hours > 0 || days > 0) parts.push(hours + (isRo ? 'h' : 'h'));
        if (minutes > 0 || hours > 0 || days > 0) parts.push(minutes + (isRo ? 'm' : 'm'));
        if (days === 0) parts.push(seconds + (isRo ? 's' : 's'));
        return parts.join(' ');
    }

    function clearActiveChatDeadlineTimer() {
        if (activeChatDeadlineTimer) {
            clearInterval(activeChatDeadlineTimer);
            activeChatDeadlineTimer = null;
        }
    }

    window._closeEventChatModal = function () {
        clearActiveChatDeadlineTimer();
        stopActiveChatLiveUpdates();
        activeChatEventId = null;
        activeChatRefreshQueued = false;
        var modal = document.getElementById('eventChatModal');
        if (modal) modal.remove();
    };

    async function cleanupExpiredRemoteEvents() {
        if (!window.supabaseClient) return;

        // The database function atomically adds deletion tombstones and removes
        // each expired event. Its cascades clean attendees, inquiries, chats,
        // messages, and notifications as one operation.
        try {
            var rpcRes = await window.supabaseClient.rpc('cleanup_expired_events');
            if (!rpcRes || !rpcRes.error) return;
        } catch (e) {}

        // Compatibility fallback while the latest migration is being deployed.
        // Record tombstones before deleting so stale clients cannot resurrect an
        // event from localStorage.
        try {
            var expiredRes = await window.supabaseClient
                .from('events')
                .select('id')
                .lte('event_date', new Date().toISOString());
            if (!expiredRes || expiredRes.error || !Array.isArray(expiredRes.data)) return;
            var expiredIds = expiredRes.data.map(function (row) { return row.id; }).filter(Boolean);
            if (expiredIds.length === 0) return;

            for (var i = 0; i < expiredIds.length; i++) {
                await recordEventDeletion(expiredIds[i]);
            }
            await window.supabaseClient.from('event_chat_messages').delete().in('event_id', expiredIds);
            await window.supabaseClient.from('event_chats').delete().in('event_id', expiredIds);
            await window.supabaseClient.from('event_attendees').delete().in('event_id', expiredIds);
            await window.supabaseClient.from('event_inquiries').delete().in('event_id', expiredIds);
            await window.supabaseClient.from('event_notifications').delete().in('event_id', expiredIds);
            await window.supabaseClient.from('events').delete().in('id', expiredIds);
        } catch (e) {
            console.warn('[Events] Could not clean up expired events:', e);
        }
    }

    async function cleanupExpiredRemoteChats() {
        if (!window.supabaseClient) return;

        try {
            var rpcRes = await window.supabaseClient.rpc('cleanup_expired_event_chats');
            if (!rpcRes || !rpcRes.error) return;
        } catch (e) {}

        try {
            var nowIso = new Date().toISOString();
            var expiredRes = await window.supabaseClient
                .from('event_chats')
                .select('event_id')
                .lte('expires_at', nowIso);
            if (expiredRes && !expiredRes.error && Array.isArray(expiredRes.data) && expiredRes.data.length > 0) {
                var expiredIds = expiredRes.data.map(function (row) { return row.event_id; }).filter(Boolean);
                if (expiredIds.length > 0) {
                    await window.supabaseClient.from('event_chat_messages').delete().in('event_id', expiredIds);
                    await window.supabaseClient.from('event_chats').delete().in('event_id', expiredIds);
                }
            }
        } catch (e) {}
    }

    var lastEventChatCleanupAt = 0;
    async function maybeCleanupExpiredEventChats(force) {
        var expiredEventIds = cleanupExpiredLocalEvents();
        cleanupExpiredLocalChats();
        if (expiredEventIds.length > 0) refreshEventsMap(true);

        var now = Date.now();
        if (!force && now - lastEventChatCleanupAt < 60000) return;
        lastEventChatCleanupAt = now;
        await cleanupExpiredRemoteEvents();
        await cleanupExpiredRemoteChats();
    }

    async function fetchActiveEventChats(eventIds) {
        var chatMap = {};
        var hasFilter = Array.isArray(eventIds) && eventIds.length > 0;
        var nowIso = new Date().toISOString();

        try {
            if (window.supabaseClient) {
                var query = window.supabaseClient
                    .from('event_chats')
                    .select('*')
                    .eq('status', 'active')
                    .gt('expires_at', nowIso);
                if (hasFilter) query = query.in('event_id', eventIds);
                var res = await query;
                if (!res.error && Array.isArray(res.data)) {
                    res.data.forEach(function (chat) {
                        chatMap[chat.event_id] = chat;
                    });
                }
            }
        } catch (e) {}

        getLocalChats().forEach(function (chat) {
            if (!isActiveEventChat(chat)) return;
            if (hasFilter && eventIds.indexOf(chat.event_id) === -1) return;
            if (!chatMap[chat.event_id]) chatMap[chat.event_id] = chat;
        });

        return Object.keys(chatMap).map(function (eventId) { return chatMap[eventId]; });
    }

    async function fetchAttendeeCounts(eventIds) {
        var counts = {};
        var uniqueKeys = {};
        if (!Array.isArray(eventIds) || eventIds.length === 0) return counts;

        try {
            if (window.supabaseClient) {
                var res = await window.supabaseClient
                    .from('event_attendees')
                    .select('event_id,user_id')
                    .in('event_id', eventIds);
                if (!res.error && Array.isArray(res.data)) {
                    res.data.forEach(function (att) {
                        var key = att.event_id + '::' + att.user_id;
                        if (uniqueKeys[key]) return;
                        uniqueKeys[key] = true;
                        counts[att.event_id] = (counts[att.event_id] || 0) + 1;
                    });
                }
            }
        } catch (e) {}

        getLocalAttendees().forEach(function (att) {
            if (eventIds.indexOf(att.event_id) === -1) return;
            var key = att.event_id + '::' + (att.user_id || att.id);
            if (uniqueKeys[key]) return;
            uniqueKeys[key] = true;
            counts[att.event_id] = (counts[att.event_id] || 0) + 1;
        });

        return counts;
    }

    async function isUserAcceptedAttendee(eventId, userId) {
        if (!eventId || !userId) return false;

        try {
            if (window.supabaseClient) {
                var res = await window.supabaseClient
                    .from('event_attendees')
                    .select('id')
                    .eq('event_id', eventId)
                    .eq('user_id', userId)
                    .limit(1);
                if (!res.error && Array.isArray(res.data)) {
                    if (res.data.length > 0) return true;
                    // The server answered "not an attendee". Trust that (it means
                    // the user was kicked out) instead of falling through to the
                    // stale local cache, which would keep granting chat access.
                    if (canTrustServerFor(eventId)) {
                        var removed = reconcileLocalAttendees([eventId], []);
                        if (removed.length > 0) handleAttendanceRemovals(removed);
                        return false;
                    }
                }
            }
        } catch (e) {}

        return getLocalAttendees().some(function (att) {
            return att.event_id === eventId && att.user_id === userId;
        });
    }

    async function ensureEventChatExists(eventOrId, attendeeCount) {
        var ev = typeof eventOrId === 'string' ? getEventById(eventOrId) : eventOrId;
        if (!ev) return null;
        if (isEventExpired(ev.event_date) || Number(attendeeCount || 0) < 1) {
            removeLocalChatArtifacts(ev.id);
            return null;
        }

        var chat = {
            event_id: ev.id,
            expires_at: ev.event_date,
            status: 'active'
        };

        try {
            if (window.supabaseClient) {
                var res = await window.supabaseClient
                    .from('event_chats')
                    .upsert([chat], { onConflict: 'event_id' })
                    .select('*');
                if (!res.error && Array.isArray(res.data) && res.data[0]) {
                    chat = res.data[0];
                }
            }
        } catch (e) {}

        upsertLocalChat(chat);
        return chat;
    }

    async function syncEventChatState(eventId) {
        var ev = getEventById(eventId);
        if (!ev) return null;
        if (isEventExpired(ev.event_date)) {
            await expireEventChat(eventId, true);
            return null;
        }
        var counts = await fetchAttendeeCounts([eventId]);
        var attendeeCount = counts[eventId] || 0;
        if (attendeeCount < 1) {
            removeLocalChatArtifacts(eventId);
            try {
                if (window.supabaseClient) {
                    await window.supabaseClient.from('event_chat_messages').delete().eq('event_id', eventId);
                    await window.supabaseClient.from('event_chats').delete().eq('event_id', eventId);
                }
            } catch (e) {}
            return null;
        }
        return ensureEventChatExists(ev, attendeeCount);
    }

    async function expireEventChat(eventId, silent) {
        if (!eventId) return;
        removeLocalChatArtifacts(eventId);

        try {
            if (window.supabaseClient) {
                var rpcRes = await window.supabaseClient.rpc('cleanup_expired_event_chats');
                if (rpcRes && rpcRes.error) throw rpcRes.error;
            }
        } catch (e) {
            try {
                if (window.supabaseClient) {
                    await window.supabaseClient.from('event_chat_messages').delete().eq('event_id', eventId);
                    await window.supabaseClient.from('event_chats').delete().eq('event_id', eventId);
                }
            } catch (_) {}
        }

        if (activeChatEventId === eventId) window._closeEventChatModal();
        if (!silent) {
            var isRo = (window._currentLang && window._currentLang() === 'ro');
            alert(isRo ? 'Chat-ul evenimentului a expirat și a fost șters.' : 'The event chat has expired and was deleted.');
        }
    }

    function startEventChatDeadlineTimer(ev) {
        clearActiveChatDeadlineTimer();
        var expiredHandled = false;

        async function tick() {
            var timerEl = document.getElementById('chatTimer');
            if (!timerEl) {
                clearActiveChatDeadlineTimer();
                return;
            }

            var isRo = (window._currentLang && window._currentLang() === 'ro');
            if (isEventExpired(ev.event_date)) {
                timerEl.textContent = isRo ? '⌛ Chat expirat. Se șterge…' : '⌛ Chat expired. Deleting…';
                clearActiveChatDeadlineTimer();
                if (!expiredHandled) {
                    expiredHandled = true;
                    await expireEventChat(ev.id, true);
                    alert(isRo ? 'Deadline-ul evenimentului a trecut. Chat-ul a fost șters automat.' : 'The event deadline has passed. The chat was deleted automatically.');
                }
                return;
            }

            timerEl.textContent = (isRo ? '⏳ Chat activ încă ' : '⏳ Chat active for ') + formatChatCountdown(ev.event_date, isRo);
        }

        tick();
        activeChatDeadlineTimer = setInterval(tick, 1000);
    }

    // Detect missing event columns so we can retry against an older `events` schema.
    // PostgREST usually reports this as PGRST204 ("Could not find the 'pin_id'
    // column ... in the schema cache"), rather than PostgreSQL's 42703. The old
    // check handled only 42703, so the fallback was never used in the deployed
    // project and every new event was left in localStorage.
    function isMissingColumnError(err) {
        if (!err) return false;
        if (err.code === '42703' || err.code === 'PGRST204') return true;
        var msg = String(err.message || err.error_description || err.hint || '').toLowerCase();
        return msg.indexOf('does not exist') !== -1 ||
            (msg.indexOf('could not find') !== -1 && msg.indexOf('column') !== -1);
    }

    // Ensure an event exists on Supabase so foreign key constraints in event_inquiries don't fail.
    // Returns { ok: true } on full sync, { ok: true, partial: true } when synced with only the
    // columns available on an older live table, or { ok: false, reason, error }.
    async function ensureEventOnServer(ev) {
        if (!window.supabaseClient || !ev || !ev.id) {
            console.warn('[Events] Supabase client not available - event saved locally only');
            return { ok: false, reason: 'no-client' };
        }
        try {
            var payload = {
                id: ev.id,
                pin_id: ev.pin_id || null,
                creator_id: ev.creator_id,
                creator_name: ev.creator_name || 'User',
                creator_email: ev.creator_email || null,
                title: ev.title,
                description: ev.description || '',
                category: ev.category || 'Other',
                latitude: Number(ev.latitude),
                longitude: Number(ev.longitude),
                event_date: ev.event_date,
                max_attendees: ev.max_attendees || null,
                is_anonymous: !!ev.is_anonymous,
                event_code: ev.event_code || null,
                created_at: ev.created_at || new Date().toISOString()
            };
            var res = await window.supabaseClient.from('events').upsert([payload], { onConflict: 'id' });
            if (res && res.error) {
                if (isMissingColumnError(res.error)) {
                    // Schema drift: the live `events` table is missing one or more
                    // newer columns. Retry with the smallest payload that preserves
                    // the event's privacy semantics. In particular, an anonymous
                    // event must NEVER be retried as a public/base event: doing so
                    // would make it visible to everybody and would also discard the
                    // code needed by the join flow.
                    var basePayload = {
                        id: ev.id,
                        creator_id: ev.creator_id,
                        creator_name: ev.creator_name || 'User',
                        title: ev.title,
                        description: ev.description || '',
                        latitude: Number(ev.latitude),
                        longitude: Number(ev.longitude),
                        event_date: ev.event_date,
                        max_attendees: ev.max_attendees || null,
                        created_at: ev.created_at || new Date().toISOString()
                    };
                    var retryPayload = basePayload;
                    if (ev.is_anonymous) {
                        // `pin_id`, `category`, and `creator_email` were added
                        // before anonymous events. A database can therefore have
                        // the anonymous columns while still missing one of those
                        // older optional columns. The previous implementation
                        // treated any missing-column error as if the anonymous
                        // migration were absent and kept the event only in
                        // localStorage; another account then could not find its
                        // code. Keep the privacy fields in this fallback.
                        retryPayload = Object.assign({}, basePayload, {
                            is_anonymous: true,
                            event_code: ev.event_code || null
                        });
                    } else {
                        console.warn('[Events] Server events table is missing newer columns; retrying with base columns. Apply migration 20260811010000_fix_events_schema_drift.sql for full sync. Detail:', res.error.message);
                    }

                    var retry = await window.supabaseClient.from('events').upsert([retryPayload], { onConflict: 'id' });
                    if (retry && retry.error) {
                        if (ev.is_anonymous && isMissingColumnError(retry.error)) {
                            // The safe retry itself failed because the privacy
                            // columns are not installed. Do not fall back to the
                            // public payload; applying the anonymous-events
                            // migration is required for cross-account joins.
                            console.error('[Events] Server events table is missing the is_anonymous/event_code columns; anonymous event kept local-only. Apply migration 20260814020000_anonymous_events.sql.');
                            return { ok: false, reason: 'schema-missing-anonymous', error: retry.error };
                        }
                        console.error('[Events] Failed to save event to Supabase (schema-drift retry):', retry.error);
                        return { ok: false, reason: 'server-error', error: retry.error };
                    }
                    return { ok: true, partial: true };
                }
                console.error('[Events] Failed to save event to Supabase:', res.error);
                return { ok: false, reason: 'server-error', error: res.error };
            }
            return { ok: true };
        } catch (e) {
            console.error('[Events] ensureEventOnServer error:', e);
            return { ok: false, reason: 'exception', error: e };
        }
    }

    /* ══════════════════════════════════════════════════════════════════
       "AN EVENT WAS CREATED NEAR YOU" NOTIFICATIONS
       ------------------------------------------------------------------
       After an event is created we resolve the event's broad location
       (nearest city/town + county) and notify every user whose LAST known
       location is in that same county, or within 50 km of the event, so
       people just across a county border are caught too.

       The notification carries kind = 'nearby_event' so the modal renders a
       "See event" button that zooms the map onto that exact event.
       ══════════════════════════════════════════════════════════════════ */

    var NEARBY_EVENT_RADIUS_KM = 50;

    function nearbyEventMessage(creatorName, placeLabel) {
        var name = creatorName || 'un detectorist';
        var ro = 'Un eveniment a fost creat în apropiere de tine de ' + name;
        var en = 'An event was created near you by ' + name;
        if (placeLabel) {
            ro += ' (' + placeLabel + ')';
            en += ' (' + placeLabel + ')';
        }
        return ro + ' / ' + en;
    }

    async function notifyUsersNearEvent(ev) {
        try {
            var LL = window.DetectLabLastLocation;
            if (!LL || !ev || !window.supabaseClient) return 0;

            var evLat = Number(ev.latitude), evLng = Number(ev.longitude);
            if (!isFinite(evLat) || !isFinite(evLng)) return 0;

            // Anonymous events are hidden from the map by design — never
            // broadcast their existence to a whole county.
            if (isAnonymousEvent(ev)) return 0;

            var place = await LL.resolveBroadLocation(evLat, evLng);
            var evCounty = place && place.county;
            var placeLabel = (place && (place.city || place.label)) || '';

            var rows = await LL.fetchLastLocations();
            if (!rows.length) return 0;

            var creatorName = ev.creator_name || 'User';
            var message = nearbyEventMessage(creatorName, placeLabel);
            var nowIso = new Date().toISOString();

            var recipients = rows.filter(function (r) {
                if (!r || !r.user_id) return false;
                if (r.user_id === ev.creator_id) return false;   // never notify the creator
                if (evCounty && LL.sameCounty(r.county, evCounty)) return true;
                return LL.distanceKm(Number(r.latitude), Number(r.longitude), evLat, evLng) <= NEARBY_EVENT_RADIUS_KM;
            });
            if (!recipients.length) return 0;

            var notifications = recipients.map(function (r) {
                return {
                    id: genUuid(),
                    user_id: r.user_id,
                    event_id: ev.id,
                    inquiry_id: null,
                    sender_id: ev.creator_id,
                    sender_name: creatorName,
                    message: message,
                    kind: 'nearby_event',
                    read: false,
                    created_at: nowIso
                };
            });

            var res = await window.supabaseClient.from('event_notifications').insert(notifications);
            if (res && res.error) {
                // Older deployments have no `kind` column: retry without it. The
                // modal falls back to detecting these by message + event_id.
                if (isMissingColumnError(res.error)) {
                    var base = notifications.map(function (n) {
                        var copy = {}; for (var k in n) { if (k !== 'kind') copy[k] = n[k]; }
                        return copy;
                    });
                    var retry = await window.supabaseClient.from('event_notifications').insert(base);
                    if (retry && retry.error) {
                        console.warn('[Events] Could not notify nearby users:', retry.error.message || retry.error);
                        return 0;
                    }
                    console.warn('[Events] Nearby-event notifications sent without `kind` (apply migration 20260815000000_user_last_locations.sql).');
                    return base.length;
                }
                console.warn('[Events] Could not notify nearby users:', res.error.message || res.error);
                return 0;
            }
            console.log('[Events] Notified ' + notifications.length + ' user(s) near the new event.');
            return notifications.length;
        } catch (e) {
            console.warn('[Events] notifyUsersNearEvent failed:', e && e.message ? e.message : e);
            return 0;
        }
    }

    // Zoom the map onto a specific event and open its popup ("See event").
    window._zoomToEvent = function (eventId) {
        var map = window._dlMap || window.map;
        if (!map || !eventId) return false;
        var ev = getEventById(eventId);
        if (!ev) return false;
        var lat = Number(ev.latitude), lng = Number(ev.longitude);
        if (!isFinite(lat) || !isFinite(lng)) return false;

        // Exit any fullscreen overlay panel that would hide the map.
        try {
            var panel = document.getElementById('eventsManagerPanel');
            if (panel) panel.remove();
        } catch (e) {}

        // maxZoom 17 keeps us inside the satellite base map's native zoom range
        // (see the nearby-detectorists fitBounds comment) so tiles keep rendering.
        try { map.flyTo([lat, lng], 16, { duration: 0.9 }); }
        catch (e) { map.setView([lat, lng], 16); }

        // Open the event's popup once the fly animation settled.
        setTimeout(function () {
            try {
                if (!eventsLayer) return;
                eventsLayer.eachLayer(function (layer) {
                    if (layer && layer._dlEventId === eventId && layer.openPopup) layer.openPopup();
                });
            } catch (e) {}
        }, 1000);
        return true;
    };

    // Fetch the set of event ids that were explicitly deleted (tombstones). Any
    // event in this set must be purged from local caches and must never be
    // re-synced, otherwise a creator-deleted event would be resurrected for
    // everyone from another user's stale localStorage copy.
    async function fetchDeletedEventIds() {
        var deletedIds = {};
        try {
            if (window.supabaseClient) {
                var res = await window.supabaseClient.from('event_deletions').select('event_id');
                if (!res.error && Array.isArray(res.data)) {
                    res.data.forEach(function (r) {
                        if (r && r.event_id) deletedIds[r.event_id] = true;
                    });
                } else if (res && res.error) {
                    console.warn('Supabase fetchDeletedEventIds error:', res.error);
                }
            }
        } catch (err) {
            console.warn('Supabase fetchDeletedEventIds error, ignoring tombstones:', err);
        }
        return deletedIds;
    }

    // Record a deletion tombstone. Best-effort: the `event_deletions` table only
    // exists once migration 20260812000000 has been applied. The caller must not
    // depend on it — fetchEvents() also treats "was on the server, now gone" as a
    // deletion, so deletes propagate even without the table.
    async function recordEventDeletion(eventId) {
        if (!eventId || !window.supabaseClient) return false;
        try {
            var user = getCurrentUser();
            var res = await window.supabaseClient.from('event_deletions').upsert(
                { event_id: eventId, deleted_by: (user && user.id) || null },
                { onConflict: 'event_id' }
            );
            if (res && res.error) {
                console.warn('[Events] Could not record deletion tombstone (apply migration 20260812000000_event_deletions.sql):', res.error.message);
                return false;
            }
            return true;
        } catch (err) {
            console.warn('[Events] Could not record deletion tombstone:', err);
            return false;
        }
    }

    // Load all events from Supabase or fallback – merges remote + local so that
    // locally-created events are not wiped when the remote query returns empty.
    async function fetchEvents() {
        var remote = null;
        try {
            if (window.supabaseClient) {
                var res = await window.supabaseClient.from('events').select('*').order('event_date', { ascending: true });
                if (!res.error && Array.isArray(res.data)) {
                    remote = res.data;
                } else if (res && res.error) {
                    console.warn('Supabase fetchEvents error:', res.error);
                }
            }
        } catch (err) {
            console.warn('Supabase fetchEvents error, using local:', err);
        }
        var deletedIds = await fetchDeletedEventIds();

        // Expired cached events are terminal: discard them before the merge so
        // they can never be mistaken for unsynced offline creations and uploaded
        // again. Also hide expired server rows immediately while cron/RPC removes
        // them permanently.
        cleanupExpiredLocalEvents();
        var local = getLocalEvents();
        if (remote !== null) {
            var expiredRemoteIds = [];
            remote = remote.filter(function (ev) {
                var expired = !!(ev && ev.id && isEventExpired(ev.event_date));
                if (expired) expiredRemoteIds.push(ev.id);
                return !expired;
            });
            if (expiredRemoteIds.length > 0) purgeLocalEventArtifacts(expiredRemoteIds);
        }

        if (remote !== null) {
            // The server answered, so it is authoritative about which events exist.
            serverReachable = true;
            serverEventIds = {};
            remote.forEach(function (e) { if (e && e.id) serverEventIds[e.id] = true; });

            var syncedIds = getSyncedEventIds();
            var merged = remote.slice();
            var vanished = [];

            local.forEach(function (e) {
                if (!e || !e.id) return;
                if (serverEventIds[e.id]) return;      // already in `remote`
                if (deletedIds[e.id]) {                // explicit tombstone
                    vanished.push(e.id);
                    return;
                }
                if (syncedIds[e.id]) {
                    // This event WAS confirmed on the server before and is gone
                    // now → the creator deleted it. Previously it was merged back
                    // in and re-uploaded, which is exactly why a deleted event
                    // kept showing up for every other participant.
                    vanished.push(e.id);
                    return;
                }
                // Never reached the server: a genuine offline-created event.
                // Keep it and (re)try the upload.
                merged.push(e);
                var pending = e.id;
                ensureEventOnServer(e).then(function (result) {
                    if (result && result.ok) markEventSynced(pending);
                });
            });

            // Purge any deleted/vanished event that leaked into the local caches.
            merged = merged.filter(function (e) {
                return !(e && e.id && (deletedIds[e.id] || vanished.indexOf(e.id) !== -1));
            });

            eventsData = merged;
            saveLocalEvents(eventsData);
            remote.forEach(function (e) { if (e && e.id) markEventSynced(e.id); });
            if (vanished.length > 0) purgeLocalEventArtifacts(vanished);
        } else {
            // Offline / server unreachable: keep showing the cache, but never
            // assume anything was deleted (we simply cannot tell).
            serverReachable = false;
            serverEventIds = null;
            eventsData = local.filter(function (e) { return !(e && e.id && deletedIds[e.id]); });
        }

        refreshEventsMap(true);
        return eventsData;
    }

    // Initialize Events Layer on Map
    function initEventsLayer(map) {
        if (!map) return;
        if (!eventsLayer) {
            eventsLayer = L.layerGroup().addTo(map);
        }
        fetchEvents();
    }

    // Calculate expiration color
    // red if <3 days (72h), yellow if 4-7 days (72h-168h), green if >7 days (>168h)
    function getEventColor(eventDateStr) {
        try {
            var now = new Date().getTime();
            var evTime = new Date(eventDateStr).getTime();
            var diffHours = (evTime - now) / (1000 * 60 * 60);
            if (diffHours < 72) return '#C42B2B'; // Red
            if (diffHours <= 168) return '#E6A817'; // Yellow
            return '#2E9E4F'; // Green
        } catch (e) {
            return '#2E9E4F';
        }
    }

    function refreshEventsMap(refreshOpenPopup) {
        var map = window._dlMap || window.map;
        if (!map || !eventsLayer) return;

        // A popup that is open while the underlying data changed (event deleted,
        // attendee kicked) would otherwise keep showing the stale state until the
        // user closes and reopens it.
        if (refreshOpenPopup) {
            try {
                var open = map._popup;
                if (open && open._source && open._source._dlEventId) {
                    var stillExists = eventsData.some(function (e) { return e.id === open._source._dlEventId; });
                    if (!stillExists) map.closePopup();
                }
            } catch (e) {}
        }

        eventsLayer.clearLayers();

        var currentUser = getCurrentUser();

        eventsData.forEach(function (ev) {
            // Anonymous events stay off the map for everyone except the
            // creator and users who already joined via the event code.
            if (!canSeeEventOnMap(ev, currentUser)) return;

            var color = getEventColor(ev.event_date);
            var helmetSvg = '<svg width="28" height="28" viewBox="0 0 24 24" fill="' + color + '" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="M12 2C8 2 5 5 5 9v4c0 3 2 5 4 6v2h6v-2c2-1 4-3 4-6V9c0-4-3-7-7-7z"/>' +
                '<path d="M8 11h8" stroke="#fff" stroke-width="1.5"/>' +
                '<path d="M12 8v6" stroke="#fff" stroke-width="1.5"/>' +
                '<path d="M10 14l2 3 2-3" stroke="#fff" stroke-width="1.5"/>' +
                '</svg>';

            // Same symbol, translucent, for anonymous events.
            var anonStyle = isAnonymousEvent(ev) ? ' opacity: 0.45;' : '';
            var icon = L.divIcon({
                html: '<div style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5)); cursor: pointer;' + anonStyle + '">' + helmetSvg + '</div>',
                className: 'warrior-helmet-marker',
                iconSize: [28, 28],
                iconAnchor: [14, 14]
            });

            var marker = L.marker([ev.latitude, ev.longitude], { icon: icon });
            marker._dlEventId = ev.id;
            // Fresh popup HTML evaluated on open
            marker.bindPopup(function () { return createEventPopupHtml(ev); });
            eventsLayer.addLayer(marker);
        });
    }

    function createEventPopupHtml(ev) {
        var user = getCurrentUser();
        var isCreator = user && (user.id === ev.creator_id || (user.email && ev.creator_email && user.email === ev.creator_email));
        var color = getEventColor(ev.event_date);
        var dateStr = formatDate(ev.event_date);

        var alreadyInquired = false;
        var alreadyAttending = false;
        if (user && !isCreator) {
            // These read the local mirror, which syncMyEventStateFromServer()
            // keeps reconciled with the server — so a kicked user stops seeing
            // "Already attending" and can request to join again.
            var localInqs = getLocalInquiries();
            alreadyInquired = localInqs.some(function(i) { return i.event_id === ev.id && i.user_id === user.id && i.status !== 'declined'; });
            var localAtts = getLocalAttendees();
            alreadyAttending = localAtts.some(function(a) { return a.event_id === ev.id && a.user_id === user.id; });
        }

        var anonBadge = '';
        if (isAnonymousEvent(ev)) {
            anonBadge = '<div style="display:inline-block; background: rgba(107,63,160,0.25); border: 1px solid rgba(196,160,240,0.45); border-radius: 4px; color: #c4a0f0; font-size: 0.66rem; font-weight: 700; padding: 2px 6px; margin-bottom: 5px;">🕶 Eveniment anonim / Anonymous event</div>';
            if (isCreator && ev.event_code) {
                anonBadge += '<div style="font-size: 0.72rem; color: #E8D0FF; margin-bottom: 5px;">🔑 Cod / Code: <strong style="letter-spacing:0.1em;">' + escapeHtml(ev.event_code) + '</strong></div>';
            }
        }

        var html = '<div style="min-width: 220px; font-family: \'Outfit\', sans-serif;">' +
            anonBadge +
            '<div style="font-weight: 700; font-size: 0.95rem; color: #F5F0EB; margin-bottom: 4px;">' + escapeHtml(ev.title) + '</div>' +
            '<div style="font-size: 0.76rem; color: rgba(184,216,240,0.8); margin-bottom: 6px;">' + escapeHtml(ev.description || '') + '</div>' +
            '<div style="font-size: 0.72rem; color: ' + color + '; font-weight: 600; margin-bottom: 4px;">📅 ' + dateStr + '</div>' +
            '<div style="font-size: 0.7rem; color: rgba(245,240,235,0.6); margin-bottom: 8px;">👤 Creator: ' + escapeHtml(ev.creator_name || 'User') + (ev.max_attendees ? ' | Max: ' + ev.max_attendees : '') + '</div>';

        // Traseu Google Maps: destinația e chiar coordonata evenimentului
        // (centrul pinului de pe hartă), nu un punct de pe marginea lui.
        if (window.DetectLabDirections && window.DetectLabDirections.buttonHtml) {
            var gmapsDirectionsBtn = window.DetectLabDirections.buttonHtml(ev.latitude, ev.longitude);
            if (gmapsDirectionsBtn) {
                html += '<div style="margin-bottom: 8px;">' + gmapsDirectionsBtn + '</div>';
            }
        }

        if (isCreator) {
            html += '<button type="button" onclick="window._manageEvent(\'' + ev.id + '\')" style="width: 100%; background: #6B3FA0; border: none; border-radius: 4px; color: #fff; font-size: 0.75rem; padding: 6px; cursor: pointer; font-weight: 600;">Gestionează Evenimentul / Manage Event</button>';
        } else if (user) {
            if (alreadyAttending) {
                html += '<div style="width: 100%; background: rgba(46,158,79,0.2); border: 1px solid rgba(46,158,79,0.5); border-radius: 4px; color: #2E9E4F; font-size: 0.75rem; padding: 5px; text-align: center; font-weight: 600;">✓ Deja participant / Already attending</div>';
            } else if (alreadyInquired) {
                html += '<div style="width: 100%; background: rgba(232,119,42,0.15); border: 1px solid rgba(232,119,42,0.4); border-radius: 4px; color: #E8772A; font-size: 0.75rem; padding: 5px; text-align: center; font-weight: 600;">⏳ Cerere trimisă / Request pending</div>';
            } else {
                html += '<button type="button" onclick="window._openInquiryModal(\'' + ev.id + '\')" style="width: 100%; background: #E8772A; border: none; border-radius: 4px; color: #fff; font-size: 0.75rem; padding: 6px; cursor: pointer; font-weight: 600;">Trimite Cerere Participare / Send Inquiry</button>';
            }
        } else {
            html += '<div style="font-size: 0.7rem; color: #ff8a8a;">Autentifică-te pentru a participa. / Log in to attend.</div>';
        }
        html += '</div>';
        return html;
    }

    function escapeHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Hook into coordinate popup in map-app.js to add "Create Event" button
    window._augmentCoordPopup = function (popupDiv, lat, lng) {
        if (!popupDiv) return;
        if (popupDiv.querySelector && popupDiv.querySelector('.pin-create-event-btn')) return;
        var pinId = popupDiv.getAttribute ? (popupDiv.getAttribute('data-pin-id') || '') : '';
        var div = document.createElement('div');
        div.style.cssText = 'margin-top: 6px;';
        div.innerHTML = '<button type="button" class="coord-popup-create-event" data-pin-id="' + String(pinId).replace(/"/g,'&quot;') + '" data-lat="' + lat + '" data-lng="' + lng + '" style="width: 100%; background: rgba(107,63,160,0.35); border: 1px solid rgba(196,160,240,0.6); border-radius: 4px; color: #c4a0f0; font-size: 0.76rem; font-family: \'Outfit\', sans-serif; padding: 5px 0; cursor: pointer; font-weight: 600;">Creează un eveniment</button>';
        var btn = div.querySelector('button');
        btn.addEventListener('click', function (e) {
            if (e) { e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); if (window.L && L.DomEvent) try { L.DomEvent.stop(e); } catch(_){} }
            var curUser = getCurrentUser();
            if (!curUser) {
                if (typeof window.openAuth === 'function') window.openAuth('login');
                return;
            }
            openCreateEventModal(lat, lng, pinId || null, '');
            var m = window._dlMap || window.map;
            if (m) m.closePopup();
        });
        popupDiv.appendChild(div);
    };

    // opts (optional, used by the social layer — js/friends.js):
    //   preselectedFriendIds [] – friends already ticked in "Adaugă prieteni"
    //   showCoordinates      – no pin behind this form (it was opened from a
    //                            chat), so latitude/longitude become editable
    //   sourceConversationId – the thread the event was started from
    //   onCreated(event)     – called after the event was saved on the server
    /* The database enforces the event quotas with trigger_guard_event_limits /
       trigger_guard_event_attendance_limits. Recognise those refusals so the
       form can show the real reason instead of "saved locally". */
    var EVENT_QUOTA_CODES = ['EVENT_CREATION_LIMIT', 'EVENT_DEADLINE_TOO_FAR', 'EVENT_ATTENDANCE_LIMIT'];

    function eventQuotaCode(err) {
        var raw = String((err && (err.message || err.details)) || err || '');
        for (var i = 0; i < EVENT_QUOTA_CODES.length; i++) {
            if (raw.indexOf(EVENT_QUOTA_CODES[i]) !== -1) return EVENT_QUOTA_CODES[i];
        }
        return null;
    }

    function eventQuotaMessage(code, arg, isRo) {
        if (code === 'EVENT_DEADLINE_TOO_FAR') {
            return isRo
                ? 'Un eveniment poate fi programat cel mult ' + arg + ' zile în viitor.'
                : 'An event can be scheduled at most ' + arg + ' days in the future.';
        }
        if (code === 'EVENT_ATTENDANCE_LIMIT') {
            return isRo
                ? 'Ai atins numărul maxim de evenimente la care participi (' + arg + ').'
                : 'You reached the maximum number of events you can attend (' + arg + ').';
        }
        return isRo
            ? 'Ai deja numărul maxim de evenimente active (' + arg + '). Șterge unul înainte să creezi altul.'
            : 'You already have the maximum number of active events (' + arg + '). Delete one before creating another.';
    }

    function openCreateEventModal(lat, lng, pinId, pinTitle, opts) {
        var existing = document.getElementById('createEventModal');
        if (existing) existing.remove();

        var isRo = (window._currentLang && window._currentLang() === 'ro');
        var options = opts || {};
        var social = window.DetectLabFriends || null;
        var socialLimits = social ? social.getLimits() : null;
        var maxDeadlineDays = (socialLimits && Number(socialLimits.max_event_deadline_days)) || 365;
        var selectedFriends = {};
        (options.preselectedFriendIds || []).forEach(function (id) { if (id) selectedFriends[id] = true; });
        var pinLabel = pinTitle ? escapeHtml(pinTitle) : (pinId ? ('Pin ' + pinId) : 'Location Pin');

        // Location row: a pin when the form was opened from the map, editable
        // coordinates when it was opened from a chat (no pin exists there).
        var locationBlock;
        if (options.showCoordinates) {
            locationBlock =
                '<div style="background: rgba(107,63,160,0.2); border: 1px solid rgba(196,160,240,0.4); border-radius: 6px; padding: 10px 12px; margin-bottom: 12px; font-size: 0.78rem; color: #E8D0FF;">' +
                '📍 <strong>' + (isRo ? 'Locația evenimentului' : 'Event location') + '</strong> ' +
                '<span style="opacity:0.8;">' + (isRo ? '(centrul hărții — poți ajusta)' : '(map centre — adjust if needed)') + '</span>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">' +
                '<input type="number" step="0.00001" id="ceLat" value="' + Number(lat).toFixed(5) + '" style="width:100%;padding:7px;background:rgba(255,255,255,0.08);border:1px solid rgba(196,160,240,0.35);border-radius:6px;color:#F5F0EB;font-size:0.8rem;box-sizing:border-box;">' +
                '<input type="number" step="0.00001" id="ceLng" value="' + Number(lng).toFixed(5) + '" style="width:100%;padding:7px;background:rgba(255,255,255,0.08);border:1px solid rgba(196,160,240,0.35);border-radius:6px;color:#F5F0EB;font-size:0.8rem;box-sizing:border-box;">' +
                '</div></div>';
        } else {
            locationBlock =
                '<div style="background: rgba(107,63,160,0.2); border: 1px solid rgba(196,160,240,0.4); border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; font-size: 0.78rem; color: #E8D0FF;">' +
                '📍 <strong>' + (isRo ? 'Pin asociat:' : 'Associated Pin:') + '</strong> ' + pinLabel + ' (' + Number(lat).toFixed(5) + ', ' + Number(lng).toFixed(5) + ')' +
                '</div>';
        }

        // "Adaugă prieteni / Add friends" — the list of every friend, ticked
        // ones receive a participation request they can accept or decline.
        var friendsBlock =
            '<div id="ceFriendsBox" style="margin-bottom:12px;background:rgba(13,43,94,0.28);border:1px solid rgba(184,216,240,0.22);border-radius:6px;padding:10px;"></div>';

        var modal = document.createElement('div');
        modal.id = 'createEventModal';
        modal.style.cssText = 'position: fixed; inset: 0; z-index: 4000; background: rgba(4,10,22,0.85); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center;';
        modal.innerHTML = '<div style="background: rgba(10,20,42,0.98); border: 1px solid rgba(184,216,240,0.25); border-radius: 12px; width: 100%; max-width: 440px; overflow-y: auto; padding: 20px; color: #F5F0EB; font-family: \'Outfit\', sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,0.6);">' +
            '<h3 style="margin-top:0; font-size:1.1rem; color:var(--sky); font-family:\'Cinzel\',serif;">' + ((typeof translations !== 'undefined' && (translations[window._currentLang ? window._currentLang() : 'en'] || translations.en).pin_create_event) || 'Create event') + '</h3>' +
            locationBlock +
            '<div style="margin-bottom:10px;"><label style="display:block; font-size:0.76rem; margin-bottom:4px;">' + (isRo ? 'Titlu eveniment *' : 'Event Title *') + '</label><input type="text" id="ceTitle" placeholder="' + (isRo ? 'Ex: Căutare comori în pădure' : 'Ex: Forest metal detecting') + '" style="width:100%; padding:8px; background:rgba(255,255,255,0.06); border:1px solid rgba(184,216,240,0.25); border-radius:6px; color:#F5F0EB; font-size:0.85rem;" autocomplete="off"></div>' +
            '<div style="margin-bottom:10px;"><label style="display:block; font-size:0.76rem; margin-bottom:4px;">' + (isRo ? 'Descriere' : 'Description') + '</label><textarea id="ceDesc" placeholder="' + (isRo ? 'Detalii despre întâlnire...' : 'Meeting details...') + '" style="width:100%; height:55px; padding:8px; background:rgba(255,255,255,0.06); border:1px solid rgba(184,216,240,0.25); border-radius:6px; color:#F5F0EB; font-size:0.85rem; resize:none;"></textarea></div>' +
            '<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px;">' +
            '<div style="min-width:0;"><label style="display:block; font-size:0.76rem; margin-bottom:4px;">' + (isRo ? 'Dată *' : 'Event Date *') + '</label><input type="date" id="ceDate" style="width:100%; padding:8px 10px; background:rgba(255,255,255,0.06); border:1px solid rgba(184,216,240,0.25); border-radius:6px; color:#F5F0EB; font-size:0.85rem; font-family:\'Outfit\',sans-serif; box-sizing:border-box;"></div>' +
            '<div style="min-width:0;"><label style="display:block; font-size:0.76rem; margin-bottom:4px;">' + (isRo ? 'Oră' : 'Event Time') + '</label><input type="time" id="ceTime" style="width:100%; padding:8px 10px; background:rgba(255,255,255,0.06); border:1px solid rgba(184,216,240,0.25); border-radius:6px; color:#F5F0EB; font-size:0.85rem; font-family:\'Outfit\',sans-serif; box-sizing:border-box;"></div>' +
            '</div>' +
            '<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:12px;">' +
            '<div style="min-width:0;"><label style="display:block; font-size:0.76rem; margin-bottom:4px;">' + (isRo ? 'Categorie' : 'Category') + '</label><select id="ceCategory" style="width:100%; padding:8px 10px; background:rgba(255,255,255,0.06); border:1px solid rgba(184,216,240,0.25); border-radius:6px; color:#F5F0EB; font-size:0.82rem; font-family:\'Outfit\',sans-serif; box-sizing:border-box; appearance:auto; -webkit-appearance:menulist;"><option value="Metal Detecting">Metal Detecting</option><option value="Treasure Hunt">Treasure Hunt</option><option value="Archaeology">Archaeology</option><option value="Community Meetup">Community Meetup</option><option value="Other">Other</option></select></div>' +
            '<div style="min-width:0;"><label style="display:block; font-size:0.76rem; margin-bottom:4px;">' + (isRo ? 'Max participanți' : 'Max attendees') + '</label><input type="number" id="ceMax" min="1" placeholder="' + (isRo ? 'Fără limită' : 'No limit') + '" style="width:100%; padding:8px 10px; background:rgba(255,255,255,0.06); border:1px solid rgba(184,216,240,0.25); border-radius:6px; color:#F5F0EB; font-size:0.85rem; font-family:\'Outfit\',sans-serif; box-sizing:border-box;"></div>' +
            '</div>' +
            '<div style="margin-bottom:12px; background:rgba(107,63,160,0.12); border:1px solid rgba(196,160,240,0.3); border-radius:6px; padding:10px;">' +
            '<label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:0.78rem;">' +
            '<input type="checkbox" id="ceAnonymous" style="margin-top:2px; accent-color:#6B3FA0; cursor:pointer;">' +
            '<span><strong>🕶 ' + (isRo ? 'Eveniment anonim' : 'Anonymous event') + '</strong><br>' +
            '<span style="font-size:0.7rem; opacity:0.75;">' + (isRo
                ? 'Nu apare pe hartă. Participanții intră instant cu un cod de eveniment, fără cerere de participare.'
                : 'Does not appear on the map. Participants join instantly with an event code, no join request needed.') + '</span></span>' +
            '</label>' +
            '</div>' +
            friendsBlock +
            '<div id="ceQuotaNote" style="font-size:0.7rem; opacity:0.62; margin-bottom:10px; line-height:1.5;"></div>' +
            '<div id="ceError" style="font-size:0.76rem; color:#ff8a8a; margin-bottom:10px;"></div>' +
            '<div style="display:flex; gap:10px;"><button type="button" id="ceSubmitBtn" style="flex:1; background:#6B3FA0; border:none; border-radius:6px; color:#fff; font-weight:600; padding:10px; cursor:pointer;">' + (isRo ? 'Salvează Evenimentul' : 'Save Event') + '</button><button type="button" id="ceCancelBtn" style="background:rgba(255,255,255,0.1); border:none; border-radius:6px; color:#F5F0EB; padding:10px; cursor:pointer;">' + (isRo ? 'Anulează' : 'Cancel') + '</button></div>' +
            '</div>';

        document.body.appendChild(modal);

        // ── Social wiring: friends picker + live quota note ──
        var maxInvitesPerEvent = (socialLimits && Number(socialLimits.max_event_invites_per_event)) || 50;
        (function initCreateEventSocial() {
            if (!social) return;
            try {
                var box = modal.querySelector('#ceFriendsBox');
                if (box) {
                    social.renderFriendPicker(box, {
                        selected: selectedFriends,
                        onChange: function () {}
                    });
                    // The first paint uses the per-account mirror; refresh from
                    // the server so friends added on another device (or a
                    // request accepted a minute ago) are listed here too. The
                    // ticked ids live in `selectedFriends`, which survives the
                    // re-render.
                    Promise.resolve(social.loadFriends()).then(function () {
                        if (!document.getElementById('createEventModal')) return;
                        social.renderFriendPicker(box, {
                            selected: selectedFriends,
                            onChange: function () {}
                        });
                    }).catch(function () {});
                }
            } catch (e) {
                console.warn('[Events] friend picker could not be rendered', e);
            }
            var note = modal.querySelector('#ceQuotaNote');
            if (!note) return;
            note.textContent = isRo ? 'Se verifică limitele…' : 'Checking limits…';
            Promise.resolve(social.getEventQuota(true)).then(function (quota) {
                var L = social.getLimits();
                var deadlineDays = (quota && quota.deadlineDays) || maxDeadlineDays;
                // The database owns the deadline cap; keep the submit handler in
                // sync with whatever get_my_event_quota() reported.
                maxDeadlineDays = deadlineDays;
                if (!quota) {
                    note.textContent = isRo
                        ? 'Limite: max ' + deadlineDays + ' zile în viitor pentru dată.'
                        : 'Limits: the date can be at most ' + deadlineDays + ' days ahead.';
                    return;
                }
                note.textContent = isRo
                    ? 'Limitele contului tău: ' + quota.created + '/' + quota.createdMax + ' evenimente create active • ' +
                      quota.attending + '/' + quota.attendingMax + ' participări active • data maximă: +' + deadlineDays + ' zile.'
                    : 'Your account limits: ' + quota.created + '/' + quota.createdMax + ' active events created • ' +
                      quota.attending + '/' + quota.attendingMax + ' active attendances • latest date: +' + deadlineDays + ' days.';
                if (quota.created >= quota.createdMax) {
                    var err = modal.querySelector('#ceError');
                    if (err) {
                        err.textContent = isRo
                            ? 'Ai atins numărul maxim de evenimente active (' + quota.createdMax + '). Șterge unul ca să poți crea altul.'
                            : 'You reached the maximum number of active events (' + quota.createdMax + '). Delete one to create another.';
                    }
                }
                if (L && L.max_event_invites_per_event) {
                    maxInvitesPerEvent = Number(L.max_event_invites_per_event);
                }
            }).catch(function () { note.textContent = ''; });
        })();

        modal.querySelector('#ceCancelBtn').addEventListener('click', function () { modal.remove(); });
        modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });

        modal.querySelector('#ceSubmitBtn').addEventListener('click', async function () {
            var title = document.getElementById('ceTitle').value.trim();
            var desc = document.getElementById('ceDesc').value.trim();
            var dateVal = document.getElementById('ceDate').value;
            var timeVal = document.getElementById('ceTime').value || '10:00';
            var categoryVal = document.getElementById('ceCategory').value;
            var maxStr = document.getElementById('ceMax').value;
            var anonEl = document.getElementById('ceAnonymous');
            var isAnonymous = !!(anonEl && anonEl.checked);
            var errEl = document.getElementById('ceError');

            // Coordinates come from the editable fields when the form was
            // opened from a chat (no pin behind it).
            var eventLat = Number(lat);
            var eventLng = Number(lng);
            if (options.showCoordinates) {
                var latEl = document.getElementById('ceLat');
                var lngEl = document.getElementById('ceLng');
                if (latEl && latEl.value !== '') eventLat = Number(latEl.value);
                if (lngEl && lngEl.value !== '') eventLng = Number(lngEl.value);
                if (!isFinite(eventLat) || !isFinite(eventLng) || eventLat < -90 || eventLat > 90 || eventLng < -180 || eventLng > 180) {
                    errEl.textContent = isRo ? 'Coordonatele nu sunt valide.' : 'The coordinates are not valid.';
                    return;
                }
            }

            // Friends ticked in the "Adaugă prieteni / Add friends" box.
            var invitedFriendIds = [];
            try {
                var friendsBox = document.getElementById('ceFriendsBox');
                if (social && friendsBox) invitedFriendIds = social.readFriendPicker(friendsBox) || [];
            } catch (e) {}
            if (invitedFriendIds.length > maxInvitesPerEvent) {
                errEl.textContent = isRo
                    ? 'Poți invita maximum ' + maxInvitesPerEvent + ' prieteni la un eveniment.'
                    : 'You can invite at most ' + maxInvitesPerEvent + ' friends to an event.';
                return;
            }

            if (!title || !dateVal) {
                errEl.textContent = isRo ? 'Completați titlul și data.' : 'Please fill in title and date.';
                return;
            }

            var fullDateStr = dateVal + 'T' + timeVal + ':00';
            var eventDate = new Date(fullDateStr);
            if (isNaN(eventDate.getTime())) {
                eventDate = new Date(dateVal);
            }

            var now = new Date();
            // Deadline cap: at most `max_event_deadline_days` (365 by default,
            // read from public.app_limits) in the future. The same rule is
            // enforced by trigger_guard_event_limits in the database, so an
            // old cached client cannot book a hunt five years ahead.
            var deadlineLimit = new Date(now.getTime());
            deadlineLimit.setDate(deadlineLimit.getDate() + (maxDeadlineDays || 365));

            if (eventDate > deadlineLimit) {
                errEl.textContent = isRo
                    ? 'Evenimentele nu pot fi create mai târziu de ' + (maxDeadlineDays || 365) + ' zile de la data curentă.'
                    : 'Events cannot be created later than ' + (maxDeadlineDays || 365) + ' days from now.';
                return;
            }

            if (eventDate <= now) {
                errEl.textContent = isRo ? 'Data evenimentului trebuie să fie în viitor.' : 'Event date must be in the future.';
                return;
            }

            var user = getCurrentUser();
            if (!user || !user.id) {
                errEl.textContent = isRo ? 'Trebuie să fii autentificat.' : 'You must be logged in.';
                return;
            }
            var submitBtn = document.getElementById('ceSubmitBtn');

            // How many events may this account still create?
            if (social) {
                try {
                    var quota = await social.getEventQuota(true);
                    if (quota && quota.created >= quota.createdMax) {
                        errEl.textContent = isRo
                            ? 'Ai deja ' + quota.created + ' din ' + quota.createdMax + ' evenimente active. Șterge unul înainte să creezi altul.'
                            : 'You already have ' + quota.created + ' of ' + quota.createdMax + ' active events. Delete one before creating another.';
                        return;
                    }
                } catch (e) {}
            }

            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = isRo ? 'Se salvează…' : 'Saving…'; }

            var newEvent = {
                id: genUuid(),
                pin_id: pinId || null,
                creator_id: user.id,
                creator_name: (user.name || (user.email ? user.email.split('@')[0] : 'User')),
                creator_email: user.email || null,
                title: title,
                description: desc,
                category: categoryVal,
                latitude: eventLat,
                longitude: eventLng,
                event_date: eventDate.toISOString(),
                max_attendees: maxStr ? parseInt(maxStr, 10) : null,
                is_anonymous: isAnonymous,
                event_code: isAnonymous ? generateEventCode() : null,
                created_at: new Date().toISOString()
            };

            var savedToServer = await ensureEventOnServer(newEvent);

            // The server refused because of a quota: show why and do NOT keep a
            // local ghost event nobody else will ever see.
            var quotaCode = eventQuotaCode(savedToServer && savedToServer.error);
            if (savedToServer && !savedToServer.ok && quotaCode) {
                var rawMsg = String((savedToServer.error && savedToServer.error.message) || '');
                var quotaArg = rawMsg.indexOf(':') !== -1 ? rawMsg.split(':')[1].trim() : '';
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = isRo ? 'Salvează Evenimentul' : 'Save Event';
                }
                errEl.textContent = eventQuotaMessage(quotaCode, quotaArg, isRo);
                try { if (social) social.getEventQuota(true); } catch (e) {}
                return;
            }

            // Remember that the server accepted it. If the event later vanishes
            // from the server it was deleted there, and fetchEvents() must drop
            // it instead of re-uploading the stale local copy.
            if (savedToServer && savedToServer.ok) markEventSynced(newEvent.id);

            eventsData.push(newEvent);
            saveLocalEvents(eventsData);
            if (window.updatePinWithEvent && pinId) {
                window.updatePinWithEvent(pinId, newEvent);
            }
            refreshEventsMap();
            modal.remove();

            // Tell everyone whose last known location is in this event's county
            // (or within 50 km) that an event was created near them. Fire and
            // forget — the creator must not wait on reverse geocoding.
            if (savedToServer && savedToServer.ok) {
                notifyUsersNearEvent(newEvent);
            }

            // ── "Adaugă prieteni": every ticked friend receives a
            // participation request (event_inquiries + a notification with
            // kind = 'friend_event_invite') that they can accept or decline.
            var inviteSummary = '';
            if (savedToServer && savedToServer.ok && social && invitedFriendIds.length) {
                try {
                    var inviteRes = await social.inviteFriendsToEvent(newEvent.id, invitedFriendIds);
                    if (inviteRes && inviteRes.ok) {
                        var counts = social.summariseInviteResults(inviteRes.results);
                        inviteSummary = social.inviteSummaryText(counts);
                    } else if (inviteRes) {
                        inviteSummary = inviteRes.message || '';
                    }
                } catch (e) {
                    console.warn('[Events] inviting friends failed', e);
                }
                try { social.getEventQuota(true); } catch (e) {}
            }

            // A chat that started this event may want to post a link/summary.
            if (typeof options.onCreated === 'function') {
                try { options.onCreated(newEvent, invitedFriendIds); } catch (e) { console.warn('[Events] onCreated hook failed', e); }
            }

            if (savedToServer && savedToServer.ok) {
                if (isAnonymous && newEvent.event_code) {
                    alert(isRo
                        ? 'Eveniment anonim creat cu succes!\n\n🔑 Codul evenimentului: ' + newEvent.event_code + '\n\nTrimite acest cod persoanelor pe care vrei să le inviți. Ele îl pot introduce în bara „Participă la un eveniment anonim” din secțiunea Evenimente.' + (inviteSummary ? '\n\n👥 ' + inviteSummary : '')
                        : 'Anonymous event created successfully!\n\n🔑 Event code: ' + newEvent.event_code + '\n\nShare this code with the people you want to invite. They can enter it in the "Join an anonymous event" bar in the Events section.' + (inviteSummary ? '\n\n👥 ' + inviteSummary : ''));
                } else {
                    alert(isRo
                        ? 'Eveniment creat cu succes!' + (inviteSummary ? '\n\n👥 ' + inviteSummary : '')
                        : 'Event created successfully!' + (inviteSummary ? '\n\n👥 ' + inviteSummary : ''));
                }
                if (savedToServer.partial) {
                    console.warn('[Events] Event synced without pin_id/category/creator_email (older server schema).');
                }
            } else if (isAnonymous && savedToServer && savedToServer.reason === 'schema-missing-anonymous') {
                alert(isRo
                    ? '⚠️ Evenimentul anonim a fost creat doar local: serverul nu suportă încă evenimente anonime (migrația lipsește). Ceilalți nu se vor putea alătura cu codul până la actualizarea serverului.\n\n🔑 Codul evenimentului: ' + newEvent.event_code
                    : '⚠️ The anonymous event was created locally only: the server does not support anonymous events yet (missing migration). Others cannot join with the code until the server is updated.\n\n🔑 Event code: ' + newEvent.event_code);
            } else {
                alert(isRo
                    ? 'Eveniment creat local. Alți utilizatori nu îl vor vedea până când conexiunea la server nu este restabilită.'
                    : 'Event created locally. Other users will not see it until server connection is restored.');
            }
        });
    }

    // Global Pin Deletion Function
    window.deletePin = async function (pinId, btnElement) {
        if (!pinId) return;

        if (btnElement) {
            btnElement.disabled = true;
            btnElement.textContent = 'Deleting…';
        }

        var map = window._dlMap || window.map;

        // 1. Remove from window._detectLabPins
        if (window._detectLabPins) {
            var idx = window._detectLabPins.findIndex(function (p) { return String(p.id) === String(pinId); });
            if (idx !== -1) {
                var pinObj = window._detectLabPins[idx];
                if (pinObj.marker && map && map.hasLayer(pinObj.marker)) {
                    map.removeLayer(pinObj.marker);
                }
                window._detectLabPins.splice(idx, 1);
            }
        }

        // 2. Remove marker from savedLocationsLayer
        if (window._savedLocationsLayer) {
            window._savedLocationsLayer.eachLayer(function (layer) {
                if (layer.pinId === pinId || (layer.options && layer.options.pinId === pinId) || layer._pinId === pinId) {
                    window._savedLocationsLayer.removeLayer(layer);
                }
            });
        }

        // 3. Remove active temporary coordMarker
        if (window._activeCoordMarker && (window._activeCoordMarker.pinId === pinId || window._activeCoordMarker._pinId === pinId)) {
            if (map) map.removeLayer(window._activeCoordMarker);
            window._activeCoordMarker = null;
        }

        // 4. Remove from localStorage
        try {
            var local = JSON.parse(localStorage.getItem('detectlab_saved_pins') || '[]');
            var filtered = local.filter(function (p) { return String(p.id) !== String(pinId); });
            localStorage.setItem('detectlab_saved_pins', JSON.stringify(filtered));
        } catch (e) {}

        // 5. Remove from Supabase if DB row exists
        try {
            if (window.supabaseClient && pinId && !String(pinId).startsWith('temp_')) {
                await window.supabaseClient.from('saved_coordinates').delete().eq('id', pinId);
            }
        } catch (err) {
            console.warn('Could not delete pin from Supabase backend:', err);
        }

        // 6. Close active popup and notify
        if (map) map.closePopup();
        console.log('[DetectLab] Pin deleted successfully:', pinId);
    };

    // Update pin when event is linked
    window.updatePinWithEvent = function (pinId, event) {
        if (!pinId) return;
        var pins = window._detectLabPins || [];
        var pinObj = pins.find(function (p) { return String(p.id) === String(pinId); });
        if (pinObj) {
            pinObj.has_event = true;
            pinObj.event_data = event;
        }
        if (typeof window.refreshEventsMap === 'function') {
            window.refreshEventsMap();
        }
    };

    // Global Event Delegation for Delete & Create Event buttons
    function _handlePinDelegation(e) {
        // Delete Pin
        var delBtn = e.target && e.target.closest ? e.target.closest('.delete-pin-btn, .pin-delete-btn, .coord-popup-delete') : null;
        if (delBtn) {
            e.preventDefault();
            e.stopPropagation();
            if (window.L && L.DomEvent) try { L.DomEvent.stop(e); } catch(_){}
            var pinId = (delBtn.getAttribute('data-pin-id') || delBtn.dataset.pinId || '').trim();
            if (!pinId) {
                var pinWrap = delBtn.closest ? delBtn.closest('[data-pin-id]') : null;
                if (pinWrap) pinId = pinWrap.getAttribute('data-pin-id') || '';
            }
            if (confirm('Sigur doriți să ștergeți acest pin? / Are you sure you want to delete this pin?')) {
                window.deletePin(pinId, delBtn);
            }
            return;
        }

        // Create Event from Pin
        var createBtn = e.target && e.target.closest ? e.target.closest('.pin-create-event-btn, .coord-popup-create-event') : null;
        if (createBtn) {
            e.preventDefault();
            e.stopPropagation();
            if (window.L && L.DomEvent) try { L.DomEvent.stop(e); } catch(_){}
            var pinId2 = (createBtn.getAttribute('data-pin-id') || createBtn.dataset.pinId || '').trim();
            if (!pinId2) {
                var pinWrap2 = createBtn.closest ? createBtn.closest('[data-pin-id]') : null;
                if (pinWrap2) pinId2 = pinWrap2.getAttribute('data-pin-id') || '';
            }
            var lat2 = parseFloat(createBtn.getAttribute('data-lat') || createBtn.dataset.lat || '');
            var lng2 = parseFloat(createBtn.getAttribute('data-lng') || createBtn.dataset.lng || '');
            var title2 = createBtn.getAttribute('data-title') || createBtn.dataset.title || '';
            if (!isFinite(lat2) || !isFinite(lng2)) {
                var pinWrap3 = createBtn.closest ? createBtn.closest('.pin-popup, .map-place-popup, .coord-popup-container') : null;
                if (pinWrap3) {
                    var fallbackId = pinWrap3.getAttribute('data-pin-id') || pinId2;
                    if (fallbackId && window._detectLabPins) {
                        var found = window._detectLabPins.find(function(p){ return String(p.id)===String(fallbackId); });
                        if (found) { lat2 = Number(found.lat); lng2 = Number(found.lng); if (!title2 && found.title) title2 = found.title; pinId2 = found.id; }
                    }
                }
            }
            if (!isFinite(lat2) || !isFinite(lng2)) return;
            var user2 = getCurrentUser();
            if (!user2) {
                if (typeof window.openAuth === 'function') window.openAuth('login');
                return;
            }
            openCreateEventModal(lat2, lng2, pinId2 || null, title2 || '');
            var m2 = window._dlMap || window.map;
            if (m2) m2.closePopup();
            return;
        }
    }
    document.addEventListener('click', _handlePinDelegation, true);
    document.addEventListener('click', _handlePinDelegation, false);

    window.getEventsData = function () { return eventsData; };
    window.openCreateEventModal = openCreateEventModal;

    // Check attendance 1-event-per-day rule
    async function checkAttendanceConflict(userId, eventDateIso, excludeEventId) {
        var targetDateStr = getDateString(eventDateIso);
        var isRo = (window._currentLang && window._currentLang() === 'ro');

        var attendances = [];
        try {
            if (window.supabaseClient) {
                var res = await window.supabaseClient.from('event_attendees').select('event_id').eq('user_id', userId);
                if (!res.error && res.data) {
                    attendances = res.data;
                }
            }
        } catch (e) {}

        if (attendances.length === 0) {
            attendances = getLocalAttendees().filter(function(a) { return a.user_id === userId; });
        }

        for (var i = 0; i < attendances.length; i++) {
            var att = attendances[i];
            if (excludeEventId && att.event_id === excludeEventId) continue;
            var ev = eventsData.find(function(e) { return e.id === att.event_id; });
            if (ev) {
                if (excludeEventId && ev.id === excludeEventId) continue;
                var evDateStr = getDateString(ev.event_date);
                if (evDateStr === targetDateStr) {
                    return isRo
                        ? 'Deja participi la un eveniment în ' + evDateStr
                        : 'You are already attending to an event on ' + evDateStr;
                }
            }
        }
        return null;
    }

    // Open Inquiry Modal
    window._openInquiryModal = function (eventId) {
        var ev = eventsData.find(function (e) { return e.id === eventId; });
        if (!ev) return;
        var user = getCurrentUser();
        if (!user) {
            if (typeof window.openAuth === 'function') window.openAuth('login');
            return;
        }

        var existing = document.getElementById('inquiryModal');
        if (existing) existing.remove();

        var isRo = (window._currentLang && window._currentLang() === 'ro');

        var modal = document.createElement('div');
        modal.id = 'inquiryModal';
        modal.style.cssText = 'position: fixed; inset: 0; z-index: 4000; background: rgba(4,10,22,0.85); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 16px;';
        modal.innerHTML = '<div style="background: rgba(10,20,42,0.98); border: 1px solid rgba(184,216,240,0.25); border-radius: 12px; width: 100%; max-width: 420px; padding: 20px; color: #F5F0EB; font-family: \'Outfit\', sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,0.6);">' +
            '<h3 style="margin-top:0; font-size:1.1rem; color:var(--sky); font-family:\'Cinzel\',serif;">' + (isRo ? 'Cerere de participare' : 'Attendance Inquiry') + '</h3>' +
            '<div style="font-size:0.8rem; margin-bottom:8px;"><strong>' + escapeHtml(ev.title) + '</strong></div>' +
            '<div style="font-size:0.75rem; opacity:0.7; margin-bottom:12px;">' + (isRo ? 'Scrie un mesaj scurt (max 100 cuvinte) către creator:' : 'Write a short message (max 100 words) to the creator:') + '</div>' +
            '<textarea id="inqMessage" placeholder="' + (isRo ? 'Salut, aș dori să particip...' : 'Hi, I would like to attend...') + '" style="width:100%; height:90px; padding:8px; background:rgba(255,255,255,0.06); border:1px solid rgba(184,216,240,0.25); border-radius:6px; color:#F5F0EB; font-size:0.85rem; resize:none; margin-bottom:12px;"></textarea>' +
            '<div id="inqError" style="font-size:0.76rem; color:#ff8a8a; margin-bottom:10px;"></div>' +
            '<div style="display:flex; gap:10px;"><button type="button" id="inqSubmitBtn" style="flex:1; background:#E8772A; border:none; border-radius:6px; color:#fff; font-weight:600; padding:10px; cursor:pointer;">' + (isRo ? 'Trimite Cererea' : 'Send Inquiry') + '</button><button type="button" id="inqCancelBtn" style="background:rgba(255,255,255,0.1); border:none; border-radius:6px; color:#F5F0EB; padding:10px; cursor:pointer;">' + (isRo ? 'Anulează' : 'Cancel') + '</button></div>' +
            '</div>';

        document.body.appendChild(modal);

        modal.querySelector('#inqCancelBtn').addEventListener('click', function () { modal.remove(); });
        modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });

        modal.querySelector('#inqSubmitBtn').addEventListener('click', async function () {
            var msgText = document.getElementById('inqMessage').value.trim();
            var errEl = document.getElementById('inqError');
            var submitBtn = document.getElementById('inqSubmitBtn');

            var words = msgText.split(/\s+/).filter(Boolean);
            if (words.length > 100) {
                errEl.textContent = isRo ? 'Mesajul nu poate depăși 100 de cuvinte.' : 'Message cannot exceed 100 words.';
                return;
            }

            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = isRo ? 'Se trimite…' : 'Sending…';
            }

            // ── Duplicate inquiry check: one request per user per event ──
            var alreadyRequested = false;
            try {
                if (window.supabaseClient) {
                    var dupRes = await window.supabaseClient.from('event_inquiries').select('id,status').eq('event_id', ev.id).eq('user_id', user.id);
                    if (!dupRes.error && dupRes.data && dupRes.data.length > 0) {
                        var activeInq = dupRes.data.some(function(d){ return d.status !== 'declined'; });
                        if (activeInq) alreadyRequested = true;
                    }
                }
            } catch (e) {}
            if (!alreadyRequested) {
                var localDup = getLocalInquiries().filter(function(i) { return i.event_id === ev.id && i.user_id === user.id && i.status !== 'declined'; });
                if (localDup.length > 0) alreadyRequested = true;
            }

            // Check if already an accepted attendee
            var alreadyAttendee = false;
            try {
                if (window.supabaseClient) {
                    var attRes = await window.supabaseClient.from('event_attendees').select('id').eq('event_id', ev.id).eq('user_id', user.id);
                    if (!attRes.error && attRes.data && attRes.data.length > 0) alreadyAttendee = true;
                }
            } catch (e) {}
            if (!alreadyAttendee) {
                var localAttDup = getLocalAttendees().filter(function(a) { return a.event_id === ev.id && a.user_id === user.id; });
                if (localAttDup.length > 0) alreadyAttendee = true;
            }
            if (alreadyAttendee) {
                errEl.textContent = isRo ? 'Deja ești participant la acest eveniment.' : 'You are already an attendee of this event.';
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isRo ? 'Trimite Cererea' : 'Send Inquiry'; }
                return;
            }
            if (alreadyRequested) {
                errEl.textContent = isRo ? 'Ai deja o cerere trimisă pentru acest eveniment.' : 'You have already sent a request for this event.';
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isRo ? 'Trimite Cererea' : 'Send Inquiry'; }
                return;
            }

            // Check 1-event-per-day rule
            var conflictMsg = await checkAttendanceConflict(user.id, ev.event_date);
            if (conflictMsg) {
                errEl.textContent = conflictMsg;
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isRo ? 'Trimite Cererea' : 'Send Inquiry'; }
                return;
            }

            // Ensure parent event exists on Supabase so foreign key constraints in event_inquiries don't fail
            var evSync = await ensureEventOnServer(ev);

            var inquiryId = genUuid();
            var inquiry = {
                id: inquiryId,
                event_id: ev.id,
                user_id: user.id,
                user_name: user.name || (user.email ? user.email.split('@')[0] : 'User'),
                message: msgText,
                status: 'pending',
                created_at: new Date().toISOString()
            };

            var notification = {
                id: genUuid(),
                user_id: ev.creator_id,
                event_id: ev.id,
                inquiry_id: inquiryId,
                sender_id: user.id,
                sender_name: inquiry.user_name,
                message: msgText,
                read: false,
                created_at: new Date().toISOString()
            };

            var hasServerClient = !!window.supabaseClient;
            var remoteInquiryOk = false;
            try {
                if (window.supabaseClient) {
                    var inqRes = await window.supabaseClient.from('event_inquiries').insert([inquiry]);
                    if (inqRes && inqRes.error) {
                        console.error('Supabase insert inquiry failed:', inqRes.error);
                    } else {
                        remoteInquiryOk = true;
                    }
                    var notifRes = await window.supabaseClient.from('event_notifications').insert([notification]);
                    if (notifRes && notifRes.error) {
                        console.error('Supabase insert notification failed:', notifRes.error);
                        if (remoteInquiryOk) {
                            console.warn('[Events] The request was stored but the creator notification row failed; the creator can still see it via Manage Event.');
                        }
                    }
                }
            } catch (err) {
                console.warn('Supabase inquiry error, storing locally:', err);
            }

            var localInqs = getLocalInquiries();
            localInqs.push(inquiry);
            saveLocalInquiries(localInqs);

            var localNotifs = getLocalNotifications();
            localNotifs.push(notification);
            saveLocalNotifications(localNotifs);

            modal.remove();
            if (remoteInquiryOk) {
                alert(isRo ? 'Cererea a fost trimisă cu succes!' : 'Inquiry sent successfully!');
            } else if (!hasServerClient) {
                alert(isRo
                    ? '⚠️ Cererea a fost salvată doar pe acest dispozitiv — fără conexiune la server, creatorul nu o va primi. Reîncearcă când conexiunea este restabilită.'
                    : '⚠️ Your request was only saved on this device — without a server connection the creator will not receive it. Try again once the connection is restored.');
            } else if (evSync && !evSync.ok) {
                alert(isRo
                    ? '⚠️ Evenimentul nu a putut fi sincronizat pe server, deci cererea a fost salvată doar local și creatorul nu o va primi. Verifică consola browserului (F12).'
                    : '⚠️ The event could not be synced to the server, so your request was only saved locally and the creator will not receive it. Check the browser console (F12).');
            } else {
                alert(isRo
                    ? '⚠️ Cererea NU a putut fi salvată pe server și a fost păstrată doar local. Verifică consola browserului (F12) pentru detalii.'
                    : '⚠️ Your request could NOT be saved to the server and was kept locally only. Check the browser console (F12) for details.');
            }
            refreshEventsMap();
        });
    };

    // ── JOIN ANONYMOUS EVENT BY CODE ──
    // No inquiry / approval round-trip: the user is added to event_attendees
    // immediately and the creator receives a notification.
    window._joinAnonymousEvent = async function () {
        var isRo = (window._currentLang && window._currentLang() === 'ro');
        var input = document.getElementById('anonJoinInput');
        var errEl = document.getElementById('anonJoinError');
        var btn = document.getElementById('anonJoinBtn');
        var setErr = function (msg) { if (errEl) errEl.textContent = msg; };
        setErr('');

        var user = getCurrentUser();
        if (!user || !user.id) {
            if (typeof window.openAuth === 'function') window.openAuth('login');
            return;
        }

        var code = normalizeEventCode(input ? input.value : '');
        if (!code) {
            setErr(isRo ? 'Introdu codul evenimentului.' : 'Enter the event code.');
            return;
        }

        if (btn) { btn.disabled = true; btn.textContent = isRo ? 'SE CAUTĂ…' : 'SEARCHING…'; }
        var restoreBtn = function () {
            if (btn) { btn.disabled = false; btn.textContent = isRo ? 'PARTICIPĂ' : 'JOIN'; }
        };

        // Find the event by code: server first, local cache as fallback.
        var ev = null;
        try {
            if (window.supabaseClient) {
                var res = await window.supabaseClient
                    .from('events')
                    .select('*')
                    .eq('event_code', code)
                    .limit(1);
                if (res && !res.error && Array.isArray(res.data) && res.data[0]) {
                    ev = res.data[0];
                } else if (res && res.error) {
                    console.warn('[Events] Anonymous event lookup failed:', res.error);
                }
            }
        } catch (e) {
            console.warn('[Events] Anonymous event lookup error:', e);
        }
        if (!ev) {
            var allLocal = eventsData.slice();
            getLocalEvents().forEach(function (le) {
                if (le && !allLocal.some(function (x) { return x.id === le.id; })) allLocal.push(le);
            });
            ev = allLocal.find(function (e) {
                return e && e.event_code && normalizeEventCode(e.event_code) === code;
            }) || null;
        }

        if (!ev) {
            restoreBtn();
            setErr(isRo ? 'Niciun eveniment găsit cu acest cod.' : 'No event found with this code.');
            return;
        }

        if (isEventExpired(ev.event_date)) {
            restoreBtn();
            setErr(isRo ? 'Acest eveniment a expirat.' : 'This event has expired.');
            return;
        }

        if (isEventOwnedByUser(ev, user)) {
            restoreBtn();
            setErr(isRo ? 'Ești creatorul acestui eveniment.' : 'You are the creator of this event.');
            return;
        }

        // Already an attendee?
        var alreadyAttendee = isLocalAttendeeOf(ev.id, user);
        if (!alreadyAttendee) {
            try {
                if (window.supabaseClient) {
                    var attRes = await window.supabaseClient
                        .from('event_attendees')
                        .select('id')
                        .eq('event_id', ev.id)
                        .eq('user_id', user.id)
                        .limit(1);
                    if (attRes && !attRes.error && Array.isArray(attRes.data) && attRes.data.length > 0) {
                        alreadyAttendee = true;
                    }
                }
            } catch (e) {}
        }
        if (alreadyAttendee) {
            restoreBtn();
            setErr(isRo ? 'Participi deja la acest eveniment.' : 'You are already attending this event.');
            return;
        }

        // Max attendees limit
        if (ev.max_attendees) {
            try {
                var counts = await fetchAttendeeCounts([ev.id]);
                if ((counts[ev.id] || 0) >= Number(ev.max_attendees)) {
                    restoreBtn();
                    setErr(isRo ? 'Evenimentul a atins numărul maxim de participanți.' : 'The event has reached its maximum number of attendees.');
                    return;
                }
            } catch (e) {}
        }

        // 1-event-per-day rule (same as approved joins)
        var conflictMsg = await checkAttendanceConflict(user.id, ev.event_date, ev.id);
        if (conflictMsg) {
            restoreBtn();
            setErr(conflictMsg);
            return;
        }

        // Make sure the event is in the local caches so the map/calendar can
        // render it for this (now participating) user.
        if (!eventsData.some(function (x) { return x.id === ev.id; })) {
            eventsData.push(ev);
            saveLocalEvents(eventsData);
        }

        var attendee = {
            id: genUuid(),
            event_id: ev.id,
            user_id: user.id,
            user_name: user.name || (user.email ? user.email.split('@')[0] : 'User'),
            joined_at: new Date().toISOString()
        };

        var joinedOnServer = false;
        try {
            if (window.supabaseClient) {
                var insRes = await window.supabaseClient.from('event_attendees').insert([attendee]);
                if (insRes && insRes.error) {
                    console.error('[Events] Anonymous join insert failed:', insRes.error);
                } else {
                    joinedOnServer = true;
                }
            }
        } catch (e) {
            console.error('[Events] Anonymous join insert error:', e);
        }

        // Mirror locally so the user is a participant immediately.
        var atts = getLocalAttendees();
        if (!atts.some(function (a) { return a.event_id === ev.id && a.user_id === user.id; })) {
            atts.push(attendee);
            saveLocalAttendees(atts);
        }

        // Notify the creator that someone joined their anonymous event.
        if (joinedOnServer || !window.supabaseClient) {
            try {
                await createOutcomeNotification({
                    userId: ev.creator_id,
                    eventId: ev.id,
                    inquiryId: null,
                    senderId: user.id,
                    senderName: attendee.user_name,
                    message: isRo
                        ? '🎟 ' + attendee.user_name + ' s-a alăturat evenimentului tău anonim «' + (ev.title || '') + '» folosind codul de participare.'
                        : '🎟 ' + attendee.user_name + ' joined your anonymous event "' + (ev.title || '') + '" using the join code.'
                });
            } catch (e) {
                console.error('[Events] Failed to notify creator about anonymous join:', e);
            }
        }

        // Chat becomes available right away.
        try { await syncEventChatState(ev.id); } catch (e) {}

        refreshEventsMap(true);
        try { if (window._updateEventBadges) window._updateEventBadges(); } catch (e) {}
        try {
            var attendingMap = await getAttendingMapAsync();
            renderCalendar(attendingMap);
        } catch (e) {}

        if (input) input.value = '';
        restoreBtn();

        if (window.supabaseClient && !joinedOnServer) {
            alert(isRo
                ? '⚠️ Participarea a fost salvată doar pe acest dispozitiv — serverul a respins operațiunea. Creatorul nu a fost notificat. Verifică consola browserului (F12).'
                : '⚠️ Your participation was only saved on this device — the server rejected the change. The creator was not notified. Check the browser console (F12).');
        } else {
            alert(isRo
                ? '✅ Te-ai alăturat evenimentului «' + (ev.title || '') + '»! Creatorul a fost notificat, iar evenimentul apare acum (translucid) pe harta ta.'
                : '✅ You joined the event "' + (ev.title || '') + '"! The creator was notified and the event now appears (translucent) on your map.');
        }
    };

    // Manage Event / Creator Panel
    window._manageEvent = function (eventId) {
        var ev = eventsData.find(function (e) { return e.id === eventId; });
        if (!ev) return;
        var isRo = (window._currentLang && window._currentLang() === 'ro');

        var existing = document.getElementById('manageEventModal');
        if (existing) existing.remove();

        var modal = document.createElement('div');
        modal.id = 'manageEventModal';
        modal.setAttribute('data-event-id', eventId);
        modal.style.cssText = 'position: fixed; inset: 0; z-index: 4000; background: rgba(4,10,22,0.85); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 16px;';
        
        var modalBox = document.createElement('div');
        modalBox.style.cssText = 'background: rgba(10,20,42,0.98); border: 1px solid rgba(184,216,240,0.25); border-radius: 12px; width: 100%; max-width: 500px; max-height: 85vh; overflow-y: auto; padding: 20px; color: #F5F0EB; font-family: \'Outfit\', sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,0.6);';
        
        var meAnonInfo = '';
        if (isAnonymousEvent(ev)) {
            meAnonInfo = '<div style="background:rgba(107,63,160,0.18); border:1px solid rgba(196,160,240,0.4); border-radius:6px; padding:8px 12px; margin-bottom:12px; font-size:0.78rem; color:#E8D0FF;">' +
                '🕶 ' + (isRo ? 'Eveniment anonim (nu apare pe hartă).' : 'Anonymous event (hidden from the map).') +
                (ev.event_code ? ('<br>🔑 ' + (isRo ? 'Cod de participare:' : 'Join code:') + ' <strong style="letter-spacing:0.12em; font-size:0.9rem;">' + escapeHtml(ev.event_code) + '</strong>') : '') +
                '</div>';
        }

        modalBox.innerHTML = '<h3 style="margin-top:0; font-size:1.1rem; color:var(--sky); font-family:\'Cinzel\',serif;">' + escapeHtml(ev.title) + '</h3>' +
            '<div style="font-size:0.78rem; opacity:0.7; margin-bottom:12px;">📅 ' + formatDate(ev.event_date) + '</div>' +
            meAnonInfo +
            '<div style="display:flex; gap:10px; margin-bottom:16px;">' +
            '<button type="button" id="meDeleteBtn" style="background:rgba(196,43,43,0.3); border:1px solid rgba(196,43,43,0.6); border-radius:6px; color:#ff8a8a; padding:6px 12px; font-size:0.76rem; cursor:pointer; font-weight:600;">' + (isRo ? 'Șterge Evenimentul' : 'Delete Event') + '</button>' +
            '<button type="button" id="meCloseBtn" style="background:rgba(255,255,255,0.1); border:none; border-radius:6px; color:#F5F0EB; padding:6px 12px; font-size:0.76rem; cursor:pointer;">' + (isRo ? 'Închide' : 'Close') + '</button>' +
            '</div>' +
            '<h4 style="font-size:0.9rem; border-bottom:1px solid rgba(184,216,240,0.15); padding-bottom:4px; margin-bottom:8px;">' + (isRo ? 'Participanți & Cereri' : 'Attendees & Inquiries') + '</h4>' +
            '<div id="meAttendeesList">Se încarcă…</div>';

        modal.appendChild(modalBox);
        document.body.appendChild(modal);

        modal.querySelector('#meCloseBtn').addEventListener('click', function () { modal.remove(); });
        modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });

        modal.querySelector('#meDeleteBtn').addEventListener('click', async function () {
            if (!confirm(isRo ? 'Sigur doriți să ștergeți acest eveniment?' : 'Are you sure you want to delete this event?')) return;

            var delBtn = modal.querySelector('#meDeleteBtn');
            if (delBtn) { delBtn.disabled = true; delBtn.textContent = isRo ? 'Se șterge…' : 'Deleting…'; }

            var deletedOnServer = false;
            if (window.supabaseClient) {
                // Record the deletion tombstone FIRST so every other client knows
                // to purge this event from its local cache and stop re-syncing it.
                await recordEventDeletion(ev.id);

                try {
                    // Remove the children explicitly. `on delete cascade` handles
                    // this server-side, but doing it here keeps the data clean even
                    // if the deployed schema predates those constraints — otherwise
                    // orphan attendee rows keep the event "alive" for participants.
                    await window.supabaseClient.from('event_chat_messages').delete().eq('event_id', ev.id);
                    await window.supabaseClient.from('event_chats').delete().eq('event_id', ev.id);
                    await window.supabaseClient.from('event_attendees').delete().eq('event_id', ev.id);
                    await window.supabaseClient.from('event_inquiries').delete().eq('event_id', ev.id);
                    await window.supabaseClient.from('event_notifications').delete().eq('event_id', ev.id);
                } catch (err) {
                    console.warn('Could not fully clean up event children:', err);
                }

                try {
                    var delRes = await window.supabaseClient.from('events').delete().eq('id', ev.id);
                    if (delRes && delRes.error) {
                        console.error('[Events] Failed to delete event on the server:', delRes.error);
                    } else {
                        deletedOnServer = true;
                    }
                } catch (err) {
                    console.warn('Could not delete event from Supabase backend:', err);
                }
            }

            // Purge every local trace so the event cannot be re-uploaded later.
            eventsData = eventsData.filter(function (e) { return e.id !== ev.id; });
            purgeLocalEventArtifacts([ev.id]);
            saveLocalEvents(eventsData);
            refreshEventsMap(true);
            modal.remove();

            if (window.supabaseClient && !deletedOnServer) {
                alert(isRo
                    ? '⚠️ Evenimentul a fost șters de pe acest dispozitiv, dar serverul a respins ștergerea, deci ceilalți participanți îl vor vedea în continuare. Verifică consola browserului (F12).'
                    : '⚠️ The event was removed on this device, but the server rejected the delete, so other participants will still see it. Check the browser console (F12).');
            }
        });

        loadManageEventDetails(ev.id);
    };

    async function loadManageEventDetails(eventId) {
        var listEl = document.getElementById('meAttendeesList');
        if (!listEl) return;
        var isRo = (window._currentLang && window._currentLang() === 'ro');

        var inquiries = [];
        var attendees = [];
        var remoteInquiriesOk = false;
        var remoteAttendeesOk = false;
        try {
            if (window.supabaseClient) {
                var resInq = await window.supabaseClient.from('event_inquiries').select('*').eq('event_id', eventId);
                if (!resInq.error && Array.isArray(resInq.data)) { inquiries = resInq.data; remoteInquiriesOk = true; }
                var resAtt = await window.supabaseClient.from('event_attendees').select('*').eq('event_id', eventId);
                if (!resAtt.error && Array.isArray(resAtt.data)) { attendees = resAtt.data; remoteAttendeesOk = true; }
            }
        } catch (e) {
            console.warn('loadManageEventDetails remote fetch error:', e);
        }

        // The server list is the truth when we could read it. Merging unmatched
        // local rows back in unconditionally (the old behaviour) is what made a
        // kicked attendee reappear in the creator's own list: the deleted row was
        // still cached locally and got re-added on every re-render.
        if (remoteAttendeesOk) {
            var removedAtt = reconcileLocalAttendees([eventId], attendees);
            if (removedAtt.length > 0) handleAttendanceRemovals(removedAtt);
        } else {
            // Offline: fall back to the cache so the panel is not empty.
            var attMap = {};
            attendees.forEach(function (a) { attMap[a.event_id + '::' + a.user_id] = a; });
            getLocalAttendees().forEach(function (a) {
                if (!a || a.event_id !== eventId) return;
                if (!attMap[a.event_id + '::' + a.user_id]) {
                    attendees.push(a);
                    attMap[a.event_id + '::' + a.user_id] = a;
                }
            });
        }

        if (!remoteInquiriesOk) {
            var inqMap = {};
            inquiries.forEach(function (i) { inqMap[i.id] = i; });
            getLocalInquiries().forEach(function (i) {
                if (!i || i.event_id !== eventId) return;
                if (!inqMap[i.id]) { inquiries.push(i); inqMap[i.id] = i; }
            });
        }

        // Never offer to accept someone who is already an approved attendee.
        var attendeeUserIds = {};
        attendees.forEach(function (a) { if (a && a.user_id) attendeeUserIds[a.user_id] = true; });

        var html = '';
        if (inquiries.length === 0 && attendees.length === 0) {
            listEl.innerHTML = '<div style="font-size:0.78rem; opacity:0.6;">' + (isRo ? 'Nicio cerere sau participant încă.' : 'No inquiries or attendees yet.') + '</div>';
            return;
        }

        html += '<div style="font-size:0.78rem; font-weight:600; color:var(--sky); margin-top:8px;">' + (isRo ? 'Cereri în așteptare:' : 'Pending Inquiries:') + '</div>';
        var pending = inquiries.filter(function(i) {
            return i.status === 'pending' && !attendeeUserIds[i.user_id];
        });
        if (pending.length === 0) {
            html += '<div style="font-size:0.75rem; opacity:0.5; margin-bottom:6px;">' + (isRo ? 'Nicio cerere în așteptare.' : 'No pending inquiries.') + '</div>';
        } else {
            pending.forEach(function(inq) {
                html += '<div style="background:rgba(255,255,255,0.04); border:1px solid rgba(184,216,240,0.15); border-radius:6px; padding:8px; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">' +
                    '<div><strong>' + escapeHtml(inq.user_name) + '</strong><div style="font-size:0.72rem; opacity:0.8; margin-top:2px;">"' + escapeHtml(inq.message || '') + '"</div></div>' +
                    '<div style="display:flex; gap:6px;">' +
                    '<button type="button" onclick="window._acceptInquiry(\'' + inq.id + '\', \'' + eventId + '\')" style="background:#2E9E4F; border:none; border-radius:4px; color:#fff; padding:4px 8px; font-size:0.7rem; cursor:pointer;">' + (isRo ? 'Acceptă' : 'Accept') + '</button>' +
                    '<button type="button" onclick="window._declineInquiry(\'' + inq.id + '\')" style="background:#C42B2B; border:none; border-radius:4px; color:#fff; padding:4px 8px; font-size:0.7rem; cursor:pointer;">' + (isRo ? 'Respinge' : 'Decline') + '</button>' +
                    '</div></div>';
            });
        }

        html += '<div style="font-size:0.78rem; font-weight:600; color:var(--sky); margin-top:12px;">' + (isRo ? 'Participanți aprobați:' : 'Approved Attendees:') + '</div>';
        if (attendees.length === 0) {
            html += '<div style="font-size:0.75rem; opacity:0.5;">' + (isRo ? 'Niciun participant aprobat.' : 'No approved attendees.') + '</div>';
        } else {
            attendees.forEach(function(att) {
                html += '<div style="background:rgba(255,255,255,0.04); border:1px solid rgba(184,216,240,0.15); border-radius:6px; padding:8px; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">' +
                    '<span>' + escapeHtml(att.user_name) + '</span>' +
                    '<button type="button" onclick="window._kickAttendee(\'' + att.id + '\', \'' + eventId + '\')" style="background:rgba(196,43,43,0.3); border:1px solid rgba(196,43,43,0.5); border-radius:4px; color:#ff8a8a; padding:3px 6px; font-size:0.68rem; cursor:pointer;">' + (isRo ? 'Dă afară' : 'Kick out') + '</button>' +
                    '</div>';
            });
        }

        listEl.innerHTML = html;
    }

    // Create a notification addressed to the inquiring user about the outcome of
    // their request (accepted/declined). The creator already gets notified when an
    // inquiry arrives; without this the attendee never hears back and their UI keeps
    // showing "Request pending". No schema change is required: the notification kind
    // is derived at read time from the related inquiry's owner + status, so this is
    // robust against the deployed schema lagging the latest migration.
    async function createOutcomeNotification(params) {
        var notification = {
            id: genUuid(),
            user_id: params.userId,
            event_id: params.eventId || null,
            inquiry_id: params.inquiryId || null,
            sender_id: params.senderId || null,
            sender_name: params.senderName || '',
            message: params.message || '',
            read: false,
            created_at: new Date().toISOString()
        };
        try {
            if (window.supabaseClient) {
                var res = await window.supabaseClient.from('event_notifications').insert([notification]);
                if (res && res.error) {
                    console.error('Supabase insert outcome notification failed:', res.error);
                }
            }
        } catch (e) {
            console.error('createOutcomeNotification error:', e);
        }
        var localNotifs = getLocalNotifications();
        localNotifs.push(notification);
        saveLocalNotifications(localNotifs);
        return notification;
    }

    // When the attendee receives an "accepted" notification, mirror that outcome into
    // their own local inquiry + attendee records so the map popup and panels reflect
    // "Already attending" instead of a stale "Request pending".
    function applyAcceptedOutcome(notif) {
        if (!notif || !notif.inquiry_id) return;
        var user = getCurrentUser();
        if (!user || notif.user_id !== user.id) return;

        var inqs = getLocalInquiries();
        var idx = inqs.findIndex(function (i) { return i.id === notif.inquiry_id; });
        if (idx !== -1) {
            inqs[idx].status = 'accepted';
        } else if (notif.event_id) {
            inqs.push({
                id: notif.inquiry_id,
                event_id: notif.event_id,
                user_id: user.id,
                user_name: user.name || (user.email ? user.email.split('@')[0] : 'User'),
                message: notif.message || '',
                status: 'accepted',
                created_at: notif.created_at || new Date().toISOString()
            });
        }
        saveLocalInquiries(inqs);

        if (notif.event_id) {
            var atts = getLocalAttendees();
            var hasAtt = atts.some(function (a) { return a.event_id === notif.event_id && a.user_id === user.id; });
            if (!hasAtt) {
                atts.push({
                    id: genUuid(),
                    event_id: notif.event_id,
                    user_id: user.id,
                    user_name: user.name || (user.email ? user.email.split('@')[0] : 'User'),
                    joined_at: new Date().toISOString()
                });
                saveLocalAttendees(atts);
            }
            refreshEventsMap();
        }
    }

    // Accept Inquiry
    window._acceptInquiry = async function (inquiryId, eventId) {
        var isRo = (window._currentLang && window._currentLang() === 'ro');
        var inquiries = getLocalInquiries();
        var inq = inquiries.find(function(i) { return i.id === inquiryId; });

        // Also fetch from Supabase if needed
        try {
            if (window.supabaseClient) {
                var res = await window.supabaseClient.from('event_inquiries').select('*').eq('id', inquiryId).single();
                if (!res.error && res.data) inq = res.data;
            }
        } catch (e) {}

        if (!inq) {
            try {
                if (window.supabaseClient) {
                    var resList = await window.supabaseClient.from('event_inquiries').select('*').eq('event_id', eventId);
                    if (!resList.error && resList.data) {
                        inq = resList.data.find(function(i) { return i.id === inquiryId; });
                    }
                }
            } catch (e) {}
        }

        if (!inq) {
            alert(isRo ? 'Cererea nu a fost găsită.' : 'Inquiry not found.');
            return;
        }

        var wasAlreadyAccepted = (inq.status === 'accepted');

        // Check 1-event-per-day rule for the attendee
        var ev = eventsData.find(function(e) { return e.id === eventId; });
        if (ev) {
            if (isEventExpired(ev.event_date)) {
                alert(isRo ? 'Evenimentul a expirat deja.' : 'This event has already expired.');
                await expireEventChat(eventId, true);
                return;
            }
            var conflict = await checkAttendanceConflict(inq.user_id, ev.event_date, eventId);
            if (conflict) {
                alert(conflict);
                return;
            }
        }

        inq.status = 'accepted';

        var attendee = null;
        try {
            if (window.supabaseClient) {
                var existingAttRes = await window.supabaseClient
                    .from('event_attendees')
                    .select('*')
                    .eq('event_id', eventId)
                    .eq('user_id', inq.user_id)
                    .limit(1);
                if (!existingAttRes.error && Array.isArray(existingAttRes.data) && existingAttRes.data[0]) {
                    attendee = existingAttRes.data[0];
                }
            }
        } catch (e) {}

        var isNewAttendee = !attendee;
        if (isNewAttendee) {
            attendee = {
                id: genUuid(),
                event_id: eventId,
                user_id: inq.user_id,
                user_name: inq.user_name,
                joined_at: new Date().toISOString()
            };

            // Attendance quota (public.app_limits.max_events_attending_active),
            // checked before anything is written so the server-side trigger
            // never has to refuse a half-applied acceptance.
            if (window.DetectLabFriends) {
                try {
                    var quota = await window.DetectLabFriends.getEventQuota(true);
                    if (quota && quota.attending >= quota.attendingMax) {
                        alert(eventQuotaMessage('EVENT_ATTENDANCE_LIMIT', quota.attendingMax, isRo));
                        return;
                    }
                } catch (e) {}
            }
        }

        var attendeeInsertError = null;
        try {
            if (window.supabaseClient) {
                var updRes = await window.supabaseClient.from('event_inquiries').update({ status: 'accepted' }).eq('id', inquiryId);
                if (updRes && updRes.error) console.error('Supabase update inquiry status failed:', updRes.error);
                if (!attendee.joined_at) attendee.joined_at = new Date().toISOString();
                if (!attendee.id || attendee.id === inquiryId) attendee.id = genUuid();
                var hasExistingRemoteAttendee = false;
                try {
                    var remoteAttCheck = await window.supabaseClient
                        .from('event_attendees')
                        .select('id')
                        .eq('event_id', eventId)
                        .eq('user_id', inq.user_id)
                        .limit(1);
                    hasExistingRemoteAttendee = !remoteAttCheck.error && Array.isArray(remoteAttCheck.data) && remoteAttCheck.data.length > 0;
                } catch (_) {}
                if (!hasExistingRemoteAttendee) {
                    var attInsRes = await window.supabaseClient.from('event_attendees').insert([attendee]);
                    if (attInsRes && attInsRes.error) {
                        console.error('Supabase insert attendee failed:', attInsRes.error);
                        attendeeInsertError = attInsRes.error;
                    }
                }
            }
        } catch (err) {
            console.error('Supabase accept inquiry error:', err);
            attendeeInsertError = err;
        }

        // Safety net: the DB trigger refused the attendance (quota reached from
        // another device in the meantime). Roll the inquiry back to pending and
        // tell the user instead of pretending they are attending.
        var acceptQuotaCode = eventQuotaCode(attendeeInsertError);
        if (acceptQuotaCode) {
            try {
                if (window.supabaseClient) {
                    await window.supabaseClient.from('event_inquiries').update({ status: 'pending' }).eq('id', inquiryId);
                }
            } catch (e) {}
            var rawAcceptMsg = String((attendeeInsertError && attendeeInsertError.message) || '');
            alert(eventQuotaMessage(acceptQuotaCode, rawAcceptMsg.indexOf(':') !== -1 ? rawAcceptMsg.split(':')[1].trim() : '', isRo));
            return;
        }

        // Update local storage
        var localInqs = getLocalInquiries();
        var inqIdx = localInqs.findIndex(function(i) { return i.id === inquiryId; });
        if (inqIdx !== -1) {
            localInqs[inqIdx].status = 'accepted';
        } else {
            localInqs.push(inq);
        }
        saveLocalInquiries(localInqs);

        var atts = getLocalAttendees();
        var existingLocalAttendeeIdx = atts.findIndex(function(a) {
            return a.event_id === eventId && a.user_id === inq.user_id;
        });
        if (existingLocalAttendeeIdx === -1) {
            atts.push(attendee);
        } else {
            atts[existingLocalAttendeeIdx] = Object.assign({}, atts[existingLocalAttendeeIdx], attendee);
        }
        saveLocalAttendees(atts);

        // Notify the inquiring user their request was accepted so they actually find out.
        // Previously only the creator was notified; the attendee never heard back, and
        // their UI kept showing "Request pending". Guard against double-accept so we do
        // not spam duplicate outcome notifications.
        if (!wasAlreadyAccepted && inq.user_id) {
            try {
                var creatorName = (ev && ev.creator_name) ? ev.creator_name : 'Creator';
                var creatorId = (ev && ev.creator_id) ? ev.creator_id : null;
                var evTitle = (ev && ev.title) ? ev.title : '';
                var acceptMsg = isRo
                    ? '✅ Cererea ta de participare la evenimentul «' + evTitle + '» a fost ACCEPTATĂ. Ai acum acces la chatul evenimentului!'
                    : '✅ Your request to join the event "' + evTitle + '" was ACCEPTED. You now have access to the event chat!';
                await createOutcomeNotification({
                    userId: inq.user_id,
                    eventId: eventId,
                    inquiryId: inquiryId,
                    senderId: creatorId,
                    senderName: creatorName,
                    message: acceptMsg
                });
            } catch (e) {
                console.error('Failed to create acceptance notification:', e);
            }
        }

        await syncEventChatState(eventId);
        loadManageEventDetails(eventId);
        try { if (window._updateEventBadges) window._updateEventBadges(); } catch (e) {}
        alert(isRo ? 'Cerere acceptată! Chat-ul evenimentului a fost creat.' : 'Inquiry accepted! The event chat was created.');
    };

    // Decline Inquiry
    window._declineInquiry = async function (inquiryId) {
        var isRo = (window._currentLang && window._currentLang() === 'ro');
        // Resolve the inquiry so we can notify the inquiring user of the outcome.
        var inq = getLocalInquiries().find(function (i) { return i.id === inquiryId; });
        try {
            if (window.supabaseClient) {
                var res = await window.supabaseClient.from('event_inquiries').select('*').eq('id', inquiryId).single();
                if (!res.error && res.data) inq = res.data;
            }
        } catch (e) {}

        var wasAlreadyDeclined = !!(inq && inq.status === 'declined');

        try {
            if (window.supabaseClient) {
                await window.supabaseClient.from('event_inquiries').update({ status: 'declined' }).eq('id', inquiryId);
            }
        } catch (err) {
            console.error('Supabase decline inquiry error:', err);
        }
        var inquiries = getLocalInquiries();
        var found = false;
        inquiries.forEach(function(i) {
            if (i.id === inquiryId) {
                i.status = 'declined';
                found = true;
            }
        });
        if (!found) {
            inquiries.push({ id: inquiryId, status: 'declined' });
        }
        saveLocalInquiries(inquiries);

        // Notify the inquiring user their request was declined (symmetric with accept).
        if (!wasAlreadyDeclined && inq && inq.user_id) {
            try {
                var evDecl = eventsData.find(function (e) { return e.id === inq.event_id; });
                var declTitle = (evDecl && evDecl.title) ? evDecl.title : '';
                var declMsg = isRo
                    ? '❌ Cererea ta de participare la evenimentul «' + declTitle + '» a fost RESPINSĂ.'
                    : '❌ Your request to join the event "' + declTitle + '" was DECLINED.';
                await createOutcomeNotification({
                    userId: inq.user_id,
                    eventId: inq.event_id || null,
                    inquiryId: inquiryId,
                    senderId: (evDecl && evDecl.creator_id) ? evDecl.creator_id : null,
                    senderName: (evDecl && evDecl.creator_name) ? evDecl.creator_name : 'Creator',
                    message: declMsg
                });
            } catch (e) {
                console.error('Failed to create decline notification:', e);
            }
        }

        var manageModal = document.getElementById('manageEventModal');
        if (manageModal) {
            var activeEventId = manageModal.getAttribute('data-event-id');
            if (activeEventId) loadManageEventDetails(activeEventId);
        }
    };

    // Kick Attendee
    //
    // The kick has to be durable on the SERVER, otherwise it is only a local
    // edit on the creator's device and everyone else — including the kicked
    // user — keeps seeing the old participant list. Three things are required:
    //   1. delete the event_attendees row by (event_id, user_id), not just by
    //      the row id: the id in the creator's list may come from a local cache
    //      and not match the server row, in which case `.eq('id', …)` deletes
    //      nothing and silently "succeeds";
    //   2. also drop the accepted inquiry, or the user is re-added as an
    //      attendee the next time the acceptance is mirrored locally;
    //   3. tell the kicked user, via a notification they pick up on any device.
    window._kickAttendee = async function (attendeeId, eventId) {
        var isRo = (window._currentLang && window._currentLang() === 'ro');
        if (!confirm(isRo ? 'Sigur doriți să dați afară acest participant din eveniment și din chat?' : 'Are you sure you want to kick out this attendee from the event and chat?')) return;

        // Resolve the attendee so we can delete by (event_id, user_id).
        var attendee = getLocalAttendees().find(function (a) {
            return a.id === attendeeId && a.event_id === eventId;
        });
        if (window.supabaseClient) {
            try {
                var lookup = await window.supabaseClient
                    .from('event_attendees').select('*').eq('id', attendeeId).limit(1);
                if (lookup && !lookup.error && Array.isArray(lookup.data) && lookup.data[0]) {
                    attendee = lookup.data[0];
                }
            } catch (e) {}
        }

        if (!attendee || !attendee.user_id) {
            alert(isRo ? 'Participantul nu a putut fi identificat.' : 'Could not identify that attendee.');
            return;
        }

        var removedOnServer = false;
        if (window.supabaseClient) {
            try {
                var delRes = await window.supabaseClient
                    .from('event_attendees')
                    .delete()
                    .eq('event_id', eventId)
                    .eq('user_id', attendee.user_id);
                if (delRes && delRes.error) {
                    console.error('[Events] Failed to remove attendee on the server:', delRes.error);
                } else {
                    removedOnServer = true;
                }
            } catch (err) {
                console.error('[Events] Kick attendee request failed:', err);
            }

            // Withdraw the acceptance so the kick is not undone by a re-sync.
            try {
                await window.supabaseClient
                    .from('event_inquiries')
                    .update({ status: 'declined' })
                    .eq('event_id', eventId)
                    .eq('user_id', attendee.user_id);
            } catch (e) {}
        }

        // Mirror locally (creator's own cache).
        saveLocalAttendees(getLocalAttendees().filter(function (a) {
            return !(a && a.event_id === eventId && a.user_id === attendee.user_id);
        }));
        var localInqs = getLocalInquiries();
        localInqs.forEach(function (i) {
            if (i && i.event_id === eventId && i.user_id === attendee.user_id) i.status = 'declined';
        });
        saveLocalInquiries(localInqs);

        // Let the kicked user know, on whatever device they use next.
        if (removedOnServer) {
            try {
                var evKick = getEventById(eventId);
                var kickTitle = (evKick && evKick.title) ? evKick.title : '';
                await createOutcomeNotification({
                    userId: attendee.user_id,
                    eventId: eventId,
                    inquiryId: null,
                    senderId: (evKick && evKick.creator_id) ? evKick.creator_id : null,
                    senderName: (evKick && evKick.creator_name) ? evKick.creator_name : 'Creator',
                    message: isRo
                        ? '🚫 Ai fost eliminat din evenimentul «' + kickTitle + '» de către organizator.'
                        : '🚫 You were removed from the event "' + kickTitle + '" by the organiser.'
                });
            } catch (e) {
                console.error('Failed to create kick notification:', e);
            }
        }

        await syncEventChatState(eventId);
        refreshEventsMap(true);
        loadManageEventDetails(eventId);
        try { if (window._updateEventBadges) window._updateEventBadges(); } catch (e) {}

        if (window.supabaseClient && !removedOnServer) {
            alert(isRo
                ? '⚠️ Participantul a fost eliminat doar pe acest dispozitiv — serverul a respins operațiunea, deci ceilalți îl vor vedea în continuare. Verifică consola browserului (F12).'
                : '⚠️ The attendee was only removed on this device — the server rejected the change, so others will still see them. Check the browser console (F12).');
        }
    };

    // ── NOTIFICATIONS & WINDOWS NOTIFICATION SYSTEM ──
    async function checkNotifications() {
        var user = getCurrentUser();
        if (!user || !user.id) return;

        var notifs = [];
        try {
            if (window.supabaseClient) {
                var res = await window.supabaseClient.from('event_notifications').select('*').eq('user_id', user.id).eq('read', false).order('created_at', { ascending: false });
                if (!res.error && Array.isArray(res.data)) notifs = res.data;
            }
        } catch (e) {}

        var localUnread = getLocalNotifications().filter(function(n) { return n.user_id === user.id && !n.read; });
        var remoteIds = {};
        notifs.forEach(function(n) { remoteIds[n.id] = true; });
        localUnread.forEach(function(n) { if (!remoteIds[n.id]) notifs.push(n); });

        if (notifs.length > 0) {
            await showNotificationModal(notifs[0]);
        }
    }

    async function showNotificationModal(notif) {
        var existing = document.getElementById('eventNotifModal');
        if (existing) existing.remove();

        var isRo = (window._currentLang && window._currentLang() === 'ro');
        var user = getCurrentUser();

        // Determine the notification kind. Outcome notifications (accepted/declined) are
        // addressed to the inquiring user; incoming requests are addressed to the event
        // creator. We disambiguate by inspecting the related inquiry: if it belongs to the
        // current user and has an outcome status, this is about THEIR request. This needs
        // no schema change and is robust against the deployed DB lagging the latest migration.
        var kind = 'inquiry';
        // Notifications without a related inquiry are purely informational
        // (anonymous-event join announcements, kick-out notices): there is
        // nothing to accept or decline.
        if (!notif.inquiry_id) kind = 'info';
        // "An event was created near you": marked with kind = 'nearby_event'.
        // Deployments whose event_notifications table predates the `kind`
        // column are detected from the message text instead.
        if (notif.kind === 'nearby_event' ||
            (!notif.inquiry_id && notif.event_id &&
             /created near you|creat în apropiere|creat in apropiere/i.test(notif.message || ''))) {
            kind = 'nearby_event';
        }
        // "X te-a invitat la evenimentul Y" — a friend invite created from the
        // "Adaugă prieteni / Add friends" box or from a chat. The invitee
        // decides; nothing is written before they accept. Detected before the
        // inquiry lookup so an already-handled invite still shows its outcome.
        if (notif.kind === 'friend_event_invite') kind = 'friend_event_invite';
        try {
            if (notif.inquiry_id) {
                if (window.supabaseClient) {
                    var inqRes = await window.supabaseClient
                        .from('event_inquiries')
                        .select('id,user_id,status')
                        .eq('id', notif.inquiry_id)
                        .single();
                    if (!inqRes.error && inqRes.data && inqRes.data.user_id === (user && user.id)) {
                        if (inqRes.data.status === 'accepted') kind = 'accepted';
                        else if (inqRes.data.status === 'declined') kind = 'declined';
                    }
                }
                if (kind === 'inquiry' || kind === 'friend_event_invite') {
                    var localInq = getLocalInquiries().find(function (i) { return i.id === notif.inquiry_id; });
                    if (localInq && localInq.user_id === (user && user.id)) {
                        if (localInq.status === 'accepted') kind = 'accepted';
                        else if (localInq.status === 'declined') kind = 'declined';
                    }
                }
            }
        } catch (e) {
            console.warn('showNotificationModal kind lookup failed:', e);
        }

        var modal = document.createElement('div');
        modal.id = 'eventNotifModal';
        modal.style.cssText = 'position: fixed; inset: 0; z-index: 5000; background: rgba(4,10,22,0.85); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 16px;';

        if (kind === 'accepted') {
            // Mirror the acceptance into local state so the attendee's map popup / panels
            // immediately show "Already attending" instead of a stale "Request pending".
            applyAcceptedOutcome(notif);

            modal.innerHTML = '<div style="background: rgba(10,20,42,0.98); border: 1px solid rgba(46,158,79,0.5); border-radius: 12px; width: 100%; max-width: 420px; padding: 20px; color: #F5F0EB; font-family: \'Outfit\', sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,0.7); animation: pwaDropUp 0.3s ease;">' +
                '<div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;"><span style="font-size:1.4rem;">✅</span><h3 style="margin:0; font-size:1.1rem; color:#2E9E4F; font-family:\'Cinzel\',serif;">' + (isRo ? 'Cerere Acceptată' : 'Request Accepted') + '</h3></div>' +
                '<div style="background:rgba(255,255,255,0.05); border:1px solid rgba(184,216,240,0.2); border-radius:6px; padding:10px; font-size:0.84rem; margin-bottom:14px;">' + escapeHtml(notif.message || (isRo ? 'Cererea ta a fost acceptată.' : 'Your request was accepted.')) + '</div>' +
                '<div style="display:flex; gap:10px;"><button type="button" id="notifOpenChatBtn" style="flex:1; background:#0D2B5E; border:1px solid rgba(184,216,240,0.3); border-radius:6px; color:var(--sky); font-weight:600; padding:10px; cursor:pointer;">💬 ' + (isRo ? 'Deschide Chat' : 'Open Chat') + '</button><button type="button" id="notifCloseBtn" style="flex:1; background:rgba(255,255,255,0.1); border:none; border-radius:6px; color:#F5F0EB; font-weight:600; padding:10px; cursor:pointer;">' + (isRo ? 'Închide' : 'Close') + '</button></div>' +
                '</div>';

            document.body.appendChild(modal);

            var dismissAccepted = async function () { await markNotifRead(notif.id); modal.remove(); };
            var openChatBtn = modal.querySelector('#notifOpenChatBtn');
            var closeBtn = modal.querySelector('#notifCloseBtn');
            if (openChatBtn) openChatBtn.addEventListener('click', async function () {
                openChatBtn.disabled = true;
                await markNotifRead(notif.id);
                modal.remove();
                if (notif.event_id && typeof window._openEventChat === 'function') {
                    window._openEventChat(notif.event_id);
                }
            });
            if (closeBtn) closeBtn.addEventListener('click', dismissAccepted);
            modal.addEventListener('click', function (e) { if (e.target === modal) dismissAccepted(); });
            return;
        }

        if (kind === 'friend_event_invite') {
            // A friend ticked this user in the "Adaugă prieteni / Add friends"
            // box (or started the event from their chat): they now have a real
            // participation request to accept or decline.
            var invitedEvent = notif.event_id ? getEventById(notif.event_id) : null;
            if (!invitedEvent && notif.event_id) {
                try { await fetchEvents(); } catch (e) {}
                invitedEvent = getEventById(notif.event_id);
            }
            var inviterName = escapeHtml(notif.sender_name || (isRo ? 'un prieten' : 'a friend'));
            var invitedTitle = escapeHtml((invitedEvent && invitedEvent.title) || (isRo ? 'evenimentul său' : 'their event'));
            var invitedWhen = invitedEvent ? escapeHtml(formatDate(invitedEvent.event_date)) : '';

            modal.innerHTML = '<div style="background: rgba(10,20,42,0.98); border: 1px solid rgba(196,160,240,0.5); border-radius: 12px; width: 100%; max-width: 420px; padding: 20px; color: #F5F0EB; font-family: \'Outfit\', sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,0.7); animation: pwaDropUp 0.3s ease;">' +
                '<div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;"><span style="font-size:1.4rem;">👥</span><h3 style="margin:0; font-size:1.05rem; color:#c4a0f0; font-family:\'Cinzel\',serif;">' + (isRo ? 'Invitație de la un prieten' : 'Invitation from a friend') + '</h3></div>' +
                '<div style="background:rgba(255,255,255,0.05); border:1px solid rgba(184,216,240,0.2); border-radius:6px; padding:10px; font-size:0.84rem; margin-bottom:14px; line-height:1.5;">' +
                    '<strong>' + inviterName + '</strong> ' + (isRo ? 'te-a invitat la evenimentul' : 'invited you to the event') + ' <strong>„' + invitedTitle + '”</strong>' +
                    (invitedWhen ? '<br><span style="opacity:0.75;">🕒 ' + invitedWhen + '</span>' : '') +
                    '<br><span style="opacity:0.7;font-size:0.78rem;">' + (isRo ? 'Dacă accepți, intri în chat-ul evenimentului.' : 'If you accept, you join the event chat.') + '</span>' +
                '</div>' +
                '<div style="display:flex; gap:10px;">' +
                    '<button type="button" id="notifInviteAcceptBtn" style="flex:1; background:#2E9E4F; border:none; border-radius:6px; color:#fff; font-weight:600; padding:10px; cursor:pointer;">' + (isRo ? 'Acceptă' : 'Accept') + '</button>' +
                    '<button type="button" id="notifInviteDeclineBtn" style="flex:1; background:#C42B2B; border:none; border-radius:6px; color:#fff; font-weight:600; padding:10px; cursor:pointer;">' + (isRo ? 'Refuză' : 'Decline') + '</button>' +
                '</div></div>';

            document.body.appendChild(modal);

            var dismissInvite = async function () { await markNotifRead(notif.id); modal.remove(); };
            var inviteAcceptBtn = modal.querySelector('#notifInviteAcceptBtn');
            var inviteDeclineBtn = modal.querySelector('#notifInviteDeclineBtn');
            if (inviteAcceptBtn) inviteAcceptBtn.addEventListener('click', async function () {
                inviteAcceptBtn.disabled = true;
                if (notif.inquiry_id) {
                    await window._acceptInquiry(notif.inquiry_id, notif.event_id);
                }
                await markNotifRead(notif.id);
                modal.remove();
                try { if (window.DetectLabFriends) window.DetectLabFriends.getEventQuota(true); } catch (e) {}
            });
            if (inviteDeclineBtn) inviteDeclineBtn.addEventListener('click', async function () {
                inviteDeclineBtn.disabled = true;
                if (notif.inquiry_id) {
                    await window._declineInquiry(notif.inquiry_id);
                }
                await markNotifRead(notif.id);
                modal.remove();
            });
            modal.addEventListener('click', function (e) { if (e.target === modal) dismissInvite(); });
            return;
        }

        if (kind === 'nearby_event') {
            // "An event was created near you by X" / "Un eveniment a fost creat
            // în apropiere de tine de X" + a button that zooms onto the event.
            var senderName = escapeHtml(notif.sender_name || (isRo ? 'un detectorist' : 'a detectorist'));
            var headline = isRo
                ? 'Un eveniment a fost creat în apropiere de tine de <strong>' + senderName + '</strong>'
                : 'An event was created near you by <strong>' + senderName + '</strong>';

            modal.innerHTML = '<div style="background: rgba(10,20,42,0.98); border: 1px solid rgba(230,168,23,0.45); border-radius: 12px; width: 100%; max-width: 420px; padding: 20px; color: #F5F0EB; font-family: \'Outfit\', sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,0.7); animation: pwaDropUp 0.3s ease;">' +
                '<div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;"><span style="font-size:1.4rem;">📍</span><h3 style="margin:0; font-size:1.1rem; color:#E6A817; font-family:\'Cinzel\',serif;">' + (isRo ? 'Eveniment în apropiere' : 'Event Near You') + '</h3></div>' +
                '<div style="background:rgba(255,255,255,0.05); border:1px solid rgba(184,216,240,0.2); border-radius:6px; padding:10px; font-size:0.86rem; margin-bottom:14px; line-height:1.5;">' + headline + '</div>' +
                '<div style="display:flex; gap:10px;">' +
                '<button type="button" id="notifSeeEventBtn" style="flex:1; background:#E6A817; border:none; border-radius:6px; color:#182126; font-weight:700; padding:10px; cursor:pointer;">🔍 ' + (isRo ? 'Vezi evenimentul' : 'See event') + '</button>' +
                '<button type="button" id="notifCloseBtn" style="background:rgba(255,255,255,0.1); border:none; border-radius:6px; color:#F5F0EB; font-weight:600; padding:10px 14px; cursor:pointer;">' + (isRo ? 'Închide' : 'Close') + '</button>' +
                '</div></div>';

            document.body.appendChild(modal);

            var dismissNearby = async function () { await markNotifRead(notif.id); modal.remove(); };
            var closeNearbyBtn = modal.querySelector('#notifCloseBtn');
            if (closeNearbyBtn) closeNearbyBtn.addEventListener('click', dismissNearby);
            var seeBtn = modal.querySelector('#notifSeeEventBtn');
            if (seeBtn) seeBtn.addEventListener('click', async function () {
                seeBtn.disabled = true;
                await markNotifRead(notif.id);
                modal.remove();
                // The event may not be in the local cache yet on a fresh device.
                if (!getEventById(notif.event_id)) {
                    try { await fetchEvents(); } catch (e) {}
                }
                var zoomed = window._zoomToEvent(notif.event_id);
                if (!zoomed) {
                    alert(isRo
                        ? 'Evenimentul nu mai este disponibil.'
                        : 'This event is no longer available.');
                }
            });
            modal.addEventListener('click', function (e) { if (e.target === modal) dismissNearby(); });
            return;
        }

        if (kind === 'info') {
            modal.innerHTML = '<div style="background: rgba(10,20,42,0.98); border: 1px solid rgba(184,216,240,0.3); border-radius: 12px; width: 100%; max-width: 420px; padding: 20px; color: #F5F0EB; font-family: \'Outfit\', sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,0.7); animation: pwaDropUp 0.3s ease;">' +
                '<div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;"><span style="font-size:1.4rem;">🔔</span><h3 style="margin:0; font-size:1.1rem; color:var(--sky); font-family:\'Cinzel\',serif;">' + (isRo ? 'Notificare Eveniment' : 'Event Notification') + '</h3></div>' +
                '<div style="background:rgba(255,255,255,0.05); border:1px solid rgba(184,216,240,0.2); border-radius:6px; padding:10px; font-size:0.84rem; margin-bottom:14px;">' + escapeHtml(notif.message || '') + '</div>' +
                '<div style="display:flex; gap:10px;">' +
                (notif.event_id ? '<button type="button" id="notifInfoManageBtn" style="flex:1; background:#0D2B5E; border:1px solid rgba(184,216,240,0.3); border-radius:6px; color:var(--sky); font-weight:600; padding:10px; cursor:pointer;">' + (isRo ? 'Vezi Evenimentul' : 'View Event') + '</button>' : '') +
                '<button type="button" id="notifCloseBtn" style="flex:1; background:rgba(255,255,255,0.1); border:none; border-radius:6px; color:#F5F0EB; font-weight:600; padding:10px; cursor:pointer;">' + (isRo ? 'Închide' : 'Close') + '</button></div>' +
                '</div>';

            document.body.appendChild(modal);
            var dismissInfo = async function () { await markNotifRead(notif.id); modal.remove(); };
            var closeBtnInfo = modal.querySelector('#notifCloseBtn');
            if (closeBtnInfo) closeBtnInfo.addEventListener('click', dismissInfo);
            var manageBtnInfo = modal.querySelector('#notifInfoManageBtn');
            if (manageBtnInfo) manageBtnInfo.addEventListener('click', async function () {
                manageBtnInfo.disabled = true;
                await markNotifRead(notif.id);
                modal.remove();
                var evInfo = getEventById(notif.event_id);
                var userInfo = getCurrentUser();
                if (evInfo && isEventOwnedByUser(evInfo, userInfo) && typeof window._manageEvent === 'function') {
                    window._manageEvent(notif.event_id);
                } else if (typeof window._openEventChat === 'function') {
                    window._openEventChat(notif.event_id);
                }
            });
            modal.addEventListener('click', function (e) { if (e.target === modal) dismissInfo(); });
            return;
        }

        if (kind === 'declined') {
            modal.innerHTML = '<div style="background: rgba(10,20,42,0.98); border: 1px solid rgba(196,43,43,0.5); border-radius: 12px; width: 100%; max-width: 420px; padding: 20px; color: #F5F0EB; font-family: \'Outfit\', sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,0.7); animation: pwaDropUp 0.3s ease;">' +
                '<div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;"><span style="font-size:1.4rem;">❌</span><h3 style="margin:0; font-size:1.1rem; color:#ff8a8a; font-family:\'Cinzel\',serif;">' + (isRo ? 'Cerere Respinsă' : 'Request Declined') + '</h3></div>' +
                '<div style="background:rgba(255,255,255,0.05); border:1px solid rgba(184,216,240,0.2); border-radius:6px; padding:10px; font-size:0.84rem; margin-bottom:14px;">' + escapeHtml(notif.message || (isRo ? 'Cererea ta a fost respinsă.' : 'Your request was declined.')) + '</div>' +
                '<div style="display:flex; gap:10px;"><button type="button" id="notifCloseBtn" style="flex:1; background:rgba(255,255,255,0.1); border:none; border-radius:6px; color:#F5F0EB; font-weight:600; padding:10px; cursor:pointer;">' + (isRo ? 'Închide' : 'Close') + '</button></div>' +
                '</div>';

            document.body.appendChild(modal);
            var dismissDeclined = async function () { await markNotifRead(notif.id); modal.remove(); };
            var closeBtn2 = modal.querySelector('#notifCloseBtn');
            if (closeBtn2) closeBtn2.addEventListener('click', dismissDeclined);
            modal.addEventListener('click', function (e) { if (e.target === modal) dismissDeclined(); });
            return;
        }

        // Default: incoming attendance request (creator view) — existing behaviour
        modal.innerHTML = '<div style="background: rgba(10,20,42,0.98); border: 1px solid rgba(184,216,240,0.3); border-radius: 12px; width: 100%; max-width: 420px; padding: 20px; color: #F5F0EB; font-family: \'Outfit\', sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,0.7); animation: pwaDropUp 0.3s ease;">' +
            '<div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;"><span style="font-size:1.4rem;">🔔</span><h3 style="margin:0; font-size:1.1rem; color:var(--sky); font-family:\'Cinzel\',serif;">' + (isRo ? 'Cerere Nouă de Participare' : 'New Attendance Inquiry') + '</h3></div>' +
            '<div style="font-size:0.85rem; margin-bottom:8px;"><strong>' + escapeHtml(notif.sender_name) + '</strong> ' + (isRo ? 'vrea să participe la evenimentul tău:' : 'wants to attend your event:') + '</div>' +
            '<div style="background:rgba(255,255,255,0.05); border:1px solid rgba(184,216,240,0.2); border-radius:6px; padding:10px; font-size:0.82rem; font-style:italic; margin-bottom:14px;">"' + escapeHtml(notif.message || '') + '"</div>' +
            '<div style="display:flex; gap:10px;"><button type="button" id="notifAcceptBtn" style="flex:1; background:#2E9E4F; border:none; border-radius:6px; color:#fff; font-weight:600; padding:10px; cursor:pointer;">' + (isRo ? 'Acceptă / Accept' : 'Accept') + '</button><button type="button" id="notifDeclineBtn" style="flex:1; background:#C42B2B; border:none; border-radius:6px; color:#fff; font-weight:600; padding:10px; cursor:pointer;">' + (isRo ? 'Respinge / Decline' : 'Decline') + '</button></div>' +
            '</div>';

        document.body.appendChild(modal);

        modal.querySelector('#notifAcceptBtn').addEventListener('click', async function () {
            var btn = modal.querySelector('#notifAcceptBtn');
            if (btn) btn.disabled = true;
            if (notif.inquiry_id) {
                await window._acceptInquiry(notif.inquiry_id, notif.event_id);
            }
            await markNotifRead(notif.id);
            modal.remove();
        });

        modal.querySelector('#notifDeclineBtn').addEventListener('click', async function () {
            var btn = modal.querySelector('#notifDeclineBtn');
            if (btn) btn.disabled = true;
            if (notif.inquiry_id) {
                await window._declineInquiry(notif.inquiry_id);
            }
            await markNotifRead(notif.id);
            modal.remove();
        });
    }

    async function markNotifRead(notifId) {
        try {
            if (window.supabaseClient) {
                await window.supabaseClient.from('event_notifications').update({ read: true }).eq('id', notifId);
            }
        } catch (e) {}
        var notifs = getLocalNotifications();
        notifs.forEach(function(n) { if (n.id === notifId) n.read = true; });
        saveLocalNotifications(notifs);
    }


    // ── BADGE / UNREAD CHAT SYSTEM ──
    function ensureEventBadges() {
        try {
            var navTrigger = document.querySelector('#navUser .user-trigger');
            if (navTrigger) {
                navTrigger.style.position = 'relative';
                if (!document.getElementById('navUserBadge')) {
                    var b = document.createElement('span');
                    b.id = 'navUserBadge';
                    b.className = 'event-notif-badge hidden';
                    b.textContent = '0';
                    navTrigger.appendChild(b);
                }
            }
            var userMenu = document.getElementById('userMenu');
            if (userMenu) {
                var btns = userMenu.querySelectorAll('button');
                for (var i = 0; i < btns.length; i++) {
                    var btn = btns[i];
                    var onclick = btn.getAttribute('onclick') || '';
                    var txt = (btn.textContent || '').toLowerCase();
                    if (onclick.indexOf('openEvents') !== -1 || txt.indexOf('eveniment') !== -1 || txt.indexOf('event') !== -1) {
                        if (txt.indexOf('eveniment') !== -1 || txt.indexOf('event') !== -1) {
                            btn.style.position = 'relative';
                            if (!btn.querySelector('#navEventsBadge')) {
                                var b2 = document.createElement('span');
                                b2.id = 'navEventsBadge';
                                b2.className = 'event-notif-badge hidden';
                                b2.textContent = '0';
                                btn.appendChild(b2);
                            }
                        }
                    }
                }
            }
            var pwaTrigger = document.getElementById('pwaUserTrigger');
            if (pwaTrigger) {
                pwaTrigger.style.position = 'relative';
                if (!document.getElementById('pwaUserBadge')) {
                    var b3 = document.createElement('span');
                    b3.id = 'pwaUserBadge';
                    b3.className = 'event-notif-badge hidden';
                    b3.textContent = '0';
                    pwaTrigger.appendChild(b3);
                }
            }
            var pwaDrop = document.getElementById('pwaUserDropdown');
            if (pwaDrop) {
                var pwaBtns = pwaDrop.querySelectorAll('button');
                for (var j = 0; j < pwaBtns.length; j++) {
                    var pb = pwaBtns[j];
                    var pon = pb.getAttribute('onclick') || '';
                    if (pon.indexOf('openEvents') !== -1) {
                        pb.style.position = 'relative';
                        if (!pb.querySelector('#pwaEventsBadge')) {
                            var b4 = document.createElement('span');
                            b4.id = 'pwaEventsBadge';
                            b4.className = 'event-notif-badge hidden';
                            b4.textContent = '0';
                            pb.appendChild(b4);
                        }
                    }
                }
            }
        } catch (e) { console.warn('ensureEventBadges error', e); }
    }

    async function getMyParticipatingEventIds() {
        var user = getCurrentUser();
        if (!user || !user.id) return [];
        var ids = {};
        var allEvs = eventsData.slice();
        getLocalEvents().forEach(function(ev){ if (!allEvs.some(function(x){return x.id===ev.id;})) allEvs.push(ev); });
        allEvs.forEach(function(ev){
            if (ev.creator_id === user.id || (user.email && ev.creator_email && user.email === ev.creator_email)) {
                ids[ev.id] = true;
            }
        });
        var remoteAttendanceOk = false;
        try {
            if (window.supabaseClient) {
                var res = await window.supabaseClient.from('event_attendees').select('*').eq('user_id', user.id);
                if (!res.error && Array.isArray(res.data)) {
                    remoteAttendanceOk = true;
                    // Reconcile first, so an event this user was kicked out of is
                    // dropped from the cache instead of being OR-ed back in below.
                    var removed = reconcileLocalAttendanceForUser(user.id, res.data);
                    if (removed.length > 0) handleAttendanceRemovals(removed);
                    res.data.forEach(function(a){ if (a.event_id) ids[a.event_id]=true; });
                }
            }
        } catch (e) {}

        getLocalAttendees().forEach(function(a){
            if (a.user_id !== user.id || !a.event_id) return;
            // When the server answered, it already told us the full list; only
            // add cached rows it could not have known about (local-only events).
            if (remoteAttendanceOk && canTrustServerFor(a.event_id)) return;
            ids[a.event_id] = true;
        });

        // Never list events that no longer exist on the server.
        return Object.keys(ids).filter(function (id) {
            if (serverReachable && serverEventIds && !serverEventIds[id]) {
                return !!getLocalEvents().some(function (e) {
                    return e && e.id === id && !getSyncedEventIds()[id];
                });
            }
            return true;
        });
    }

    async function fetchChatMessagesForBadge(eventId) {
        var msgs = [];
        try {
            if (window.supabaseClient) {
                var res = await window.supabaseClient.from('event_chat_messages').select('user_id,created_at').eq('event_id', eventId).order('created_at', {ascending:false}).limit(10);
                if (!res.error && Array.isArray(res.data) && res.data.length>0) msgs = res.data;
            }
        } catch (e) {}
        if (msgs.length===0) {
            var local = getLocalMessages().filter(function(m){ return m.event_id===eventId; });
            local.sort(function(a,b){ return new Date(b.created_at)-new Date(a.created_at); });
            msgs = local.slice(0,10);
        }
        return msgs;
    }

    async function getUnreadChatInfos() {
        var user = getCurrentUser();
        if (!user || !user.id) return [];
        var myIds = await getMyParticipatingEventIds();
        if (myIds.length===0) return [];
        var activeChats = await fetchActiveEventChats(myIds);
        var unread = [];
        for (var i=0;i<activeChats.length;i++) {
            var chat = activeChats[i];
            var ev = getEventById(chat.event_id);
            if (!ev || isEventExpired(ev.event_date)) continue;
            var lastSeen = getLastSeen(chat.event_id);
            if (!lastSeen) {
                unread.push(chat);
                continue;
            }
            try {
                var msgs = await fetchChatMessagesForBadge(chat.event_id);
                var lastSeenTime = new Date(lastSeen).getTime();
                for (var m=0;m<msgs.length;m++) {
                    var msg = msgs[m];
                    if (!msg) continue;
                    if (msg.user_id && msg.user_id === user.id) continue;
                    var msgTime = new Date(msg.created_at).getTime();
                    if (msgTime > lastSeenTime) { unread.push(chat); break; }
                }
            } catch (e) {}
        }
        return unread;
    }

    async function updateEventBadges() {
        ensureEventBadges();
        // The two badges that sit ON THE PROFILE BUTTON (desktop pill +
        // PWA trigger) are shared with the social layer: js/friends.js feeds
        // 'social' (pending friend requests + unread chats) into the very same
        // elements through window.DetectLabNotify, so both counts are summed
        // there instead of overwriting each other. Every other badge stays
        // event-only and is painted directly.
        var PROFILE_BADGE_IDS = ['navUserBadge','pwaUserBadge'];
        var EVENT_BADGE_IDS = ['navEventsBadge','pwaEventsBadge','calChatsBadge'];

        function paintBadge(id, n) {
            var el = document.getElementById(id);
            if (!el) return;
            var count = Number(n) || 0;
            if (count > 0) {
                el.textContent = count > 99 ? '99+' : String(count);
                el.classList.remove('hidden');
                el.classList.add('pulse');
            } else {
                el.textContent = '0';
                el.classList.add('hidden');
                el.classList.remove('pulse');
            }
        }

        function paint(count) {
            var notify = window.DetectLabNotify;
            if (notify && typeof notify.setSourceCount === 'function') {
                notify.setSourceCount('events', count);
            } else {
                PROFILE_BADGE_IDS.forEach(function(id){ paintBadge(id, count); });
            }
            EVENT_BADGE_IDS.forEach(function(id){ paintBadge(id, count); });
        }

        var user = getCurrentUser();
        if (!user || !user.id) {
            paint(0);
            return 0;
        }
        var unreadChats = [];
        try { unreadChats = await getUnreadChatInfos(); } catch (e) { console.warn('getUnreadChatInfos failed', e); }
        var count = unreadChats.length;

        try {
            if (count===0) {
                var notifs = getLocalNotifications().filter(function(n){ return n.user_id===user.id && !n.read; });
                if (window.supabaseClient) {
                    try {
                        var res = await window.supabaseClient.from('event_notifications').select('id,inquiry_id,event_id').eq('user_id', user.id).eq('read', false);
                        if (!res.error && Array.isArray(res.data)) {
                            res.data.forEach(function(r){ if (!notifs.some(function(nn){return nn.id===r.id;})) notifs.push(r); });
                        }
                    } catch (ee){}
                }
                for (var ni=0; ni<notifs.length; ni++) {
                    var nn = notifs[ni];
                    if (!nn.inquiry_id) continue;
                    var localInq = getLocalInquiries().find(function(ix){return ix.id===nn.inquiry_id;});
                    if (localInq && localInq.status==='accepted' && localInq.user_id===user.id) { count++; break; }
                }
            }
        } catch (e) {}

        paint(count);
        var chatsBtnCount = document.getElementById('calChatsCount');
        if (chatsBtnCount) chatsBtnCount.textContent = count>0 ? '('+count+')' : '';
        return count;
    }

    window._updateEventBadges = updateEventBadges;

    // ── CALENDAR STATE ──
    var calCurrent = new Date();
    var calSelectedDateStr = null;
    var calViewMode = 'calendar';

    function formatYMD(d) {
        var yyyy = d.getFullYear();
        var mm = String(d.getMonth()+1).padStart(2,'0');
        var dd = String(d.getDate()).padStart(2,'0');
        return yyyy+'-'+mm+'-'+dd;
    }

    function getAttendingMap() {
        var user = getCurrentUser();
        var map = {};
        if (!user) return map;
        var allEvs = eventsData.slice();
        getLocalEvents().forEach(function(ev){ if (!allEvs.some(function(x){return x.id===ev.id;})) allEvs.push(ev); });
        var attendingIds = {};
        try {
            getLocalAttendees().forEach(function(a){ if (a.user_id===user.id) attendingIds[a.event_id]=true; });
        } catch(e){}
        allEvs.forEach(function(ev){
            var isCreator = ev.creator_id===user.id || (user.email && ev.creator_email && user.email===ev.creator_email);
            var isAttendee = !!attendingIds[ev.id];
            if (!isCreator && !isAttendee) return;
            if (isEventExpired(ev.event_date)) return;
            var ds = getDateString(ev.event_date);
            if (!ds) return;
            if (!map[ds]) map[ds]=[];
            map[ds].push(ev);
        });
        return map;
    }

    async function getAttendingMapAsync() {
        var user = getCurrentUser();
        var map = {};
        if (!user) return map;
        var myIds = await getMyParticipatingEventIds();
        var allEvs = eventsData.slice();
        getLocalEvents().forEach(function(ev){ if (!allEvs.some(function(x){return x.id===ev.id;})) allEvs.push(ev); });
        var wanted = {};
        myIds.forEach(function(id){ wanted[id]=true; });
        allEvs.forEach(function(ev){
            if (!wanted[ev.id]) return;
            if (isEventExpired(ev.event_date)) return;
            var ds = getDateString(ev.event_date);
            if (!ds) return;
            if (!map[ds]) map[ds]=[];
            map[ds].push(ev);
        });
        return map;
    }

    function renderCalendar(attendingMap) {
        var grid = document.getElementById('calGrid');
        var titleEl = document.getElementById('calMonthTitle');
        if (!grid) return;
        var isRo = (window._currentLang && window._currentLang() === 'ro');
        var year = calCurrent.getFullYear();
        var month = calCurrent.getMonth();
        var firstDay = new Date(year, month, 1);
        var rawDow = firstDay.getDay();
        var leading = (rawDow + 6) % 7;
        var daysInMonth = new Date(year, month+1, 0).getDate();
        var daysInPrev = new Date(year, month, 0).getDate();
        var todayStr = formatYMD(new Date());

        if (titleEl) {
            try {
                titleEl.textContent = firstDay.toLocaleDateString(isRo ? 'ro-RO' : 'en-US', { month:'long', year:'numeric' });
            } catch(e) { titleEl.textContent = (month+1)+'/'+year; }
        }

        var html = '';
        for (var i=0;i<42;i++) {
            var dayNum, dateObj, isOther=false;
            if (i < leading) {
                dayNum = daysInPrev - leading + 1 + i;
                dateObj = new Date(year, month-1, dayNum);
                isOther=true;
            } else if (i >= leading+daysInMonth) {
                dayNum = i - (leading+daysInMonth) + 1;
                dateObj = new Date(year, month+1, dayNum);
                isOther=true;
            } else {
                dayNum = i - leading + 1;
                dateObj = new Date(year, month, dayNum);
            }
            var ds = formatYMD(dateObj);
            var has = attendingMap && attendingMap[ds] && attendingMap[ds].length>0;
            var isToday = ds===todayStr;
            var isSelected = calSelectedDateStr && ds===calSelectedDateStr;
            var cls = 'cal-day';
            if (isOther) cls+=' other-month';
            if (isToday) cls+=' today';
            if (has) cls+=' has-event attending';
            if (isSelected) cls+=' selected';
            var countBadge = '';
            if (has) {
                var cnt = attendingMap[ds].length;
                if (cnt>1) countBadge='<span class="cal-day-count">'+cnt+'</span>';
            }
            html += '<div class="'+cls+'" data-date="'+ds+'" onclick="window._calSelectDate(\''+ds+'\')"><span class="cal-day-num">'+dayNum+'</span>'+countBadge+'</div>';
        }
        grid.innerHTML = html;
        renderSelectedDayEvents(attendingMap);
    }

    function renderSelectedDayEvents(attendingMap) {
        var cont = document.getElementById('calSelectedEvents');
        if (!cont) return;
        var isRo = (window._currentLang && window._currentLang() === 'ro');
        var sel = calSelectedDateStr;
        if (!sel) {
            var all = [];
            Object.keys(attendingMap).forEach(function(ds){ attendingMap[ds].forEach(function(ev){ all.push(ev); }); });
            all.sort(function(a,b){ return new Date(a.event_date)-new Date(b.event_date); });
            var upcoming = all.slice(0,6);
            if (upcoming.length===0) {
                cont.innerHTML = '<div class="cal-selected-title">'+(isRo?'Selectează o zi cu eveniment':'Select a day with events')+'</div><div style="font-size:0.78rem;opacity:0.6;">'+(isRo?'Nu participi la evenimente viitoare.':'You are not attending upcoming events.')+'</div>';
                return;
            }
            var html = '<div class="cal-selected-title"><span>'+(isRo?'Evenimentele tale viitoare':'Your upcoming events')+'</span><span style="font-size:0.7rem;opacity:0.6;">'+upcoming.length+'</span></div>';
            upcoming.forEach(function(ev){
                html += '<div class="cal-event-card"><div class="cec-title">'+escapeHtml(ev.title)+'</div><div class="cec-meta">📅 '+formatDate(ev.event_date)+' • 👤 '+escapeHtml(ev.creator_name||'User')+'</div><div style="display:flex;gap:8px;margin-top:6px;"><button type="button" onclick="window._openEventChat(\''+ev.id+'\')" style="flex:1;background:#0D2B5E;border:1px solid rgba(184,216,240,0.3);border-radius:6px;color:var(--sky);padding:6px 10px;font-size:0.75rem;cursor:pointer;font-weight:600;">💬 '+(isRo?'Chat':'Chat')+'</button><button type="button" onclick="window._manageEvent(\''+ev.id+'\')" style="background:rgba(255,255,255,0.08);border:1px solid rgba(184,216,240,0.18);border-radius:6px;color:rgba(245,240,235,0.85);padding:6px 10px;font-size:0.72rem;cursor:pointer;">'+(isRo?'Detalii':'Details')+'</button></div></div>';
            });
            cont.innerHTML = html;
            return;
        }
        var eventsOnDay = (attendingMap && attendingMap[sel]) ? attendingMap[sel] : [];
        if (eventsOnDay.length===0) {
            cont.innerHTML = '<div class="cal-selected-title"><span>📅 '+sel+'</span></div><div style="font-size:0.78rem;opacity:0.6;">'+(isRo?'Niciun eveniment în această zi.':'No events on this day.')+'</div>';
            return;
        }
        var h = '<div class="cal-selected-title"><span>📅 '+sel+'</span><span style="font-size:0.7rem;opacity:0.6;">'+eventsOnDay.length+' '+(isRo?'evenimente':'events')+'</span></div>';
        eventsOnDay.forEach(function(ev){
            h += '<div class="cal-event-card"><div class="cec-title">'+escapeHtml(ev.title)+'</div><div class="cec-meta">'+escapeHtml(ev.description||'')+'</div><div class="cec-meta" style="margin-top:2px;">🕒 '+formatDate(ev.event_date)+'</div><div style="display:flex;gap:8px;margin-top:8px;"><button type="button" onclick="window._openEventChat(\''+ev.id+'\')" style="flex:1;background:#0D2B5E;border:1px solid rgba(184,216,240,0.3);border-radius:6px;color:var(--sky);padding:6px 10px;font-size:0.75rem;cursor:pointer;font-weight:600;">💬 '+(isRo?'Deschide Chat':'Open Chat')+'</button><button type="button" onclick="window._manageEvent(\''+ev.id+'\')" style="background:rgba(255,255,255,0.08);border:1px solid rgba(184,216,240,0.18);border-radius:6px;color:rgba(245,240,235,0.85);padding:6px 10px;font-size:0.72rem;cursor:pointer;">'+(isRo?'Gestionează':'Manage')+'</button></div></div>';
        });
        cont.innerHTML = h;
    }

    window._calSelectDate = function(dateStr) {
        calSelectedDateStr = dateStr;
        getAttendingMapAsync().then(function(map){ renderCalendar(map); }).catch(function(){ renderCalendar(getAttendingMap()); });
    };
    window._calPrevMonth = function() {
        calCurrent.setMonth(calCurrent.getMonth()-1);
        getAttendingMapAsync().then(function(map){ renderCalendar(map); }).catch(function(){ renderCalendar(getAttendingMap()); });
    };
    window._calNextMonth = function() {
        calCurrent.setMonth(calCurrent.getMonth()+1);
        getAttendingMapAsync().then(function(map){ renderCalendar(map); }).catch(function(){ renderCalendar(getAttendingMap()); });
    };
    window._calToday = function() {
        calCurrent = new Date();
        calSelectedDateStr = formatYMD(new Date());
        getAttendingMapAsync().then(function(map){ renderCalendar(map); }).catch(function(){ renderCalendar(getAttendingMap()); });
    };

    async function renderChatsView() {
        var isRo = (window._currentLang && window._currentLang() === 'ro');
        var listEl = document.getElementById('calChatsList');
        if (!listEl) return;
        listEl.innerHTML = '<div style="font-size:0.8rem;opacity:0.6;">'+(isRo?'Se încarcă chat-urile…':'Loading chats…')+'</div>';
        var user = getCurrentUser();
        if (!user) { listEl.innerHTML = '<div style="font-size:0.8rem;opacity:0.6;">Login required</div>'; return; }
        await fetchEvents();
        await maybeCleanupExpiredEventChats();
        var myIds = await getMyParticipatingEventIds();
        if (myIds.length===0) { listEl.innerHTML = '<div style="font-size:0.8rem;opacity:0.6;">'+(isRo?'Nu participi la niciun chat':'You are not in any chat')+'</div>'; return; }
        var activeChats = await fetchActiveEventChats(myIds);
        var attendeeCounts = await fetchAttendeeCounts(myIds);
        for (var i=0;i<myIds.length;i++) {
            var eid = myIds[i];
            var ev = getEventById(eid);
            if (!ev || isEventExpired(ev.event_date)) continue;
            if ((attendeeCounts[eid]||0)>=1) {
                var exists = activeChats.some(function(c){return c.event_id===eid;});
                if (!exists) {
                    var ensured = await ensureEventChatExists(ev, attendeeCounts[eid]);
                    if (ensured) activeChats.push(ensured);
                }
            }
        }
        if (activeChats.length===0) {
            listEl.innerHTML = '<div style="font-size:0.8rem;opacity:0.6;">'+(isRo?'Nu există chat-uri active.':'No active chats.')+'</div>';
            return;
        }
        activeChats.sort(function(a,b){ return new Date(b.expires_at)-new Date(a.expires_at); });
        var html='';
        var lastSeenMap = getChatLastSeenMap();
        for (var j=0;j<activeChats.length;j++) {
            var chat = activeChats[j];
            var ev2 = getEventById(chat.event_id);
            if (!ev2) continue;
            var ls = lastSeenMap[chat.event_id];
            var isUnread = !ls;
            html += '<div class="cal-chat-card" style="'+(isUnread?'border-color:rgba(196,43,43,0.55);background:rgba(196,43,43,0.08);':'')+'"><div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:0.92rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+escapeHtml(ev2.title)+'</div><div style="font-size:0.72rem;opacity:0.7;">📅 '+formatDate(ev2.event_date)+' • '+ (attendeeCounts[ev2.id]||0) +' '+(isRo?'participanți':'attendees')+'</div>'+(isUnread?'<div style="font-size:0.68rem;color:#ff8a8a;font-weight:700;margin-top:3px;">● '+(isRo?'Nou / necitit':'New / unread')+'</div>':'')+'</div><div style="display:flex;flex-direction:column;gap:6px;"><button type="button" onclick="window._openEventChat(\''+ev2.id+'\')" style="background:#0D2B5E;border:1px solid rgba(184,216,240,0.3);border-radius:6px;color:var(--sky);padding:6px 12px;font-size:0.75rem;cursor:pointer;font-weight:600;white-space:nowrap;">💬 '+(isRo?'Deschide':'Open')+'</button></div></div>';
        }
        listEl.innerHTML = html;
    }

    // ── NEW EVENTS PANEL WITH CALENDAR ──
    window.openEvents = async function () {
        var menu = document.getElementById('userMenu');
        if (menu) menu.classList.add('hidden');
        var pwaDropdowns = document.querySelectorAll('#pwa-br-stack .pwa-dropdown');
        pwaDropdowns.forEach(function(dd){ dd.classList.remove('open'); });
        var pwaTriggers = document.querySelectorAll('#pwa-br-stack .pwa-bar-trigger');
        pwaTriggers.forEach(function(tr){ tr.classList.remove('active'); });

        var user = getCurrentUser();
        if (!user) {
            if (typeof window.openAuth === 'function') window.openAuth('login');
            return;
        }

        var existing = document.getElementById('eventsManagerPanel');
        if (existing) existing.remove();

        var isRo = (window._currentLang && window._currentLang() === 'ro');

        var panel = document.createElement('div');
        panel.id = 'eventsManagerPanel';

        panel.innerHTML =
            '<div class="cal-wrap">'+
                '<div class="cal-header-row">'+
                    '<button class="cal-back-btn" onclick="document.getElementById(\'eventsManagerPanel\').remove()">← '+(isRo?'Înapoi la hartă':'Back to map')+'</button>'+
                    '<button class="cal-back-btn" onclick="window._calToday()" style="font-size:0.78rem;opacity:0.85;">'+(isRo?'Astăzi':'Today')+'</button>'+
                '</div>'+
                '<h2 class="cal-title">'+(isRo?'Evenimente':'Events')+'</h2>'+

                '<div id="calView">'+
                    '<div class="cal-header-row" style="margin-top:6px;">'+
                        '<div class="cal-title" id="calMonthTitle" style="font-size:1.05rem;"></div>'+
                        '<div class="cal-nav"><button type="button" onclick="window._calPrevMonth()">‹</button><button type="button" onclick="window._calNextMonth()">›</button></div>'+
                    '</div>'+
                    '<div class="cal-weekdays"><span>'+(isRo?'Lun':'Mon')+'</span><span>Mar</span><span>Mie</span><span>Joi</span><span>Vin</span><span>Sâm</span><span>Dum</span></div>'+
                    '<div class="cal-grid" id="calGrid"></div>'+
                    '<div class="cal-selected-events" id="calSelectedEvents"><div style="font-size:0.8rem;opacity:0.6;">'+(isRo?'Se încarcă evenimentele…':'Loading events…')+'</div></div>'+
                    '<div class="cal-footer">'+
                        '<button class="cal-chats-btn" id="calChatsBtn" type="button" onclick="window._openChatsFromCalendar()"><span>💬 '+(isRo?'Chat-uri Evenimente':'Event Chats')+'</span><span id="calChatsCount" style="opacity:0.9;font-size:0.8rem;"></span><span class="event-notif-badge hidden" id="calChatsBadge">0</span></button>'+
                        '<div class="anon-join-bar">'+
                            '<div class="anon-join-label">🕶 '+(isRo?'Participă la un eveniment anonim':'Join an anonymous event')+'</div>'+
                            '<div class="anon-join-row">'+
                                '<div class="anon-join-input-wrap">'+
                                    '<span class="anon-join-icon">🔍</span>'+
                                    '<input type="text" class="anon-join-input" id="anonJoinInput" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="'+(isRo?'Introdu codul evenimentului…':'Enter the event code…')+'">'+
                                '</div>'+
                                '<button type="button" class="anon-join-btn" id="anonJoinBtn">'+(isRo?'PARTICIPĂ':'JOIN')+'</button>'+
                            '</div>'+
                            '<div class="anon-join-error" id="anonJoinError"></div>'+
                        '</div>'+
                    '</div>'+
                '</div>'+

                '<div id="calChatsView" style="display:none;">'+
                    '<div class="cal-header-row"><button class="cal-back-btn" onclick="window._backToCalendarView()">← '+(isRo?'Înapoi la calendar':'Back to calendar')+'</button></div>'+
                    '<h3 style="font-size:1.1rem;color:var(--sky);margin:4px 0 8px;font-family:Cinzel,serif;">💬 '+(isRo?'Chat-uri Evenimente':'Event Chats')+'</h3>'+
                    '<div class="cal-chats-list" id="calChatsList"></div>'+
                    '<div style="margin-top:14px;"><button class="cal-chats-btn" type="button" onclick="window._backToCalendarView()" style="background:rgba(255,255,255,0.06);border-color:rgba(184,216,240,0.18);">← '+(isRo?'Înapoi la calendar':'Back to calendar')+'</button></div>'+
                '</div>'+

            '</div>';

        document.body.appendChild(panel);
        calCurrent = new Date();
        calSelectedDateStr = formatYMD(new Date());
        calViewMode = 'calendar';

        // Join an anonymous event bar
        var anonJoinBtn = document.getElementById('anonJoinBtn');
        var anonJoinInput = document.getElementById('anonJoinInput');
        if (anonJoinBtn) anonJoinBtn.addEventListener('click', function () { window._joinAnonymousEvent(); });
        if (anonJoinInput) {
            anonJoinInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') window._joinAnonymousEvent();
            });
            anonJoinInput.addEventListener('input', function () {
                var errEl = document.getElementById('anonJoinError');
                if (errEl) errEl.textContent = '';
            });
        }

        try {
            await fetchEvents();
            await syncMyEventStateFromServer();
            await maybeCleanupExpiredEventChats();
            var attendingMap = await getAttendingMapAsync();
            renderCalendar(attendingMap);
            await updateEventBadges();
        } catch (e) {
            console.warn('openEvents calendar error', e);
            renderCalendar(getAttendingMap());
        }
    };

    window._openChatsFromCalendar = async function() {
        var calView = document.getElementById('calView');
        var chatsView = document.getElementById('calChatsView');
        if (calView) calView.style.display='none';
        if (chatsView) chatsView.style.display='block';
        calViewMode='chats';
        await renderChatsView();
        await updateEventBadges();
    };
    window._backToCalendarView = async function() {
        var calView = document.getElementById('calView');
        var chatsView = document.getElementById('calChatsView');
        if (chatsView) chatsView.style.display='none';
        if (calView) calView.style.display='block';
        calViewMode='calendar';
        try {
            var map = await getAttendingMapAsync();
            renderCalendar(map);
        } catch(e){ renderCalendar(getAttendingMap()); }
    };

    window._switchEvTab = async function(tab) {
        if (tab==='my') {
            await window._openChatsFromCalendar();
        } else {
            await window._backToCalendarView();
        }
    };



    // ── EVENT CHAT SYSTEM ──
    // Keep a small local mirror of messages received through Realtime. This
    // gives the renderer an immediate fallback if the follow-up SELECT is
    // briefly delayed or the device loses its connection at that moment.
    function upsertLocalChatMessage(message) {
        if (!message || !message.event_id) return;
        var messages = getLocalMessages();
        var idx = messages.findIndex(function (existing) {
            return message.id && existing.id === message.id;
        });
        if (idx === -1) messages.push(message);
        else messages[idx] = Object.assign({}, messages[idx], message);
        saveLocalMessages(messages);
    }

    function cacheRemoteChatMessages(eventId, messages) {
        if (!eventId || !Array.isArray(messages) || messages.length === 0) return;
        var localMessages = getLocalMessages();
        var indexesById = {};
        localMessages.forEach(function (message, index) {
            if (message && message.id) indexesById[message.id] = index;
        });
        messages.forEach(function (message) {
            if (!message || message.event_id !== eventId) return;
            var idx = message.id ? indexesById[message.id] : undefined;
            if (typeof idx === 'number') {
                localMessages[idx] = Object.assign({}, localMessages[idx], message);
            } else {
                localMessages.push(message);
                if (message.id) indexesById[message.id] = localMessages.length - 1;
            }
        });
        saveLocalMessages(localMessages);
    }

    // Serialize refreshes so an older SELECT cannot finish after a newer one
    // and overwrite the chat with stale markup. Realtime events received while
    // a refresh is running queue one more read.
    async function refreshActiveChatMessages(eventId) {
        if (!eventId || activeChatEventId !== eventId) return;

        if (activeChatRefreshPromise) {
            if (activeChatRefreshEventId === eventId) {
                activeChatRefreshQueued = true;
                return activeChatRefreshPromise;
            }
            // A previous chat may still be finishing a request after its modal
            // was closed. Wait for it, then refresh the newly opened chat.
            try { await activeChatRefreshPromise; } catch (e) {}
            if (activeChatEventId !== eventId) return;
        }

        activeChatRefreshEventId = eventId;
        activeChatRefreshQueued = false;
        activeChatRefreshPromise = loadChatMessages(eventId);
        try {
            await activeChatRefreshPromise;
            if (activeChatEventId === eventId && !document.hidden && document.getElementById('eventChatModal')) {
                try { setLastSeen(eventId); } catch (e) {}
            }
        } catch (e) {
            console.warn('[Events] Could not refresh active event chat:', e);
        } finally {
            activeChatRefreshPromise = null;
            activeChatRefreshEventId = null;
        }

        if (activeChatRefreshQueued && activeChatEventId === eventId) {
            activeChatRefreshQueued = false;
            return refreshActiveChatMessages(eventId);
        }
    }

    function stopActiveChatLiveUpdates() {
        activeChatRealtimeGeneration += 1;
        if (activeChatRefreshTimer) {
            clearInterval(activeChatRefreshTimer);
            activeChatRefreshTimer = null;
        }

        var channel = activeChatRealtimeChannel;
        activeChatRealtimeChannel = null;
        if (!channel) return;

        try {
            if (window.supabaseClient && typeof window.supabaseClient.removeChannel === 'function') {
                window.supabaseClient.removeChannel(channel);
            } else if (typeof channel.unsubscribe === 'function') {
                channel.unsubscribe();
            }
        } catch (e) {
            console.warn('[Events] Could not close event chat Realtime channel:', e);
        }
    }

    function startActiveChatLiveUpdates(eventId) {
        stopActiveChatLiveUpdates();
        if (!eventId || activeChatEventId !== eventId) return;

        var generation = activeChatRealtimeGeneration;
        var client = window.supabaseClient;

        // Realtime is the primary path. The short poll is an intentional
        // safety net for mobile websocket suspension, temporary disconnects,
        // and deployments where the Realtime publication has not refreshed
        // yet. It only runs while a chat modal is open.
        activeChatRefreshTimer = setInterval(function () {
            if (generation !== activeChatRealtimeGeneration || activeChatEventId !== eventId) return;
            if (document.hidden) return;
            refreshActiveChatMessages(eventId);
        }, 2500);

        if (!client || typeof client.channel !== 'function') return;

        try {
            var channel = client
                .channel('event-chat-' + eventId + '-' + generation)
                .on(
                    'postgres_changes',
                    {
                        event: 'INSERT',
                        schema: 'public',
                        table: 'event_chat_messages',
                        filter: 'event_id=eq.' + eventId
                    },
                    function (payload) {
                        if (generation !== activeChatRealtimeGeneration || activeChatEventId !== eventId) return;
                        var message = payload && payload.new;
                        if (!message || message.event_id !== eventId) return;

                        // Cache before fetching so the incoming message can be
                        // rendered even if the immediate SELECT has a transient
                        // failure. Dedupe by id also handles our own INSERT.
                        upsertLocalChatMessage(message);
                        if (!document.hidden && document.getElementById('eventChatModal')) {
                            try { setLastSeen(eventId); } catch (e) {}
                        }
                        refreshActiveChatMessages(eventId);
                        try { if (window._updateEventBadges) window._updateEventBadges(); } catch (e) {}
                    }
                );

            activeChatRealtimeChannel = channel;
            channel.subscribe(function (status) {
                if (generation !== activeChatRealtimeGeneration || activeChatEventId !== eventId) return;
                if (status === 'SUBSCRIBED') {
                    // Close the SELECT/subscription race: once the server says
                    // the stream is live, read once more for any message sent
                    // while the channel was connecting.
                    refreshActiveChatMessages(eventId);
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    console.warn('[Events] Event chat Realtime unavailable; live polling remains active.');
                }
            });
        } catch (e) {
            activeChatRealtimeChannel = null;
            console.warn('[Events] Could not start event chat Realtime; live polling remains active:', e);
        }
    }

    window._openEventChat = async function (eventId) {
        await maybeCleanupExpiredEventChats();

        // Close calendar panel if open, so chat is on top
        try {
            var calPanel = document.getElementById('eventsManagerPanel');
            if (calPanel) calPanel.remove();
        } catch (e) {}

        var ev = getEventById(eventId);
        if (!ev) return;
        var isRo = (window._currentLang && window._currentLang() === 'ro');
        var user = getCurrentUser();

        if (isEventExpired(ev.event_date)) {
            await expireEventChat(eventId, true);
            alert(isRo ? 'Chat-ul nu mai este disponibil deoarece deadline-ul evenimentului a trecut.' : 'The chat is no longer available because the event deadline has passed.');
            return;
        }

        if (!user || !user.id) {
            if (typeof window.openAuth === 'function') window.openAuth('login');
            return;
        }

        var isCreator = user.id === ev.creator_id || (user.email && ev.creator_email && user.email === ev.creator_email);
        var isApprovedAttendee = isCreator ? true : await isUserAcceptedAttendee(eventId, user.id);
        if (!isApprovedAttendee) {
            alert(isRo ? 'Chat-ul devine disponibil doar pentru creator și participanții acceptați.' : 'The chat is only available to the creator and accepted attendees.');
            return;
        }

        var attendeeCounts = await fetchAttendeeCounts([eventId]);
        var attendeeCount = attendeeCounts[eventId] || 0;
        if (attendeeCount < 1) {
            alert(isRo ? 'Chat-ul se creează automat după acceptarea primului participant.' : 'The chat is created automatically after the first participant is accepted.');
            return;
        }

        var chat = await ensureEventChatExists(ev, attendeeCount);

        // Mark as seen and update badges
        try { setLastSeen(eventId); } catch (e) {}
        try { if (window._updateEventBadges) window._updateEventBadges(); } catch (e) {}
        if (!chat) {
            alert(isRo ? 'Chat-ul evenimentului nu a putut fi creat.' : 'The event chat could not be created.');
            return;
        }

        clearActiveChatDeadlineTimer();
        stopActiveChatLiveUpdates();
        activeChatEventId = eventId;

        var existing = document.getElementById('eventChatModal');
        if (existing) existing.remove();

        var modal = document.createElement('div');
        modal.id = 'eventChatModal';

        var box = document.createElement('div');
        box.style.cssText = 'max-width: 600px; width: 100%; margin: 0 auto; height: 100%; display: flex; flex-direction: column; background: rgba(10,20,42,0.98); border: 1px solid rgba(184,216,240,0.25); border-radius: 12px; overflow: hidden;';

        box.innerHTML = '<div style="background: rgba(6,14,30,0.95); padding: 12px 16px; border-bottom: 1px solid rgba(184,216,240,0.15); display: flex; flex-direction: column; gap: 6px;">' +
            '<div style="display: flex; justify-content: space-between; align-items: center;">' +
            '<strong style="font-size: 1rem; color: #F5F0EB;">' + escapeHtml(ev.title) + '</strong>' +
            '<button type="button" onclick="window._closeEventChatModal()" style="background:none; border:none; color:var(--sky); font-size:1.2rem; cursor:pointer;">✕</button>' +
            '</div>' +
            '<div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.76rem; gap:8px;">' +
            '<span id="chatTimer" style="color: #ffc832; font-weight: 600;">⏳ ' + (isRo ? 'Se verifică deadline-ul chat-ului…' : 'Checking chat deadline…') + '</span>' +
            '<button type="button" onclick="window._addToCalendar(\'' + ev.id + '\')" style="background: rgba(107,63,160,0.35); border: 1px solid rgba(196,160,240,0.5); border-radius: 4px; color: #c4a0f0; padding: 3px 8px; font-size: 0.7rem; cursor: pointer; font-weight: 600;">📅 ' + (isRo ? 'Adaugă în Calendar' : 'Add to Calendar') + '</button>' +
            '</div>' +
            '</div>' +
            '<div id="chatMessagesList" style="flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px;"></div>' +
            '<div style="background: rgba(6,14,30,0.95); padding: 12px; border-top: 1px solid rgba(184,216,240,0.15); display: flex; gap: 8px; align-items: center;">' +
            '<label style="cursor: pointer; background: rgba(184,216,240,0.1); border: 1px solid rgba(184,216,240,0.25); border-radius: 6px; padding: 8px; display: flex; align-items: center; justify-content: center;" title="' + (isRo ? 'Atașare foto/video' : 'Attach photo/video') + '">' +
            '📎<input type="file" id="chatMediaInput" accept="image/*,video/*" style="display:none;" onchange="window._handleChatMedia(this)">' +
            '</label>' +
            '<input type="text" id="chatInput" placeholder="' + (isRo ? 'Scrie un mesaj...' : 'Type a message...') + '" style="flex:1; background:rgba(255,255,255,0.06); border:1px solid rgba(184,216,240,0.25); border-radius:6px; padding:8px 12px; color:#F5F0EB; font-size:0.85rem;" autocomplete="off">' +
            '<button type="button" onclick="window._sendChatMessage()" style="background:#6B3FA0; border:none; border-radius:6px; color:#fff; font-weight:600; padding:8px 16px; cursor:pointer;">' + (isRo ? 'Trimite' : 'Send') + '</button>' +
            '</div>';

        modal.appendChild(box);
        document.body.appendChild(modal);

        // Subscribe before the initial history read. A second read runs when
        // the channel reaches SUBSCRIBED, which prevents messages sent during
        // channel setup from falling through a timing gap.
        startActiveChatLiveUpdates(eventId);

        // Make sure the SERVER-side `event_chats` row exists before we read
        // the message history. `ensure_event_chat_for_event` is security
        // definer, so it works even when the client-side upsert above was
        // blocked by RLS. Some deployments gate message reads on the chat
        // row existing, which used to make previous messages invisible until
        // the user posted (the insert-guard trigger then created the row).
        try {
            if (window.supabaseClient) {
                await window.supabaseClient.rpc('ensure_event_chat_for_event', { _event_id: eventId });
            }
        } catch (e) {
            console.warn('[Events] ensure_event_chat_for_event failed:', e);
        }

        await refreshActiveChatMessages(eventId);
        startEventChatDeadlineTimer(ev);

        var chatInput = document.getElementById('chatInput');
        if (chatInput) {
            chatInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') window._sendChatMessage();
            });
        }
    };

    async function loadChatMessages(eventId) {
        var listEl = document.getElementById('chatMessagesList');
        if (!listEl) return;
        var user = getCurrentUser();
        var ev = getEventById(eventId);
        var isRo = (window._currentLang && window._currentLang() === 'ro');

        if (ev && isEventExpired(ev.event_date)) {
            await expireEventChat(eventId, true);
            listEl.innerHTML = '<div style="text-align:center; opacity:0.7; font-size:0.8rem; margin-top:20px;">' + (isRo ? 'Chat expirat.' : 'Chat expired.') + '</div>';
            return;
        }

        // Fetch the full history for this event. Returns the messages plus
        // whether the server actually answered, so callers can distinguish a
        // genuinely empty chat from a failed / RLS-blocked read.
        async function fetchRemoteMessages() {
            if (!window.supabaseClient) return { msgs: [], remoteOk: false };
            try {
                var res = await window.supabaseClient.from('event_chat_messages').select('*').eq('event_id', eventId).order('created_at', { ascending: true });
                if (res && !res.error && res.data) return { msgs: res.data, remoteOk: true };
                if (res && res.error) console.warn('[Events] loadChatMessages remote error:', res.error);
                return { msgs: [], remoteOk: false };
            } catch (e) {
                console.warn('[Events] loadChatMessages remote fetch failed:', e);
                return { msgs: [], remoteOk: false };
            }
        }

        var fetched = await fetchRemoteMessages();
        // If the first read returned no messages, retry once before falling
        // back — the server-side chat row may have just been created, and a
        // transient failure must not hide an existing conversation behind the
        // "start the conversation" placeholder.
        if (fetched.msgs.length === 0) {
            await new Promise(function (resolve) { setTimeout(resolve, 400); });
            var retried = await fetchRemoteMessages();
            if (retried.msgs.length > 0) fetched = retried;
        }

        var msgs = fetched.msgs;
        if (msgs.length > 0) {
            cacheRemoteChatMessages(eventId, msgs);
        } else {
            msgs = getLocalMessages().filter(function(m) { return m.event_id === eventId; });
        }
        msgs = msgs.slice().sort(function (a, b) {
            return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
        });

        var html = '';
        if (msgs.length === 0) {
            html = '<div style="text-align:center; opacity:0.5; font-size:0.8rem; margin-top:20px;">' + (isRo ? 'Chat creat. Începe conversația!' : 'Chat created. Start the conversation!') + '</div>';
        } else {
            msgs.forEach(function (m) {
                var isMe = user && m.user_id === user.id;
                html += '<div style="display: flex; flex-direction: column; align-items: ' + (isMe ? 'flex-end' : 'flex-start') + ';">' +
                    '<div style="font-size: 0.68rem; opacity: 0.6; margin-bottom: 2px;">' + escapeHtml(m.user_name) + '</div>' +
                    '<div style="background: ' + (isMe ? '#6B3FA0' : 'rgba(255,255,255,0.08)') + '; padding: 8px 12px; border-radius: 8px; max-width: 80%; font-size: 0.85rem; word-break: break-word;">';
                if (m.message) html += escapeHtml(m.message);
                if (m.media_url) {
                    if (m.media_type === 'image') {
                        html += '<div style="margin-top:6px;"><img src="' + m.media_url + '" style="max-width:100%; border-radius:6px; max-height:200px; display:block;"></div>';
                    } else if (m.media_type === 'video') {
                        html += '<div style="margin-top:6px;"><video src="' + m.media_url + '" controls style="max-width:100%; border-radius:6px; max-height:200px; display:block;"></video></div>';
                    }
                }
                html += '</div></div>';
            });
        }
        listEl.innerHTML = html;
        listEl.scrollTop = listEl.scrollHeight;
    }

    window._sendChatMessage = async function () {
        var input = document.getElementById('chatInput');
        if (!input) return;
        var text = input.value.trim();
        if (!text || !activeChatEventId) return;

        var user = getCurrentUser();
        if (!user || !user.id) return;

        var ev = getEventById(activeChatEventId);
        var isRo = (window._currentLang && window._currentLang() === 'ro');
        if (!ev || isEventExpired(ev.event_date)) {
            await expireEventChat(activeChatEventId, true);
            alert(isRo ? 'Chat-ul a expirat și nu mai poate primi mesaje.' : 'The chat has expired and can no longer receive messages.');
            return;
        }

        var msg = {
            id: genUuid(),
            event_id: activeChatEventId,
            user_id: user.id,
            user_name: user.name || (user.email ? user.email.split('@')[0] : 'User'),
            message: text,
            media_url: null,
            media_type: 'none',
            created_at: new Date().toISOString()
        };

        var shouldPersistLocally = true;
        try {
            if (window.supabaseClient) {
                var chatInsertRes = await window.supabaseClient.from('event_chat_messages').insert([msg]);
                if (chatInsertRes && chatInsertRes.error) {
                    console.error('Supabase insert chat message failed:', chatInsertRes.error);
                    var chatErrorMsg = String(chatInsertRes.error.message || '').toLowerCase();
                    if (chatErrorMsg.indexOf('chat') !== -1 || chatErrorMsg.indexOf('active') !== -1) {
                        shouldPersistLocally = false;
                        await syncEventChatState(activeChatEventId);
                    }
                }
            }
        } catch (e) {}

        if (!shouldPersistLocally) return;

        var msgs = getLocalMessages();
        msgs.push(msg);
        saveLocalMessages(msgs);

        input.value = '';
        try { setLastSeen(activeChatEventId); } catch (e) {}
        try { if (window._updateEventBadges) window._updateEventBadges(); } catch (e) {}
        refreshActiveChatMessages(activeChatEventId);
    };

    window._handleChatMedia = async function (input) {
        if (!input.files || !input.files[0] || !activeChatEventId) return;
        var file = input.files[0];
        var reader = new FileReader();

        reader.onload = async function (e) {
            var ev = getEventById(activeChatEventId);
            var isRo = (window._currentLang && window._currentLang() === 'ro');
            if (!ev || isEventExpired(ev.event_date)) {
                await expireEventChat(activeChatEventId, true);
                alert(isRo ? 'Chat-ul a expirat și nu mai poate primi atașamente.' : 'The chat has expired and can no longer receive attachments.');
                return;
            }

            var dataUrl = e.target.result;
            var isVideo = file.type.startsWith('video');
            var user = getCurrentUser();
            if (!user || !user.id) return;

            var msg = {
                id: genUuid(),
                event_id: activeChatEventId,
                user_id: user.id,
                user_name: user.name || (user.email ? user.email.split('@')[0] : 'User'),
                message: '',
                media_url: dataUrl,
                media_type: isVideo ? 'video' : 'image',
                created_at: new Date().toISOString()
            };

            var shouldPersistLocally = true;
            try {
                if (window.supabaseClient) {
                    var mediaInsertRes = await window.supabaseClient.from('event_chat_messages').insert([msg]);
                    if (mediaInsertRes && mediaInsertRes.error) {
                        var mediaErrorMsg = String(mediaInsertRes.error.message || '').toLowerCase();
                        if (mediaErrorMsg.indexOf('chat') !== -1 || mediaErrorMsg.indexOf('active') !== -1) {
                            shouldPersistLocally = false;
                            await syncEventChatState(activeChatEventId);
                        }
                    }
                }
            } catch (err) {}

            if (!shouldPersistLocally) return;

            var msgs = getLocalMessages();
            msgs.push(msg);
            saveLocalMessages(msgs);

            refreshActiveChatMessages(activeChatEventId);
        };
        reader.readAsDataURL(file);
    };

    // Add to Phone Calendar (.ics generator)
    window._addToCalendar = function (eventId) {
        var ev = eventsData.find(function (e) { return e.id === eventId; });
        if (!ev) return;

        var startDate = new Date(ev.event_date);
        var endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000); // +2 hours

        function fmtIcsDate(d) {
            return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        }

        var icsContent = 'BEGIN:VCALENDAR\n' +
            'VERSION:2.0\n' +
            'PRODID:-//DetectLab//Events//EN\n' +
            'BEGIN:VEVENT\n' +
            'SUMMARY:' + ev.title + '\n' +
            'DESCRIPTION:' + (ev.description || '') + '\n' +
            'DTSTART:' + fmtIcsDate(startDate) + '\n' +
            'DTEND:' + fmtIcsDate(endDate) + '\n' +
            'LOCATION:Lat ' + ev.latitude + ', Lng ' + ev.longitude + '\n' +
            'END:VEVENT\n' +
            'END:VCALENDAR';

        var blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
        var link = document.createElement('a');
        link.href = window.URL.createObjectURL(blob);
        link.setAttribute('download', (ev.title || 'event').replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.ics');
        document.body.appendChild(link);
        link.click();
        link.remove();
    };

    // Pull the shared event state (events + my attendance) from the server.
    // Runs on a timer so deletions and kick-outs performed by the creator on
    // another device show up here without a page reload.
    async function pollSharedEventState() {
        if (!getCurrentUser()) return;
        try {
            await fetchEvents();              // picks up deleted events
            await syncMyEventStateFromServer(); // picks up kick-outs
        } catch (e) {
            console.warn('pollSharedEventState failed', e);
        }
    }
    window._syncMyEventState = syncMyEventStateFromServer;

    // Periodic check for notifications on app load / login
    document.addEventListener('DOMContentLoaded', function () {
        try { ensureEventBadges(); } catch (e) {}
        setTimeout(checkNotifications, 2000);
        setTimeout(function () { maybeCleanupExpiredEventChats(true); try { updateEventBadges(); } catch (e) {} }, 2500);
        setTimeout(function () { try { updateEventBadges(); } catch (e) {} }, 3000);
        setTimeout(pollSharedEventState, 3500);
        setInterval(checkNotifications, 15000);
        setInterval(function () { maybeCleanupExpiredEventChats(); }, 60000);
        setInterval(function () { try { updateEventBadges(); } catch (e) {} }, 12000);
        setInterval(pollSharedEventState, 30000);
        // Also refresh as soon as the user comes back to the tab.
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) {
                pollSharedEventState();
                if (activeChatEventId) {
                    var eventId = activeChatEventId;
                    try { setLastSeen(eventId); } catch (e) {}
                    // Mobile browsers commonly suspend websocket connections
                    // in the background. Recreate the filtered channel and
                    // immediately catch up when the chat becomes visible.
                    startActiveChatLiveUpdates(eventId);
                    refreshActiveChatMessages(eventId);
                }
            }
        });
        window.addEventListener('online', function () {
            if (!activeChatEventId) return;
            var eventId = activeChatEventId;
            startActiveChatLiveUpdates(eventId);
            refreshActiveChatMessages(eventId);
        });
        // Observe DOM changes for dynamically created user menus (PWA dropdowns)
        if (window.MutationObserver) {
            var obs = new MutationObserver(function(){ try { ensureEventBadges(); } catch(e){} });
            try { obs.observe(document.body, { childList:true, subtree:true }); } catch (e) {}
        }
    });

    // Rebuild event markers and check notifications when auth state changes (login / logout / token refresh)
    window.addEventListener('detectlab:authchange', async function () {
        if (!getCurrentUser() && activeChatEventId) {
            window._closeEventChatModal();
        }
        await fetchEvents();
        try { await syncMyEventStateFromServer(); } catch (e) {}
        refreshEventsMap(true);
        await maybeCleanupExpiredEventChats(true);
        checkNotifications();
        try { ensureEventBadges(); } catch (e) {}
        try { updateEventBadges(); } catch (e) {}
    });

    // Expose init and methods
    window._initEventsLayer = initEventsLayer;
    window._checkEventNotifications = checkNotifications;
    // Exposed for the nearby-event notification regression test and so other
    // modules can re-broadcast an event to its county if needed.
    window._notifyUsersNearEvent = notifyUsersNearEvent;
    window._fetchEvents = fetchEvents;
})();
