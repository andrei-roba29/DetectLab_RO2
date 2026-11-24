/* ─────────────────────────────────────────────────────────────────────────────
 * DetectLab — "Archeological Report" PDF layout
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns the report model produced by js/archeo-report.js into a multi-page,
 * print-ready PDF. Pages are painted on a supersampled <canvas> (2.2×) and
 * handed to js/pdf-writer.js as JPEG pages — see that file for why the report
 * is image-based instead of using the PDF standard fonts (ă/ș/ț).
 *
 * Structure of the document
 *   1  Cover              — area, date, result summary, disclaimer
 *   2  Method             — the 3 sources, the 3 exclusions, the weighted score
 *   3… Result pages       — score breakdown + APM / potential-zone / LIDAR
 *                           interpretation + estimated period + nearest sites
 *   …  Figures            — APM 2.0 polygons, LIDAR, potential zones vs. sites
 *   n  Sources & links    — provenance, CIMEC/RAN links, legend
 *
 * Everything the pages say comes from the `tr` passed into build() — a
 * language-bound translator — so the document is produced in the language
 * the user picked for the PDF (RO or EN), independent of the site language.
 * ───────────────────────────────────────────────────────────────────────────── */
(function (root) {
    'use strict';

    var SCALE = 2.2;                       // canvas supersampling factor
    var PAGE = { w: 595.276, h: 841.89 };  // A4 portrait, in PDF points
    var MARGIN = 46;
    var CONTENT_W = PAGE.w - MARGIN * 2;

    var C = {
        ink: '#e8eef8',
        muted: '#9aa8bc',
        faint: '#6b7a90',
        line: '#1e2a40',
        purple: '#66c8ff',
        purpleSoft: '#132033',
        orange: '#4db8ff',
        orangeSoft: '#0e2238',
        green: '#4ade80',
        card: '#121c2c',
        page: '#0a1220'
    };

    var FONT_BODY = "'Outfit', 'Segoe UI', Arial, sans-serif";
    var FONT_HEAD = "'Cinzel', Georgia, 'Times New Roman', serif";

    function font(weight, size, family) {
        return weight + ' ' + size + 'px ' + (family || FONT_BODY);
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * PAINTER — a tiny layout engine over a canvas 2D context
     * ═══════════════════════════════════════════════════════════════════════ */
    function Painter(tr, fmtM, langCode) {
        this.tr = tr;
        this.fmtM = fmtM;
        this.lang = langCode || 'en';
        this.canvas = null;
        this.g = null;
        this.y = 0;
        this.pageNumber = 0;
        this.pageTitle = '';
    }

    Painter.prototype.beginPage = function (title) {
        this.pageNumber++;
        this.pageTitle = title || '';
        var canvas = root.document.createElement('canvas');
        canvas.width = Math.round(PAGE.w * SCALE);
        canvas.height = Math.round(PAGE.h * SCALE);
        var g = canvas.getContext('2d');
        g.setTransform(SCALE, 0, 0, SCALE, 0, 0);
        g.textBaseline = 'alphabetic';
        g.fillStyle = C.page;
        g.fillRect(0, 0, PAGE.w, PAGE.h);
        this.canvas = canvas;
        this.g = g;
        this.y = MARGIN;
        this.header(title);
        return this;
    };

    Painter.prototype.header = function (title) {
        var g = this.g;
        // top accent rule
        g.fillStyle = C.purple;
        g.fillRect(0, 0, PAGE.w, 4);
        g.fillStyle = C.orange;
        g.fillRect(0, 0, PAGE.w * 0.34, 4);

        g.font = font(700, 9.5, FONT_BODY);
        g.fillStyle = C.purple;
        g.textAlign = 'left';
        g.fillText('DETECTLAB', MARGIN, MARGIN - 14);
        g.font = font(500, 8, FONT_BODY);
        g.fillStyle = C.faint;
        g.textAlign = 'right';
        g.fillText(this.tr('arch_report_header_right'), PAGE.w - MARGIN, MARGIN - 14);
        g.textAlign = 'left';

        if (title) {
            g.font = font(600, 13, FONT_HEAD);
            g.fillStyle = C.ink;
            g.fillText(title, MARGIN, MARGIN + 14);
            g.strokeStyle = C.line;
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(MARGIN, MARGIN + 24);
            g.lineTo(PAGE.w - MARGIN, MARGIN + 24);
            g.stroke();
            this.y = MARGIN + 44;
        } else {
            this.y = MARGIN + 10;
        }
    };

    Painter.prototype.footer = function () {
        var g = this.g;
        var y = PAGE.h - 30;
        g.strokeStyle = C.line;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(MARGIN, y - 10);
        g.lineTo(PAGE.w - MARGIN, y - 10);
        g.stroke();
        g.font = font(500, 7.5, FONT_BODY);
        g.fillStyle = C.faint;
        g.textAlign = 'left';
        g.fillText(this.tr('arch_report_footer_left'), MARGIN, y + 2);
        g.textAlign = 'right';
        g.fillText(this.tr('arch_report_page') + ' ' + this.pageNumber, PAGE.w - MARGIN, y + 2);
        g.textAlign = 'left';
    };

    Painter.prototype.finishPage = function () {
        this.footer();
        return this.canvas.toDataURL('image/jpeg', 0.86);
    };

    Painter.prototype.space = function (h) { this.y += h; return this; };

    Painter.prototype.h1 = function (text) {
        var g = this.g;
        g.font = font(700, 22, FONT_HEAD);
        g.fillStyle = C.ink;
        g.fillText(text, MARGIN, this.y + 20);
        this.y += 34;
        return this;
    };

    Painter.prototype.h2 = function (text) {
        var g = this.g;
        g.font = font(700, 13, FONT_HEAD);
        g.fillStyle = C.purple;
        g.fillText(text, MARGIN, this.y + 12);
        this.y += 24;
        return this;
    };

    Painter.prototype.h3 = function (text) {
        var g = this.g;
        g.font = font(600, 10.5, FONT_BODY);
        g.fillStyle = C.ink;
        g.fillText(text, MARGIN, this.y + 10);
        this.y += 18;
        return this;
    };

    // Word-wrapped paragraph. `opts`: size, weight, color, width, x, lineHeight, italic
    Painter.prototype.para = function (text, opts) {
        opts = opts || {};
        var g = this.g;
        var size = opts.size || 9.5;
        var lh = opts.lineHeight || size * 1.45;
        var x = opts.x === undefined ? MARGIN : opts.x;
        var width = opts.width === undefined ? CONTENT_W : opts.width;
        g.font = font(opts.weight || 400, size, FONT_BODY);
        g.fillStyle = opts.color || C.ink;
        if (opts.italic) g.font = 'italic ' + g.font;
        var lines = this.wrap(String(text == null ? '' : text), width, g.font);
        lines.forEach(function (line) {
            g.fillText(line, x, this.y + size);
            this.y += lh;
        }, this);
        if (opts.spaceAfter !== undefined) this.y += opts.spaceAfter;
        return this;
    };

    Painter.prototype.wrap = function (text, maxWidth, fontStr) {
        var g = this.g;
        if (fontStr) g.font = fontStr;
        var out = [];
        String(text).split('\n').forEach(function (hardLine) {
            var words = hardLine.split(/\s+/);
            var line = '';
            for (var i = 0; i < words.length; i++) {
                var test = line ? line + ' ' + words[i] : words[i];
                if (g.measureText(test).width > maxWidth && line) {
                    out.push(line);
                    line = words[i];
                } else {
                    line = test;
                }
            }
            out.push(line);
        });
        return out;
    };

    Painter.prototype.rule = function (color) {
        var g = this.g;
        g.strokeStyle = color || C.line;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(MARGIN, this.y);
        g.lineTo(PAGE.w - MARGIN, this.y);
        g.stroke();
        this.y += 10;
        return this;
    };

    // Label/value row inside a card.
    Painter.prototype.kv = function (label, value, opts) {
        opts = opts || {};
        var g = this.g;
        var x = opts.x === undefined ? MARGIN + 10 : opts.x;
        var w = opts.width === undefined ? CONTENT_W - 20 : opts.width;
        g.font = font(500, 8.5, FONT_BODY);
        g.fillStyle = C.muted;
        var labelW = Math.max(96, g.measureText(label).width + 8);
        g.fillText(label, x, this.y + 9);
        g.font = font(opts.bold ? 600 : 500, 9.2, FONT_BODY);
        g.fillStyle = opts.color || C.ink;
        var lines = this.wrap(String(value == null ? '—' : value), w - labelW, g.font);
        var startY = this.y;
        lines.forEach(function (line, i) {
            g.fillText(line, x + labelW, startY + 9 + i * 12.5);
        });
        this.y = startY + Math.max(1, lines.length) * 12.5 + 2;
        return this;
    };

    Painter.prototype.card = function (height, color) {
        var g = this.g;
        g.fillStyle = color || C.card;
        roundRect(g, MARGIN, this.y - 4, CONTENT_W, height, 6);
        g.fill();
        return this;
    };

    // Score: colored bar + percentage + 5 stars.
    Painter.prototype.scoreBar = function (score, opts) {
        opts = opts || {};
        var g = this.g;
        var x = opts.x === undefined ? MARGIN : opts.x;
        var w = opts.width === undefined ? CONTENT_W : opts.width;
        var pct = Math.round(score * 100);
        var barY = this.y + 4;
        var barH = 9;

        g.fillStyle = '#1a2740';
        roundRect(g, x, barY, w, barH, 4.5);
        g.fill();
        g.fillStyle = scoreColor(score);
        roundRect(g, x, barY, Math.max(barH, w * score), barH, 4.5);
        g.fill();

        g.font = font(700, 15, FONT_BODY);
        g.fillStyle = scoreColor(score);
        g.textAlign = 'left';
        g.fillText(pct + '%', x, barY + barH + 20);
        var pctW = g.measureText(pct + '%').width;
        this.stars(x + pctW + 14, barY + barH + 20, score, 12);
        this.y = barY + barH + 26;
        return this;
    };

    Painter.prototype.stars = function (x, baselineY, score, size) {
        var g = this.g;
        var star = '\u2605';
        g.font = font(400, size, FONT_BODY);
        g.fillStyle = '#1e2a40';
        var total = 0;
        for (var i = 0; i < 5; i++) {
            g.fillText(star, x + total, baselineY);
            total += g.measureText(star).width + 1.5;
        }
        g.save();
        g.beginPath();
        g.rect(x, baselineY - size, total * score, size + 4);
        g.clip();
        g.fillStyle = scoreColor(score);
        total = 0;
        for (var j = 0; j < 5; j++) {
            g.fillText(star, x + total, baselineY);
            total += g.measureText(star).width + 1.5;
        }
        g.restore();
        g.font = font(600, size * 0.72, FONT_BODY);
        g.fillStyle = scoreColor(score);
        g.fillText((score * 5).toFixed(1) + '/5', x + total + 6, baselineY);
    };

    // Simple table: rows = [[cell,…]], first row is the header.
    Painter.prototype.table = function (rows, colWidths, opts) {
        opts = opts || {};
        var g = this.g;
        var x = opts.x === undefined ? MARGIN : opts.x;
        var rowH = opts.rowHeight || 16;
        var size = opts.size || 8.5;
        var self = this;
        this.pageBreakTable = false;
        this.tableRowsDrawn = 0;

        rows.forEach(function (row, ri) {
            if (self.pageBreakTable) return;
            var isHead = ri === 0;
            var cellLines = [];
            var maxLines = 1;
            row.forEach(function (cell, ci) {
                g.font = font(isHead ? 600 : (opts.boldFirstCol && ci === 0 ? 600 : 400), size, FONT_BODY);
                var lines = self.wrap(String(cell == null ? '' : cell), colWidths[ci] - 8, g.font);
                cellLines.push(lines);
                if (lines.length > maxLines) maxLines = lines.length;
            });
            var h = Math.max(rowH, maxLines * (size + 3.5) + 6);
            if (self.y + h > PAGE.h - 46) { self.pageBreakTable = true; return; }
            if (!isHead) self.tableRowsDrawn++;
            if (isHead) {
                g.fillStyle = C.purpleSoft;
                g.fillRect(x, self.y - 2, CONTENT_W, h);
            } else if (ri % 2 === 0) {
                g.fillStyle = '#0e1828';
                g.fillRect(x, self.y - 2, CONTENT_W, h);
            }
            var cx = x;
            cellLines.forEach(function (lines, ci) {
                g.font = font(isHead ? 600 : (opts.boldFirstCol && ci === 0 ? 600 : 400), size, FONT_BODY);
                g.fillStyle = isHead ? C.purple : (opts.colorFor && opts.colorFor(ci, ri)) || C.ink;
                lines.forEach(function (line, li) {
                    g.fillText(line, cx + 4, self.y + size + 1 + li * (size + 3.5));
                });
                cx += colWidths[ci];
            });
            self.y += h;
            g.strokeStyle = C.line;
            g.lineWidth = 0.6;
            g.beginPath();
            g.moveTo(x, self.y - 2);
            g.lineTo(x + CONTENT_W, self.y - 2);
            g.stroke();
        });
        this.y += 8;
        return this;
    };

    // Draws a figure with its caption box.
    Painter.prototype.figure = function (fig, captionLines, opts) {
        opts = opts || {};
        var g = this.g;
        var img = opts.image;             // HTMLImageElement (already decoded)
        var w = opts.width === undefined ? CONTENT_W : opts.width;
        var h = w;                        // the figures are square
        if (this.y + h + 44 > PAGE.h - 40) return false;   // caller starts a new page

        g.save();
        roundRect(g, MARGIN, this.y, w, h, 6);
        g.clip();
        if (img) g.drawImage(img, MARGIN, this.y, w, h);
        else {
            g.fillStyle = '#121c2c';
            g.fillRect(MARGIN, this.y, w, h);
        }
        g.restore();
        g.strokeStyle = C.line;
        g.lineWidth = 1;
        roundRect(g, MARGIN, this.y, w, h, 6);
        g.stroke();

        if (fig && fig.dataUrl) {
            // small " DetectLab " watermark inside the figure
            g.font = font(600, 8, FONT_BODY);
            g.fillStyle = 'rgba(255,255,255,0.8)';
            g.fillText('DetectLab', MARGIN + 10, this.y + h - 10);
        }
        this.y += h + 10;

        if (captionLines && captionLines.length) {
            g.font = font(600, 9, FONT_BODY);
            g.fillStyle = C.purple;
            g.fillText(captionLines[0], MARGIN, this.y + 8);
            this.y += 14;
            for (var i = 1; i < captionLines.length; i++) {
                this.para(captionLines[i], { size: 8.2, color: C.muted, lineHeight: 11.5 });
            }
        }
        this.y += 8;
        return true;
    };

    function scoreColor(score) {
        if (score >= 0.75) return '#1c8a3c';
        if (score >= 0.5) return '#d9700a';
        return '#b3261e';
    }

    function roundRect(g, x, y, w, h, r) {
        g.beginPath();
        g.moveTo(x + r, y);
        g.lineTo(x + w - r, y);
        g.quadraticCurveTo(x + w, y, x + w, y + r);
        g.lineTo(x + w, y + h - r);
        g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        g.lineTo(x + r, y + h);
        g.quadraticCurveTo(x, y + h, x, y + h - r);
        g.lineTo(x, y + r);
        g.quadraticCurveTo(x, y, x + r, y);
        g.closePath();
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * PAGE BUILDERS
     * ═══════════════════════════════════════════════════════════════════════ */

    function fmtDate(d, langCode) {
        function p(n) { return (n < 10 ? '0' : '') + n; }
        return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() +
            ' · ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function pageCoverPages(pt, model) {
        var tr = pt.tr, meta = model.meta;
        var pages = [];
        pt.beginPage('');
        var g = pt.g;

        // PREMIUM badge
        g.font = font(700, 8, FONT_BODY);
        var badge = tr('arch_report_badge_premium');
        var bw = g.measureText(badge).width + 16;
        g.fillStyle = C.orangeSoft;
        roundRect(g, MARGIN, pt.y, bw, 16, 8);
        g.fill();
        g.strokeStyle = C.orange;
        g.lineWidth = 0.8;
        roundRect(g, MARGIN, pt.y, bw, 16, 8);
        g.stroke();
        g.fillStyle = C.orange;
        g.fillText(badge, MARGIN + 8, pt.y + 11.5);
        pt.y += 30;

        pt.h1(tr('arch_report_title'));
        pt.para(tr('arch_report_subtitle', {
            radius: meta.radiusKm != null ? meta.radiusKm : (meta.sideM / 2000).toFixed(0),
            area: meta.areaKm2
        }), {
            size: 11, color: C.muted, lineHeight: 16, spaceAfter: 10
        });
        pt.rule();

        pt.card(84);
        pt.kv(tr('arch_report_generated_on'), fmtDate(meta.generatedAt, pt.lang));
        pt.kv(tr('arch_report_analysis_point'), meta.center.lat.toFixed(5) + ', ' + meta.center.lng.toFixed(5));
        pt.kv(tr('arch_report_area'), tr('arch_report_area_value', {
            radius: meta.radiusKm != null ? meta.radiusKm : (meta.sideM / 2000).toFixed(0),
            area: meta.areaKm2
        }));
        pt.kv(tr('arch_report_language'), pt.lang === 'ro' ? 'Română' : 'English');
        pt.kv(tr('arch_report_duration'), meta.ms + ' ms');
        pt.y += 12;

        pt.h2(tr('arch_report_results_found', { n: model.results.length }));
        if (!model.results.length) {
            pt.para(tr('arch_report_no_results'), { color: C.muted });
        } else {
            var headerRow = [
                tr('arch_report_tbl_result'), tr('arch_report_tbl_class'), tr('arch_report_score'),
                tr('arch_report_tbl_focus'), tr('arch_report_tbl_coords'), tr('arch_report_tbl_period')
            ];
            var allRows = model.results.map(function (r) {
                return [
                    r.label,
                    r.classificationLabel,
                    r.scorePct + '%',
                    areaText(r.focus, pt.lang),
                    r.lat.toFixed(5) + ', ' + r.lng.toFixed(5),
                    r.period.key ? tr('arch_period_' + r.period.key) : tr('arch_report_period_unknown')
                ];
            });
            var offset = 0;
            while (offset < allRows.length) {
                var baseOffset = offset;
                pt.table(
                    [headerRow].concat(allRows.slice(baseOffset)),
                    [74, 78, 40, 96, 104, CONTENT_W - 392],
                    {
                        boldFirstCol: true,
                        colorFor: function (ci, ri) {
                            var rec = model.results[baseOffset + ri - 1];
                            return ci === 2 && rec ? scoreColor(rec.score) : null;
                        }
                    }
                );
                var drawn = Math.max(1, pt.tableRowsDrawn || 0);
                offset += drawn;
                if (offset < allRows.length) {
                    pages.push(pt.finishPage());
                    pt.beginPage(tr('arch_report_title'));
                }
            }
        }

        // If 5–10 result rows pushed the cursor too close to the footer for the
        // intro + data-sources + disclaimer sections, continue cleanly on page 2.
        if (pt.y > PAGE.h - 335) {
            pages.push(pt.finishPage());
            pt.beginPage(tr('arch_report_title'));
        } else {
            pt.space(6);
        }

        pt.h2(tr('arch_report_cover_intro_title'));
        pt.para(tr('arch_report_cover_intro'), { color: C.muted, spaceAfter: 8 });
        if (meta.baseline) {
            var coverNotes = [tr('arch_report_method_baseline', { mode: baselineModeLabel(tr, meta) })];
            if (meta.bonuses) {
                var coverBonuses = [];
                if (meta.bonuses.roads) coverBonuses.push(tr('arch_report_bonus_roads'));
                if (meta.bonuses.potential) coverBonuses.push(tr('arch_report_bonus_potential'));
                if (meta.bonuses.lidar) coverBonuses.push(tr('arch_report_bonus_lidar'));
                coverNotes.push(tr('arch_report_method_bonuses', {
                    list: coverBonuses.length ? coverBonuses.join(' · ') : tr('arch_report_bonus_none')
                }));
            }
            pt.para(coverNotes.join('  ·  '), { color: C.muted, spaceAfter: 8 });
        }

        pt.h2(tr('arch_report_sources_used'));
        pt.para([
            apmBaselineTitle(tr, meta) + ' — ' + (meta.apmAvailable
                ? tr('arch_report_src_available')
                : (meta.apmUnreadable ? tr('arch_report_src_unreadable') : tr('arch_report_src_unavailable'))),
            tr('arch_report_src_pot_title') + ' — ' + tr('arch_report_src_pot_state', {
                n: meta.bubblesInArea, total: meta.bubblesCount
            }),
            tr('arch_report_src_lidar_title') + ' — ' + (meta.ignoreLidar
                ? tr('arch_report_lidar_ignored_desc')
                : tr('arch_report_src_lidar_state', { n: meta.lidarInArea, total: meta.lidarCount })),
            tr('arch_report_src_roads_title') + ' — ' + tr('arch_report_src_roads_state', {
                n: meta.romanRoadSegments || 0
            }),
            'UAT — ' + (meta.uatAvailable ? tr('arch_report_src_available') : tr('arch_report_src_unavailable'))
        ].join('\n'), { color: C.muted, spaceAfter: 10 });

        if (pt.y + 68 > PAGE.h - 46) {
            pages.push(pt.finishPage());
            pt.beginPage(tr('arch_report_title'));
        }
        pt.card(58, C.orangeSoft);
        pt.para(tr('arch_report_disclaimer'), {
            x: MARGIN + 10, width: CONTENT_W - 20, size: 8, color: C.muted, lineHeight: 11.5
        });
        pages.push(pt.finishPage());
        return pages;
    }

    function pageCover(pt, model) {
        return pageCoverPages(pt, model)[0];
    }

    function pageMethod(pt, model) {
        var tr = pt.tr, meta = model.meta;
        pt.beginPage(tr('arch_report_method_title'));

        pt.h2(tr('arch_report_sources_title'));
        [[apmBaselineTitle(tr, meta), tr('arch_report_src_apm_desc')],
         [tr('arch_report_src_pot_title'), tr('arch_report_src_pot_desc')],
         [tr('arch_report_src_lidar_title'), tr('arch_report_src_lidar_desc')],
         [tr('arch_report_src_roads_title'), tr('arch_report_src_roads_desc')]].forEach(function (row) {
            pt.h3(row[0]);
            pt.para(row[1], { color: C.muted, spaceAfter: 6 });
        });

        pt.h2(tr('arch_report_exclusions_title'));
        pt.para(tr('arch_report_excl_uat', { dist: model.thresholds.uatClearanceM }), { spaceAfter: 5 });
        pt.para(tr('arch_report_excl_sites', {
            radius: model.thresholds.siteRadiusM, buffer: model.thresholds.siteBufferM,
            total: model.thresholds.siteRadiusM + model.thresholds.siteBufferM
        }), { spaceAfter: 5 });
        pt.para(tr('arch_report_excl_apm'), { spaceAfter: 8 });

        pt.h2(tr('arch_report_score_title'));
        pt.para(tr('arch_report_score_formula', {
            wapm: Math.round(model.weights.apm * 100),
            wpot: Math.round(model.weights.potential * 100),
            wlidar: Math.round(model.weights.lidar * 100),
            wroads: Math.round((model.weights.romanRoads || 0) * 100)
        }), { color: C.muted, spaceAfter: 6 });
        // The chosen baseline and the enabled bonuses are documented on the
        // cover (and the weight table below marks every switched-off bonus);
        // no extra lines here, or the rejected-reason table would be pushed
        // off this page.
        pt.table([
            [tr('arch_report_tbl_component'), tr('arch_report_tbl_weight'), tr('arch_report_tbl_how')],
            [apmBaselineTitle(tr, meta), Math.round(model.weights.apm * 100) + '%', tr('arch_report_weight_apm')],
            [tr('arch_report_src_pot_title'), Math.round(model.weights.potential * 100) + '%',
                meta.bonuses && !meta.bonuses.potential ? tr('arch_report_bonus_off') : tr('arch_report_weight_potential')],
            ['LIDAR Scanner', Math.round(model.weights.lidar * 100) + '%',
                meta.ignoreLidar ? tr('arch_report_lidar_ignored_desc')
                    : (meta.bonuses && !meta.bonuses.lidar ? tr('arch_report_bonus_off') : tr('arch_report_weight_lidar'))],
            [tr('arch_report_src_roads_title'), '+' + Math.round((model.weights.romanRoads || 0) * 100) + '%',
                meta.bonuses && !meta.bonuses.roads ? tr('arch_report_bonus_off') : tr('arch_report_weight_roads')]
        ], [120, 58, CONTENT_W - 178], { boldFirstCol: true });

        pt.h2(tr('arch_report_classify_title'));
        pt.para(tr('arch_report_class_thresholds', {
            high: Math.round(root.ARCH_REPORT_CONFIG.CLASSIFY.HIGH_FROM * 100),
            medium: Math.round(root.ARCH_REPORT_CONFIG.CLASSIFY.MEDIUM_FROM * 100)
        }), { color: C.muted, spaceAfter: 8 });

        pt.h2(tr('arch_report_area_stats_title'));
        pt.table([
            [tr('arch_report_tbl_indicator'), tr('arch_report_tbl_value')],
            [tr('arch_report_stat_sites'), String(meta.sitesCount)],
            [tr('arch_report_stat_bubbles'), meta.bubblesInArea + ' / ' + meta.bubblesCount],
            [tr('arch_report_stat_lidar'), meta.lidarInArea + ' / ' + meta.lidarCount],
            [tr('arch_report_stat_roads'), String(meta.romanRoadSegments || 0)],
            [tr('arch_report_stat_seeds'), String(meta.seeds)],
            [tr('arch_report_stat_candidates'), String(meta.candidates)]
        ], [CONTENT_W - 90, 90]);

        var rejKeys = Object.keys(meta.rejected || {});
        if (rejKeys.length) {
            pt.h2(tr('arch_report_rejected_title'));
            pt.table(
                [[tr('arch_report_tbl_reason'), tr('arch_report_tbl_value')]].concat(rejKeys.map(function (k) {
                    return [tr('arch_report_rej_' + k), String(meta.rejected[k])];
                })),
                [CONTENT_W - 90, 90]
            );
        }
        return pt.finishPage();
    }

    function apmExplanation(tr, parts) {
        if (!parts.apmKnown) {
            return parts.apmWaived ? tr('arch_report_apm_explain_unknown_waived') : tr('arch_report_apm_explain_unknown');
        }
        var key = 'arch_report_apm_explain_' + String(parts.apmCls).replace('.', '');
        return tr(key);
    }

    /* The APM component can come from the published 2.0 raster or from the
     * Next-Gen engine (custom curves, or a model trained on a period) — the
     * cover, method, score and sources pages must all say which. */
    function apmBaselineTitle(tr, meta) {
        return (meta && meta.baseline && meta.baseline !== 'apm20')
            ? tr('arch_report_src_apm_nextgen_title')
            : tr('arch_report_src_apm_title');
    }

    var BASELINE_MODE_KEYS = {
        apm20: 'arch_report_baseline_apm20',
        nextgen_custom: 'arch_report_baseline_custom',
        nextgen_train: 'arch_report_baseline_train'
    };

    function baselineModeLabel(tr, meta) {
        var b = (meta && meta.baseline) || 'apm20';
        var label = tr(BASELINE_MODE_KEYS[b] || BASELINE_MODE_KEYS.apm20);
        if (b === 'nextgen_train' && meta.baselinePeriod) label += ' · ' + meta.baselinePeriod;
        return label;
    }

    function pageResult(pt, model, res) {
        var tr = pt.tr;
        pt.beginPage(res.label);
        var g = pt.g;

        // score header card
        pt.card(62);
        g.font = font(600, 11, FONT_HEAD);
        g.fillStyle = C.ink;
        g.fillText(res.classificationLabel, MARGIN + 10, pt.y + 12);
        g.font = font(400, 8, FONT_BODY);
        g.fillStyle = C.muted;
        g.fillText(res.lat.toFixed(5) + ', ' + res.lng.toFixed(5) +
            (res.annotated ? '  ·  ' + tr('arch_report_flag_lidar') : ''), MARGIN + 10, pt.y + 24);
        pt.y += 28;
        pt.scoreBar(res.score, { x: MARGIN + 10, width: CONTENT_W - 20 });
        pt.y += 4;

        pt.h2(tr('arch_report_how_score'));
        var w = res.weights;
        pt.table([
            [tr('arch_report_tbl_component'), tr('arch_report_tbl_weight'), tr('arch_report_tbl_value'), tr('arch_report_tbl_contribution')],
            [apmBaselineTitle(tr, model.meta) + ' · ' + tr('arch_report_apm_class_' + (res.parts.apmCls || 0)),
             Math.round(w.apm * 100) + '%', pct(res.parts.apmComp), pct(res.parts.apmComp * w.apm)],
            [tr('arch_report_src_pot_title'),
             Math.round(w.potential * 100) + '%', pct(res.parts.potentialComp), pct(res.parts.potentialComp * w.potential)],
            ['LIDAR Scanner',
             res.parts.lidarApplied ? Math.round(w.lidar * 100) + '%' : '—',
             res.parts.lidarApplied ? pct(res.parts.lidarComp) : '—',
             res.parts.lidarApplied ? pct(res.parts.lidarComp * w.lidar) : '—'],
            [tr('arch_report_src_roads_title'),
             res.parts.romanRoadApplied ? '+' + Math.round((w.romanRoads || 0) * 100) + '%' : '—',
             res.parts.romanRoadApplied ? pct(res.parts.romanRoadComp) : '—',
             res.parts.romanRoadApplied ? pct(res.parts.romanRoadComp * (w.romanRoads || 0)) : '—'],
            [tr('arch_report_tbl_total'), '100%', '', res.scorePct + '%']
        ], [CONTENT_W - 190, 58, 62, 70], { boldFirstCol: true });

        pt.h2(apmBaselineTitle(tr, model.meta));
        pt.para(tr('arch_report_apm_line', {
            cls: tr('arch_report_apm_class_' + (res.parts.apmCls || 0)),
            value: pct(res.parts.apmComp)
        }), { spaceAfter: 4 });
        pt.para(apmExplanation(tr, res.parts), { color: C.muted, size: 8.2, spaceAfter: 4 });

        pt.h2(tr('arch_report_src_pot_title'));
        if (res.parts.potentialApplied === false) {
            pt.para(tr('arch_report_bonus_off'), { color: C.muted, size: 8.4, spaceAfter: 4 });
        } else if (res.parts.potentialInside) {
            pt.para(tr('arch_report_pot_inside_long', { score: pct(res.parts.potentialScore) }), { size: 8.4, spaceAfter: 2 });
        } else if (res.parts.potentialDistM !== null && res.parts.potentialDistM <= root.ARCH_REPORT_CONFIG.POTENTIAL.PROXIMITY_M) {
            pt.para(tr('arch_report_pot_near_long', {
                dist: pt.fmtM(res.parts.potentialDistM), score: pct(res.parts.potentialScore)
            }), { size: 8.4, spaceAfter: 2 });
        } else {
            pt.para(tr('arch_report_pot_none_long', { n: res.parts.bubblesInArea }), { size: 8.4, spaceAfter: 2 });
        }
        if (res.parts.potentialFactors) {
            pt.para(tr('arch_report_pot_factors', {
                nearby: res.parts.potentialFactors.nearbyCount,
                avg: pt.fmtM(res.parts.potentialFactors.avgDistM),
                density: res.parts.potentialFactors.densityCount,
                closest: pt.fmtM(res.parts.potentialFactors.closestSiteM),
                tri: res.parts.potentialFactors.triQuality.toFixed(2)
            }), { size: 8.2, color: C.muted, spaceAfter: 8 });
        } else {
            pt.space(6);
        }

        pt.h2(tr('arch_report_lidar_section_title'));
        if (res.parts.lidarIgnored) {
            pt.para(tr('arch_report_lidar_ignored_desc'), { color: C.muted, size: 8.4, spaceAfter: 4 });
        } else if (res.parts.lidarBonus === false) {
            pt.para(tr('arch_report_bonus_off'), { color: C.muted, size: 8.4, spaceAfter: 4 });
        } else if (res.annotated && res.parts.lidarPoint) {
            pt.para(tr('arch_report_lidar_hit_long', {
                title: res.parts.lidarPoint.category || res.parts.lidarPoint.name || '—'
            }), { size: 8.4, spaceAfter: 4 });
        } else if (res.parts.lidarDistM !== null && res.parts.lidarDistM <= root.ARCH_REPORT_CONFIG.LIDAR.PROXIMITY_M) {
            pt.para(tr('arch_report_lidar_near_long', {
                dist: pt.fmtM(res.parts.lidarDistM),
                title: res.parts.lidarPoint ? (res.parts.lidarPoint.category || res.parts.lidarPoint.name || '—') : '—'
            }), { size: 8.4, spaceAfter: 4 });
        } else {
            pt.para(tr('arch_report_lidar_none_long'), { color: C.muted, size: 8.4, spaceAfter: 4 });
        }

        pt.h2(tr('arch_report_roads_section_title'));
        if (res.parts.romanRoadBonus === false) {
            pt.para(tr('arch_report_bonus_off'), { color: C.muted, spaceAfter: 8 });
        } else if (res.parts.romanRoadApplied) {
            pt.para(tr('arch_report_roads_near_long', { dist: pt.fmtM(res.parts.romanRoadDistM) }), { spaceAfter: 8 });
        } else {
            pt.para(tr('arch_report_roads_none_long'), { color: C.muted, spaceAfter: 8 });
        }

        pt.h2(tr('arch_report_uat_line_title'));
        pt.para(tr('arch_report_uat_ok_long', { dist: pt.fmtM(res.parts.uatClearanceM) }), {
            size: 8.2, color: C.muted, spaceAfter: 6
        });

        pt.h2(tr('arch_report_period_title'));
        if (res.period.key) {
            pt.para(tr('arch_report_period_line', {
                period: tr('arch_period_' + res.period.key),
                confidence: Math.round(res.period.confidence * 100)
            }), { size: 8.6, spaceAfter: 2 });
        } else {
            pt.para(tr('arch_report_period_none'), { size: 8.6, color: C.muted, spaceAfter: 2 });
        }
        if (res.period.evidence && res.period.evidence.length) {
            res.period.evidence.forEach(function (ev, i) {
                var dating;
                if (ev.datingFromName) {
                    dating = tr('arch_report_period_from_name', {
                        period: ev.periodKey ? tr('arch_period_' + ev.periodKey) : tr('arch_report_period_unknown')
                    });
                } else {
                    dating = ev.period || tr('arch_report_period_unknown');
                }
                pt.para((i + 1) + '. ' + ev.name + ' — ' + dating + ' · ' + pt.fmtM(ev.distanceM) +
                    (ev.ran ? ' · RAN ' + ev.ran : ''), { size: 8, spaceAfter: 1 });
            });
        }

        pt.h2(tr('arch_report_sites_title'));
        pt.table(
            [[tr('arch_report_tbl_site'), tr('arch_report_tbl_period'), tr('arch_report_tbl_type'),
              tr('arch_report_tbl_dist'), tr('arch_report_tbl_link')]]
                .concat(res.nearestSites.map(function (s) {
                    return [
                        s.name + (s.locality ? ' (' + s.locality + ')' : ''),
                        s.period || (s.datingFromName && s.periodKey
                            ? tr('arch_period_' + s.periodKey) + ' †'
                            : tr('arch_report_period_unknown')),
                        s.type || '—',
                        pt.fmtM(s.distanceM),
                        s.url || '—'
                    ];
                })),
            [148, 96, 86, 52, CONTENT_W - 382],
            { size: 7.6, rowHeight: 14 }
        );
        return pt.finishPage();
    }

    // Exact areas of the drawn outlines. Figures come from the same smoothed
    // rings the map and the figures use, so they always agree with them.
    function fmtNumber(n, digits, langCode) {
        return Number(n || 0).toLocaleString(langCode === 'ro' ? 'ro-RO' : 'en-GB', {
            minimumFractionDigits: digits, maximumFractionDigits: digits
        });
    }

    function areaText(focus, langCode) {
        var m2 = focus && focus.areaM2 ? focus.areaM2 : 0;
        return fmtNumber(m2, 0, langCode) + ' m² (' + fmtNumber(m2 / 10000, 2, langCode) + ' ha)';
    }

    // Third page of a result: the sizes of the focus and survey outlines.
    function pageResultFocus(pt, model, res) {
        var tr = pt.tr, f = res.focus || {};
        var langCode = pt.lang;
        pt.beginPage(res.label + ' — ' + tr('arch_report_focus_section_title'));

        pt.h2(tr('arch_report_focus_section_title'));
        var diamM = f.areaM2 ? 2 * Math.sqrt(f.areaM2 / Math.PI) : 0;
        pt.table([
            [tr('arch_report_tbl_indicator'), tr('arch_report_tbl_value')],
            [tr('arch_report_focus_area_label'), areaText(f, langCode)],
            [tr('arch_report_focus_perim_label'), pt.fmtM(f.perimeterM || 0)],
            [tr('arch_report_focus_diam_label'), pt.fmtM(Math.round(diamM))],
            [tr('arch_report_survey_area_label'), areaText({ areaM2: f.secondaryAreaM2 }, langCode)],
            [tr('arch_report_focus_centre_label'), res.lat.toFixed(5) + ', ' + res.lng.toFixed(5)]
        ], [CONTENT_W - 210, 210], { boldFirstCol: true, size: 8.8, rowHeight: 18 });
        pt.space(10);

        pt.para(tr('arch_report_focus_line', {
            area: areaText(f, langCode),
            diam: pt.fmtM(Math.round(diamM)),
            perim: pt.fmtM(f.perimeterM || 0),
            survey: areaText({ areaM2: f.secondaryAreaM2 }, langCode)
        }), { spaceAfter: 8 });
        pt.para(tr('arch_report_focus_caveat'), { size: 8.2, color: C.muted, spaceAfter: 8 });
        return pt.finishPage();
    }

    function pct(v) { return (v === null || v === undefined) ? '—' : Math.round(v * 100) + '%'; }

    // Second page of a result: estimated period + the nearest known sites.
    // The evidence list ALWAYS prints the raw dating text the database has
    // (or an explicit note when the dating came from the site name), so the
    // reader sees exactly what the records say even when no period key can be
    // derived.
    function pageResultSites(pt, model, res) {
        var tr = pt.tr;
        pt.beginPage(res.label + ' — ' + tr('arch_report_period_title'));

        pt.h2(tr('arch_report_period_title'));
        if (res.period.key) {
            pt.para(tr('arch_report_period_line', {
                period: tr('arch_period_' + res.period.key),
                confidence: Math.round(res.period.confidence * 100)
            }), { spaceAfter: 4 });
            pt.para(tr('arch_report_period_explain'), { color: C.muted, spaceAfter: 8 });
        } else {
            pt.para(tr('arch_report_period_none'), { color: C.muted, spaceAfter: 8 });
        }

        if (res.period.evidence.length) {
            pt.h3(tr('arch_report_period_evidence'));
            res.period.evidence.forEach(function (ev, i) {
                var dating;
                if (ev.datingFromName) {
                    dating = tr('arch_report_period_from_name', {
                        period: ev.periodKey ? tr('arch_period_' + ev.periodKey) : tr('arch_report_period_unknown')
                    });
                } else {
                    dating = ev.period || tr('arch_report_period_unknown');
                }
                pt.para((i + 1) + '. ' + ev.name + ' — ' + dating + ' · ' + pt.fmtM(ev.distanceM) +
                    (ev.ran ? ' · RAN ' + ev.ran : ''), { size: 8.6, spaceAfter: 2 });
                if (ev.url) {
                    pt.para(ev.url, { size: 7.4, color: C.purple, spaceAfter: 5 });
                }
            });
        }

        pt.space(4);
        pt.h2(tr('arch_report_sites_title'));
        pt.table(
            [[tr('arch_report_tbl_site'), tr('arch_report_tbl_period'), tr('arch_report_tbl_type'),
              tr('arch_report_tbl_dist'), tr('arch_report_tbl_link')]]
                .concat(res.nearestSites.map(function (s) {
                    return [
                        s.name + (s.locality ? ' (' + s.locality + ')' : ''),
                        s.period || (s.datingFromName && s.periodKey
                            ? tr('arch_period_' + s.periodKey) + ' †'
                            : tr('arch_report_period_unknown')),
                        s.type || '—',
                        pt.fmtM(s.distanceM),
                        s.url || '—'
                    ];
                })),
            [148, 96, 86, 52, CONTENT_W - 382],
            { size: 8, rowHeight: 15 }
        );
        pt.para(tr('arch_report_sites_note'), { size: 8, color: C.muted });
        return pt.finishPage();
    }

    function figurePages(pt, model, figures, images) {
        var tr = pt.tr;
        var pages = [];
        var items = [];
        if (figures.apm) items.push({ key: 'apm', fig: figures.apm });
        if (figures.lidar) items.push({ key: 'lidar', fig: figures.lidar });
        if (figures.potential) items.push({ key: 'potential', fig: figures.potential });
        if (!items.length) return pages;

        var started = false;
        items.forEach(function (item) {
            var caption = [tr('arch_report_fig_' + item.key + '_title')];
            caption.push(tr('arch_report_fig_' + item.key + '_caption'));
            if (item.fig.used && item.fig.used.length) {
                caption.push(tr('arch_report_fig_sources', { list: item.fig.used.join(' · ') }));
            }
            if (item.fig.missing && item.fig.missing.length) {
                caption.push(tr('arch_report_fig_missing', { list: item.fig.missing.join(' · ') }));
            }
            if (!started || !pt.figure(item.fig, caption, { image: images[item.key], width: CONTENT_W })) {
                pages.push(pt.finishPage());
                pt.beginPage(tr('arch_report_figures_title'));
                started = true;
                pt.figure(item.fig, caption, { image: images[item.key], width: CONTENT_W });
            }
        });
        pages.push(pt.finishPage());
        return pages;
    }

    function pageSources(pt, model) {
        var tr = pt.tr;
        pt.beginPage(tr('arch_report_sources_page_title'));

        pt.h2(tr('arch_report_provenance_title'));
        var detectLabOrigin = (window.DetectLabSite && window.DetectLabSite.canonicalOrigin) || 'https://detectlab.ro';
        var apmProvenance = (model.meta && model.meta.baseline && model.meta.baseline !== 'apm20')
            ? tr('arch_report_src_apm_nextgen_title') + ' — ' + baselineModeLabel(tr, model.meta) + ' (DetectLab APM Next-Gen engine)'
            : detectLabOrigin + ' — APM 2.0 (Cloudflare R2 tiles)';
        [[apmBaselineTitle(tr, model.meta), apmProvenance],
         ['UAT', detectLabOrigin + ' — UAT raster (Cloudflare R2 tiles) · © geo-spatial.org'],
         [tr('arch_report_src_pot_title'), 'RAN / CIMEC — https://ran.cimec.ro'],
         [tr('arch_report_src_lidar_title'), 'DetectLab LIDAR Scanner (CSV) + LIDAR RO hillshade tiles']].forEach(function (row) {
            pt.kv(row[0], row[1]);
        });
        pt.space(6);

        pt.h2(tr('arch_report_legend_title'));
        pt.para(tr('arch_report_legend_apm'), { color: C.muted, spaceAfter: 4 });
        pt.para(tr('arch_report_legend_results', { n: model.results.length || 3 }), { color: C.muted, spaceAfter: 4 });
        pt.para(tr('arch_report_legend_potential'), { color: C.muted, spaceAfter: 10 });

        pt.h2(tr('arch_report_disclaimer_title'));
        pt.para(tr('arch_report_disclaimer_full'), { color: C.muted, spaceAfter: 8 });
        pt.para(tr('arch_report_generated_by'), { size: 8.5, color: C.faint });
        return pt.finishPage();
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * BUILD
     * ═══════════════════════════════════════════════════════════════════════ */

    function loadImageFromDataUrl(dataUrl) {
        return new Promise(function (resolve) {
            if (!dataUrl) return resolve(null);
            var img = new root.Image();
            img.onload = function () { resolve(img); };
            img.onerror = function () { resolve(null); };
            img.src = dataUrl;
        });
    }

    /**
     * @param {Object} model   report model from js/archeo-report.js
     * @param {Object} figures {apm, lidar, potential} — captureFigure() outputs
     * @param {Object} opts    { tr, fmtM, lang }
     * @returns {Promise<DetectLabPdf>}
     */
    function build(model, figures, opts) {
        opts = opts || {};
        var tr = opts.tr || function (k) { return k; };
        var fmtM = opts.fmtM || function (m) { return Math.round(m) + ' m'; };
        figures = figures || {};

        var images = {};
        return Promise.all(Object.keys(figures).map(function (key) {
            var fig = figures[key];
            if (!fig || !fig.dataUrl) return null;
            return loadImageFromDataUrl(fig.dataUrl).then(function (img) { images[key] = img; });
        })).then(function () {
            var pt = new Painter(tr, fmtM, opts.lang);
            var pages = [];

            pageCoverPages(pt, model).forEach(function (p) { pages.push(p); });
            pages.push(pageMethod(pt, model));
            model.results.forEach(function (res) {
                pages.push(pageResult(pt, model, res));
                pages.push(pageResultSites(pt, model, res));
                pages.push(pageResultFocus(pt, model, res));
            });
            figurePages(pt, model, figures, images).forEach(function (p) { pages.push(p); });
            pages.push(pageSources(pt, model));

            var pdf = new root.DetectLabPdf({
                size: 'a4',
                title: tr('arch_report_title') + ' — ' +
                    model.meta.center.lat.toFixed(4) + ', ' + model.meta.center.lng.toFixed(4),
                author: 'DetectLab',
                subject: tr('arch_report_subtitle', {
                    radius: model.meta.radiusKm != null ? model.meta.radiusKm : '',
                    area: model.meta.areaKm2
                }),
                keywords: 'DetectLab, APM 2.0, LIDAR, RAN, CIMEC, archaeology',
                date: model.meta.generatedAt
            });
            pages.forEach(function (dataUrl) {
                pdf.addImagePage(dataUrl, Math.round(PAGE.w * SCALE), Math.round(PAGE.h * SCALE));
            });
            pdf.pageCount = pages.length;
            return pdf;
        });
    }

    root.DetectLabReportPdf = {
        build: build,
        Painter: Painter,
        PAGE: PAGE,
        SCALE: SCALE,
        MARGIN: MARGIN,
        COLORS: C,
        scoreColor: scoreColor
    };
})(typeof window !== 'undefined' ? window : globalThis);
