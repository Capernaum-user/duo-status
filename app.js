/* =====================================================================
 * app.js — claude-duo 관제 보드 (등각 팩토리 플로어)
 *   1) mapStateToScene(state): 순수 함수. /api/state JSON → 장면 모델(DOM/canvas 무의존, node 단독 실행 가능).
 *   2) 브라우저 앱: canvas 등각 렌더 + 팬/줌/클릭/호버 + 보드/리스트 토글 + 2초 폴링. (window 있을 때만 실행)
 * 외부 리소스 0 · 바닐라 JS · /api/state 계약 불변(읽기만).
 * ===================================================================== */

/* ---------------- 1. 순수 장면 매핑 (node 테스트 대상) ---------------- */
/* 'yyyy-MM-dd HH:mm:ss' 등 문자열에서 앞 10자 'YYYY-MM-DD'만 취하고, 형식이 아니면 null */
function pickDateStr(raw) {
  if (raw == null) return null;
  var d = String(raw).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}
/* 날짜 문자열 배열(null 포함 가능) → [{date,count}] 날짜 내림차순 집계 */
function aggregateDates(dateList) {
  var counts = {};
  dateList.forEach(function (d) { if (d) counts[d] = (counts[d] || 0) + 1; });
  return Object.keys(counts).sort(function (a, b) { return a < b ? 1 : (a > b ? -1 : 0); })
    .map(function (d) { return { date: d, count: counts[d] }; });
}
function mapStateToScene(state) {
  state = state || {};
  var STN = { 1: 'plan', 2: 'work', 3: 'report', 4: 'review', 5: 'done', 0: 'escalation' };
  var jobs = Array.isArray(state.jobs) ? state.jobs : [];
  var stackN = 0;
  var tokens = jobs.map(function (j) {
    var station = (STN[j.stageIndex] != null) ? STN[j.stageIndex] : 'plan';
    var v = j.verify || null;
    var booth = !!v;
    var boothActive = !!(v && v.status === 'RUNNING');
    var boothFail = !!(v && v.status === 'DONE' && (v.decision === 'BOTH_FAIL' || v.decision === 'CONFLICT'));
    var alert = (j.stageIndex === 0) || !!(j.flags && j.flags.protocolError) || ((j.stageLabel || '').indexOf('[확인필요]') >= 0);
    var stackIndex = (station === 'done') ? (stackN++) : -1;
    var color = alert ? 'rose' : (j.stageIndex === 5 ? 'green' : 'primary');
    var tl = Array.isArray(j.timeline) ? j.timeline : [];
    var doneDate = (j.stageIndex === 5) ? pickDateStr(tl.length ? tl[tl.length - 1].time : j.lastUpdate) : null;
    var requestDate = pickDateStr(tl.length ? tl[0].time : j.lastUpdate);
    return {
      jobId: j.jobId, title: j.title || j.jobId, project: j.project || '', round: j.round,
      station: station, booth: booth, boothActive: boothActive, boothFail: boothFail, stackIndex: stackIndex,
      badges: {
        auto: !!(j.autorun && j.autorun.active), rework: !!(j.flags && j.flags.rework),
        autoResult: j.autorun ? j.autorun.result : null, autoPhase: j.autorun ? j.autorun.phase : null
      },
      alert: alert, color: color,
      stageIndex: j.stageIndex, stageLabel: j.stageLabel, nextAction: j.nextAction,
      verify: v, autorun: j.autorun || null, timeline: tl, lastUpdate: j.lastUpdate || '',
      doneDate: doneDate, requestDate: requestDate
    };
  });
  return {
    tokens: tokens,
    counts: state.counts || {},
    escalations: Array.isArray(state.escalations) ? state.escalations : [],
    externalVerifies: Array.isArray(state.externalVerifies) ? state.externalVerifies : [],
    generatedAt: state.generatedAt || '',
    hasAlerts: tokens.some(function (t) { return t.alert; }),
    doneDates: aggregateDates(tokens.map(function (t) { return t.doneDate; })),
    requestDates: aggregateDates(tokens.map(function (t) { return t.requestDate; }))
  };
}

/* 완료 토큰을 선택 날짜로 걸러내고 stackIndex를 0부터 재부여(빈틈 없는 선반 스택을 위해).
 * 진행 중 토큰(stageIndex!==5)은 필터와 무관하게 항상 포함. DOM/storage 비의존 순수 함수 — node에서도 검증 가능. */
function computeFilteredView(tokens, selDate) {
  tokens = Array.isArray(tokens) ? tokens : [];
  var out = [], stackN = 0;
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (t.stageIndex !== 5) { out.push(t); continue; }
    if (selDate === 'ALL' || t.doneDate === selDate) {
      var c = {}, k;
      for (k in t) { if (Object.prototype.hasOwnProperty.call(t, k)) c[k] = t[k]; }
      c.stackIndex = stackN++;
      out.push(c);
    }
  }
  return out;
}

/* node에서 require 가능하게 export (브라우저엔 영향 없음) */
if (typeof module !== 'undefined' && module.exports) { module.exports = { mapStateToScene: mapStateToScene, computeFilteredView: computeFilteredView }; }

/* ---------------- 2. 브라우저 앱 (window 있을 때만) ---------------- */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  (function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // --- 등각 스테이션 배치(타일 좌표) ---
    var STATIONS = {
      plan: { c: 0, r: 0, icon: '📋', label: '기획 데스크' },
      work: { c: 2.4, r: 0, icon: '⚙️', label: '작업 스테이션' },
      report: { c: 4.8, r: 0, icon: '📤', label: '보고 트레이' },
      review: { c: 4.8, r: 2.4, icon: '🧐', label: '검토 데스크' },
      done: { c: 4.8, r: 4.8, icon: '📦', label: '완료 선반' },
      booth: { c: 0, r: 2.4, icon: '🔍', label: '검수 부스' },
      escalation: { c: 2.4, r: 2.4, icon: '⚠️', label: '에스컬레이션' }
    };
    var FLOW = ['plan', 'work', 'report', 'review', 'done'];
    var TW = 74, TH = 37; // half-tile w/h

    var css = function (v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); };
    function palette() {
      return {
        floor: css('--floor'), floorLine: css('--floor-line'), surface: css('--surface'), border: css('--border'),
        text: css('--text'), text2: css('--text-2'), text3: css('--text-3'),
        primary: css('--primary'), green: css('--green'), rose: css('--rose'), amber: css('--amber'), shadow: 'rgba(0,0,0,.22)'
      };
    }

    var cv = $('board'), ctx = cv.getContext('2d');
    var cam = { x: 0, y: 0, scale: 1 };
    var scene = { tokens: [], view: [], counts: {}, escalations: [], externalVerifies: [], hasAlerts: false, doneDates: [], requestDates: [] };
    var pos = {};           // jobId → {x,y} 현재 화면상 타일좌표(트윈)
    var hover = null, selected = null, view = 'board', firstLoad = true, dpr = 1;
    var userAdjustedView = false; // 사용자가 직접 줌(휠/버튼/핀치)했는지 — true면 자동 줌보정 중단

    /* ---------- 완료 선반 날짜 필터 ---------- */
    var selDate = null;   // 'YYYY-MM-DD' 또는 'ALL'
    var calMonth = null;  // 캘린더 팝오버가 보여주는 달 { y, m(0-11) }
    var DFKEY = 'duo.doneFilter';
    function todayStr() {
      var d = new Date();
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }
    function pad2(n) { return n < 10 ? '0' + n : '' + n; }
    function addDays(ds, delta) {
      var p = ds.split('-').map(Number), d = new Date(p[0], p[1] - 1, p[2]);
      d.setDate(d.getDate() + delta);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }
    function clampToday(ds) { var t = todayStr(); return ds > t ? t : ds; }
    function monthOf(ds) { var p = ds.split('-').map(Number); return { y: p[0], m: p[1] - 1 }; }
    function loadSelDate() {
      var today = todayStr();
      try {
        var raw = localStorage.getItem(DFKEY);
        if (raw) {
          var obj = JSON.parse(raw);
          if (obj && obj.savedOn === today && (obj.date === 'ALL' || /^\d{4}-\d{2}-\d{2}$/.test(obj.date))) return obj.date;
        }
      } catch (e) { /* 저장값 손상 시 오늘로 폴백 */ }
      return today;
    }
    function saveSelDate() {
      try { localStorage.setItem(DFKEY, JSON.stringify({ date: selDate, savedOn: todayStr() })); } catch (e) { /* 스토리지 불가 환경 무시 */ }
    }
    function applyFilter() { scene.view = computeFilteredView(scene.tokens, selDate); }
    // 필터 변경 시 진입점: 정적 스냅샷 모드는 poll()이 1회만 도므로 poll()을 다시 부르지 않고
    // applyFilter + 필요한 렌더 함수만 직접 호출한다(보드 canvas는 tick()의 rAF 루프가 상시 재렌더).
    function onDateChange() {
      saveSelDate();
      applyFilter();
      renderDateBar();
      renderHud();
      if (view === 'list') renderList();
    }
    function renderDateBar() {
      if (!$('dateBar')) { return; }   // 날짜 바가 없는 셸(구 board.html 등)에서는 아무것도 하지 않는다
      var today = todayStr();
      $('dLabel').textContent = selDate === 'ALL' ? '전체 기간' : (selDate === today ? ('오늘 (' + today + ')') : selDate);
      $('dToday').classList.toggle('on', selDate === today);
      $('dAll').classList.toggle('on', selDate === 'ALL');
      $('dNext').disabled = (selDate === today);
      var reqCount, doneCount;
      if (selDate === 'ALL') {
        reqCount = scene.tokens.length;
        doneCount = scene.tokens.filter(function (t) { return t.stageIndex === 5; }).length;
      } else {
        reqCount = scene.tokens.filter(function (t) { return t.requestDate === selDate; }).length;
        doneCount = scene.tokens.filter(function (t) { return t.doneDate === selDate; }).length;
      }
      $('dSummary').textContent = '요청 ' + reqCount + '건 · 완료 ' + doneCount + '건';
    }
    function renderCal() {
      var y = calMonth.y, m = calMonth.m, today = todayStr();
      $('mLabel').textContent = y + '-' + pad2(m + 1);
      var dowEl = document.querySelector('#calPop .cal-dow');
      dowEl.innerHTML = ['월', '화', '수', '목', '금', '토', '일'].map(function (d) { return '<span>' + d + '</span>'; }).join('');
      var first = new Date(y, m, 1), startPad = (first.getDay() + 6) % 7, daysInMonth = new Date(y, m + 1, 0).getDate();
      var doneMap = {}; (scene.doneDates || []).forEach(function (d) { doneMap[d.date] = d.count; });
      var cells = [];
      for (var i = 0; i < startPad; i++) cells.push('<span class="cal-d cal-pad"></span>');
      for (var day = 1; day <= daysInMonth; day++) {
        var ds = y + '-' + pad2(m + 1) + '-' + pad2(day), cnt = doneMap[ds] || 0, isFuture = ds > today;
        var cls = ['cal-d']; if (cnt === 0) cls.push('empty'); if (ds === today) cls.push('today'); if (ds === selDate) cls.push('sel'); if (isFuture) cls.push('future');
        cells.push('<button type="button" class="' + cls.join(' ') + '" data-date="' + ds + '"' + (isFuture ? ' disabled' : '') + '>' + day + (cnt > 0 ? '<span class="cal-b">' + cnt + '</span>' : '') + '</button>');
      }
      $('calGrid').innerHTML = cells.join('');
    }
    function toggleCal() {
      var pop = $('calPop'), willOpen = pop.hidden;
      if (willOpen) { calMonth = monthOf(selDate === 'ALL' ? todayStr() : selDate); renderCal(); }
      pop.hidden = !willOpen;
    }
    // 이 app.js는 두 개의 셸에서 로드된다 — dashboard\index.html(라이브)과 publish\build-site.ps1이
    // 생성하는 board.html(정적 스냅샷). 셸이 어긋나 날짜 바 마크업이 없을 수 있으므로,
    // 없으면 배선을 통째로 건너뛴다. 가드가 없으면 null.addEventListener가 던져서
    // IIFE 전체가 죽고 보드가 아예 안 그려진다.
    var hasDateBar = !!($('dateBar') && $('dPick') && $('calPop') && $('calGrid'));
    if (hasDateBar) {
      $('dPick').addEventListener('click', function (e) { e.stopPropagation(); toggleCal(); });
      $('dPrev').addEventListener('click', function () { var base = selDate === 'ALL' ? todayStr() : selDate; selDate = addDays(base, -1); onDateChange(); });
      $('dNext').addEventListener('click', function () { if ($('dNext').disabled) return; var base = selDate === 'ALL' ? todayStr() : selDate; selDate = clampToday(addDays(base, 1)); onDateChange(); });
      $('dToday').addEventListener('click', function () { selDate = todayStr(); onDateChange(); });
      $('dAll').addEventListener('click', function () { selDate = 'ALL'; onDateChange(); });
      $('mPrev').addEventListener('click', function () { calMonth.m--; if (calMonth.m < 0) { calMonth.m = 11; calMonth.y--; } renderCal(); });
      $('mNext').addEventListener('click', function () { calMonth.m++; if (calMonth.m > 11) { calMonth.m = 0; calMonth.y++; } renderCal(); });
      $('calGrid').addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.cal-d[data-date]') : null;
        if (!btn || btn.disabled) return;
        selDate = btn.getAttribute('data-date'); $('calPop').hidden = true; onDateChange();
      });
      document.addEventListener('click', function (e) {
        var pop = $('calPop');
        if (!pop.hidden && !pop.contains(e.target) && !$('dPick').contains(e.target)) pop.hidden = true;
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('calPop').hidden = true; });
    } else {
      // 날짜 바가 없는 셸: 필터를 걸 UI가 없으므로 전체 보기로 고정한다(종전 동작 유지).
      selDate = 'ALL';
    }

    // 좁은 화면에서 보드 전체가 대략 보이도록 초기/리사이즈 시 자동 줌 보정(사용자가 직접 줌하기 전까지만)
    function fitScale() {
      var w = cv.width / dpr, target = 640;
      return w >= target ? 1 : Math.max(0.5, Math.min(1, w / target));
    }

    function resize() {
      dpr = window.devicePixelRatio || 1;
      var r = cv.parentElement.getBoundingClientRect();
      cv.width = Math.max(1, Math.floor(r.width * dpr));
      cv.height = Math.max(1, Math.floor(r.height * dpr));
      cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
      if (!userAdjustedView) cam.scale = fitScale();
    }
    function origin() { return { x: cv.width / dpr * 0.30, y: 90 }; }
    function tileToScreen(c, r) { var o = origin(); return { x: o.x + (c - r) * TW * cam.scale + cam.x, y: o.y + (c + r) * TH * cam.scale + cam.y }; }

    // 각 토큰의 목표 타일좌표(스테이션 기준, done은 스택 오프셋, booth 점유 시 부스)
    function targetTile(t) {
      var st = (t.booth && (t.boothActive || t.boothFail) && t.stageIndex <= 2) ? STATIONS.booth : (STATIONS[t.station] || STATIONS.plan);
      var c = st.c, r = st.r;
      if (t.station === 'done' && t.stackIndex >= 0) { r += 0.0; c += 0.0; }
      return { c: c, r: r, stackIndex: t.stackIndex };
    }

    /* ---------- 등각 그리기 헬퍼 ---------- */
    function isoBox(sx, sy, w, h, dep, top, side, line) {
      // top diamond
      ctx.beginPath();
      ctx.moveTo(sx, sy - h); ctx.lineTo(sx + w, sy); ctx.lineTo(sx, sy + h); ctx.lineTo(sx - w, sy); ctx.closePath();
      ctx.fillStyle = top; ctx.fill(); if (line) { ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.stroke(); }
      // left/right faces
      ctx.beginPath(); ctx.moveTo(sx - w, sy); ctx.lineTo(sx, sy + h); ctx.lineTo(sx, sy + h + dep); ctx.lineTo(sx - w, sy + dep); ctx.closePath();
      ctx.fillStyle = side; ctx.fill();
      ctx.beginPath(); ctx.moveTo(sx + w, sy); ctx.lineTo(sx, sy + h); ctx.lineTo(sx, sy + h + dep); ctx.lineTo(sx + w, sy + dep); ctx.closePath();
      ctx.fillStyle = shade(side, -14); ctx.fill();
    }
    function shade(hex, d) {
      var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return hex;
      var n = parseInt(m[1], 16), r = Math.max(0, Math.min(255, (n >> 16) + d)), g = Math.max(0, Math.min(255, ((n >> 8) & 255) + d)), b = Math.max(0, Math.min(255, (n & 255) + d));
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    function drawFloor(p) {
      // 등각 바닥 타일 그리드
      ctx.save();
      for (var c = -1; c <= 7; c++) for (var r = -1; r <= 7; r++) {
        var s = tileToScreen(c, r);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - TH * cam.scale); ctx.lineTo(s.x + TW * cam.scale, s.y); ctx.lineTo(s.x, s.y + TH * cam.scale); ctx.lineTo(s.x - TW * cam.scale, s.y); ctx.closePath();
        ctx.fillStyle = ((c + r) % 2 === 0) ? p.floor : shade(p.floor, 6);
        ctx.fill(); ctx.strokeStyle = p.floorLine; ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.restore();
    }
    function drawConnectors(p) {
      ctx.save(); ctx.strokeStyle = p.border; ctx.lineWidth = 3 * cam.scale; ctx.setLineDash([]);
      for (var i = 0; i < FLOW.length - 1; i++) {
        var a = STATIONS[FLOW[i]], b = STATIONS[FLOW[i + 1]];
        var sa = tileToScreen(a.c, a.r), sb = tileToScreen(b.c, b.r);
        ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
      }
      // 검수부스 분기(기획→부스→작업)
      var pl = tileToScreen(STATIONS.plan.c, STATIONS.plan.r), bo = tileToScreen(STATIONS.booth.c, STATIONS.booth.r), wk = tileToScreen(STATIONS.work.c, STATIONS.work.r);
      ctx.setLineDash([6, 5]); ctx.strokeStyle = p.amber;
      ctx.beginPath(); ctx.moveTo(pl.x, pl.y); ctx.lineTo(bo.x, bo.y); ctx.lineTo(wk.x, wk.y); ctx.stroke();
      ctx.setLineDash([]); ctx.restore();
    }
    function drawStations(p) {
      Object.keys(STATIONS).forEach(function (k) {
        if (k === 'escalation' && !scene.hasAlerts) return;
        var st = STATIONS[k], s = tileToScreen(st.c, st.r), w = TW * 0.62 * cam.scale, h = TH * 0.62 * cam.scale, dep = 22 * cam.scale;
        // 그림자
        ctx.save(); ctx.globalAlpha = .5; ctx.fillStyle = p.shadow;
        ctx.beginPath(); ctx.ellipse(s.x, s.y + dep + 4, w, h * 0.7, 0, 0, 7); ctx.fill(); ctx.restore();
        var isBooth = (k === 'booth'), busy = isBooth && scene.view.some(function (t) { return t.boothActive; });
        var fail = isBooth && scene.view.some(function (t) { return t.boothFail; });
        var top = (k === 'escalation' || fail) ? p.rose : (busy ? p.amber : p.surface);
        isoBox(s.x, s.y, w, h, dep, top, shade(top, -8), p.border);
        // 아이콘/라벨
        ctx.textAlign = 'center';
        ctx.font = (16 * cam.scale) + 'px sans-serif'; ctx.fillText(st.icon, s.x, s.y + 5 * cam.scale);
        ctx.fillStyle = p.text2; ctx.font = '700 ' + (10.5 * cam.scale) + 'px sans-serif';
        ctx.fillText(st.label, s.x, s.y + dep + 16 * cam.scale);
        // 검수부스 로봇 2기(Codex/gemini)
        if (isBooth) drawRobots(p, s, busy, fail);
      });
    }
    function drawRobots(p, s, busy, fail) {
      var lamp = fail ? p.rose : (busy ? p.amber : p.text3);
      [['Codex', -18], ['gemini', 18]].forEach(function (rb) {
        var rx = s.x + rb[1] * cam.scale, ry = s.y - 20 * cam.scale;
        ctx.fillStyle = shade(p.surface, -10); ctx.strokeStyle = p.border; ctx.lineWidth = 1;
        ctx.fillRect(rx - 7 * cam.scale, ry - 7 * cam.scale, 14 * cam.scale, 14 * cam.scale);
        ctx.strokeRect(rx - 7 * cam.scale, ry - 7 * cam.scale, 14 * cam.scale, 14 * cam.scale);
        ctx.beginPath(); ctx.arc(rx, ry, 2.6 * cam.scale, 0, 7); ctx.fillStyle = lamp;
        if (busy) ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(Date.now() / 300));
        ctx.fill(); ctx.globalAlpha = 1;
      });
    }
    function tokenColor(p, t) { return t.color === 'rose' ? p.rose : (t.color === 'green' ? p.green : p.primary); }
    function drawToken(p, t) {
      var pt = pos[t.jobId]; if (!pt) return;
      var s = tileToScreen(pt.x, pt.y);
      var lift = 26 * cam.scale + (t.stackIndex >= 0 ? t.stackIndex * 9 * cam.scale : 0);
      var y = s.y - lift, w = 44 * cam.scale, h = 26 * cam.scale, col = tokenColor(p, t);
      // 그림자
      ctx.save(); ctx.globalAlpha = .35; ctx.fillStyle = p.shadow;
      ctx.beginPath(); ctx.ellipse(s.x, s.y + 2, w * 0.5, h * 0.28, 0, 0, 7); ctx.fill(); ctx.restore();
      // 카드
      roundRect(s.x - w / 2, y - h, w, h, 5 * cam.scale); ctx.fillStyle = p.surface; ctx.fill();
      ctx.lineWidth = (t.jobId === (hover && hover.jobId) || t.jobId === (selected && selected.jobId)) ? 2.5 : 1.4;
      ctx.strokeStyle = t.alert ? p.rose : col; ctx.stroke();
      // 좌측 상태 바
      ctx.fillStyle = col; roundRect(s.x - w / 2, y - h, 4 * cam.scale, h, 2 * cam.scale); ctx.fill();
      // 텍스트
      ctx.textAlign = 'left'; ctx.fillStyle = p.text; ctx.font = '800 ' + (9.5 * cam.scale) + 'px sans-serif';
      ctx.fillText(shortId(t.jobId), s.x - w / 2 + 8 * cam.scale, y - h + 11 * cam.scale);
      ctx.fillStyle = p.text3; ctx.font = (8 * cam.scale) + 'px sans-serif';
      var sub = 'R' + t.round + (t.badges.auto ? ' 🤖' : '') + (t.badges.rework ? ' ↩' : '');
      ctx.fillText(sub, s.x - w / 2 + 8 * cam.scale, y - 6 * cam.scale);
      if (t.alert) { ctx.fillStyle = p.rose; ctx.textAlign = 'right'; ctx.fillText('⚠', s.x + w / 2 - 5 * cam.scale, y - h + 11 * cam.scale); }
    }
    function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
    function shortId(id) { return id.length > 18 ? id.slice(0, 17) + '…' : id; }

    // 토큰 화면 사각(히트테스트용)
    function tokenRect(t) {
      var pt = pos[t.jobId]; if (!pt) return null;
      var s = tileToScreen(pt.x, pt.y);
      var lift = 26 * cam.scale + (t.stackIndex >= 0 ? t.stackIndex * 9 * cam.scale : 0);
      var w = 44 * cam.scale, h = 26 * cam.scale, y = s.y - lift;
      return { x: s.x - w / 2, y: y - h, w: w, h: h };
    }
    function hitTest(mx, my) {
      for (var i = scene.view.length - 1; i >= 0; i--) {
        var r = tokenRect(scene.view[i]); if (r && mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) return scene.view[i];
      }
      return null;
    }

    function draw() {
      if (view !== 'board') return;
      var p = palette();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      // 빈 상태
      if (scene.view.length === 0) {
        drawFloor(p);
        ctx.textAlign = 'center'; ctx.fillStyle = p.text3; ctx.font = '600 15px sans-serif';
        var emsg = (scene.tokens.length === 0)
          ? '🏭 텅 빈 플로어 — 기획 패널에서 “기획해줘 …”로 시작하세요'
          : ((selDate === 'ALL' ? '전체 기간' : selDate) + ' 표시할 항목 없음');
        ctx.fillText(emsg, cv.width / dpr / 2, cv.height / dpr / 2);
        return;
      }
      drawFloor(p); drawConnectors(p); drawStations(p);
      // 토큰: 뒤(작은 c+r)부터
      scene.view.slice().sort(function (a, b) { var pa = pos[a.jobId] || { x: 0, y: 0 }, pb = pos[b.jobId] || { x: 0, y: 0 }; return (pa.x + pa.y) - (pb.x + pb.y); }).forEach(function (t) { drawToken(p, t); });
    }

    // 트윈 애니메이션 루프
    function tick() {
      var moving = false;
      scene.view.forEach(function (t) {
        var tg = targetTile(t); var cur = pos[t.jobId] || { x: tg.c, y: tg.r };
        if (reduceMotion) { cur.x = tg.c; cur.y = tg.r; }
        else {
          var dx = tg.c - cur.x, dy = tg.r - cur.y;
          if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) { cur.x += dx * 0.15; cur.y += dy * 0.15; moving = true; }
          else { cur.x = tg.c; cur.y = tg.r; }
        }
        pos[t.jobId] = cur;
      });
      // booth pulse 시 계속 그림
      var pulsing = scene.view.some(function (t) { return t.boothActive; });
      draw();
      requestAnimationFrame(tick);
    }

    /* ---------- 인터랙션 ---------- */
    var dragging = false, dragMoved = false, last = { x: 0, y: 0 };
    cv.addEventListener('mousedown', function (e) { dragging = true; dragMoved = false; last = { x: e.clientX, y: e.clientY }; });
    window.addEventListener('mouseup', function () { dragging = false; });
    cv.addEventListener('mousemove', function (e) {
      var rect = cv.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (dragging) { cam.x += (e.clientX - last.x); cam.y += (e.clientY - last.y); last = { x: e.clientX, y: e.clientY }; dragMoved = true; hideTip(); return; }
      var h = hitTest(mx, my); hover = h; cv.style.cursor = h ? 'pointer' : 'grab';
      if (h) showTip(e.clientX, e.clientY, h); else hideTip();
    });
    cv.addEventListener('mouseleave', function () { hover = null; hideTip(); });
    cv.addEventListener('click', function (e) {
      if (dragMoved) return;
      var rect = cv.getBoundingClientRect(), h = hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (h) openPanel(h);
    });
    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      var f = e.deltaY < 0 ? 1.1 : 0.9, ns = Math.min(2.0, Math.max(0.5, cam.scale * f)); // 클램프 0.5~2.0
      cam.scale = ns; userAdjustedView = true;
    }, { passive: false });
    $('zoomReset').addEventListener('click', function () { cam = { x: 0, y: 0, scale: fitScale() }; userAdjustedView = false; });
    $('zoomIn').addEventListener('click', function () { cam.scale = Math.min(2.0, cam.scale * 1.15); userAdjustedView = true; });
    $('zoomOut').addEventListener('click', function () { cam.scale = Math.max(0.5, cam.scale * 0.87); userAdjustedView = true; });

    /* ---------- 터치 입력(모바일): 기존 마우스 핸들러는 그대로 두고 별도 추가 ----------
     * 한 손가락 드래그=팬 · 두 손가락 핀치=줌(기존 0.5~2.0 클램프 재사용) · 탭(이동 없는 터치)=토큰 선택
     * touchend에서 e.preventDefault()로 뒤이은 합성 mouse/click 이벤트를 억제해 이중 처리 방지.
     */
    var touchState = { mode: null, moved: false, panStart: null, startCam: null, startDist: 0, startScale: 1 };
    function touchDist(a, b) { var dx = a.clientX - b.clientX, dy = a.clientY - b.clientY; return Math.sqrt(dx * dx + dy * dy); }
    cv.addEventListener('touchstart', function (e) {
      hideTip();
      if (e.touches.length === 1) {
        touchState.mode = 'pan'; touchState.moved = false;
        touchState.panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        touchState.startCam = { x: cam.x, y: cam.y };
      } else if (e.touches.length === 2) {
        touchState.mode = 'pinch'; touchState.moved = true;
        touchState.startDist = touchDist(e.touches[0], e.touches[1]) || 1;
        touchState.startScale = cam.scale;
      }
    }, { passive: true });
    cv.addEventListener('touchmove', function (e) {
      if (touchState.mode === 'pan' && e.touches.length === 1) {
        e.preventDefault();
        var dx = e.touches[0].clientX - touchState.panStart.x, dy = e.touches[0].clientY - touchState.panStart.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) touchState.moved = true;
        cam.x = touchState.startCam.x + dx; cam.y = touchState.startCam.y + dy;
      } else if (touchState.mode === 'pinch' && e.touches.length === 2) {
        e.preventDefault();
        var d = touchDist(e.touches[0], e.touches[1]);
        cam.scale = Math.min(2.0, Math.max(0.5, touchState.startScale * (d / touchState.startDist))); // 0.5~2.0 클램프
        userAdjustedView = true;
      }
    }, { passive: false });
    cv.addEventListener('touchend', function (e) {
      e.preventDefault();
      if (touchState.mode === 'pan' && !touchState.moved && e.touches.length === 0) {
        var rect = cv.getBoundingClientRect();
        var tx = e.changedTouches[0].clientX - rect.left, ty = e.changedTouches[0].clientY - rect.top;
        var h = hitTest(tx, ty); if (h) openPanel(h);
      }
      if (e.touches.length === 0) touchState.mode = null;
      else if (e.touches.length === 1) { // 핀치→단손가락 전환: 팬으로 이어감(탭 오인 방지)
        touchState.mode = 'pan'; touchState.moved = true;
        touchState.panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        touchState.startCam = { x: cam.x, y: cam.y };
      }
    }, { passive: false });
    cv.addEventListener('touchcancel', function () { touchState.mode = null; }, { passive: true });

    function showTip(x, y, t) {
      var el = $('tip'); el.innerHTML = '<b>' + esc(t.jobId) + '</b> · ' + esc(t.stageLabel) + '<br>' + esc(t.title);
      el.style.left = (x + 14) + 'px'; el.style.top = (y + 14) + 'px'; el.classList.add('show');
    }
    function hideTip() { $('tip').classList.remove('show'); }

    /* ---------- 우측 상세 슬라이드 패널 ---------- */
    function openPanel(t) {
      selected = t;
      var v = t.verify, a = t.autorun;
      var steps = ['기획', '작업', '보고', '검토', '완료'];
      var tl = (t.timeline || []).map(function (e) { return '<li><span class="tt">' + esc(e.time) + '</span> <b>' + esc(e.state) + '</b>' + (e.round ? ' R' + e.round : '') + '</li>'; }).join('');
      var verifyHtml = v ? ('<div class="psec"><h4>교차검증</h4><div>상태 <b>' + esc(v.status) + '</b>' + (v.decision ? ' · ' + esc(v.decision) : '') + '</div><div class="pm">Codex ' + esc(v.a || '…') + ' · gemini ' + esc(v.b || '…') + (v.runs > 1 ? ' (' + v.runs + '회)' : '') + '</div></div>') : '';
      var autoHtml = a ? ('<div class="psec"><h4>무인 러너 🤖</h4><div>' + (a.active ? ('진행 중 · ' + esc(a.phase || '') + (a.round ? ' R' + a.round : '')) : ('종료 · ' + esc(a.result || ''))) + '</div></div>') : '';
      $('panelBody').innerHTML =
        '<div class="pttl">' + esc(t.jobId) + ' <span class="pr">R' + esc(t.round) + '</span>' + (t.badges.auto ? ' 🤖' : '') + '</div>' +
        '<div class="psub">' + (t.project ? esc(t.project) + ' · ' : '') + esc(t.title) + '</div>' +
        '<div class="pchip ' + t.color + '">' + esc(t.stageLabel) + '</div>' +
        '<div class="psec"><h4>다음 행동</h4><div>' + esc(t.nextAction || '—') + '</div></div>' +
        verifyHtml + autoHtml +
        '<div class="psec"><h4>타임라인</h4><ul class="ptl">' + (tl || '<li class="pm">기록 없음</li>') + '</ul></div>' +
        '<div class="pm">갱신 ' + esc(t.lastUpdate || '—') + '</div>';
      $('panel').classList.add('open');
    }
    $('panelClose').addEventListener('click', function () { $('panel').classList.remove('open'); selected = null; });

    /* ---------- HUD / 뷰 토글 ---------- */
    function renderHud() {
      var c = scene.counts || {};
      $('c-active').textContent = c.active != null ? c.active : 0;
      $('c-worker').textContent = c.waitingWorker != null ? c.waitingWorker : 0;
      $('c-review').textContent = c.waitingReview != null ? c.waitingReview : 0;
      var totalDone = scene.tokens.filter(function (t) { return t.stageIndex === 5; }).length;
      var selDone = (selDate === 'ALL') ? totalDone : scene.tokens.filter(function (t) { return t.doneDate === selDate; }).length;
      $('c-done').textContent = selDone;
      var doneLabel = $('c-done').parentElement.querySelector('.l');
      if (doneLabel) {
        var dtxt = (selDate === todayStr()) ? '오늘' : selDate;
        doneLabel.textContent = (totalDone > selDone) ? ('완료(' + dtxt + ') · 총 ' + totalDone) : '완료';
      }
      $('c-alert').textContent = c.alerts != null ? c.alerts : 0;
      var ab = $('alertBanner'), al = scene.view.filter(function (t) { return t.alert; });
      if (al.length) { ab.classList.add('show'); ab.innerHTML = '⚠ 주의 ' + al.length + '건: ' + al.map(function (t) { return esc(t.jobId) + ' (' + esc(t.stageLabel) + ')'; }).join(', '); }
      else ab.classList.remove('show');
    }
    function setView(v) {
      view = v;
      $('board').style.display = v === 'board' ? 'block' : 'none';
      $('listView').style.display = v === 'list' ? 'block' : 'none';
      $('boardControls').style.display = v === 'board' ? 'flex' : 'none';
      $('tabBoard').classList.toggle('on', v === 'board'); $('tabList').classList.toggle('on', v === 'list');
      if (v === 'list') renderList();
      if (v === 'board') { resize(); }
    }
    $('tabBoard').addEventListener('click', function () { setView('board'); });
    $('tabList').addEventListener('click', function () { setView('list'); });

    /* ---------- 리스트 뷰 (현행 SVG 레인 이식 보존) ---------- */
    var STAGES = ['기획', '작업', '보고', '검토', '완료'], NX = [50, 165, 280, 395, 510], NY = 30, SVGW = 560;
    function laneSvg(t) {
      var idx = t.stageIndex, hasV = !!t.verify, H = hasV ? 120 : 60, s = '<svg viewBox="0 0 ' + SVGW + ' ' + H + '" width="' + SVGW + '" height="' + H + '" class="lane-svg">';
      for (var k = 0; k < 4; k++) { var fill = (idx !== 0 && (k + 1) < idx); s += '<line x1="' + NX[k] + '" y1="' + NY + '" x2="' + NX[k + 1] + '" y2="' + NY + '" class="conn ' + (fill ? 'c-fill' : '') + '"/>'; }
      if (hasV) {
        var vx = 130, vy = 88, jx = 220, vc = t.verify.status === 'RUNNING' ? 'v-run' : (t.boothFail ? 'v-fail' : (t.verify.decision === 'BOTH_PASS' ? 'v-pass' : 'v-warn'));
        s += '<path d="M50 ' + (NY + 8) + ' L50 ' + vy + ' L' + (vx - 13) + ' ' + vy + '" class="vbranch ' + vc + '"/><path d="M' + (vx + 13) + ' ' + vy + ' L' + jx + ' ' + vy + ' L' + jx + ' ' + (NY + 8) + '" class="vbranch ' + vc + '"/>';
        s += '<polygon points="' + vx + ',' + (vy - 8) + ' ' + (vx + 8) + ',' + vy + ' ' + vx + ',' + (vy + 8) + ' ' + (vx - 8) + ',' + vy + '" class="vd ' + vc + '"/>';
        s += '<text x="' + vx + '" y="' + (vy + 22) + '" class="vlabel" text-anchor="middle">Codex:' + esc(t.verify.a || '…') + ' · gemini:' + esc(t.verify.b || '…') + ' → ' + esc(t.verify.status === 'RUNNING' ? '검증중' : (t.verify.decision || '')) + '</text>';
      }
      for (var k2 = 0; k2 < 5; k2++) {
        var cls = 'n-future', end = (k2 === 4) ? ' n-end' : '';
        if (idx === 0) cls = (k2 === 0) ? 'n-warn' : 'n-future'; else if (k2 < idx - 1) cls = 'n-done' + end; else if (k2 === idx - 1) cls = 'n-cur' + end;
        s += '<circle cx="' + NX[k2] + '" cy="' + NY + '" r="8" class="nd ' + cls + '"/><text x="' + NX[k2] + '" y="' + (NY + 22) + '" class="nlabel" text-anchor="middle">' + STAGES[k2] + '</text>';
      }
      return s + '</svg>';
    }
    function laneRow(t, n) {
      var auto = t.badges.auto ? '<span class="rework">🤖 ' + esc(t.badges.autoPhase || '무인') + '</span>' : (t.autorun ? '<span class="rework">🤖 ' + esc(t.badges.autoResult || '') + '</span>' : '');
      var reqd = t.requestDate ? '<span class="reqd">요청 ' + esc(t.requestDate) + '</span>' : '';
      return '<div class="lane' + (t.alert ? ' warn' : '') + '"><div class="lane-head"><span class="idx">#' + n + '</span><span class="jobid">' + esc(t.jobId) + '</span>' + (t.project ? '<span class="proj">· ' + esc(t.project) + '</span>' : '') + '<span class="rbadge">R' + esc(t.round) + '</span>' + (t.badges.rework ? '<span class="rework">↩ 재작업</span>' : '') + auto + '<span class="ltitle">' + esc(t.title) + '</span><span class="chip s' + t.stageIndex + '">' + esc(t.stageLabel) + '</span></div><div class="lane-graph">' + laneSvg(t) + '</div><div class="lane-foot"><span>다음: <b>' + esc(t.nextAction) + '</b></span>' + reqd + '<span class="upd">' + esc(t.lastUpdate || '—') + '</span></div></div>';
    }
    function renderList() {
      var act = scene.view.filter(function (t) { return t.stageIndex !== 5; }), done = scene.view.filter(function (t) { return t.stageIndex === 5; });
      $('listActive').innerHTML = act.map(function (t, i) { return laneRow(t, i + 1); }).join('') || '<div class="empty2">진행 중 없음</div>';
      var dtag = (selDate === 'ALL') ? '전체' : selDate;
      if (done.length) {
        $('listDoneToggle').textContent = dtag + ' 완료 ' + done.length + '건';
        $('listDoneToggle').style.display = 'flex';
        $('listDone').innerHTML = done.map(function (t, i) { return laneRow(t, i + 1); }).join('');
      } else {
        $('listDoneToggle').style.display = 'none';
        $('listDone').classList.add('open');
        $('listDone').innerHTML = '<div class="empty2">' + dtag + ' 완료 없음</div>';
      }
    }
    $('listDoneToggle').addEventListener('click', function () { $('listDoneToggle').classList.toggle('open'); $('listDone').classList.toggle('open'); });

    /* ---------- 폴러 ---------- */
    function setConn(ok) { $('connBanner').classList.toggle('show', !ok); $('statusText').textContent = ok ? '실시간 연결됨' : '연결 끊김'; $('status').classList.toggle('off', !ok); }
    function poll() {
      /* 정적 스냅샷 모드(publish\build-site.ps1 산출물): window.__STATE__가 주입돼 있으면
       * fetch/폴링 없이 그 객체로 1회만 렌더하고 이후 poll() 호출(setInterval)은 즉시 반환한다.
       * __STATE__가 없으면 아래 기존 폴링 경로가 그대로 실행된다(무변경). */
      if (window.__STATE__) {
        if (poll._staticDone) return;
        poll._staticDone = true;
        scene = mapStateToScene(window.__STATE__);
        applyFilter();
        setConn(true);
        renderDateBar();
        renderHud();
        if (view === 'list') renderList();
        firstLoad = false;
        var stEl = $('statusText');
        if (stEl) stEl.textContent = '스냅샷 · ' + (window.__STATE__.generatedAt || '');
        return;
      }
      fetch('/api/state', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (st) { scene = mapStateToScene(st); applyFilter(); setConn(true); renderDateBar(); renderHud(); if (view === 'list') renderList(); firstLoad = false; })
        .catch(function () { setConn(false); if (firstLoad) $('statusText').textContent = '서버 대기 중…'; });
    }

    /* ---------- init ---------- */
    selDate = loadSelDate();
    calMonth = monthOf(selDate === 'ALL' ? todayStr() : selDate);
    renderDateBar();
    window.addEventListener('resize', function () { resize(); });
    resize(); setView('board'); tick(); poll(); setInterval(poll, 2000);
  })();
}
