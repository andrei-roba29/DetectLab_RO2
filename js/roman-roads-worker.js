/* ============================================================================
 * roman-roads-worker.js — the Roman-road stream reader
 * ----------------------------------------------------------------------------
 * Runs the whole ingest off the main thread: fetch → streaming NDJSON →
 * Web-Mercator geometry → transferable typed arrays. The page only ever
 * receives finished binary batches, so a 40 MB stream cannot freeze the tab
 * (the tab used to freeze *and* crawl, because parsing and drawing shared the
 * task that pumps the socket).
 *
 * Protocol (page → worker)
 *   {cmd:'start', url, config}     begin (config = parser overrides)
 *   {cmd:'cancel'}                 stop for good (tab closed the layer)
 *   {cmd:'ack'}                    one batch payload was consumed by the page
 *
 * (worker → page)
 *   {type:'progress', bytes, total, lines, segments, vertices, elapsed}
 *   {type:'batch', payload, stats} (payload buffers are transferred)
 *   {type:'done', stats}
 *   {type:'error', message}
 *
 * Backpressure: at most MAX_OUTSTANDING batches may be in flight. The page
 * acknowledges each one after it has appended it, so a fast socket plus a
 * busy main thread can never queue up an unbounded amount of geometry.
 * ========================================================================== */
'use strict';

var config = {};
var MAX_OUTSTANDING = 4;
var PROGRESS_MS = 250;

var parserUrl = 'roman-roads-parser.js';
try {
    var here = new URL(self.location.href);
    parserUrl = 'roman-roads-parser.js' + (here.search || '');
} catch (e) { /* keep the plain relative name */ }

try {
    importScripts(parserUrl);
} catch (err) {
    /* Reported as a normal protocol error: the page then runs the same
     * pipeline on the main thread instead (see roman-roads.js `load`). */
    self.postMessage({ type: 'error', message: 'roads parser unavailable: ' + (err && err.message) });
}

var P = self.DetectLabRomanRoadsParser;



var state = {
    cancelled: false,
    reading: false,
    outstanding: 0,
    ackWaiters: [],
    startedAt: 0
};

function post(msg, transfer) {
    try {
        if (transfer && transfer.length) self.postMessage(msg, transfer);
        else self.postMessage(msg);
    } catch (e) {
        /* A transfer failure must never take the stream down: post a copy. */
        self.postMessage(msg);
    }
}

function waitForAck() {
    if (state.outstanding < MAX_OUTSTANDING) return Promise.resolve();
    return new Promise(function (resolve) { state.ackWaiters.push(resolve); });
}

function releaseAck() {
    if (state.outstanding > 0) state.outstanding--;
    var waiter = state.ackWaiters.shift();
    if (waiter) waiter();
}

function now() {
    return (self.performance && self.performance.now) ? self.performance.now() : Date.now();
}

function start(msg) {
    if (state.reading) return;
    state.reading = true;
    state.cancelled = false;
    state.startedAt = now();

    var collector = P.createCollector(msg.config || {});
    var lines = 0, bytes = 0, total = 0, lastProgress = 0, batches = 0;
    var url = msg.url;

    function progress(force) {
        var t = now();
        if (!force && t - lastProgress < PROGRESS_MS) return;
        lastProgress = t;
        var s = collector.stats();
        post({
            type: 'progress',
            bytes: bytes,
            total: total,
            lines: lines,
            segments: s.segments,
            vertices: s.vertices,
            seen: s.seen,
            sampled: s.sampled,
            stride: s.stride,
            elapsed: Math.round(t - state.startedAt)
        });
    }

    function flushBatch(force) {
        if (!collector.stats().segments) return;
        if (!force && !collector.shouldFlush()) return;
        var framed = collector.flush();
        if (!framed) return;
        state.outstanding++;
        batches++;
        post({ type: 'batch', payload: framed.payload, stats: framed.payload.stats }, framed.transfer);
    }

    function handleLine(line) {
        lines++;
        var rec;
        if (line.charCodeAt(0) === 123 /* { */ || line.charCodeAt(0) === 91 /* [ */) {
            try { rec = JSON.parse(line); } catch (e) { collector.addRecord(null); return; }
        } else if (/^(LINESTRING|MULTILINESTRING)/i.test(line)) {
            rec = line;
        } else {
            collector.addRecord(null);     /* malformed or unsupported record */
            return;
        }
        collector.addRecord(rec);
    }

    function finish(stats) {
        post({ type: 'done', stats: stats });
    }

    function fail(err) {
        post({ type: 'error', message: String((err && err.message) || err) });
    }

    /* Drain complete records within each response chunk. A chunk (or a
     * response.text() body) can contain the entire file: flushing only after
     * the chunk used to overflow a batch and discard perfectly valid roads.
     * Pause even in the middle of a chunk when four transfers await an ack. */
    var buffer = '';
    function processBuffer(final) {
        var startAt = 0;
        function advance() {
            if (state.cancelled) { buffer = ''; return Promise.resolve(); }
            var i;
            while ((i = buffer.indexOf('\n', startAt)) >= 0) {
                var line = buffer.slice(startAt, i).trim();
                startAt = i + 1;
                if (line) handleLine(line);
                if (collector.shouldFlush()) {
                    flushBatch(false);
                    progress(false);
                    if (state.outstanding >= MAX_OUTSTANDING) {
                        buffer = buffer.slice(startAt);
                        startAt = 0;
                        return waitForAck().then(advance);
                    }
                }
            }
            var tail = buffer.slice(startAt);
            buffer = '';
            if (final) {
                if (tail.trim()) handleLine(tail.trim());
                if (collector.shouldFlush()) flushBatch(false);
            } else {
                buffer = tail;
            }
            return state.outstanding >= MAX_OUTSTANDING ? waitForAck() : Promise.resolve();
        }
        return advance();
    }

    fetch(url, { credentials: 'omit', cache: 'default' })
        .then(function (resp) {
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            total = +resp.headers.get('content-length') || 0;
            if (collector.setSourceTotal) collector.setSourceTotal(total);
            progress(true);
            if (!resp.body || !resp.body.getReader || typeof TextDecoder !== 'function') {
                return resp.text().then(function (text) {
                    if (state.cancelled) return;
                    /* Without a content length this is an approximate byte
                     * count; no additional 40 MB encoding buffer is needed. */
                    bytes = total || text.length;
                    if (collector.noteSourceBytes) collector.noteSourceBytes(bytes);
                    buffer = text;
                    return processBuffer(true);
                });
            }
            var reader = resp.body.getReader();
            var decoder = new TextDecoder();

            function pump() {
                if (state.cancelled) {
                    try { reader.cancel(); } catch (e) {}
                    return Promise.resolve();
                }
                return waitForAck().then(function () {
                    if (state.cancelled) {
                        try { reader.cancel(); } catch (e) {}
                        return;
                    }
                    return reader.read().then(function (res) {
                        if (res.done) {
                            buffer += decoder.decode();
                            return processBuffer(true);
                        }
                        bytes += res.value.length;
                        if (collector.noteSourceBytes) collector.noteSourceBytes(res.value.length);
                        buffer += decoder.decode(res.value, { stream: true });
                        return processBuffer(false).then(function () {
                            progress(false);
                            return pump();
                        });
                    });
                });
            }
            return pump();
        })
        .then(function () {
            if (state.cancelled) return;
            flushBatch(true);
            progress(true);
            finish(collector.stats());
        })
        .catch(function (err) {
            if (!state.cancelled) fail(err);
        })
        .then(function () {
            state.reading = false;
        });
}

self.addEventListener('message', function (event) {
    var msg = event.data || {};
    switch (msg.cmd) {
        case 'start':
            if (!P) { post({ type: 'error', message: 'roads parser unavailable' }); break; }
            config = msg.config || {};
            start(msg);
            break;
        case 'ack':
            releaseAck();
            break;
        case 'cancel':
            state.cancelled = true;
            releaseAck();
            break;
    }
});
