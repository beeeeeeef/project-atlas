/* Project Atlas viewer.
   Vanilla JS, zero dependencies, zero network. Reads window.__ARCH__ (model.json).
   The renderer never computes layout: every node carries build-time x/y/w/h. */
(function () {
  'use strict';

  var M = window.__ARCH__ || {};

  /* ---------- 调用链索引 ----------
     整张函数级调用图随产物一起发下来（构建期编码，几 KB 到几十 KB），
     这里只建正反两张邻接表。遍历时按需展开，所以深度和分支都不做截断。 */
  var CALLS = (function () {
    var c = M.calls;
    if (!c || !c.pool || !c.edges) return null;
    var pool = c.pool, up = {}, down = {}, byId = {};
    pool.forEach(function (p, i) {
      var id = 'fn:' + p[1] + '::' + p[0];
      byId[id] = i;
    });
    c.edges.forEach(function (e) {
      var a = e[0], b = e[1], conf = e[2];
      (down[a] = down[a] || []).push([b, conf]);
      (up[b] = up[b] || []).push([a, conf]);
    });
    return { pool: pool, up: up, down: down, byId: byId };
  })();
  var VIEWS = M.views || {};
  var FLOWS = M.flows || [];
  var INTRO = M.intro || {};
  var START = M.startHere || [];
  var TYPES = M.types || null;
  var TECH = (M.meta && M.meta.techstack) || [];
  var NS = 'http://www.w3.org/2000/svg';

  var KIND_CN = {
    layer: '分层', module: '模块', file: '文件', 'class': '类',
    function: '函数', external: '外部', data: '数据'
  };

  /* ---------- tiny helpers ---------- */
  function byId(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function svgEl(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) {
      if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(e);
    return e;
  }
  function fmt(n) { return String(n == null ? '—' : n); }

  /* text measurement shares the CSS font stacks (single source of truth) */
  var rootCS = getComputedStyle(document.documentElement);
  var SANS = (rootCS.getPropertyValue('--sans') || 'system-ui, sans-serif').trim();
  var MONO = (rootCS.getPropertyValue('--mono') || 'ui-monospace, monospace').trim();
  var F_LABEL = '600 13px ' + SANS;
  var F_SUB = '400 10.5px ' + SANS;
  var F_BADGE = '600 10px ' + SANS;
  var F_ETX = '500 9.5px ' + SANS;

  var measureCtx = document.createElement('canvas').getContext('2d');
  function measure(s, font) {
    measureCtx.font = font;
    return measureCtx.measureText(s).width;
  }
  function wrapText(str, maxW, font) {
    if (!str) return [];
    var lines = [], cur = '';
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (measure(cur + ch, font) > maxW && cur) { lines.push(cur); cur = ch; }
      else cur += ch;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function fitText(s, max, font) {
    s = String(s == null ? '' : s);
    if (max <= 2) return '';
    if (measure(s, font) <= max) return s;
    var chars = Array.from(s);
    var lo = 0, hi = chars.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (measure(chars.slice(0, mid).join('') + '…', font) <= max) lo = mid; else hi = mid - 1;
    }
    return lo <= 0 ? '' : chars.slice(0, lo).join('') + '…';
  }

  /* ---------- dom ---------- */
  var stage = byId('stage');
  var stagewrap = byId('stagewrap');
  var cam = byId('cam');
  var layerEdges = byId('edges');
  var layerNodes = byId('nodes');
  var layerLabels = byId('elabels');
  var panel = byId('panel');
  var crumbsEl = byId('crumbs');
  var vtitleEl = byId('vtitle');
  var vnoteEl = byId('vnote');
  var legendEl = byId('legend');
  var flowbar = byId('flowbar');
  var qEl = byId('q');
  var resultsEl = byId('results');
  var levelsEl = byId('levels');
  var statsEl = byId('stats');
  var warnbar = byId('warnbar');
  var toastEl = byId('toast');
  var projectEl = byId('project');
  var geninfoEl = byId('geninfo');

  /* ---------- state ---------- */
  var st = {
    cur: null,
    k: 1, tx: 0, ty: 0,
    sel: null,
    hover: null,
    panel: false,
    hist: [],
    q: '', qIdx: -1, qOpen: false,
    fitRetries: 0,
    userZoomed: false,  /* 用户手动缩放/平移过，就不再自动 fit */
    tab: 'overview',
    expanded: {},       /* 数据页：typeId -> true（字段全展开） */
    stack: [],          /* 返回栈：{tab, view, node} */
    flow: null,
    type: null,
    callOpen: {}       /* 调用链展开状态：dir:idx -> true */
  };

  var nodeEls = {};      /* id -> <g> */
  var edgeEls = [];      /* {a,b,path,tx,bg} */
  var adj = {};          /* id -> {otherId:true} */
  var edgeIndex = [];    /* {from,to,kind,label,confidence,weight} */
  var kindOf = {};       /* id -> kind */
  var nodeSearch = [];   /* flattened index for search */

  function curView() { return VIEWS[st.cur] || null; }

  /* ---------- model index ---------- */
  function buildIndex() {
    nodeSearch = [];
    for (var vid in VIEWS) {
      if (!Object.prototype.hasOwnProperty.call(VIEWS, vid)) continue;
      var v = VIEWS[vid];
      (v.nodes || []).forEach(function (n) {
        nodeSearch.push({
          view: vid, viewTitle: v.title || vid,
          id: n.id, label: n.label || '', kind: n.kind || '',
          sub: n.sub || '', xref: n.xref || '', summary: n.summary || '',
          hay: [n.label, n.kind, n.sub, n.xref, n.summary, n.id, v.title]
            .join(' ').toLowerCase()
        });
      });
    }
  }

  function findNodeAnywhere(id) {
    for (var vid in VIEWS) {
      if (!Object.prototype.hasOwnProperty.call(VIEWS, vid)) continue;
      var arr = VIEWS[vid].nodes || [];
      for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return { viewId: vid, node: arr[i] };
    }
    return null;
  }

  /* ---------- camera ---------- */
  function applyCam() {
    cam.setAttribute('transform', 'translate(' + st.tx.toFixed(2) + ',' + st.ty.toFixed(2) + ') scale(' + st.k.toFixed(4) + ')');
    var z = st.k < 0.62 ? 'far' : (st.k < 0.86 ? 'mid' : 'near');
    if (stage.getAttribute('data-z') !== z) stage.setAttribute('data-z', z);
  }

  function stageSize() {
    var r = stage.getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  }

  function fitView() {
    var v = curView();
    var sz = stageSize();
    // 布局/字体还没稳定时 stage 会被量成极小值，此时算出的 k 会掉到下限。
    // 宁可不画，也不要留下一个「图缩成一小团」的首屏。
    if (!st.fitRetries) st.fitRetries = 0;
    if ((sz.w < 240 || sz.h < 240) && st.fitRetries < 30) {
      st.fitRetries++;
      requestAnimationFrame(fitView);
      return;
    }
    st.fitRetries = 0;
    if (!v || !v.nodes || !v.nodes.length) { st.k = 1; st.tx = sz.w / 2; st.ty = sz.h / 2; applyCam(); return; }
    var pad = 52;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    v.nodes.forEach(function (n) {
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + num(n.w, 160)); y1 = Math.max(y1, n.y + num(n.h, 56));
    });
    var bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
    /* the view header floats over the canvas: keep the graph clear of it */
    var head = byId('viewhead');
    var headH = (head && !head.hidden) ? head.offsetHeight + 18 : 0;
    var padTop = headH + 10, padBot = 46;
    var avW = Math.max(80, sz.w - pad * 2), avH = Math.max(80, sz.h - padTop - padBot);
    var k = Math.min(avW / bw, avH / bh, 1.45);
    st.k = clamp(k, 0.3, 2.6);
    st.tx = (sz.w - bw * st.k) / 2 - x0 * st.k;
    st.ty = padTop + (avH - bh * st.k) / 2 - y0 * st.k;
    applyCam();
  }

  function zoomAt(clientX, clientY, factor) {
    var r = stage.getBoundingClientRect();
    var cx = clientX - r.left, cy = clientY - r.top;
    var nk = clamp(st.k * factor, 0.28, 2.8);
    var f = nk / st.k;
    st.tx = cx - f * (cx - st.tx);
    st.ty = cy - f * (cy - st.ty);
    st.k = nk;
    st.userZoomed = true;
    applyCam();
  }

  /* keep the selected node clear of the detail panel */
  function revealNode(id) {
    var v = curView(); if (!v) return;
    var n = null;
    (v.nodes || []).forEach(function (m) { if (m.id === id) n = m; });
    if (!n) return;
    if (!st.panel) return;
    var sz = stageSize();
    var panelW = Math.max(300, Math.min(380, sz.w * 0.5));
    var right = (n.x + num(n.w, 160)) * st.k + st.tx;
    var need = right - (sz.w - panelW - 24);
    if (need > 0) { st.tx -= need; applyCam(); }
    var left = n.x * st.k + st.tx;
    if (left < 16) { st.tx += (16 - left); applyCam(); }
  }

  /* ---------- edge geometry ---------- */
  function rectOf(n) { return { x: n.x, y: n.y, w: num(n.w, 160), h: num(n.h, 56) }; }

  function edgeGeom(a, b) {
    var ar = rectOf(a), br = rectOf(b);
    var ac = { x: ar.x + ar.w / 2, y: ar.y + ar.h / 2 };
    var bc = { x: br.x + br.w / 2, y: br.y + br.h / 2 };
    var dx = bc.x - ac.x, dy = bc.y - ac.y;
    var horiz = Math.abs(dx) > Math.abs(dy) * 0.85;
    var p0, p1, cx, cy;
    if (horiz) {
      var sx = dx >= 0 ? 1 : -1;
      p0 = { x: ac.x + sx * ar.w / 2, y: ac.y };
      p1 = { x: bc.x - sx * br.w / 2, y: bc.y };
      cx = (p0.x + p1.x) / 2; cy = p0.y;
    } else {
      var sy = dy >= 0 ? 1 : -1;
      p0 = { x: ac.x, y: ac.y + sy * ar.h / 2 };
      p1 = { x: bc.x, y: bc.y - sy * br.h / 2 };
      cx = p0.x; cy = (p0.y + p1.y) / 2;
    }
    var ex = p1.x - cx, ey = p1.y - cy;
    var el = Math.sqrt(ex * ex + ey * ey) || 1;
    var tipX = p1.x - ex / el * 6.5, tipY = p1.y - ey / el * 6.5;
    var r1 = Math.round;
    return {
      d: 'M' + r1(p0.x) + ' ' + r1(p0.y) + ' Q' + r1(cx) + ' ' + r1(cy) + ' ' + r1(tipX) + ' ' + r1(tipY),
      p0: p0, c: { x: cx, y: cy }, p1: { x: tipX, y: tipY }
    };
  }

  /* point on a quadratic bezier */
  function qPoint(gm, t) {
    var u = 1 - t;
    return {
      x: u * u * gm.p0.x + 2 * u * t * gm.c.x + t * t * gm.p1.x,
      y: u * u * gm.p0.y + 2 * u * t * gm.c.y + t * t * gm.p1.y
    };
  }

  /* place the label where it does not vanish behind a node box */
  function labelSpot(gm, byNodeId, skipA, skipB) {
    var ts = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.12, 0.88];
    for (var i = 0; i < ts.length; i++) {
      var p = qPoint(gm, ts[i]);
      var hit = false;
      for (var id in byNodeId) {
        if (id === skipA || id === skipB) continue;
        var n = byNodeId[id], w = num(n.w, 160), h = num(n.h, 56);
        if (p.x > n.x - 6 && p.x < n.x + w + 6 && p.y > n.y - 6 && p.y < n.y + h + 6) { hit = true; break; }
      }
      if (!hit) return p;
    }
    return qPoint(gm, 0.5);
  }

  /* ---------- render ---------- */
  function clearLayer(g) { while (g.firstChild) g.removeChild(g.firstChild); }

  function renderView() {
    var v = curView(); if (!v) return;
    clearLayer(layerEdges); clearLayer(layerNodes); clearLayer(layerLabels);
    nodeEls = {}; edgeEls = []; adj = {}; kindOf = {}; edgeIndex = [];

    var byNodeId = {};
    (v.nodes || []).forEach(function (n, i) {
      byNodeId[n.id] = n; kindOf[n.id] = n.kind; adj[n.id] = adj[n.id] || {}; n.__i = i;
    });

    var edges = v.edges || [];
    var maxW = 1;
    edges.forEach(function (e) { maxW = Math.max(maxW, num(e.weight, 1)); });

    edges.forEach(function (e) {
      var a = byNodeId[e.from], b = byNodeId[e.to];
      if (!a || !b || a === b) return;
      var gm = edgeGeom(a, b);
      var conf = (e.confidence || 'EXTRACTED').toUpperCase();
      var cls = 'edge c-' + conf + ' k-' + (e.kind || 'depends');
      var g = svgEl('g', { 'class': cls }, layerEdges);
      var sw = 1 + Math.sqrt(num(e.weight, 1) / maxW) * 2.3;
      var p = svgEl('path', {
        'class': 'e-path', d: gm.d,
        'stroke-width': sw.toFixed(2),
        'marker-end': 'url(#arw' + (conf === 'INFERRED' ? '-inf' : (conf === 'MIXED' ? '-mix' : '')) + ')'
      }, g);

      var rec = { a: e.from, b: e.to, g: g, path: p, lab: null, edge: e };
      if (e.label != null && String(e.label) !== '') {
        var txt = String(e.label);
        var at = labelSpot(gm, byNodeId, e.from, e.to);
        var tw = measure(txt, F_ETX) + 8;
        var lg = svgEl('g', { 'class': 'edge-lab c-' + conf }, layerLabels);
        svgEl('rect', {
          'class': 'e-bg', x: (at.x - tw / 2).toFixed(1), y: (at.y - 8).toFixed(1),
          width: tw.toFixed(1), height: 14, rx: 3
        }, lg);
        var t = svgEl('text', {
          'class': 'e-tx', x: at.x.toFixed(1), y: (at.y + 3.2).toFixed(1),
          'text-anchor': 'middle'
        }, lg);
        t.textContent = txt;
        rec.lab = lg;
      }
      edgeEls.push(rec);
      edgeIndex.push({ from: e.from, to: e.to, kind: e.kind || 'depends', label: e.label, confidence: e.confidence || 'EXTRACTED', weight: num(e.weight, 1) });
      adj[e.from][e.to] = true;
      adj[e.to][e.from] = true;
    });

    (v.nodes || []).forEach(function (n) { renderNode(n, v); });

    applyCam();
    syncFocus();
  }

  function renderNode(n, v) {
    var w = num(n.w, 160), h = num(n.h, 56);
    var drill = n.drill && VIEWS[n.drill] ? n.drill : null;
    var cls = 'node k-' + (n.kind || 'file') + (drill ? ' has-drill' : '') + (n.id === st.sel ? ' sel' : '');
    var g = svgEl('g', {
      'class': cls, 'data-id': n.id,
      transform: 'translate(' + n.x + ' ' + n.y + ')',
      tabindex: '0', role: 'button',
      'aria-label': (n.label || n.id) + ' ' + (KIND_CN[n.kind] || n.kind || '')
    }, layerNodes);

    var inner = svgEl('g', { 'class': 'n-inner', style: '--i:' + (n.__i || 0) }, g);

    svgEl('rect', { 'class': 'n-glow', x: -3, y: -3, width: w + 6, height: h + 6, rx: 11 }, inner);
    svgEl('rect', { 'class': 'n-bg', width: w, height: h, rx: 8 }, inner);
    svgEl('rect', { 'class': 'n-accent', x: 0, y: 8, width: 3, height: Math.max(4, h - 16), rx: 1.5 }, inner);

    // 卡片最多三行：名字 / 一句话介绍 / 规模指标。文字一律完整显示，不截断。
    var hasSub = n.sub != null && String(n.sub) !== '';
    var hasMeta = n.metrics != null && String(n.metrics) !== '';
    var subLinesReady = Array.isArray(n.subLines) ? n.subLines : null;
    var estSubLines = subLinesReady ? subLinesReady.length : (hasSub ? wrapText(n.sub, w - 30, F_SUB).length : 0);

    var badgeW = 0;
    var count = drill ? ((VIEWS[drill].nodes || []).length) : 0;
    var badgeTxt = drill ? ('▸ ' + count) : '';
    if (drill) badgeW = measure(badgeTxt, F_BADGE) + 14;

    var hasCall = ((n.callUp || 0) + (n.callDown || 0)) > 0;
    var padL = 13 + (n.badge ? 24 : 0), padR = 14 + (drill ? badgeW + 10 : 0) + (hasCall ? 46 : 0);
    var maxLabel = w - padL - padR;

    var lineH = 15;
    var blockH = 17 + Math.max(0, estSubLines - 1) * lineH + (hasMeta ? lineH + 2 : 0);
    var labelY = (h - blockH) / 2 + 12;

    var lbl = svgEl('text', { 'class': 'n-label', x: padL, y: labelY.toFixed(1) }, inner);
    lbl.textContent = n.label || n.id;

    var subLines = [];
    if (hasSub) {
      subLines = subLinesReady || wrapText(n.sub, maxLabel, F_SUB);
      subLines.forEach(function (ln, i) {
        var sub = svgEl('text', { 'class': 'n-sub', x: padL, y: (labelY + 17 + i * 15).toFixed(1) }, inner);
        sub.textContent = ln;
      });
    }
    if (hasMeta) {
      var metaY = labelY + 17 + subLines.length * 15 + (subLines.length ? 2 : 0);
      var met = svgEl('text', { 'class': 'n-meta', x: padL, y: metaY.toFixed(1) }, inner);
      met.textContent = n.metrics;
    }

    if (drill) {
      var bw = badgeW, bx = w - bw - 8, by = 7;   /* 角标放右上角，不压正文 */
      svgEl('rect', { 'class': 'badge-bg', x: bx.toFixed(1), y: by.toFixed(1), width: bw.toFixed(1), height: 18, rx: 9 }, inner);
      var bt = svgEl('text', { 'class': 'badge-tx', x: (bx + bw / 2).toFixed(1), y: (by + 12.6).toFixed(1), 'text-anchor': 'middle' }, inner);
      bt.textContent = badgeTxt;
    }

    /* 调用链徽标：有上下游的函数卡片标 ⇅N，让"这张卡能看链"一眼可见 */
    var callN = (n.callUp || 0) + (n.callDown || 0);
    if (callN > 0) {
      var ctxt = '⇅ ' + callN;
      var cw = measure(ctxt, F_BADGE) + 16;
      var cx = w - cw - 8, cy = 7;
      svgEl('rect', { 'class': 'call-badge-bg', x: cx.toFixed(1), y: cy.toFixed(1), width: cw.toFixed(1), height: 18, rx: 9 }, inner);
      var ct = svgEl('text', { 'class': 'call-badge-tx', x: (cx + cw / 2).toFixed(1), y: (cy + 12.6).toFixed(1), 'text-anchor': 'middle' }, inner);
      ct.textContent = ctxt;
    }

    if (n.badge) {
      svgEl('circle', { 'class': 'step-badge-bg', cx: 15, cy: 15, r: 10 }, inner);
      var sbt = svgEl('text', { 'class': 'step-badge-tx', x: 15, y: 18.6, 'text-anchor': 'middle' }, inner);
      sbt.textContent = n.badge;
    }

    nodeEls[n.id] = g;
    g.__node = n;
  }

  /* ---------- focus / selection ---------- */
  function clearFocus() {
    stage.classList.remove('focusing');
    for (var id in nodeEls) nodeEls[id].classList.remove('on');
    edgeEls.forEach(function (e) { e.g.classList.remove('on'); if (e.lab) e.lab.classList.remove('on'); });
  }

  function syncFocus() {
    clearFocus();
    var src = st.hover || st.sel;
    if (!src || !adj[src]) return;
    stage.classList.add('focusing');
    nodeEls[src] && nodeEls[src].classList.add('on');
    for (var other in adj[src]) {
      if (nodeEls[other]) nodeEls[other].classList.add('on');
    }
    edgeEls.forEach(function (e) {
      if (e.a === src || e.b === src) { e.g.classList.add('on'); if (e.lab) e.lab.classList.add('on'); }
    });
  }

  function select(id, flash) {
    st.sel = id;
    for (var k in nodeEls) nodeEls[k].classList.toggle('sel', k === id);
    syncFocus();
    if (flash && nodeEls[id]) {
      var g = nodeEls[id];
      g.classList.remove('flash');
      void g.getBoundingClientRect();
      g.classList.add('flash');
      setTimeout(function () { g.classList.remove('flash'); }, 1300);
    }
  }

  /* ---------- detail panel ---------- */
  function relRows(list, dirLabel) {
    if (!list.length) return '<div class="none">' + dirLabel + '：无</div>';
    var html = '';
    list.forEach(function (r) {
      var other = r.other;
      var canClick = !!nodeEls[other];
      var kindCls = 'k-' + (kindOf[other] || 'file');
      var confTag = (r.confidence === 'INFERRED') ? ' <span class="inf">推断</span>'
        : (r.confidence === 'MIXED' ? ' <span class="inf">聚合</span>' : '');
      var metaTxt = esc(r.kind) + (r.label ? ' · ' + esc(r.label) : '') + confTag;
      html += '<button class="r' + (canClick ? ' clickable' : '') + ' ' + kindCls + '"' +
        (canClick ? ' data-goto="' + esc(other) + '"' : ' disabled') + '>' +
        '<span class="rd"></span>' +
        '<span class="rl"><span class="aris">' + (r.dir === 'in' ? '←' : '→') + '</span>' +
        esc(labelOf(other) || other) + '</span>' +
        '<span class="rm">' + metaTxt + '</span>' +
        '</button>';
    });
    return '<div class="rel">' + html + '</div>';
  }

  function labelOf(id) {
    if (nodeEls[id] && nodeEls[id].__node) return nodeEls[id].__node.label;
    var hit = findNodeAnywhere(id);
    return hit ? hit.node.label : id;
  }

  /* ---------- 调用链 ---------- */
  // 展开状态：dir + 节点索引 + 祖先链（防止环无限展开）
  function callKey(dir, idx) { return dir + ':' + idx; }

  function callStep(idx) {
    var p = CALLS.pool[idx] || ['?', '', ''];
    var id = 'fn:' + p[1] + '::' + p[0];
    var canJump = !!nodeEls[id] || !!findNodeAnywhere(id);
    return { id: id, label: p[0], file: p[1], line: p[2], canJump: canJump };
  }

  function callRows(dir, idx, ancestors, depth) {
    if (depth > 40) return '';
    var list = (dir === 'up' ? CALLS.up : CALLS.down)[idx] || [];
    if (!list.length) return '';
    var html = '<div class="cl-list">';
    list.forEach(function (pair) {
      var ci = pair[0], conf = pair[1];
      var stp = callStep(ci);
      var loop = ancestors.indexOf(ci) >= 0;
      var hasMore = ((dir === 'up' ? CALLS.up : CALLS.down)[ci] || []).length > 0 && !loop;
      var open = st.callOpen[callKey(dir, ci)] === true;
      var confTag = conf === 1 ? '' : ' <span class="inf">推断</span>';
      html += '<div class="cl-node' + (loop ? ' cl-loop' : '') + '">' +
        '<div class="cl-row">' +
        (hasMore
          ? '<button class="cl-tog" data-cl-tog="' + dir + ':' + ci + '" aria-label="展开">' + (open ? '▾' : '▸') + '</button>'
          : '<span class="cl-tog cl-leaf"></span>') +
        (stp.canJump
          ? '<button class="cl-name clickable" data-goto="' + esc(stp.id) + '">' + esc(stp.label) + '</button>'
          : '<span class="cl-name">' + esc(stp.label) + '</span>') +
        confTag +
        (loop ? '<span class="cl-note">↺ 已在上文</span>' : '') +
        '</div>' +
        '<div class="cl-meta">' + esc(stp.file) + (stp.line ? ':' + stp.line : '') + '</div>';
      if (open && hasMore) {
        html += callRows(dir, ci, ancestors.concat([ci]), depth + 1);
      }
      html += '</div>';
    });
    return html + '</div>';
  }

  function callSection(n) {
    if (!CALLS) return '';
    var idx = CALLS.byId[n.id];
    if (idx === undefined) return '';
    var ups = CALLS.up[idx] || [], downs = CALLS.down[idx] || [];
    if (!ups.length && !downs.length) {
      return '<div class="p-sec"><h3>调用链</h3>' +
        '<div class="none">未被任何函数调用，也不调用其他函数（独立函数，通常是入口或工具函数）。</div></div>';
    }
    var out = '<div class="p-sec"><h3>调用链</h3>';
    out += '<div class="cl-legend">上游 = 谁把它叫起来，一路到根；下游 = 它最终会走到哪。点 ▸ 可继续展开，不限深度。</div>';
    if (ups.length) {
      out += '<div class="cl-block"><div class="cl-h">上游 · ' + ups.length + ' 个直接调用者</div>' +
        callRows('up', idx, [idx], 0) + '</div>';
    }
    if (downs.length) {
      out += '<div class="cl-block"><div class="cl-h">下游 · ' + downs.length + ' 个直接被调用的函数</div>' +
        callRows('down', idx, [idx], 0) + '</div>';
    }
    return out + '</div>';
  }

  function panelHTML(n) {
    var ins = n.insight || {};
    var hasIns = !!(ins.role || ins.risk || ins.why);
    var out = [];

    out.push('<div class="p-head">');
    out.push('<div class="p-label">' + esc(n.label || n.id) + '</div>');
    out.push('<button class="p-close" data-close title="关闭 (Esc)" aria-label="关闭">✕</button>');
    out.push('</div>');

    out.push('<div class="p-meta">');
    out.push('<span class="chip k-' + esc(n.kind || 'file') + '">' + esc(KIND_CN[n.kind] || n.kind || '—') + '</span>');
    if (n.sub) out.push('<span class="p-sub">' + esc(n.sub) + '</span>');
    out.push('</div>');

    if (n.summary) out.push('<p class="p-summary">' + esc(n.summary) + '</p>');

    /* insight: model-authored, kept visually separate from extracted facts */
    out.push('<div class="p-sec"><h3>模型解读</h3>');
    if (hasIns) {
      out.push('<div class="p-insight">');
      if (ins.role) out.push('<div class="p-ins role"><span class="tk">职责</span><p>' + esc(ins.role) + '</p></div>');
      if (ins.risk) out.push('<div class="p-ins risk"><span class="tk">风险</span><p>' + esc(ins.risk) + '</p></div>');
      if (ins.why) out.push('<div class="p-ins why"><span class="tk">为什么这样设计</span><p>' + esc(ins.why) + '</p></div>');
      out.push('</div>');
    } else {
      out.push('<div class="p-empty">未提供模型解读（该节点只有抽取事实）。</div>');
    }
    out.push('</div>');

    /* evidence anchor */
    if (n.xref) {
      out.push('<div class="p-sec"><h3>证据锚点</h3>');
      out.push('<div class="p-xref"><code>' + esc(n.xref) + '</code>' +
        '<button data-copy="' + esc(n.xref) + '">复制</button></div>');
      out.push('</div>');
    }

    /* relations from extracted edges of this view */
    var ins2 = [], outs = [];
    edgeIndex.forEach(function (e) {
      if (e.to === n.id) ins2.push({ other: e.from, kind: e.kind, label: e.label, confidence: e.confidence, dir: 'in' });
      if (e.from === n.id) outs.push({ other: e.to, kind: e.kind, label: e.label, confidence: e.confidence, dir: 'out' });
    });
    out.push(callSection(n));
    out.push('<div class="p-sec"><h3>入边 · ' + ins2.length + '</h3>' + relRows(ins2, '入边') + '</div>');
    out.push('<div class="p-sec"><h3>出边 · ' + outs.length + '</h3>' + relRows(outs, '出边') + '</div>');

    if (n.drill && VIEWS[n.drill]) {
      out.push('<button class="p-enter" data-drill="' + esc(n.drill) + '">' +
        '<span>进入 ' + esc(VIEWS[n.drill].title || n.drill) + '</span><span>▸</span></button>');
    }
    return out.join('');
  }

  function openPanel(n) {
    st.panel = true;
    stagewrap.classList.add('panel-open');
    panel.hidden = false;
    panel.innerHTML = panelHTML(n);
    panel.scrollTop = 0;
    select(n.id, false);
    revealNode(n.id);
  }

  function closePanel(refit) {
    if (!st.panel) return;
    st.panel = false;
    stagewrap.classList.remove('panel-open');
    panel.hidden = true;
    panel.innerHTML = '';
    st.sel = null;
    for (var k in nodeEls) nodeEls[k].classList.remove('sel');
    syncFocus();
    if (refit) fitView();
  }

  /* ---------- chrome ---------- */
  function renderHead() {
    var v = curView(); if (!v) return;
    vtitleEl.textContent = v.title || v.id;
    vnoteEl.textContent = v.note || '';
    vnoteEl.hidden = !v.note;

    var parts = [];
    var bc = v.breadcrumb || [];
    bc.forEach(function (id) {
      var label = null, target = null;
      if (VIEWS[id]) { label = VIEWS[id].title || id; target = id; }
      else {
        var hit = findNodeAnywhere(id);
        if (hit) { label = hit.node.label || id; target = hit.node.drill || hit.viewId; }
      }
      if (label) parts.push({ label: label, target: target });
    });
    if (!parts.length) {
      /* root view: the big title says it already — no redundant crumb */
      crumbsEl.innerHTML = '';
      crumbsEl.hidden = true;
      return;
    }
    crumbsEl.hidden = false;

    var html = parts.map(function (p, i) {
      var isLast = i === parts.length - 1;
      if (isLast) return '<span class="cur">' + esc(p.label) + '</span>';
      if (!p.target || !VIEWS[p.target]) return '<span class="cur">' + esc(p.label) + '</span>';
      return '<button data-nav="' + esc(p.target) + '">' + esc(p.label) + '</button>';
    }).join('<span class="sep">›</span>');
    crumbsEl.innerHTML = html;
  }

  function renderLevels() {
    var v = curView(); if (!v) return;
    if (levelsEl) levelsEl.hidden = (v.kind === 'flow');
    var max = 1;
    for (var vid in VIEWS) max = Math.max(max, num(VIEWS[vid].level, 1));
    var html = [];
    for (var i = 1; i <= max; i++) {
      if (i > 1) html.push('<span class="arrow">→</span>');
      html.push('<span class="lv' + (i === num(v.level, 1) ? ' on' : '') + '">' + i + '</span>');
    }
    levelsEl.innerHTML = html.join('');
  }

  function renderStats() {
    var s = M.stats || {};
    var html = [];
    if (s.nodes != null) html.push('<span><b>' + fmt(s.nodes) + '</b> 节点</span>');
    if (s.edges != null) html.push('<span><b>' + fmt(s.edges) + '</b> 边</span>');
    if (s.files != null) html.push('<span class="opt"><b>' + fmt(s.files) + '</b> 文件</span>');
    if (s.functions != null) html.push('<span class="opt"><b>' + fmt(s.functions) + '</b> 函数</span>');
    if (s.extracted != null || s.inferred != null) {
      html.push('<span class="pill opt"><span class="sw" style="background:#5f8fbf"></span>直读 <b>' + fmt(s.extracted) + '</b></span>');
      html.push('<span class="pill opt"><span class="sw" style="background:#b08b3c"></span>推断 <b>' + fmt(s.inferred) + '</b></span>');
    }
    statsEl.innerHTML = html.join('');
  }

  function renderLegend() {
    var v = curView(); if (!v) return;
    var seen = {}, order = ['layer', 'module', 'file', 'class', 'function', 'data', 'external'];
    (v.nodes || []).forEach(function (n) { if (n.kind) seen[n.kind] = true; });
    var html = [];
    order.forEach(function (k) {
      if (!seen[k]) return;
      html.push('<span class="li"><span class="sw" style="background:var(--k-' + k + ')"></span>' + esc(KIND_CN[k] || k) + '</span>');
    });
    html.push('<span class="li"><span class="ls"></span>直读</span>');
    html.push('<span class="li"><span class="ls dash"></span>推断</span>');
    if (edgeIndex.some(function (e) { return String(e.confidence).toUpperCase() === 'MIXED'; })) {
      html.push('<span class="li"><span class="ls mix"></span>聚合</span>');
    }
    html.push('<span class="li">▸ 可下钻</span>');
    legendEl.innerHTML = html.join('');
  }

  function renderFlows() {
    if (!flowbar) return;   /* 流程已独立成页，架构页不再显示链路条 */
    if (!FLOWS.length) { flowbar.hidden = true; return; }
    flowbar.hidden = false;
    var html = FLOWS.map(function (f) {
      var v = VIEWS[f.view];
      var labels = v ? (v.nodes || []).slice(0, 6).map(function (n) { return n.label; }) : [];
      var more = v && (v.nodes || []).length > 6 ? ' …' : '';
      var on = st.flow && st.flow.id === f.id ? ' on' : '';
      return '<div class="flow" data-flow="' + esc(f.id) + '">' +
        '<span class="ft">' + esc(f.title) + '</span>' +
        '<span class="fp">' + esc(labels.join(' → ') + more) + '</span></div>';
    }).join('');
    flowbar.innerHTML = html;
  }

  function renderWarnings() {
    var w = (M.meta && M.meta.warnings) || [];
    if (!w.length) { warnbar.hidden = true; return; }
    warnbar.hidden = false;
    var first = String(w[0]);
    var extra = w.length > 1 ? '（共 ' + w.length + ' 条）' : '';
    warnbar.innerHTML =
      '<span class="wico">!</span>' +
      '<div class="wtxt"><span class="w1">' + esc(first) + '</span>' +
      (w.length > 1 ? '<ul class="wmore" hidden>' + w.slice(1).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
      '</div>' +
      (w.length > 1 ? '<button class="wtoggle">展开' + esc(extra) + '</button>' : '');
    warnbar.classList.remove('open');
  }

  function renderTop() {
    projectEl.textContent = (M.meta && M.meta.project) || 'project';
    var ex = (M.meta && M.meta.extractor) || {};
    var bits = [];
    if (ex.name) bits.push(ex.name + (ex.version ? ' ' + ex.version : ''));
    if (ex.mode) bits.push(ex.mode);
    geninfoEl.textContent = bits.join(' · ');
    renderStats();
    renderWarnings();
    renderLevels();
  }

  /* ---------- navigation ---------- */
  function nav(viewId, opts) {
    opts = opts || {};
    if (!VIEWS[viewId]) return;
    if (st.cur && st.cur !== viewId && opts.push !== false) {
      st.hist.push(st.cur);
      if (opts.stack !== false) pushStack();
    }
    st.cur = viewId;
    st.hover = null;
    closePanel(false);
    renderView();
    renderHead();
    renderLevels();
    renderLegend();
    renderFlows();
    fitView();
    if (opts.select) select(opts.select, true);
    else syncFocus();
  }

  function goBack() {
    if (st.stack.length) { popStack(); return; }
    if (!st.hist.length) return;
    var prev = st.hist.pop();
    nav(prev, { push: false });
  }

  function drillTo(viewId, fromLabel) {
    if (!VIEWS[viewId]) return;
    nav(viewId);
    if (fromLabel) toast('进入 · ' + fromLabel);
  }

  /* ---------- toast ---------- */
  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    toastEl.style.animation = 'none';
    void toastEl.offsetWidth;
    toastEl.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 1900);
  }

  /* ---------- search ---------- */
  function searchResults(q) {
    var s = q.trim().toLowerCase();
    if (!s) return [];
    var parts = s.split(/\s+/);
    var out = [];
    for (var i = 0; i < nodeSearch.length && out.length < 60; i++) {
      var n = nodeSearch[i];
      var okAll = true;
      for (var j = 0; j < parts.length; j++) {
        if (n.hay.indexOf(parts[j]) < 0) { okAll = false; break; }
      }
      if (okAll) out.push(n);
    }
    out.sort(function (a, b) {
      var al = a.label.toLowerCase(), bl = b.label.toLowerCase();
      var ai = al.indexOf(s) === 0 ? 0 : (al.indexOf(s) > 0 ? 1 : 2);
      var bi = bl.indexOf(s) === 0 ? 0 : (bl.indexOf(s) > 0 ? 1 : 2);
      return ai - bi || a.label.length - b.label.length;
    });
    return out;
  }

  function renderResults() {
    var q = qEl.value;
    st.q = q;
    if (!q.trim()) { resultsEl.hidden = true; st.qOpen = false; return; }
    var rs = searchResults(q);
    st.qOpen = true;
    resultsEl.hidden = false;
    if (!rs.length) {
      resultsEl.innerHTML = '<div class="rhint">没有匹配「' + esc(q) + '」的节点</div>';
      st.qIdx = -1;
      return;
    }
    if (st.qIdx >= rs.length) st.qIdx = rs.length - 1;
    resultsEl.innerHTML = rs.map(function (r, i) {
      return '<div class="rit' + (i === st.qIdx ? ' act' : '') + '" data-i="' + i + '"' +
        ' data-view="' + esc(r.view) + '" data-node="' + esc(r.id) + '">' +
        '<span class="rl">' + esc(r.label) + '</span>' +
        '<span class="rk">' + esc(KIND_CN[r.kind] || r.kind) + '</span>' +
        '<span class="rv">' + esc(r.viewTitle) + (r.sub ? ' · ' + esc(r.sub) : '') + (r.xref ? ' · ' + esc(r.xref) : '') + '</span>' +
        '</div>';
    }).join('');
    resultsEl.__rs = rs;
  }

  function jumpTo(viewId, nodeId) {
    hideResults();
    qEl.blur();
    if (viewId !== st.cur) nav(viewId);
    var n = nodeEls[nodeId] && nodeEls[nodeId].__node;
    if (!n) { var hit = findNodeAnywhere(nodeId); n = hit && hit.node; }
    if (n) {
      select(nodeId, true);
      if (n.drill) { /* keep selection visible; do not force drill */ }
      openPanel(n);
    }
  }

  function hideResults() {
    resultsEl.hidden = true;
    st.qOpen = false;
    st.qIdx = -1;
  }

  /* ---------- events ---------- */
  var drag = null;

  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    var f = Math.exp(-e.deltaY * 0.0016);
    if (e.deltaMode === 1) f = Math.exp(-e.deltaY * 0.05);
    zoomAt(e.clientX, e.clientY, clamp(f, 0.5, 2));
  }, { passive: false });

  stage.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    var nodeG = e.target.closest ? e.target.closest('.node') : null;
    drag = { x: e.clientX, y: e.clientY, tx: st.tx, ty: st.ty, moved: false, node: nodeG ? nodeG.getAttribute('data-id') : null };
    if (!nodeG) stage.classList.add('dragging');
    try { stage.setPointerCapture(e.pointerId); } catch (err) { }
  });

  stage.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
      drag.moved = true;
      stage.classList.add('dragging');
    }
    if (drag.moved) {
      st.tx = drag.tx + dx;
      st.ty = drag.ty + dy;
      st.userZoomed = true;
      applyCam();
    }
  });

  function endDrag(e) {
    if (!drag) return;
    var wasMoved = drag.moved, nodeId = drag.node;
    stage.classList.remove('dragging');
    try { stage.releasePointerCapture(e.pointerId); } catch (err) { }
    drag = null;
    if (wasMoved) {
      /* a pan must not be read as a click on empty canvas */
      st.suppressEmptyClick = true;
      setTimeout(function () { st.suppressEmptyClick = false; }, 0);
      return;
    }
    if (nodeId) activateNode(nodeId);
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', function (e) {
    stage.classList.remove('dragging');
    drag = null;
    try { stage.releasePointerCapture(e.pointerId); } catch (err) { }
  });

  stage.addEventListener('dblclick', function (e) {
    if (e.target.closest && e.target.closest('.node')) return;
    st.userZoomed = false;
    fitView();
  });

  stage.addEventListener('pointerover', function (e) {
    var g = e.target.closest ? e.target.closest('.node') : null;
    var id = g ? g.getAttribute('data-id') : null;
    if (id === st.hover) return;
    st.hover = id;
    syncFocus();
  });
  stage.addEventListener('pointerleave', function () {
    st.hover = null;
    syncFocus();
  });

  stage.addEventListener('keydown', function (e) {
    var g = e.target.closest ? e.target.closest('.node') : null;
    if (!g) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateNode(g.getAttribute('data-id'));
    }
  });

  function activateNode(id) {
    var vv = curView();
    var nodeDef = vv && (vv.nodes || []).filter(function (x) { return x.id === id; })[0];
    if (nodeDef && nodeDef.link && VIEWS[nodeDef.link.view]) {
      pushStack();
      st.tab = 'arch';
      setTab('arch', { silent: true });
      nav(nodeDef.link.view, { push: false, select: nodeDef.link.node });
      centerOn(nodeDef.link.node);
      return;
    }
    var g = nodeEls[id];
    if (!g || !g.__node) return;
    var n = g.__node;
    if (n.drill && VIEWS[n.drill]) { drillTo(n.drill, n.label); return; }
    openPanel(n);
  }

  /* delegated clicks from panel / crumbs / flows / results */
  document.addEventListener('click', function (e) {
    var t = e.target;

    var closeBtn = t.closest && t.closest('[data-close]');
    if (closeBtn) { closePanel(true); return; }

    var navBtn = t.closest && t.closest('[data-nav]');
    if (navBtn) { nav(navBtn.getAttribute('data-nav')); return; }

    var drillBtn = t.closest && t.closest('[data-drill]');
    if (drillBtn) { drillTo(drillBtn.getAttribute('data-drill')); return; }

    var copyBtn = t.closest && t.closest('[data-copy]');
    if (copyBtn) { copyText(copyBtn.getAttribute('data-copy'), copyBtn); return; }

    var clTog = t.closest && t.closest('[data-cl-tog]');
    if (clTog) {
      var k = clTog.getAttribute('data-cl-tog');
      st.callOpen[k] = st.callOpen[k] !== true;
      var cur = curView() && st.sel ? findNodeAnywhere(st.sel) : null;
      if (cur) {
        var keepScroll = panel.scrollTop;
        panel.innerHTML = panelHTML(cur.node);
        panel.scrollTop = keepScroll;
      }
      return;
    }

    var gotoBtn = t.closest && t.closest('[data-goto]');
    if (gotoBtn) {
      var gid = gotoBtn.getAttribute('data-goto');
      var gg = nodeEls[gid];
      if (gg && gg.__node) { openPanel(gg.__node); return; }
      var hit = findNodeAnywhere(gid);      /* 调用链上可能不在当前屏：跳过去 */
      if (hit && hit.viewId !== st.cur) nav(hit.viewId);
      if (hit) openPanel(hit.node);
      return;
    }

    var step = t.closest && t.closest('[data-flow]');
    if (step) {
      var vid = step.getAttribute('data-view'), nid = step.getAttribute('data-node');
      if (vid !== st.cur) nav(vid);
      select(nid, true);
      renderFlows();
      return;
    }

    var rit = t.closest && t.closest('.rit');
    if (rit) { jumpTo(rit.getAttribute('data-view'), rit.getAttribute('data-node')); return; }

    /* click on empty canvas closes the panel */
    if (st.suppressEmptyClick) return;
    if (stage.contains(t) && !(t.closest && t.closest('.node')) && !drag) {
      if (st.panel) closePanel(true);
    }
  });

  function copyText(text, btn) {
    var done = function () {
      btn.classList.add('done');
      btn.textContent = '已复制';
      setTimeout(function () { btn.classList.remove('done'); btn.textContent = '复制'; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch (err) { toast('复制失败：' + text); }
    }
  }

  /* search input */
  qEl.addEventListener('input', function () { st.qIdx = -1; renderResults(); });
  qEl.addEventListener('focus', function () { if (qEl.value.trim()) renderResults(); });
  qEl.addEventListener('keydown', function (e) {
    var rs = resultsEl.__rs || [];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      st.qIdx = Math.min((st.qIdx < 0 ? -1 : st.qIdx) + 1, rs.length - 1);
      renderResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      st.qIdx = Math.max(st.qIdx - 1, 0);
      renderResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!rs.length) return;
      var pick = rs[st.qIdx >= 0 ? st.qIdx : 0];
      jumpTo(pick.view, pick.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideResults();
      qEl.blur();
    }
  });

  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '');

    if (e.key === '/' && !typing) {
      e.preventDefault();
      qEl.focus();
      qEl.select();
      return;
    }
    if (e.key === 'Escape') {
      if (st.qOpen) { hideResults(); qEl.blur(); return; }
      if (st.panel) { closePanel(true); return; }
      return;
    }
    if (typing) return;
    if (e.key === 'ArrowLeft') {
      if (st.hist.length) { e.preventDefault(); goBack(); }
      return;
    }
    if (e.key === 'Backspace') {
      if (st.hist.length) { e.preventDefault(); goBack(); }
      return;
    }
    if (e.key === '0') { fitView(); }
  });

  warnbar.addEventListener('click', function (e) {
    if (!e.target.closest('.wtoggle')) return;
    var more = warnbar.querySelector('.wmore');
    var open = warnbar.classList.toggle('open');
    if (more) more.hidden = !open;
    e.target.textContent = open ? '收起' : '展开';
  });

  window.addEventListener('resize', function () {
    var v = curView();
    if (v && !st.userZoomed) fitView();
  });

  /* 容器尺寸变化（面板开合、窗口缩放）时补一次 fit，避免首屏残留错误缩放 */
  if (typeof ResizeObserver !== 'undefined') {
    var ro = new ResizeObserver(function () {
      if (!st.userZoomed) fitView();
    });
    ro.observe(stage);
  }

  /* ---------- boot ---------- */
  function boot() {
    buildIndex();
    renderTop();
    bindShell();
    var start = VIEWS[M.rootView] ? M.rootView : Object.keys(VIEWS)[0];
    if (!start) {
      vtitleEl.textContent = '没有可渲染的 view';
      return;
    }
    st.cur = start;
    renderView();
    renderHead();
    renderLevels();
    renderLegend();
    renderFlows();
    fitView();
    /* 首次 fit 可能发生在 CSS/字体稳定之前：再补两次，保证首屏一定铺满 */
    requestAnimationFrame(function () {
      if (!st.userZoomed) fitView();
      requestAnimationFrame(function () { if (!st.userZoomed) fitView(); });
    });
    window.addEventListener('load', function () { if (!st.userZoomed) fitView(); });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { if (st.tab !== 'overview' && !st.userZoomed) fitView(); });
    }
    setTab('overview');
    if (M.meta && M.meta.generatedAt) {
      geninfoEl.title = '生成于 ' + M.meta.generatedAt;
    }
    /* 兜底自愈：首屏如果还是扁的，强制重算一次（应对极端布局时序） */
    setTimeout(function () {
      var r = stage.getBoundingClientRect();
      if (r.height >= 240 && r.width >= 240 && st.k < 0.45) {
        st.userZoomed = false;
        fitView();
      }
    }, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();


  /* ================= 页签 / 概览 / 数据 / 流程 ================= */

  var OVERVIEW_TAB = 'overview';

  function tabEls() { return Array.prototype.slice.call(document.querySelectorAll('#sidenav .tab')); }

  function setTab(tab, opts) {
    opts = opts || {};
    st.tab = tab;
    tabEls().forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === tab); });

    var isOv = tab === 'overview', isData = tab === 'data', isFlow = tab === 'flow', isArch = tab === 'arch';
    byId('overview').hidden = !isOv;
    byId('dataview').hidden = !isData;
    byId('stagewrap').hidden = !(isArch || isFlow);
    byId('flowpicker').hidden = !isFlow;
    if (byId('flowbar')) byId('flowbar').hidden = true;
    byId('viewhead').hidden = isFlow;   /* 流程页用选择器当标题，避免与标题重叠 */
    if (levelsEl) levelsEl.hidden = isOv || isData;  /* 层级指示只对架构页有意义 */
    byId('legend').hidden = !isArch;
    byId('hint').hidden = !isArch;
    if (isOv) renderOverview();
    if (isData) renderData();
    if (isFlow) {
      renderFlowPicker();
      if (st.flow && VIEWS[st.flow.view]) {
        /* 保持当前链路：必须重画，否则舞台里还留着上一次的架构视图 */
        gotoFlow(st.flow.id, true);
      } else if (FLOWS.length) {
        gotoFlow(FLOWS[0].id, true);
      }
    }
    if (isArch) {
      if (!st.cur || VIEWS[st.cur] && VIEWS[st.cur].kind === 'flow') st.cur = M.rootView || st.cur;
      if (st.cur) { renderView(); renderHead(); renderLevels(); renderLegend(); }
      fitView();
      if (st.sel) select(st.sel, false);
    }
  }

  /* ---------- 技术栈 chips ---------- */
  function techChipsHTML() {
    return TECH.map(function (t) {
      var cls = 'ts' + (t.kind === 'lang' ? ' lang' : t.kind === 'db' ? ' db' : '');
      var v = t.ver ? ' ' + t.ver : '';
      return '<span class="' + cls + '" title="来源 ' + esc(t.from || '') + '">' + esc(t.name + v) + '</span>';
    }).join('');
  }

  /* ---------- 概览页 ---------- */
  function renderOverview() {
    var el = byId('overview');
    if (!el) return;
    var meta = M.meta || {}, stt = M.stats || {};
    var paras = (INTRO.paragraphs || []).slice();
    if (!paras.length) {
      paras = ['这次没有生成项目介绍。可以在 insights.json 里补 intro.paragraphs（2–4 段），说明这个项目是什么、给谁用、解决什么问题。'];
    }
    var h = '<div class="ov-inner">';
    h += '<h1>' + esc(meta.project || '项目') + '</h1>';
    h += '<div class="ov-sub">' + esc((meta.extractor && meta.extractor.name) || '') +
      ' · ' + stt.files + ' 文件 · ' + stt.functions + ' 符号 · ' + stt.nodes + ' 节点 · ' + stt.edges + ' 条关系</div>';

    paras.forEach(function (p) { h += '<p>' + esc(p) + '</p>'; });

    if (TECH.length) {
      h += '<h2>技术栈</h2><div class="techrow">' + techChipsHTML() + '</div>';
    }
    h += '<h2>规模</h2><div class="kv">' +
      '<div><b>' + fmt(stt.files) + '</b>文件</div>' +
      '<div><b>' + fmt(stt.functions) + '</b>可调用符号</div>' +
      '<div><b>' + fmt(stt.nodes) + '</b>图节点</div>' +
      '<div><b>' + fmt(stt.edges) + '</b>关系边</div>' +
      '<div><b>' + fmt(stt.extracted) + '</b>直读边</div>' +
      '<div><b>' + fmt(stt.inferred) + '</b>推断边</div>' +
      '</div>';

    if (START.length) {
      h += '<h2>从这读起</h2><div class="startlist">';
      START.forEach(function (s, i) {
        h += '<div class="startitem" data-view="' + esc(s.view) + '" data-node="' + esc(s.node) + '">' +
          '<span class="no">' + (i + 1) + '</span>' +
          '<span><span class="nm">' + esc(s.label || s.node) + '</span>' +
          '<div class="wh">' + esc(s.why || '') + '</div></span></div>';
      });
      h += '</div>';
    }

    if ((INTRO.basis || []).length) {
      h += '<div class="basis">介绍依据：' + INTRO.basis.map(esc).join(' · ') + '</div>';
    }
    h += '</div>';
    el.innerHTML = h;
  }

  /* ---------- 数据页 ---------- */
  function typeName(id) {
    var gs = (TYPES && TYPES.groups) || [];
    for (var i = 0; i < gs.length; i++) {
      for (var j = 0; j < (gs[i].items || []).length; j++) if (gs[i].items[j].id === id) return gs[i].items[j].name;
    }
    return id;
  }

  function usagesOf(typeId) {
    var us = (TYPES && TYPES.usages) || [];
    for (var i = 0; i < us.length; i++) if (us[i].type === typeId) return us[i].funcs || [];
    return [];
  }

  function renderData() {
    var el = byId('dataview');
    if (!el) return;
    var groups = (TYPES && TYPES.groups) || [];
    if (!groups.length) {
      el.innerHTML = '<div class="dv-head"><h1>数据结构</h1><span>本次没有抽取到类型定义</span></div>';
      return;
    }
    var linkMap = {};
    ((TYPES.links) || []).forEach(function (l) {
      (linkMap[l.from] = linkMap[l.from] || []).push(l.to);
      (linkMap[l.to] = linkMap[l.to] || []).push(l.from);
    });

    var total = groups.reduce(function (a, g) { return a + (g.items || []).length; }, 0);
    var h = '<div class="dv-head"><h1>数据结构</h1><span>' + total + ' 个类型 · ' +
      ((TYPES.links || []).length) + ' 条同名跨端连线 · 按名字匹配，不做模糊对齐</span></div>';
    h += '<div class="cols">';

    groups.forEach(function (g) {
      h += '<div class="col"><h2>' + esc(g.name) + '（' + (g.items || []).length + '）</h2>';
      (g.items || []).forEach(function (it) {
        var on = st.type === it.id ? ' on' : '';
        h += '<div class="tcard' + on + '" data-type="' + esc(it.id) + '" id="tc-' + esc(it.id.replace(/[^\w]/g, '_')) + '">';
        h += '<div class="tc-h"><span class="tc-n" title="' + esc(it.file + ':' + it.line) + '">' + esc(it.name) + '</span>';
        h += '<span class="tc-k">' + esc(it.kind) + '</span>';
        if (it.ambiguous) h += '<span class="tc-k" title="同一端里有多个同名类型，已用 @包名 区分">同名</span>';
        var lk = linkMap[it.id] || [];
        if (lk.length) {
          var other = lk.map(function (id) {
            var gid = id.split(':')[0];
            return (gid === 'frontend' ? '前端' : gid === 'backend' ? '后端' : gid === 'database' ? '数据库' : gid);
          });
          h += '<span class="tc-link" title="' + esc(lk.join(' , ')) + '">↔ ' + esc(other.join('/')) + '</span>';
        }
        h += '</div><div class="tc-f">';
        var opened = !!st.expanded[it.id];
        var all = it.fields || [];
        var fs = opened ? all : all.slice(0, 6);
        if (!fs.length) h += '<div class="kv-none">' + esc(it.note || '未解析到字段，见原文 ' + (it.file || '') + ':' + (it.line || 1)) + '</div>';
        fs.forEach(function (f) {
          h += '<div class="frow"><span class="fn">' + esc(f.name) + '</span><span class="ft">' + esc(f.type || '') + '</span>' +
            (f.note ? '<span class="fx">' + esc(f.note) + '</span>' : '') + '</div>';
        });
        h += '</div>';
        if (all.length > 6) {
          h += '<div class="tc-more">' + (opened
            ? '收起'
            : '还有 ' + (all.length - 6) + ' 个字段 · 点开看全部') + '</div>';
        }
        h += '</div>';
      });
      h += '</div>';
    });
    h += '</div>';

    // 选中类型的详情：谁在用它
    if (st.type) {
      var us = usagesOf(st.type);
      h += '<div class="dv-detail"><h2 style="font-size:12px;color:var(--txt-2);margin:22px 0 10px">' +
        esc(typeName(st.type)) + ' 被这些函数使用（' + us.length + '）</h2>';
      if (!us.length) h += '<div class="kv-none">没有找到引用它的函数（可能只出现在类型声明里）</div><div class="startlist">';
      else {
        h += '<div class="startlist">';
        us.slice(0, 8).forEach(function (fn, i) {
          var view = findNodeAnywhere(fn);
          h += '<div class="startitem" data-view="' + esc(view ? view.viewId : '') + '" data-node="' + esc(fn) + '">' +
            '<span class="no">' + (i + 1) + '</span><span><span class="nm">' + esc(labelOf(fn) || fn) + '</span>' +
            '<div class="wh">' + esc(view ? '在架构图中查看' : '不在本次渲染范围内（被截断）') + '</div></span></div>';
        });
        h += '</div>';
      }
      h += '</div>';
    }
    el.innerHTML = h;
    if (st.type) {
      var card = byId('tc-' + st.type.replace(/[^\w]/g, '_'));
      if (card) card.scrollIntoView({ block: 'nearest' });
    }
  }

  function toggleType(id) {
    if (st.expanded[id]) delete st.expanded[id];
    else st.expanded[id] = true;
    st.type = id;
    renderData();
  }

  /* ---------- 流程页 ---------- */
  function renderFlowPicker() {
    var el = byId('flowpicker');
    if (!el) return;
    var h = FLOWS.map(function (f) {
      var on = st.flow && st.flow.id === f.id ? ' on' : '';
      return '<button class="' + on.trim() + '" data-flow="' + esc(f.id) + '">' + esc(f.title) + '</button>';
    }).join('');
    el.innerHTML = h;
  }

  function gotoFlow(flowId, silent) {
    var f = FLOWS.filter(function (x) { return x.id === flowId; })[0];
    if (!f || !VIEWS[f.view]) return;
    st.flow = f;
    nav(f.view, { push: true, stack: { tab: 'flow' } });
    renderFlowPicker();
    if (!silent) toast('链路 · ' + f.title);
  }

  /* ---------- 返回栈 ---------- */
  function snapshot() {
    return { tab: st.tab, view: st.cur, node: st.sel, flow: st.flow && st.flow.id,
             cam: { k: st.k, tx: st.tx, ty: st.ty } };
  }
  function pushStack() {
    st.stack.push(snapshot());
    if (st.stack.length > 20) st.stack.shift();
    updateBackBtn();
  }
  function updateBackBtn() {
    var b = byId('backbtn');
    if (b) b.disabled = !st.stack.length;
  }
  function popStack() {
    var s = st.stack.pop();
    updateBackBtn();
    if (!s) return;
    st.tab = s.tab;
    if (s.flow) { st.flow = FLOWS.filter(function (x) { return x.id === s.flow; })[0] || st.flow; }
    if (s.tab === 'arch' && s.view && VIEWS[s.view]) {
      st.cur = s.view;
      setTab('arch', { silent: true });
      if (s.cam) { st.k = s.cam.k; st.tx = s.cam.tx; st.ty = s.cam.ty; applyCam(); }
      if (s.node) select(s.node, true);
    } else if (s.tab === 'flow' && s.view && VIEWS[s.view]) {
      setTab('flow');
      nav(s.view, { push: false });
    } else {
      setTab(s.tab);
    }
  }

  /* ---------- 跳转定位：目标放在 60% 高度、偏左，右侧留给侧栏 ---------- */
  function centerOn(nodeId, opts) {
    opts = opts || {};
    var v = curView(); if (!v) return;
    var n = null;
    (v.nodes || []).forEach(function (x) { if (x.id === nodeId) n = x; });
    if (!n) return;
    var sz = stageSize();
    if (sz.w < 200 || sz.h < 200) { setTimeout(function () { centerOn(nodeId, opts); }, 60); return; }
    var panelW = st.panel ? Math.min(380, sz.w * 0.42) : 0;
    var usableW = Math.max(200, sz.w - panelW);
    var headH = 96, botH = 42;
    var usableH = Math.max(120, sz.h - headH - botH);
    var k = opts.k || clamp(st.k < 0.6 ? 0.95 : st.k, 0.6, 1.5);
    st.k = k;
    var cx = n.x + num(n.w, 160) / 2;
    var cy = n.y + num(n.h, 56) / 2;
    st.tx = usableW * 0.44 - cx * k;
    st.ty = headH + usableH * 0.60 - cy * k;
    st.userZoomed = true;
    applyCam();
  }

  function jumpToNode(nodeId, targetTab) {
    var hit = findNodeAnywhere(nodeId);
    if (!hit) {
      /* 目标被截断：跳到最近的可见父级，并说明 */
      toast('该节点在本次抽取中，但没被渲染（被预算截断）；已尽力跳到父级');
      var pid = nodeId.indexOf('::') > 0 ? 'file:' + nodeId.slice(3).split('::')[0] : null;
      var ph = pid && findNodeAnywhere(pid);
      if (ph) { pushStack(); st.cur = ph.viewId; setTab(targetTab || 'arch'); nav(ph.viewId, { push: false, select: ph.node.id }); centerOn(ph.node.id); }
      return false;
    }
    pushStack();
    if (targetTab) st.tab = targetTab;
    setTab(targetTab || 'arch');
    nav(hit.viewId, { push: false, select: hit.node.id });
    centerOn(hit.node.id);
    return true;
  }

  /* ---------- 事件绑定 ---------- */
  function bindShell() {
    tabEls().forEach(function (b) {
      b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
    });
    var back = byId('backbtn');
    if (back) back.addEventListener('click', popStack);

    byId('overview').addEventListener('click', function (e) {
      var it = e.target.closest ? e.target.closest('.startitem') : null;
      if (!it) return;
      var v = it.getAttribute('data-view'), n = it.getAttribute('data-node');
      if (v && n && VIEWS[v]) { pushStack(); setTab('arch'); nav(v, { push: false, select: n }); centerOn(n); }
    });

    byId('dataview').addEventListener('click', function (e) {
      var it = e.target.closest ? e.target.closest('.startitem') : null;
      if (it) {
        var v = it.getAttribute('data-view'), n = it.getAttribute('data-node');
        if (v && n) { pushStack(); setTab('arch'); nav(v, { push: false, select: n }); centerOn(n); }
        return;
      }
      var card = e.target.closest ? e.target.closest('.tcard') : null;
      if (card) toggleType(card.getAttribute('data-type'));
    });

    if (flowbar) flowbar.addEventListener('click', function (e) {
      var f = e.target.closest ? e.target.closest('.flow[data-flow]') : null;
      if (f) { pushStack(); setTab('flow'); gotoFlow(f.getAttribute('data-flow'), true); }
    });

    byId('flowpicker').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-flow]') : null;
      if (b) gotoFlow(b.getAttribute('data-flow'));
    });
  }

  /* 运行期自检：给 agent / CI 一个可编程的验收口子。
     window.__archSelfTest() 返回 {ok, stage, k, views, warnings}，
     ok=false 表示页面渲染不可信（画布塌陷 / 缩放过小）。 */
  window.__archSelfTest = function () {
    var r = stage.getBoundingClientRect();
    var h = Math.round(r.height), w = Math.round(r.width);
    var k = Math.round(st.k * 1000) / 1000;
    var ok = h >= 240 && w >= 240 && k >= 0.45;
    return {
      ok: ok,
      reason: ok ? '' : (h < 240 || w < 240 ? '画布高度塌陷' : '首屏缩放低于 0.45'),
      stage: { w: w, h: h },
      k: k,
      views: Object.keys(VIEWS).length,
      cur: st.cur,
      warnings: (M.meta && M.meta.warnings) || []
    };
  };
})();
