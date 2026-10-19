/* Client logic for one replay window: fetch data, render the ledger, and draw
   per-model TradingView Lightweight Charts with a Long/Short position box
   (green reward / red risk) on an overlay canvas. */
(function () {
  "use strict";
  var SIG = [];
  var current = -1;
  var hidden = {};
  var PANELS = [
    { key: "claim", r: "claim_r", exit: "claim", short: "Claim" },
    { key: "hold", r: "r_hold", exit: "hold", short: "Hold" },
    { key: "entry", r: "r_entry", exit: "entry", short: "Entry" },
    { key: "tp1", r: "r_tp1", exit: "tp1", short: "TP1" },
    { key: "tp2", r: "r_tp2", exit: "tp2", short: "TP2" }
  ];
  var UNRESOLVED = ["OPEN", "OPEN/ACTIVE", "WAITING_ENTRY", "AMBIGUOUS", "NO_ENTRY", "NEEDS_REVIEW", "PRICE_UNAVAILABLE"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function esc(v) {
    return String(v === null || v === undefined ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtNum(x, dec) {
    if (x === null || x === undefined) return "\u2014";
    var s = (+x).toFixed(dec === undefined ? 6 : dec);
    return s.replace(/0+$/, "").replace(/\.$/, "");
  }
  function fmtR(x) {
    if (x === null || x === undefined) return "\u2014";
    return (x >= 0 ? "+" : "") + x.toFixed(2) + "R";
  }
  function fmtPrice(p) {
    if (p === null || p === undefined) return "\u2014";
    var a = Math.abs(+p);
    var d = a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : a >= 0.0001 ? 8 : 10;
    return (+p).toFixed(d).replace(/0+$/, "").replace(/\.$/, "");
  }
  function signClass(x) {
    if (x === null || x === undefined) return "zero";
    return x > 0 ? "pos" : x < 0 ? "neg" : "zero";
  }
  function snap(t, candles) {
    if (!candles || !candles.length) return t;
    var best = candles[0][0], bd = Infinity;
    for (var i = 0; i < candles.length; i++) {
      var d = Math.abs(candles[i][0] - t);
      if (d < bd) { bd = d; best = candles[i][0]; }
    }
    return best;
  }
  function wib(ts) {
    var d = new Date((ts + 7 * 3600) * 1000);
    return {
      day: d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear(),
      clock: ("0" + d.getUTCHours()).slice(-2) + ":" + ("0" + d.getUTCMinutes()).slice(-2) + ":" + ("0" + d.getUTCSeconds()).slice(-2)
    };
  }
  function pad2(n) { return ("0" + n).slice(-2); }
  function tFmt(t, withDate) {
    var d = new Date((t + 7 * 3600) * 1000);
    var hm = pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
    return withDate ? (d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + hm) : hm;
  }
  function observedReached(status) {
    if (status === "TP_FULL") return 4;
    var m = /^TP(\d+)(?:_THEN_SL)?$/.exec(status);
    return m ? parseInt(m[1], 10) : 0;
  }
  function pill(text, tone) {
    if (!tone) {
      var u = String(text).toUpperCase();
      if (u === "TP_FULL" || u === "MATCH" || /^TP[1-4]$/.test(u)) tone = "pos";
      else if (u === "SL" || u.indexOf("SL_") === 0 || u === "CLAIM_LOSS") tone = "neg";
      else if (/_THEN_SL$/.test(u)) tone = "warn";
      else if (["WAITING_ENTRY", "NO_ENTRY", "OPEN", "PRICE_UNAVAILABLE"].indexOf(u) !== -1) tone = "muted";
      else tone = "neutral";
    }
    return '<span class="pill ' + tone + '">' + esc(text) + "</span>";
  }
  function verdictOf(core, sig) {
    var claim = core.provider_status, status = sig.status;
    var obs = observedReached(status);
    if (claim === "open") {
      if (status === "SL") return { label: "OPEN", tone: "muted", note: "Listed open \u00b7 replay hit stop" };
      if (status === "TP_FULL") return { label: "OPEN", tone: "muted", note: "Listed open \u00b7 replay reached final target" };
      var tm = /^TP(\d+)(?:_THEN_SL)?$/.exec(status);
      if (tm) return { label: "OPEN", tone: "muted", note: "Listed open \u00b7 replay reached TP" + tm[1] + (/_THEN_SL$/.test(status) ? " then stopped" : "") };
      if (status === "WAITING_ENTRY" || status === "NO_ENTRY") return { label: "OPEN", tone: "muted", note: "Listed open \u00b7 entry not filled" };
      return { label: "OPEN", tone: "muted", note: "Listed open \u00b7 unresolved" };
    }
    if (UNRESOLVED.indexOf(status) !== -1) {
      var notes = { WAITING_ENTRY: "Still waiting for entry", NO_ENTRY: "Entry never touched in 4 days",
                    PRICE_UNAVAILABLE: "No usable price history", AMBIGUOUS: "Same candle touched SL and TP",
                    OPEN: "Replay still open" };
      return { label: "OPEN", tone: "muted", note: notes[status] || "Unresolved / open" };
    }
    if (claim === "closed_loss") {
      if (obs >= 1) return { label: "CONFLICT", tone: "neg", note: "Claimed loss but price reached TP" + obs };
      return { label: "MATCH", tone: "pos", note: "Claim loss = stop hit" };
    }
    var label = claim === "closed_win" ? "TP4/win" : claim.toUpperCase();
    var claimReached = claim === "closed_win" ? 4 : parseInt(claim.slice(2), 10);
    if (status === "SL") return { label: "CONFLICT", tone: "neg", note: "Claimed " + label + " but stop hit first" };
    if (status === "TP_FULL") return { label: "MATCH", tone: "pos", note: "Reached final target" };
    if (obs >= claimReached) {
      if (/_THEN_SL$/.test(status)) return { label: "PARTIAL", tone: "warn", note: "Reached TP" + obs + " then stopped out" };
      return { label: "MATCH", tone: "pos", note: "Reached TP" + obs };
    }
    return { label: "CONFLICT", tone: "neg", note: "Claimed " + label + " but only TP" + obs + " reached" };
  }
  function levelsCell(core) {
    var tps = "";
    core.targets.forEach(function (t, i) {
      tps += '<span class="lv-pair"><span class="lv-k">TP' + (i + 1) + '</span><span class="lv-v tp">' + esc(fmtNum(t)) + "</span></span>";
    });
    return '<div class="lv"><div class="lv-row"><span class="lv-k">E</span><span class="lv-v entry">' + esc(fmtNum(core.entry)) +
      '</span><span class="lv-k sl">SL1</span><span class="lv-v sl">' + esc(fmtNum(core.sl)) + '</span></div><div class="lv-row">' + tps + "</div></div>";
  }

  function rowHtml(s, i) {
    var core = s.core, t = wib(core.posted_at), v = verdictOf(core, s);
    var cr = s.claim_r, ar = s.r_hold;
    var search = [core.pair, core.provider_status, s.status, core.side, v.label, v.note, fmtR(cr), fmtR(ar)].join(" ").toLowerCase();
    return '<tr data-idx="' + i + '" data-conflict="' + (v.tone === "neg" ? 1 : 0) + '" data-partial="' + (v.tone === "warn" ? 1 : 0) +
      '" data-open="' + (UNRESOLVED.indexOf(s.status) !== -1 ? 1 : 0) + '" data-text="' + esc(search) + '" data-posted="' + core.posted_at + '"' +
      ' data-claim="' + (cr === null || cr === undefined ? -999 : cr) + '"' +
      ' data-r_hold="' + (s.r_hold === null || s.r_hold === undefined ? -999 : s.r_hold) + '"' +
      ' data-r_entry="' + (s.r_entry === null || s.r_entry === undefined ? -999 : s.r_entry) + '"' +
      ' data-r_tp1="' + (s.r_tp1 === null || s.r_tp1 === undefined ? -999 : s.r_tp1) + '"' +
      ' data-r_tp2="' + (s.r_tp2 === null || s.r_tp2 === undefined ? -999 : s.r_tp2) + '">' +
      '<td class="c-pair"><span class="pair">' + esc(core.pair.slice(0, -4)) + '<span class="sfx">USDT</span></span></td>' +
      '<td class="c-time"><span class="d">' + esc(t.day) + '</span><span class="h">' + esc(t.clock) + '</span><span class="tz">UTC+7</span></td>' +
      '<td><span class="dir ' + (core.side === "BUY" ? "long" : "short") + '">' + esc(core.side) + "</span></td>" +
      '<td class="c-levels">' + levelsCell(core) + "</td>" +
      '<td><span class="claim">' + esc(core.provider_status) + "</span></td>" +
      "<td>" + pill(s.status) + "</td>" +
      "<td>" + pill(v.label, v.tone) + "</td>" +
      '<td class="c-note">' + esc(v.note) + "</td>" +
      '<td class="num ' + signClass(cr) + '">' + fmtR(cr) + "</td>" +
      '<td class="num ' + signClass(s.r_hold) + '">' + fmtR(s.r_hold) + "</td>" +
      '<td class="num ' + signClass(s.r_entry) + '">' + fmtR(s.r_entry) + "</td>" +
      '<td class="num ' + signClass(s.r_tp1) + '">' + fmtR(s.r_tp1) + "</td>" +
      '<td class="num ' + signClass(s.r_tp2) + '">' + fmtR(s.r_tp2) + "</td>" +
      '<td><button class="chartbtn" data-open="' + i + '" type="button">Charts</button></td></tr>';
  }

  var rows = [];
  var searchEl, rowCountEl, filter = "all", total = 0;

  function apply() {
    var q = (searchEl.value || "").trim().toLowerCase(), shown = 0;
    rows.forEach(function (tr) {
      var ok = true;
      if (q && tr.getAttribute("data-text").indexOf(q) === -1) ok = false;
      if (ok && filter === "conflict" && tr.getAttribute("data-conflict") !== "1") ok = false;
      if (ok && filter === "partial" && tr.getAttribute("data-partial") !== "1") ok = false;
      if (ok && filter === "open" && tr.getAttribute("data-open") !== "1") ok = false;
      tr.classList.toggle("hidden", !ok);
      if (ok) shown++;
    });
    rowCountEl.innerHTML = "<b>" + shown + "</b> of " + total + " rows";
  }

  var sortState = { col: "posted", dir: "desc" };
  function updateArrows() {
    document.querySelectorAll(".arrow").forEach(function (a) {
      var col = a.getAttribute("data-arrow");
      a.textContent = col === sortState.col ? (sortState.dir === "asc" ? "\u25b2" : "\u25bc") : "";
    });
  }

  /* ---------- modal + charts ---------- */
  var modal, live = [];
  function destroy() {
    live.forEach(function (o) {
      try { o.ro.disconnect(); } catch (e) {}
      try { o.chart.remove(); } catch (e) {}
    });
    live = [];
  }
  function buildChart(key, sig) {
    var box = document.getElementById("chart_" + key);
    if (!box) return;
    box.innerHTML = "";
    var candles = (sig.candles || []).map(function (c) {
      return { time: c[0], open: c[1], high: c[2], low: c[3], close: c[4] };
    });
    if (!candles.length) { box.innerHTML = '<div style="padding:20px;color:#8e887a">No candle data.</div>'; return; }
    var core = sig.core, buy = core.side === "BUY";
    var chart = LightweightCharts.createChart(box, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#8e887a", fontSize: 11 },
      grid: { vertLines: { color: "rgba(140,130,110,.10)" }, horzLines: { color: "rgba(140,130,110,.10)" } },
      rightPriceScale: { borderColor: "rgba(140,130,110,.3)" },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: "rgba(140,130,110,.3)",
                   tickMarkFormatter: function (t, type) { return tFmt(t, type < 3); } },
      crosshair: { mode: 0 },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true, axisDoubleClickReset: true },
      localization: { priceFormatter: function (p) { return fmtPrice(p); },
                      timeFormatter: function (t) { return tFmt(t, true); } }
    });
    var series = chart.addCandlestickSeries({
      upColor: "#0a7a4a", downColor: "#ae2a21", borderVisible: false,
      wickUpColor: "#0a7a4a", wickDownColor: "#ae2a21"
    });
    series.setData(candles);
    var levels = [[core.sl, "#ae2a21", "SL1", 2]];
    core.targets.forEach(function (t, i) { levels.push([t, "#0a7a4a", "TP" + (i + 1), 2]); });
    levels.forEach(function (lv) {
      series.createPriceLine({ price: lv[0], color: lv[1], lineWidth: 1, lineStyle: lv[3], axisLabelVisible: true, title: lv[2] });
    });
    var ex = (sig.exits || {})[key] || null;
    var r = sig[PANELS.filter(function (p) { return p.key === key; })[0].r];
    var marks = [];
    if (sig.entry_at) {
      marks.push({ time: snap(sig.entry_at / 1000, sig.candles), position: buy ? "belowBar" : "aboveBar",
                   color: "#0d6b62", shape: buy ? "arrowUp" : "arrowDown", text: "Entry" });
    }
    Object.keys(sig.tp_times || {}).forEach(function (k) {
      var t = sig.tp_times[k];
      if (t) marks.push({ time: snap(t / 1000, sig.candles), position: buy ? "aboveBar" : "belowBar",
                          color: "rgba(10,122,74,.65)", shape: "circle", text: k });
    });
    if (sig.entry_at && ex && ex.time) {
      var pos = r !== null && r !== undefined && r >= 0 ? (buy ? "aboveBar" : "belowBar") : (buy ? "belowBar" : "aboveBar");
      marks.push({ time: snap(ex.time / 1000, sig.candles), position: pos,
                   color: (r >= 0 ? "#0a7a4a" : "#ae2a21"), shape: "arrowUp", text: "Exit " + fmtR(r) });
    }
    marks.sort(function (a, b) { return a.time - b.time; });
    series.setMarkers(marks);

    var canvas = document.createElement("canvas");
    canvas.className = "posbox";
    box.appendChild(canvas);
    function resize() {
      var dpr = window.devicePixelRatio || 1;
      var w = box.clientWidth, h = box.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      return { w: w, h: h, dpr: dpr };
    }
    function render() {
      var dim = resize();
      var ctx = canvas.getContext("2d");
      ctx.setTransform(dim.dpr, 0, 0, dim.dpr, 0, 0);
      ctx.clearRect(0, 0, dim.w, dim.h);
      if (!sig.entry_at) return;
      var ts = chart.timeScale();
      var paneW = (ts.width && ts.width()) || dim.w;
      var startT = core.posted_at + 60;   /* assumed 1-minute execution delay */
      var x1 = ts.timeToCoordinate(snap(startT, sig.candles));
      var endTime = (ex && ex.time) ? ex.time / 1000 : sig.candles[sig.candles.length - 1][0];
      var exitX = ts.timeToCoordinate(snap(endTime, sig.candles));
      if (x1 === null || x1 === undefined) x1 = 0;
      if (exitX === null || exitX === undefined) exitX = paneW;
      if (exitX < x1) { var tmp = x1; x1 = exitX; exitX = tmp; }
      /* Let the position box run a little past the exit (never a thin sliver) and stay on screen. */
      var MIN_W = 34, TAIL = 16;
      var x2;
      if (ex && ex.time) {
        x2 = exitX + TAIL;
        if (x2 < x1 + MIN_W) x2 = x1 + MIN_W;
        if (x2 > paneW - 2) x2 = paneW - 2;
        if (x2 < x1) x2 = x1;
      } else {
        x2 = Math.min(exitX, paneW - 2);
      }
      var yEntry = series.priceToCoordinate(core.entry);
      var ySl = series.priceToCoordinate(core.sl);
      var yTp = series.priceToCoordinate(core.targets[core.targets.length - 1]);
      if (yEntry === null || ySl === null || yTp === null) return;
      var w = Math.max(1, x2 - x1);
      ctx.fillStyle = "rgba(174,42,33,.20)";
      ctx.fillRect(x1, Math.min(yEntry, ySl), w, Math.abs(ySl - yEntry));
      ctx.strokeStyle = "rgba(174,42,33,.55)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x1 + .5, Math.min(yEntry, ySl) + .5, w - 1, Math.abs(ySl - yEntry) - 1);
      ctx.fillStyle = "rgba(10,122,74,.20)";
      ctx.fillRect(x1, Math.min(yEntry, yTp), w, Math.abs(yTp - yEntry));
      ctx.strokeStyle = "rgba(10,122,74,.55)";
      ctx.strokeRect(x1 + .5, Math.min(yEntry, yTp) + .5, w - 1, Math.abs(yTp - yEntry) - 1);
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(render);
    var ro = new ResizeObserver(function () { render(); });
    ro.observe(box);
    chart.timeScale().fitContent();
    requestAnimationFrame(render);
    live.push({ chart: chart, ro: ro });
  }
  function setPanel(key, sig, rVal, noteText) {
    var rEl = document.getElementById("r_" + key);
    if (rEl) {
      rEl.textContent = fmtR(rVal);
      rEl.className = "r " + (rVal === null || rVal === undefined ? "" : (rVal >= 0 ? "pos" : "neg"));
    }
    var nEl = document.getElementById("note_" + key);
    if (nEl) nEl.textContent = noteText;
    buildChart(key, sig);
  }
  function renderPanels(sig) {
    destroy();
    PANELS.forEach(function (p) {
      var panel = document.getElementById("chart_" + p.key).closest(".chart-panel");
      if (hidden[p.key]) { panel.classList.add("off"); return; }
      panel.classList.remove("off");
      var ex = (sig.exits || {})[p.exit];
      var note = !sig.entry_at ? "Entry never touched within the 4-day window \u2014 no fill."
        : (ex ? "exit " + ex.reason + " @ " + fmtPrice(ex.price) : "No exit (still open).");
      setPanel(p.key, sig, sig[p.r], note);
    });
  }

  /* ---------- event timeline ---------- */
  function tlPrice(kind, core) {
    if (kind === "ENTRY" || kind === "RETRACE_ENTRY") return core.entry;
    if (kind === "SL") return core.sl;
    var m = /^(?:RETRACE_)?TP([1-4])$/.exec(kind);
    return m ? core.targets[parseInt(m[1], 10) - 1] : null;
  }
  function tlGrossR(price, core) {
    if (price === null || price === undefined) return null;
    var d = core.side === "BUY" ? 1 : -1;
    var risk = d * (core.entry - core.sl);
    if (!risk) return null;
    return d * (price - core.entry) / risk;
  }
  function tlLabel(kind) {
    if (kind === "ENTRY") return "Entry filled";
    if (kind === "SL") return "Stop loss hit";
    var m = /^TP([1-4])$/.exec(kind);
    if (m) return "TP" + m[1] + " reached";
    var r = /^RETRACE_TP([1-4])$/.exec(kind);
    if (r) return "Retraced to TP" + r[1];
    if (kind === "RETRACE_ENTRY") return "Retraced to entry";
    return kind;
  }
  function tlTone(kind) {
    if (kind === "ENTRY") return "entry";
    if (kind === "SL") return "sl";
    if (/^RETRACE/.test(kind)) return "retrace";
    if (/^TP/.test(kind)) return "tp";
    return "meta";
  }
  function tShort(ms) {
    var w = wib(ms / 1000);
    return w.day.split(" ").slice(0, 2).join(" ") + " " + w.clock.slice(0, 5);
  }
  function renderTimeline(sig) {
    var list = document.getElementById("tlList");
    var chips = document.getElementById("tlExits");
    if (!list) return;
    var core = sig.core, items = [];
    items.push({ t: core.posted_at * 1000, kind: "PUB", label: "Published \u00b7 provider status ", meta: core.provider_status });
    items.push({ t: core.posted_at * 1000 + 60000, kind: "EXEC", label: "Execution window opens (T+1 min)" });
    (sig.tl || []).forEach(function (e) {
      var kind = e[0], ts = e[1];
      var price = tlPrice(kind, core);
      items.push({ t: ts, kind: kind, price: price, r: tlGrossR(price, core) });
    });
    if (!sig.entry_at) {
      items.push({ t: null, kind: "NOTE", label: "Entry never touched within the 4-day window \u2014 no fill." });
    }
    var rows = items.map(function (it) {
      var priceTxt = (it.price === null || it.price === undefined) ? "" : fmtPrice(it.price);
      var rTxt = (it.r === null || it.r === undefined) ? "" : fmtR(it.r);
      var tone = it.kind === "PUB" || it.kind === "EXEC" || it.kind === "NOTE" ? "meta" : tlTone(it.kind);
      var label = it.label || tlLabel(it.kind);
      var tail = it.meta ? "<em>" + esc(it.meta) + "</em>" : "";
      return '<li class="tl-item"><span class="tl-time">' + (it.t === null ? "\u2014" : esc(tShort(it.t))) + "</span>" +
        '<span class="tl-dot ' + tone + '"></span>' +
        '<span class="tl-label">' + label + tail + "</span>" +
        '<span class="tl-price">' + esc(priceTxt) + "</span>" +
        '<span class="tl-r ' + signClass(it.r === null || it.r === undefined ? null : it.r) + '">' + esc(rTxt) + "</span></li>";
    }).join("");
    list.innerHTML = rows;
    var out = [];
    PANELS.forEach(function (p) {
      var ex = (sig.exits || {})[p.exit] || null;
      var r = sig[p.r];
      var cls = r === null || r === undefined ? "" : (r > 0 ? "pos" : r < 0 ? "neg" : "");
      var where = ex ? ex.reason + " @ " + fmtPrice(ex.price) : "no exit";
      out.push('<span class="tl-exit ' + cls + '">' + p.short + " <b>" + fmtR(r) + "</b> \u00b7 " + esc(where) + "</span>");
    });
    chips.innerHTML = out.join("");
  }
  function open(idx) {
    var sig = SIG[idx];
    if (!sig) return;
    current = idx;
    var core = sig.core, v = verdictOf(core, sig);
    document.getElementById("mTitle").textContent = core.pair + "  \u00b7  " + core.side;
    var dir = document.getElementById("mDir");
    dir.textContent = core.side;
    dir.className = "dir " + (core.side === "BUY" ? "long" : "short");
    document.getElementById("mMeta").innerHTML =
      "Published <b>" + esc(core.provider_status) + "</b> (" + esc(core.risk_level) + ")" +
      " \u00b7 observed <b>" + esc(sig.status) + "</b>" +
      " \u00b7 verdict <b>" + esc(v.label) + "</b> \u2014 " + esc(v.note) +
      " \u00b7 candles " + esc(sig.interval) + " \u00b7 " + esc(core.pair) + " USD-M Futures";
    modal.classList.add("on");
    modal.setAttribute("aria-hidden", "false");
    hidden = {};
    document.querySelectorAll("#modelToggle .mtog").forEach(function (b) { b.setAttribute("aria-pressed", "true"); });
    renderPanels(sig);
    renderTimeline(sig);
  }

  function wireTable() {
    document.querySelectorAll("th[data-sort]").forEach(function (th) {
      th.addEventListener("click", function () {
        var col = th.getAttribute("data-col"), type = th.getAttribute("data-sort");
        var dir = (sortState.col === col && sortState.dir === "asc") ? "desc" : "asc";
        sortState = { col: col, dir: dir };
        var tbody = document.getElementById("tbody");
        rows.sort(function (a, b) {
          var av, bv;
          if (type === "time") {
            av = parseFloat(a.getAttribute("data-posted")); bv = parseFloat(b.getAttribute("data-posted"));
          } else {
            av = parseFloat(a.getAttribute("data-" + col)); bv = parseFloat(b.getAttribute("data-" + col));
          }
          return dir === "asc" ? av - bv : bv - av;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
        updateArrows();
      });
    });
    updateArrows();
    document.querySelectorAll(".chartbtn").forEach(function (b) {
      b.addEventListener("click", function () { open(parseInt(b.getAttribute("data-open"), 10)); });
    });
  }

  /* ---------- sticky ledger header (follows page scroll) ---------- */
  function wireStickyHead() {
    var wrap = document.querySelector(".table-wrap");
    if (!wrap) return;
    var table = wrap.querySelector("table");
    var realThead = table ? table.querySelector("thead") : null;
    if (!realThead) return;
    var realHeads = realThead.querySelectorAll("th");
    var nav = document.querySelector(".nav");

    var sticky = document.createElement("div");
    sticky.className = "sticky-head";
    sticky.setAttribute("aria-hidden", "true");
    var viewport = document.createElement("div");
    viewport.className = "sh-viewport";
    var stable = document.createElement("table");
    stable.className = "sh-table";
    stable.appendChild(realThead.cloneNode(true));
    viewport.appendChild(stable);
    sticky.appendChild(viewport);
    document.body.appendChild(sticky);
    var cloneHeads = stable.querySelectorAll("th");

    function syncArrows() {
      for (var i = 0; i < cloneHeads.length; i++) {
        var src = realHeads[i];
        if (!src) continue;
        var sa = src.querySelector(".arrow"), ca = cloneHeads[i].querySelector(".arrow");
        if (ca) ca.textContent = sa ? sa.textContent : "";
      }
    }
    function size() {
      var w = 0;
      for (var i = 0; i < realHeads.length; i++) {
        var cw = realHeads[i].getBoundingClientRect().width;
        if (cloneHeads[i]) cloneHeads[i].style.width = cw + "px";
        w += cw;
      }
      stable.style.width = Math.ceil(w) + "px";
      syncArrows();
    }
    function update() {
      var rect = wrap.getBoundingClientRect();
      var navH = nav ? nav.offsetHeight : 0;
      var headH = realThead.getBoundingClientRect().height || 40;
      var show = rect.top < navH && rect.bottom > navH + headH;
      sticky.classList.toggle("on", show);
      if (!show) return;
      sticky.style.top = navH + "px";
      sticky.style.left = rect.left + "px";
      sticky.style.width = rect.width + "px";
      viewport.scrollLeft = wrap.scrollLeft;
      syncArrows();
    }

    stable.addEventListener("click", function (e) {
      var th = e.target && e.target.closest ? e.target.closest("th[data-sort]") : null;
      if (!th) return;
      var idx = Array.prototype.indexOf.call(cloneHeads, th);
      if (idx >= 0 && realHeads[idx]) realHeads[idx].click();
      syncArrows();
    });

    size();
    update();
    requestAnimationFrame(function () { size(); update(); });
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", function () { size(); update(); });
    wrap.addEventListener("scroll", update, { passive: true });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { size(); update(); });
    }
  }

  function init(data) {
    SIG = (data.signals || []).slice().sort(function (a, b) { return b.core.posted_at - a.core.posted_at; });
    var tbody = document.getElementById("tbody");
    var parts = new Array(SIG.length);
    for (var i = 0; i < SIG.length; i++) parts[i] = rowHtml(SIG[i], i);
    tbody.innerHTML = parts.join("");
    rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
    total = rows.length;
    searchEl = document.getElementById("search");
    rowCountEl = document.getElementById("rowCount");
    searchEl.addEventListener("input", apply);
    document.querySelectorAll(".seg button").forEach(function (b) {
      b.addEventListener("click", function () {
        document.querySelectorAll(".seg button").forEach(function (o) { o.setAttribute("aria-pressed", "false"); });
        b.setAttribute("aria-pressed", "true");
        filter = b.getAttribute("data-filter");
        apply();
      });
    });
    wireTable();
    apply();
    wireStickyHead();

    modal = document.getElementById("modal");
    document.getElementById("mClose").addEventListener("click", function () { modal.classList.remove("on"); destroy(); });
    var zr = document.getElementById("zoomReset");
    if (zr) zr.addEventListener("click", function () {
      live.forEach(function (o) { try { o.chart.timeScale().fitContent(); } catch (e) {} });
    });
    modal.addEventListener("click", function (e) { if (e.target === modal) { modal.classList.remove("on"); destroy(); } });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && modal.classList.contains("on")) { modal.classList.remove("on"); destroy(); }
    });
    document.querySelectorAll("#modelToggle .mtog").forEach(function (b) {
      b.addEventListener("click", function () {
        var key = b.getAttribute("data-model");
        hidden[key] = !hidden[key];
        b.setAttribute("aria-pressed", hidden[key] ? "false" : "true");
        if (current >= 0) renderPanels(SIG[current]);
      });
    });

    if (location.hash.indexOf("#sig=") === 0) {
      var params = {};
      location.hash.slice(1).split("&").forEach(function (p) {
        var kv = p.split("="); params[kv[0]] = kv[1];
      });
      var i = parseInt(params.sig, 10);
      if (!isNaN(i) && i >= 0 && i < SIG.length) {
        open(i);
        if (params.hide) {
          params.hide.split(",").forEach(function (k) { hidden[k] = true; });
          document.querySelectorAll("#modelToggle .mtog").forEach(function (b) {
            b.setAttribute("aria-pressed", hidden[b.getAttribute("data-model")] ? "false" : "true");
          });
          renderPanels(SIG[i]);
        }
      }
    }
  }

  fetch(window.DATA_URL).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(init).catch(function (err) {
    var t = document.getElementById("tbody");
    if (t) t.innerHTML = '<tr><td colspan="14" style="padding:24px;color:#ae2a21">Could not load ' +
      esc(window.DATA_URL) + " \u2014 " + esc(err && err.message ? err.message : err) + "</td></tr>";
  });
})();
