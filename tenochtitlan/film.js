// 《湖上之城》：卫星简报风格。render(t) 只由 t 决定：相机来自关键帧，所有事件挂在旁白的时间点上（timeline.json），
// 标注一律经过同一个相机（engine.project）。
import { clamp, lerp, seg, ss, eio, eo, ei, env, mulberry, hash } from '/core/lib.js';
import { Engine, makeCamera, project, unproject, kmPerPx } from './engine.js';
import { C, text, measure, hair, lineLL, brackets, reticle, label, town, readout, subtitle, SUB, beginTexts, endTexts } from './overlay.js';

const W = 1920, H = 1080;
const gl = new Engine(document.getElementById('gl'));
const cv = document.getElementById('ov'), ctx = cv.getContext('2d');
const load = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('image ' + src)); i.src = src; });
const json = src => fetch(src).then(r => { if (!r.ok) throw new Error(src); return r.json(); });

let G, TL, PL, BB = {}, MAP, KEYS, LINE = {}, DUR = 60, CUES = [], WATER = null, CANOES = [];

// ------------------------------------------------------------------ 时间锚点：每件事挂在某句旁白上
const T = id => LINE[id].t0, E = id => LINE[id].t1, M = (id, f) => lerp(T(id), E(id), f);
const vis = (t, a, b, fi = .45, fo = .6) => env(t, a, b, fi, fo);

// ------------------------------------------------------------------ 几何工具
const KM = 111.32;
function kmLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dkm(pts[i - 1], pts[i]); return s; }
function dkm(a, b) { const k = Math.cos((a[1] + b[1]) / 2 * Math.PI / 180) * KM; return Math.hypot((b[0] - a[0]) * k, (b[1] - a[1]) * KM); }
function alongLL(pts, f) {   // 按长度比例取折线上的点
  const tot = kmLen(pts), stop = tot * clamp(f); let acc = 0;
  for (let i = 1; i < pts.length; i++) { const L = dkm(pts[i - 1], pts[i]);
    if (acc + L >= stop) { const u = (stop - acc) / Math.max(1e-9, L); return [lerp(pts[i - 1][0], pts[i][0], u), lerp(pts[i - 1][1], pts[i][1], u)]; }
    acc += L; }
  return pts[pts.length - 1];
}
const P = (cam, ll) => project(cam, ll[1], ll[0]);
function circleLL(c, rKm, n = 72) { const k = Math.cos(c[1] * Math.PI / 180) * KM; return Array.from({ length: n + 1 }, (_, i) => { const a = i / n * Math.PI * 2; return [c[0] + Math.cos(a) * rKm / k, c[1] + Math.sin(a) * rKm / KM]; }); }
function lerpPoly(a, b, u) { return a.map((p, i) => [lerp(p[0], b[i][0], u), lerp(p[1], b[i][1], u)]); }
const fmt = n => Math.round(n).toLocaleString('en-US');

// 沿线画刻度（每 everyKm 一道），只画到 frac
function ticks(cam, pts, frac, everyKm, { len = 7, alpha = 1, major = 0 } = {}) {
  const tot = kmLen(pts) * clamp(frac);
  for (let k = everyKm; k < tot; k += everyKm) {
    const a = alongLL(pts, (k - everyKm * .02) / kmLen(pts)), b = alongLL(pts, (k + everyKm * .02) / kmLen(pts));
    const [ax, ay] = P(cam, a), [bx, by] = P(cam, b);
    const nx = -(by - ay), ny = bx - ax, nl = Math.hypot(nx, ny) || 1, m = major && Math.abs(k / major - Math.round(k / major)) < 1e-6 ? 1.8 : 1;
    const [x, y] = P(cam, alongLL(pts, k / kmLen(pts)));
    hair(ctx, () => { ctx.moveTo(x - nx / nl * len * m, y - ny / nl * len * m); ctx.lineTo(x + nx / nl * len * m, y + ny / nl * len * m); }, { w: 1.4, alpha, halo: 2 });
  }
}
function route(cam, pts, frac, { w = 2.4, col = C.ink, dash = null, alpha = 1, off = 0 } = {}) {
  let tip = null;
  hair(ctx, () => { tip = lineLL(ctx, cam, pts, frac); }, { w, col, dash, alpha, off, cap: 'round' });
  return tip;
}
function poly(cam, pts) { lineLL(ctx, cam, pts, 1, true); }

// 小图形：帆船、独木舟
function boat(x, y, ang, s = 1, alpha = 1, col = C.ink) {
  ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(x, y); ctx.rotate(ang); ctx.scale(s, s);
  ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 4;
  ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(-9, 0); ctx.lineTo(-5, -3.4); ctx.lineTo(8, -2.6); ctx.lineTo(11, 0); ctx.lineTo(8, 2.6); ctx.lineTo(-5, 3.4); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -12); ctx.moveTo(-4, -9); ctx.lineTo(5, -9); ctx.stroke();
  ctx.restore();
}
function canoe(x, y, ang, alpha) {
  ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(x, y); ctx.rotate(ang);
  ctx.strokeStyle = 'rgba(232,238,242,.92)'; ctx.lineWidth = 1.8; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-4, 0); ctx.lineTo(4, 0); ctx.stroke(); ctx.restore();
}

// ------------------------------------------------------------------ 相机
const EASE = { io: eio, i: t => t * t * (2.2 - 1.2 * t), o: eo, lin: t => t, whip: t => ss(ss(t)), acc: t => 0.4 * t + 0.6 * Math.pow(t, 2.6), ss };
function camKeys() {
  const tw = G.town, pr = G.precinct;
  const tt = E('p5');
  return [
    { t: 0, ll: [-99.1368, 19.388], d: 9.5, tilt: 50, hd: 0, sy: 80 },
    { t: T('p2'), ll: [-99.1360, 19.398], d: 8.6, tilt: 47, hd: 0, sy: 80, e: 'lin' },
    { t: E('p2') + .4, ll: [-99.1352, 19.402], d: 9.4, tilt: 42, hd: 0, sy: 60, e: 'io' },
    { t: T('p4') + .3, ll: [-99.128, 19.426], d: 37, tilt: 0, hd: 0, sy: 0, e: 'io' },
    { t: tt + .6, ll: [-99.126, 19.428], d: 34, tilt: 0, hd: -3, e: 'lin' },
    { t: tt + 6.8, ll: [-99.126, 19.429], d: 33, tilt: 0, hd: -4, e: 'lin' },
    { t: T('c1_1') - .4, ll: [-90.4, 20.7], d: 2350, tilt: 8, hd: 0, e: 'i' },
    { t: T('c1_4'), ll: [-89.6, 20.5], d: 2050, tilt: 6, hd: 0, e: 'io' },
    { t: T('c1_9'), ll: [-93.4, 19.7], d: 1750, tilt: 5, hd: 0, e: 'io' },
    { t: E('c1_11'), ll: [-95.6, 19.5], d: 1500, tilt: 4, hd: 0, e: 'io' },
    { t: T('c2_1') - .2, ll: [-97.35, 19.36], d: 400, tilt: 0, hd: 0, e: 'i' },
    { t: T('c2_3'), ll: [-97.10, 19.40], d: 340, e: 'io' },
    { t: T('c2_5'), ll: [-97.75, 19.42], d: 310, e: 'io' },
    { t: E('c2_9'), ll: [-98.10, 19.36], d: 270, e: 'io' },
    { t: E('c2_11'), ll: [-98.30, 19.24], d: 240, e: 'io' },
    { t: T('c2_13'), ll: [-98.80, 19.22], d: 150, tilt: 28, hd: -68, e: 'io' },
    { t: E('c2_13') + .6, ll: [-98.98, 19.32], d: 118, tilt: 32, hd: -62, e: 'io' },
    { t: T('c3_1'), ll: [-99.108, 19.368], d: 24, tilt: 42, hd: -22, e: 'io' },
    { t: T('c3_4'), ll: [-99.134, 19.402], d: 14, tilt: 38, hd: -6, e: 'io' },
    { t: T('c3_5'), ll: [-99.1335, 19.424], d: 10.5, tilt: 22, hd: 0, e: 'io' },
    { t: T('c3_6'), ll: [-99.132, 19.433], d: 34, tilt: 0, hd: 0, e: 'io' },
    { t: T('c3_8') - 1.2, ll: [-99.131, 19.433], d: 37, tilt: 0, hd: 0, e: 'lin' },
    { t: T('c3_8') + .8, ll: [-96.62, 19.45], d: 430, tilt: 0, hd: 0, e: 'whip' },
    { t: E('c3_10') + .4, ll: [-96.52, 19.45], d: 390, e: 'lin' },
    { t: T('c3_11') - .2, ll: [-99.132, 19.433], d: 22, tilt: 0, hd: 0, e: 'whip' },
    { t: E('c3_14'), ll: [-99.133, 19.434], d: 19, tilt: 0, hd: 4, e: 'lin' },
    { t: T('c4_1') + 1.8, ll: [-99.150, 19.440], d: 15, tilt: 52, hd: -78, e: 'io' },
    { t: T('c4_6') - 2.2, ll: [-99.154, 19.439], d: 12.5, tilt: 56, hd: -78, e: 'lin' },
    { t: E('c4_7'), ll: [-99.180, 19.452], d: 11.5, tilt: 56, hd: -74, e: 'io' },
    { t: E('c4_8') + 1.2, ll: [-99.160, 19.452], d: 40, tilt: 8, hd: -20, e: 'io' },
    { t: T('c5_1') + 1.2, ll: [-99.06, 19.60], d: 150, tilt: 0, hd: 0, e: 'io' },
    { t: T('c5_2'), ll: [-98.96, 19.67], d: 140, e: 'io' },
    { t: T('c5_4'), ll: [-98.62, 19.50], d: 255, e: 'io' },
    { t: E('c5_4') + .5, ll: [-98.64, 19.49], d: 262, e: 'lin' },
    { t: T('c6_1') + .5, ll: [-99.00, 19.50], d: 152, e: 'io' },
    { t: T('c6_5') - .3, ll: [-99.00, 19.49], d: 150, e: 'lin' },
    { t: T('c6_6'), ll: [-98.60, 19.45], d: 232, e: 'io' },
    { t: E('c6_8'), ll: [-98.62, 19.46], d: 226, e: 'lin' },
    { t: T('c6_9'), ll: [-99.03, 19.50], d: 152, e: 'io' },
    { t: T('c6_11'), ll: [-98.99, 19.48], d: 112, e: 'io' },
    { t: E('c6_11') + .4, ll: [-99.00, 19.47], d: 104, e: 'lin' },
    { t: T('c7_1') - .4, ll: [-99.125, 19.426], d: 36, hd: 0, e: 'io' },
    { t: E('c7_12') + .8, ll: [-99.130, 19.432], d: 29, hd: -6, e: 'lin' },
    { t: T('c7_13'), ll: [-99.134, 19.444], d: 19, hd: -8, e: 'acc' },
    { t: E('c7_14') + 1, ll: [-99.133, 19.440], d: 21, hd: -8, e: 'lin' },
    { t: T('e2'), ll: [-99.120, 19.428], d: 42, hd: -4, e: 'io' },
    { t: E('e4') + .5, ll: [-99.128, 19.420], d: 48, hd: 0, e: 'io' },
    { t: DUR, ll: [-99.128, 19.420], d: 52, hd: 0, e: 'lin' },
  ];
}
function camAt(t) {
  let i = 0; while (i < KEYS.length - 2 && t > KEYS[i + 1].t) i++;
  const a = KEYS[i], b = KEYS[i + 1], u = (EASE[b.e] || eio)(seg(t, a.t, b.t));
  const d = Math.exp(lerp(Math.log(a.d), Math.log(b.d), u));
  // 大幅升降：升的时候先升高再平移，降的时候先平移再下降，镜头不会贴着地面横扫
  const la = Math.log(a.d), lb = Math.log(b.d), ld = Math.log(d);
  const k = Math.abs(lb - la) > 1.2 ? (lb > la ? ss(seg(ld, lerp(la, lb, .45), lb)) : ss(seg(ld, la, lerp(la, lb, .55)))) : u;
  const g = (p, q, dflt = 0) => lerp(a[p] ?? dflt, b[p] ?? dflt, u);
  return { lon: lerp(a.ll[0], b.ll[0], k), lat: lerp(a.ll[1], b.ll[1], k), d, tilt: g('tilt'), heading: g('hd'), sx: g('sx'), sy: g('sy'), fov: 30 };
}
// 快速甩镜时的运动模糊
function blurAt(t) {
  const whips = [[T('c3_8') - 1.2, T('c3_8') + .8], [T('c3_11') - 2.2, T('c3_11') - .2]];
  for (const [a, b] of whips) if (t > a && t < b) { const u = seg(t, a, b); return { blur: 60 * Math.sin(Math.PI * u) ** 2, vec: [1, .15] }; }
  return { blur: 0, vec: [1, 0] };
}

// ------------------------------------------------------------------ 画面状态
function plateAlphas(d) {
  const f = (hi, lo) => ss(seg(Math.log(d), Math.log(hi), Math.log(lo)));
  return { gulf: f(9000, 5500), highland: f(1300, 800), basin: f(620, 380), city: f(115, 72) };
}
function state(t, cam) {
  const d = cam.d;
  const grey = 1 - 0.68 * ss(seg(Math.log(d), Math.log(420), Math.log(1700))) - 0.22 * ss(seg(Math.log(d), Math.log(110), Math.log(220))) * (1 - ss(seg(Math.log(d), Math.log(700), Math.log(1500))));
  const expo = 1 + .22 * ss(seg(Math.log(d), Math.log(110), Math.log(220))) * (1 - ss(seg(Math.log(d), Math.log(800), Math.log(1500))));
  const shade = ss(seg(Math.log(d), Math.log(1400), Math.log(6000)));
  // 湖：开场出现；第二章到山口之前隐去，翻过山口时重新出现；尾声排干
  let lake = 1, scan = 90, dir = 1;
  if (t < T('p2')) lake = 0;
  else if (t < T('p2') + 3.5) { lake = 1; dir = -1; scan = lerp(19.52, 19.33, ss(seg(t, T('p2') + .2, T('p2') + 3.5))); }
  if (t > T('c2_1') - 4 && t < T('c2_13')) lake = 1 - ss(seg(t, T('c2_1') - 4, T('c2_1') - 2));
  if (t >= T('c2_13') && t < T('c3_1')) { lake = ss(seg(t, T('c2_13') - .2, T('c2_13') + 2.4)); }
  const drain = 10 * ss(seg(t, T('e1') + 1, E('e3')));
  const night = Math.max(ss(seg(t, T('c4_1') - 1.4, T('c4_1') + 2.2)) * (1 - ss(seg(t, E('c4_8') + .5, T('c5_1') + 2.5))), 0) * .82;
  const titleDim = vis(t, E('p5') + .8, E('p5') + 6.6, .8, .9) * .5;
  const endDim = ss(seg(t, E('e4') + .6, E('e4') + 2.2)) * .45;
  // 聚光：某个瞬间只亮一处
  let focus = [0, 0, -1], focusAmt = 0;
  const fz = [[T('c2_9') - .2, E('c2_9') + 1.2, G.town.tlaxcala, .45], [T('c3_5') - 4.4, T('c3_5') - .2, [-99.1335, 19.4290], .05],
              [T('c7_13') - 5.8, E('c7_13'), G.town.tlatelolco, .045]];
  for (const [a, b, ll, r] of fz) { const v = vis(t, a, b, .8, .9); if (v > focusAmt) { focusAmt = v; focus = [ll[0], ll[1], r]; } }
  return { grey, shade, lake, lakeScan: scan, lakeDir: dir, drain, night, dim: Math.max(titleDim, endDim), focus, focusAmt, a: plateAlphas(d),
           contrast: 1.05, clarity: d < 60 ? .45 : .32, detail: .62, expo };
}

// ------------------------------------------------------------------ 仪表、章节、字幕
const CHAP = () => [
  [0, '今天 · 墨西哥城', ''], [T('c1_1') - 1.5, '一 · 登陆', '1519 年 2 月 – 4 月'], [T('c2_1') - 2, '二 · 进军', '1519 年 8 月 – 11 月'],
  [T('c3_1') - 2, '三 · 入城', '1519 年 11 月 – 1520 年 6 月'], [T('c4_1') - 2, '四 · 悲伤之夜', '1520 年 6 月 30 日'],
  [T('c5_1') - 2, '五 · 逃亡', '1520 年 7 月'], [T('c6_1') - 2, '六 · 准备', '1520 年秋 – 1521 年春'],
  [T('c7_1') - 2, '七 · 围城', '1521 年 5 月 – 8 月'], [T('e1') - 2, '此后', '1521 年 – 今天'],
];
function instruments(t, cam, S) {
  const chap = CHAP(); let i = 0; while (i < chap.length - 1 && t >= chap[i + 1][0]) i++;
  const [t0, name, date] = chap[i], nxt = i < chap.length - 1 ? chap[i + 1][0] : DUR + 9;
  const a = vis(t, t0, nxt, .8, .6) * (1 - S.dim * 1.6) * (t < E('p5') + .8 || t > E('p5') + 6.6 ? 1 : 0);
  if (a > 0.01 && !(t > E('e4') + .6)) {
    text(ctx, name, 72, 82, { font: '500 32px SC', alpha: a, id: 'chap' + i, track: 2 });
    if (date) text(ctx, date, 72, 120, { font: '400 22px PM', alpha: a * .85, col: 'rgba(242,245,246,.8)', id: 'chapd' + i });
  }
  const ia = 1 - S.dim * 1.8; if (ia <= 0.02) return;
  const alt = cam.alt;
  text(ctx, '高度  ' + (alt >= 100 ? fmt(alt) : alt.toFixed(1)) + ' km', W - 64, 82, { font: '400 24px PM', align: 'right', alpha: ia });
  const kpp = kmPerPx(cam), nice = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  const km = nice.find(n => n / kpp > 120) || 1000, len = km / kpp;
  hair(ctx, () => { ctx.moveTo(W - 64 - len, 128); ctx.lineTo(W - 64 - len, 136); ctx.lineTo(W - 64, 136); ctx.lineTo(W - 64, 128); }, { w: 1.5, alpha: ia * .9 });
  text(ctx, km + ' km', W - 64, 120, { font: '400 20px PM', align: 'right', alpha: ia * .9 });
  // 影像出处：看当前哪块版图最细
  const A = S.a;
  const src = A.city > .5 ? 'Contains modified Copernicus Sentinel data 2026' : A.basin > .5 || A.highland > .5 ? 'Sentinel-2 cloudless 2016 by EOX (CC BY 4.0) · Copernicus' : 'NASA Blue Marble';
  text(ctx, src + (S.lake > .3 && A.highland + A.basin + A.city > .5 ? '  ·  1519 年湖岸为示意' : ''), W - 64, H - 34, { font: '400 19px PM', align: 'right', alpha: ia * .8, col: 'rgba(242,245,246,.8)' });
}
function subs(t) {
  for (const c of CUES) if (t >= c.t0 - .05 && t < c.t1 + .15) { subtitle(ctx, c.text, Math.min(1, seg(t, c.t0 - .05, c.t0 + .12)) * (1 - seg(t, c.t1, c.t1 + .15))); return; }
}

// ------------------------------------------------------------------ 各章的标注
const RX = 1290, RY = 600;         // 读数的位置：右三分之一
function dike(cam, alpha) {
  if (alpha <= .01) return;
  hair(ctx, () => lineLL(ctx, cam, G.dike, 1), { w: 5.5, col: C.dike, alpha, halo: 3 });
  hair(ctx, () => lineLL(ctx, cam, G.dike, 1), { w: 2, col: 'rgb(30,48,78)', alpha, halo: 0 });
}
function prologue(t, cam) {
  const avenue = [[-99.1415, 19.352], [-99.139, 19.385], [-99.136, 19.400], [-99.134, 19.4142], [-99.1332, 19.4326]];
  const a0 = vis(t, 1.0, T('p4') + 1.5, .6, 1.2);
  const lock = ss(seg(t, .6, 1.5));
  const [rx, ry] = P(cam, [-99.1375, 19.393]);
  if (t < T('p2') + 1) reticle(ctx, rx, ry, { r: 30, lock, alpha: vis(t, .2, T('p2') + 1, .3, .6) });
  route(cam, avenue, ss(seg(t, 1.4, 4.0)), { w: 2.6, alpha: a0 });
  const old = ss(seg(t, T('p2') + .3, T('p2') + 1.4));
  label(ctx, cam, [-99.1385, 19.3895], '特拉尔潘大道 · 今天', { dx: 150, dy: -20, size: 30, weight: 500, alpha: a0 * (1 - old), id: 'p-avenue' });
  label(ctx, cam, [-99.1385, 19.3895], '伊斯塔帕拉帕堤道 · 1519 年', { dx: 150, dy: -20, size: 30, weight: 500, alpha: a0 * old * vis(t, 0, T('p4') + 1.5), id: 'p-cause', col: C.water });
  // 岛城
  const isl = ss(seg(t, T('p4') - .2, T('p4') + 1.6)), ia = isl * (1 - ss(seg(t, E('p5') + .4, E('p5') + 1.2)));
  hair(ctx, () => lineLL(ctx, cam, G.island, isl, true), { w: 2.2, alpha: ia });
  label(ctx, cam, G.precinct, '特诺奇蒂特兰', { dx: 170, dy: -120, size: 34, weight: 700, alpha: ia * ss(seg(t, T('p4') + .8, T('p4') + 1.6)), id: 'p-ten' });
  const ca = ss(seg(t, T('p3') + .2, T('p3') + 1.6)) * (1 - ss(seg(t, E('p5') + .4, E('p5') + 1.2)));
  for (const k of ['cause_tepeyac', 'cause_tlacopan', 'cause_south', 'cause_coyoacan', 'cause_iztapalapa']) route(cam, G[k], 1, { w: 2, alpha: ca * .9 });
  label(ctx, cam, [-99.0925, 19.462], '内萨瓦尔科约特尔大堤', { dx: 60, dy: -40, alpha: ca * vis(t, T('p3') + .8, E('p5') + .4), col: C.dike, dot: false, size: 24, id: 'p-dike' });
  if (ca > .02) text(ctx, '1519 年的湖', ...P(cam, [-99.03, 19.405]).slice(0, 2), { font: '600 40px SS', col: C.water, align: 'center', alpha: ca, id: 'p-lake' });
}
function titleCard(t) {
  const a0 = E('p5') + .8, a1 = a0 + 5.8;
  if (t < a0 - .2 || t > a1 + .9) return;
  const open = eo(seg(t, a0, a0 + .9)), a = vis(t, a0, a1, .5, .9);
  const cx = W / 2, cy = H / 2 - 10, hw = lerp(40, 470, open), hh = lerp(40, 150, open);
  brackets(ctx, cx - hw, cy - hh, cx + hw, cy + hh, { len: 36, alpha: a, w: 2 });
  const ta = a * ss(seg(t, a0 + .6, a0 + 1.3));
  text(ctx, '湖上之城', cx, cy + 10, { font: '600 104px SS', align: 'center', alpha: ta, track: 14, id: 'title', halo: 14 });
  text(ctx, '特诺奇蒂特兰的陷落 · 1519—1521', cx, cy + 82, { font: '400 32px SC', align: 'center', alpha: ta * .95, track: 4, id: 'title-sub' });
}
function chapter1(t, cam) {
  if (t < T('c1_1') - 3 || t > T('c2_1') + 1) return;
  const A = vis(t, T('c1_1') - 2, T('c2_1') - .5, .8, 1.2), tw = G.town;
  const f = ss(seg(t, T('c1_1') + .3, T('c1_9') + .4));
  const tip = route(cam, G.route_sea, f, { w: 2.2, dash: [10, 8], alpha: A });
  if (tip && f < 1) reticle(ctx, tip[0], tip[1], { r: 14, alpha: A * .9 });
  town(ctx, cam, tw.cuba, 'town', { alpha: A });
  label(ctx, cam, tw.cuba, '古巴西端 · 1519 年 2 月启航', { dx: -40, dy: -80, alpha: A * vis(t, T('c1_1') + .2, T('c1_4') + 2), id: 'l-cuba' });
  const at = (id, k) => A * vis(t, T(id) - .3, k);
  town(ctx, cam, tw.cozumel, 'town', { alpha: A * ss(seg(t, T('c1_4') - .6, T('c1_4'))) });
  label(ctx, cam, tw.cozumel, '科苏梅尔岛 · 找到阿吉拉尔', { dx: -50, dy: 90, alpha: at('c1_4', E('c1_4') + 3), id: 'l-coz' });
  town(ctx, cam, tw.potonchan, 'town', { alpha: A * ss(seg(t, T('c1_5') - .6, T('c1_5'))) });
  label(ctx, cam, tw.potonchan, '波通昌 · 第一仗', { dx: 30, dy: 90, alpha: at('c1_5', T('c1_9')), id: 'l-pot' });
  // 翻译链
  const ch = vis(t, T('c1_7') - .2, T('c1_9') + .5);
  if (ch > .01) {
    const [px, py] = P(cam, tw.potonchan), y = py + 150, words = ['纳瓦特尔语', '玛雅语', '西班牙语'], who = ['玛林切', '阿吉拉尔'];
    let x = px - 260;
    words.forEach((w, i) => {
      const ai = ch * ss(seg(t, T('c1_8') + i * .7 - .4, T('c1_8') + i * .7));
      const ww = text(ctx, w, x, y, { font: '500 26px SC', alpha: Math.max(ai, i === 0 || i === 1 ? ch * ss(seg(t, T('c1_7'), T('c1_7') + .6)) * .9 : 0), id: 'chain' + i });
      if (i < 2) { const ax = x + ww + 14; hair(ctx, () => { ctx.moveTo(ax, y - 9); ctx.lineTo(ax + 64, y - 9); ctx.moveTo(ax + 56, y - 15); ctx.lineTo(ax + 64, y - 9); ctx.lineTo(ax + 56, y - 3); }, { w: 1.4, alpha: ch * ss(seg(t, T('c1_8') + i * .7, T('c1_8') + i * .7 + .4)) });
        text(ctx, who[i], ax + 32, y + 30, { font: '400 20px SC', align: 'center', col: C.amber, alpha: ch * ss(seg(t, T('c1_8') + i * .7, T('c1_8') + i * .7 + .4)), id: 'who' + i }); x = ax + 82; }
    });
  }
  town(ctx, cam, tw.veracruz, 'town', { alpha: A * ss(seg(t, T('c1_9') - .5, T('c1_9'))) });
  if (t > T('c1_9') - .4) reticle(ctx, ...P(cam, tw.veracruz).slice(0, 2), { r: 22, lock: ss(seg(t, T('c1_9') - .4, T('c1_9') + .3)), alpha: A * vis(t, T('c1_9') - .4, E('c1_9') + 1.2) });
  label(ctx, cam, tw.veracruz, '韦拉克鲁斯', { dx: 40, dy: 70, alpha: A * vis(t, T('c1_9'), T('c2_1')), id: 'l-ver' });
  // 使者：首都和海岸之间来回的虚线
  const ev = A * vis(t, T('c1_10') - .2, E('c1_11') + .6);
  if (ev > .01) {
    town(ctx, cam, tw.tenochtitlan, 'triple', { alpha: ev });
    route(cam, [tw.tenochtitlan, [-97.6, 19.6], tw.veracruz], 1, { w: 1.6, dash: [5, 7], off: -t * 30, alpha: ev * .9, col: C.ink });
    label(ctx, cam, tw.tenochtitlan, '特诺奇蒂特兰 · 蒙特祖马二世', { dx: 30, dy: -90, alpha: ev, id: 'l-moc', weight: 500 });
  }
  readout(ctx, RX, RY, { label: '远征队', value: '≈500', unit: '名士兵', note: '11 艘船 · 16 匹马', note2: '贝尔纳尔·迪亚斯记载：士兵 508 人，另有水手约 100 人', alpha: A * vis(t, T('c1_2') - .1, E('c1_3') + .6), id: 'r-exp' });
  readout(ctx, RX, RY, { label: '在韦拉克鲁斯附近靠岸', value: '1519.4.21', alpha: A * vis(t, T('c1_9') + .1, E('c1_9') + 2.6), id: 'r-land' });
}
function chapter2(t, cam) {
  if (t < T('c2_1') - 2 || t > T('c3_1') + 2) return;
  const A = vis(t, T('c2_1') - 1.2, T('c3_1'), 1, 1.2), tw = G.town;
  town(ctx, cam, tw.veracruz, 'town', { alpha: A });
  town(ctx, cam, tw.cempoala, 'ally', { alpha: A * ss(seg(t, T('c2_1') + .3, T('c2_1') + 1)) });
  label(ctx, cam, tw.cempoala, '森波阿拉 · 托托纳克人结盟', { dx: 40, dy: -80, alpha: A * vis(t, T('c2_1') + .3, T('c2_3') + 1.5), col: C.amber, id: 'l-cem' });
  // 弄沉的船
  const sk = vis(t, T('c2_2') - .2, E('c2_2') + 1.5);
  if (sk > .01) { const [x, y] = P(cam, [-96.05, 19.25]);
    for (let i = 0; i < 11; i++) { const u = ss(seg(t, T('c2_2') + .6 + i * .12, T('c2_2') + 1.8 + i * .12));
      boat(x + (i % 4) * 26 - 30, y + Math.floor(i / 4) * 22 - 18 + u * 6, -.2, 1 - u * .5, sk * (1 - u * .85)); }
    label(ctx, cam, [-96.05, 19.25], '船被弄沉', { dx: 60, dy: 60, alpha: sk, id: 'l-sink' }); }
  // 陆路测距线
  const R = G.route_land, toTlax = 6, toCho = 7, toBasin = 12;
  const kT = kmLen(R.slice(0, toTlax + 1)) / kmLen(R), kC = kmLen(R.slice(0, toCho + 1)) / kmLen(R), kB = kmLen(R.slice(0, toBasin + 1)) / kmLen(R);
  let f = 0;
  if (t > T('c2_3')) f = lerp(0, kT * .93, ss(seg(t, T('c2_3') + .2, T('c2_5') + 1.4)));
  if (t > T('c2_8')) f = lerp(kT * .93, kT, ss(seg(t, T('c2_8'), T('c2_8') + 1.2)));
  if (t > T('c2_10') - 1) f = lerp(kT, kC, ss(seg(t, T('c2_10') - 1, T('c2_10') + 1.2)));
  if (t > T('c2_12') - 1.5) f = lerp(kC, kB, ss(seg(t, T('c2_12') - 1.5, E('c2_12') + .5)));
  const tip = route(cam, R, f, { w: 3, col: C.ink, alpha: A });
  ticks(cam, R, f, 10, { alpha: A * .8, major: 50 });
  if (tip && f > 0 && f < kB * .995) reticle(ctx, tip[0], tip[1], { r: 13, alpha: A * .9 });
  const kmNow = kmLen(R) * f;
  readout(ctx, RX, RY, { label: '从海边出发 · 陆路', value: fmt(kmNow), unit: 'km', note: '沿推测路线测算', note2: '终点海拔约 2,200 米', alpha: A * vis(t, T('c2_3') + .2, T('c2_6') + .5), id: 'r-march', rep: fmt(kmLen(R) * kT * .93) });
  // 特拉斯卡拉
  const tl = ss(seg(t, T('c2_8') + .4, T('c2_8') + 1.0));
  if (t > T('c2_5') - .5) {
    town(ctx, cam, tw.tlaxcala, tl > .5 ? 'ally' : 'town', { alpha: A, s: 1 + .5 * Math.sin(Math.PI * tl) });
    label(ctx, cam, tw.tlaxcala, tl > .5 ? '特拉斯卡拉 · 结盟' : '特拉斯卡拉 · 从未被阿兹特克征服', { dx: 60, dy: 70, alpha: A * vis(t, T('c2_5'), E('c2_9') + 3), col: tl > .5 ? C.amber : C.ink, weight: 500, id: tl > .5 ? 'l-tlx2' : 'l-tlx1' });
    const [bx, by] = P(cam, [-98.02, 19.46]);
    reticle(ctx, bx, by, { r: 20, lock: ss(seg(t, T('c2_7') - .3, T('c2_7') + .3)), alpha: A * vis(t, T('c2_7') - .3, T('c2_8') + 1), col: C.amber });
    label(ctx, cam, [-98.02, 19.46], '交战约 18 天', { dx: -40, dy: -60, alpha: A * vis(t, T('c2_7'), T('c2_8') + 1.5), id: 'l-war' });
  }
  // 乔卢拉
  if (t > T('c2_10') - .5) {
    const [x, y] = P(cam, tw.cholula);
    reticle(ctx, x, y, { r: 22, lock: ss(seg(t, T('c2_10') + .2, T('c2_10') + .8)), alpha: A * vis(t, T('c2_10'), E('c2_11') + 1.5), col: C.amber });
    label(ctx, cam, tw.cholula, '乔卢拉 · 1519 年 10 月', { dx: -50, dy: 70, alpha: A * vis(t, T('c2_10') + .3, T('c2_12')), id: 'l-cho' });
    readout(ctx, RX, RY, { label: '乔卢拉 · 几个小时之内', value: '3,000–6,000', unit: '人被杀', note: '科尔特斯称约 3,000 人，戈马拉称 6,000 人', note2: '各家记载差异很大', alpha: A * vis(t, T('c2_11') + .2, E('c2_11') + 3.4), id: 'r-cho', size: 96 });
  }
  // 两座火山与山口
  if (t > T('c2_12') - 1) {
    const va = A * vis(t, T('c2_12') - .5, E('c2_13') + 1);
    town(ctx, cam, tw.popocatepetl, 'town', { alpha: va, s: .8 }); town(ctx, cam, tw.iztaccihuatl, 'town', { alpha: va, s: .8 });
    label(ctx, cam, tw.popocatepetl, '波波卡特佩特火山 5,426 m', { dx: 60, dy: 40, alpha: va, dot: false, id: 'l-popo' });
    label(ctx, cam, tw.iztaccihuatl, '伊斯塔西瓦特尔火山 5,230 m', { dx: 60, dy: -50, alpha: va, dot: false, id: 'l-izta' });
  }
  const ba = A * vis(t, T('c2_13') + .4, T('c3_1') + 1, 1.2, 1);
  if (ba > .01) text(ctx, '墨西哥谷地', ...P(cam, [-99.05, 19.45]).slice(0, 2), { font: '600 44px SS', align: 'center', col: C.water, alpha: ba, id: 'l-valley' });
}
function chapter3(t, cam) {
  if (t < T('c3_1') - 2 || t > T('c4_1') + 1) return;
  const A = vis(t, T('c3_1') - 1.5, T('c4_1'), 1, 1), tw = G.town;
  // 沿南堤道进城
  const path = [...G.cause_iztapalapa.slice().reverse(), ...G.cause_south.slice().reverse().slice(1)];
  const f = ss(seg(t, T('c3_1') + .2, T('c3_4') + .4));
  const near = t < T('c3_6');
  route(cam, path, f, { w: 3, alpha: A * (near ? 1 : .5) });
  const [cx, cy] = P(cam, [-99.1335, 19.4290]);
  if (t > T('c3_4') - .6 && t < T('c3_6') + .5) {
    reticle(ctx, cx, cy, { r: 26, lock: ss(seg(t, T('c3_4') - .5, T('c3_4') + .2)), alpha: A * vis(t, T('c3_4') - .5, T('c3_6') + .3) });
    label(ctx, cam, [-99.1335, 19.4290], '相遇 · 蒙特祖马与科尔特斯', { dx: 70, dy: 80, alpha: A * vis(t, T('c3_4') + .2, T('c3_6')), weight: 500, id: 'l-meet' });
  }
  readout(ctx, RX, RY, { label: '走上南面的堤道', value: '1519.11.8', alpha: A * vis(t, T('c3_1') + .2, E('c3_2') + .4), id: 'r-nov8' });
  readout(ctx, RX, RY, { label: '特诺奇蒂特兰 · 1519 年', value: '200,000+', unit: '人', note: '估计从 20 万到 40 万不等', alpha: A * vis(t, T('c3_3') + .1, E('c3_3b') + .8), id: 'r-pop' });
  // 独木舟
  const cn = A * vis(t, T('c3_2') - .2, E('c3_3b') + .5);
  if (cn > .01) drawCanoes(t, cam, cn, null);
  const ci = A * vis(t, T('c3_3b') - .2, E('c3_3b') + 1.6);
  label(ctx, cam, G.precinct, '大神庙', { dx: 90, dy: -70, alpha: ci, id: 'l-temple' });
  label(ctx, cam, [-99.1300, 19.4325], '蒙特祖马的宫殿', { dx: 100, dy: 40, alpha: ci, id: 'l-palace' });
  label(ctx, cam, [-99.1372, 19.4515], '特拉特洛尔科大集市', { dx: -70, dy: 60, alpha: ci, id: 'l-market' });
  // 软禁
  const sa = A * vis(t, T('c3_5'), E('c3_5') + 1);
  label(ctx, cam, [-99.1340, 19.4355], '西班牙人驻地 · 蒙特祖马被软禁', { dx: -80, dy: -90, alpha: sa, id: 'l-hostage', weight: 500 });
  // 1524 年的地图
  mapLayer(t, cam);
  // 回海边打纳瓦埃斯
  const na = vis(t, T('c3_8') - .2, E('c3_10') + 1.6);
  if (na > .01) {
    const back = G.route_land.slice().reverse();
    const ff = ss(seg(t, T('c3_8') - .4, T('c3_8') + 1.2));
    route(cam, back, ff, { w: 2.4, dash: [8, 6], alpha: na });
    town(ctx, cam, tw.cempoala, 'town', { alpha: na });
    const [x, y] = P(cam, tw.cempoala);
    reticle(ctx, x, y, { r: 20, lock: ss(seg(t, T('c3_9') + .5, T('c3_9') + 1.1)), alpha: na * vis(t, T('c3_9') + .4, E('c3_9') + 1), col: C.amber });
    label(ctx, cam, tw.cempoala, '森波阿拉 · 1520 年 5 月底夜袭', { dx: 40, dy: -80, alpha: na * vis(t, T('c3_9') + .4, E('c3_10') + 1.5), id: 'l-narv' });
    readout(ctx, RX, RY, { label: '纳瓦埃斯的远征军', value: '≈900', unit: '人', note: '奉古巴总督之命来抓科尔特斯', alpha: na * vis(t, T('c3_8') + .5, E('c3_9') + .2), id: 'r-narv' });
    const sp = vis(t, T('c3_10'), E('c3_10') + 1.6);
    for (let k = 0; k < 3; k++) { const u = (seg(t, T('c3_10') + k * .7, T('c3_10') + k * .7 + 2.2));
      if (u > 0 && u < 1) route(cam, circleLL(tw.cempoala, 6 + u * 28), 1, { w: 1.4, dash: [4, 6], alpha: na * sp * (1 - u) }); }
    label(ctx, cam, tw.cempoala, '天花？', { dx: 60, dy: 50, alpha: na * sp, id: 'l-pox1', col: C.ink });
  }
  // 屠杀、暴动、蒙特祖马之死
  const pa = A * vis(t, T('c3_11') + .3, E('c3_11') + 1.5);
  if (pa > .01) { reticle(ctx, ...P(cam, G.precinct).slice(0, 2), { r: 24, alpha: pa, col: C.amber, lock: ss(seg(t, T('c3_11') + .3, T('c3_11') + .9)) });
    label(ctx, cam, G.precinct, '托什卡特尔节屠杀 · 1520 年 5 月', { dx: 90, dy: -90, alpha: pa, id: 'l-toxcatl' }); }
  const ra = A * vis(t, T('c3_12'), E('c3_14') + 1);
  if (ra > .01) { const c = [-99.1340, 19.4355];
    for (let k = 0; k < 18; k++) { const ang = k / 18 * Math.PI * 2, rr = lerp(1.3, .45, ss(seg(t, T('c3_12'), E('c3_12')))), k2 = Math.cos(c[1] * Math.PI / 180) * KM;
      const p0 = [c[0] + Math.cos(ang) * rr / k2, c[1] + Math.sin(ang) * rr / KM], p1 = [c[0] + Math.cos(ang) * (rr + .25) / k2, c[1] + Math.sin(ang) * (rr + .25) / KM];
      const [x0, y0] = P(cam, p0), [x1, y1] = P(cam, p1); hair(ctx, () => { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }, { w: 2, alpha: ra * .9 }); }
    label(ctx, cam, c, '西班牙人被围在宫殿里', { dx: -90, dy: -90, alpha: A * vis(t, T('c3_12') + .3, T('c3_13') + .5), id: 'l-besieged' }); }
  label(ctx, cam, [-99.1340, 19.4355], '蒙特祖马之死 · 1520 年 6 月底', { dx: -90, dy: -90, alpha: A * vis(t, T('c3_13') + .3, E('c3_13') + 1.2), id: 'l-mdeath' });
  label(ctx, cam, G.precinct, '新皇帝：奎特拉瓦克', { dx: 100, dy: 70, alpha: A * vis(t, T('c3_14'), E('c3_14') + 2.2), id: 'l-cuit', weight: 500 });
}
function mapLayer(t, cam) {
  const a0 = T('c3_6') + .3, tear = T('c3_8') - 3.4;
  if (t < a0 || t > tear + 1.4) return;
  const kpp = kmPerPx(cam), s = (16 / MAP.h) / kpp * lerp(1.06, 1, eo(seg(t, a0, a0 + 1.4)));
  const [px, py] = P(cam, G.precinct), mw = MAP.w * s, mh = MAP.h * s;
  const x0 = px - PL.map1524.precinct_px[0] * s, y0 = py - PL.map1524.precinct_px[1] * s;
  const a = ss(seg(t, a0, a0 + 1.2));
  const bar = lerp(y0 - 20, y0 + mh + 20, ss(seg(t, tear, tear + .55)));
  ctx.save(); ctx.globalAlpha = a;
  ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 30;
  ctx.beginPath(); ctx.rect(x0 - 40, bar, mw + 80, H * 2); ctx.clip();
  ctx.fillStyle = '#e9dfc6'; ctx.fillRect(x0 - 14, y0 - 14, mw + 28, mh + 28);
  ctx.shadowBlur = 0; ctx.drawImage(MAP.img, x0, y0, mw, mh);
  ctx.restore();
  if (t > tear && t < tear + .7) { const g = ctx.createLinearGradient(0, bar - 40, 0, bar + 8);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(240,248,255,.75)'); ctx.fillStyle = g; ctx.fillRect(x0 - 40, bar - 40, mw + 80, 48); }
  const la = a * (1 - ss(seg(t, tear - .3, tear)));
  text(ctx, '1524 年 · 纽伦堡', x0 + mw + 40, y0 + 120, { font: '500 30px SC', alpha: la, id: 'map-y' });
  text(ctx, '随科尔特斯的第二封信出版', x0 + mw + 40, y0 + 162, { font: '400 24px SC', alpha: la * .9, id: 'map-n' });
  text(ctx, '原图西方朝上，这里转成北朝上', x0 + mw + 40, y0 + 198, { font: '400 21px SC', alpha: la * .75, col: 'rgba(242,245,246,.8)', id: 'map-n2' });
}
function drawCanoes(t, cam, alpha, toward) {
  for (const c of CANOES) {
    let ll = [c.ll[0] + Math.sin(t * .3 + c.ph) * .0006, c.ll[1] + Math.cos(t * .23 + c.ph) * .0005];
    if (toward) { const u = toward.u * c.k; ll = [lerp(ll[0], toward.ll(c)[0], u), lerp(ll[1], toward.ll(c)[1], u)]; }
    const [x, y, v] = P(cam, ll); if (!v || x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
    canoe(x, y, c.ang, alpha * c.a);
  }
}
function chapter4(t, cam) {
  if (t < T('c4_1') - 1 || t > T('c5_1') + 2) return;
  const A = vis(t, T('c4_1') - .5, T('c5_1') + 1, 1, 1.4);
  const R = G.route_retreat.slice(0, 4);
  route(cam, G.cause_tlacopan, 1, { w: 2.6, alpha: A * vis(t, T('c4_2') - .2, E('c4_8') + 1) * .7 });
  label(ctx, cam, [-99.170, 19.4465], '特拉科潘堤道 · 向西', { dx: 0, dy: -110, alpha: A * vis(t, T('c4_2'), E('c4_3') + 1.2), weight: 500, id: 'l-tlac' });
  // 缺口
  const gaps = [.16, .38, .58, .80];
  const prog = ss(seg(t, T('c4_6') - 4.2, E('c4_7') - .5));
  gaps.forEach((g, i) => {
    const ll = alongLL(G.cause_tlacopan, g), [x, y] = P(cam, ll), ga = A * vis(t, T('c4_3') + .3 + i * .35, E('c4_8') + 1);
    const hot = prog > g ? 1 : 0;
    hair(ctx, () => { ctx.moveTo(x - 9, y - 9); ctx.lineTo(x + 9, y + 9); ctx.moveTo(x + 9, y - 9); ctx.lineTo(x - 9, y + 9); }, { w: 2.4, alpha: ga, col: hot ? C.amber : C.ink });
  });
  label(ctx, cam, alongLL(G.cause_tlacopan, .38), '桥被拆掉的缺口', { dx: 40, dy: 90, alpha: A * vis(t, T('c4_3') + .6, E('c4_4') + .8), id: 'l-gaps', dot: false });
  // 突围的队伍：线头沿堤道前进
  const tip = route(cam, R, prog, { w: 3.2, col: C.amber, alpha: A });
  if (tip && prog > 0 && prog < 1) reticle(ctx, tip[0], tip[1], { r: 12, alpha: A, col: C.amber });
  // 雨
  const rain = A * vis(t, T('c4_4') - .2, E('c4_8') + .6, 1.2, 1.6);
  if (rain > .01) { const rnd = mulberry(Math.floor(t * 24) + 7); ctx.save(); ctx.strokeStyle = 'rgba(210,225,240,.22)'; ctx.lineWidth = 1; ctx.globalAlpha = rain; ctx.beginPath();
    for (let i = 0; i < 170; i++) { const x = rnd() * W, y = rnd() * H, l = 18 + rnd() * 26; ctx.moveTo(x, y); ctx.lineTo(x - l * .25, y + l); } ctx.stroke(); ctx.restore(); }
  // 独木舟从四面围上来
  const ca = A * vis(t, T('c4_5') - .5, E('c4_8') + .4);
  if (ca > .01) drawCanoes(t, cam, ca, { u: ss(seg(t, T('c4_5') - .5, T('c4_6') + 2)), ll: c => c.near });
  readout(ctx, RX, RY + 40, { label: '突围', value: '1520.6.30', note: '深夜', alpha: A * vis(t, T('c4_1') + .3, E('c4_1') + 2.4), id: 'r-noche' });
  readout(ctx, RX, RY + 40, { label: '西班牙人的损失', value: '154–1,000+', unit: '人', note: '科尔特斯自称 154 人；其他记载从数百到上千', note2: '特拉斯卡拉盟军：数千人', alpha: A * vis(t, T('c4_7') + .1, E('c4_7') + 3), id: 'r-loss', size: 96 });
  const na = A * vis(t, T('c4_8') + .4, E('c4_8') + 2.6);
  if (na > .01) text(ctx, '悲伤之夜', W / 2, 300, { font: '600 76px SS', align: 'center', alpha: na, track: 12, id: 'noche', halo: 16 });
}
function chapter5(t, cam) {
  if (t < T('c5_1') - 1 || t > T('c6_1') + 1) return;
  const A = vis(t, T('c5_1') - .5, T('c6_1'), 1, 1.2), tw = G.town, R = G.route_retreat;
  const kO = kmLen(R.slice(0, 14)) / kmLen(R);
  let f = lerp(kmLen(R.slice(0, 4)) / kmLen(R), kO, ss(seg(t, T('c5_1') - .5, T('c5_2') + .5)));
  if (t > T('c5_4') - .5) f = lerp(kO, 1, ss(seg(t, T('c5_4') - .5, E('c5_4'))));
  const tip = route(cam, R, f, { w: 3, col: C.amber, alpha: A });
  if (tip && f < 1) reticle(ctx, tip[0], tip[1], { r: 12, alpha: A, col: C.amber });
  town(ctx, cam, tw.tenochtitlan, 'triple', { alpha: A });
  label(ctx, cam, tw.tenochtitlan, '特诺奇蒂特兰', { dx: -40, dy: 70, alpha: A * vis(t, T('c5_1'), T('c5_2')), id: 'l-ten5' });
  const [ox, oy] = P(cam, tw.otumba);
  if (t > T('c5_2') - .2) { reticle(ctx, ox, oy, { r: 24, lock: ss(seg(t, T('c5_2'), T('c5_2') + .6)), alpha: A * vis(t, T('c5_2'), E('c5_3') + 1.4), col: C.amber });
    const u = seg(t, T('c5_3') + .3, T('c5_3') + 2.4); if (u > 0 && u < 1) hair(ctx, () => ctx.arc(ox, oy, 24 + u * 90, 0, 7), { w: 2, alpha: A * (1 - u), col: C.amber }); }
  readout(ctx, RX, RY, { label: '奥通巴之战', value: '1520.7.7', alpha: A * vis(t, T('c5_2') + .2, E('c5_3') + .6), id: 'r-otumba' });
  label(ctx, cam, tw.otumba, '奥通巴', { dx: 50, dy: -60, alpha: A * vis(t, T('c5_2'), E('c5_4') + 1), weight: 500, id: 'l-otu' });
  town(ctx, cam, tw.tlaxcala, 'ally', { alpha: A * ss(seg(t, T('c5_4') - .5, T('c5_4'))) });
  label(ctx, cam, tw.tlaxcala, '特拉斯卡拉', { dx: -60, dy: 70, alpha: A * vis(t, T('c5_4') + .2, T('c6_1')), col: C.amber, weight: 500, id: 'l-tlx5' });
}
const FLIP = [['iztapalapa', '伊斯塔帕拉帕'], ['xaltocan', '夏尔托坎'], ['tlacopan', '特拉科潘'], ['chalco', '查尔科'], ['xochimilco', '霍奇米尔科'],
  ['coyoacan', '科约阿坎'], ['azcapotzalco', '阿斯卡波察尔科'], ['chimalhuacan', '奇马尔瓦坎'], ['cuitlahuac', '奎特拉瓦克'], ['ecatepec', '埃卡特佩克']];
function flipT(i) { return lerp(T('c6_9') + .4, E('c6_10') - .8, i / (FLIP.length - 1)); }
function chapter6(t, cam) {
  if (t < T('c6_1') - 1 || t > T('c7_1') + 1) return;
  const A = vis(t, T('c6_1') - .5, T('c7_1'), 1, 1.2), tw = G.town;
  // 天花
  const pa = A * vis(t, T('c6_1') + .2, E('c6_4') + .8, 1, 1.2);
  if (pa > .01) {
    const seeds = ['tenochtitlan', 'texcoco', 'chalco', 'xochimilco', 'ecatepec', 'tlacopan', 'chimalhuacan', 'zumpango'];
    seeds.forEach((s, i) => { for (let k = 0; k < 2; k++) { const t0 = T('c6_2') - 1 + i * .55 + k * 1.6, u = seg(t, t0, t0 + 3.4);
      if (u > 0 && u < 1) route(cam, circleLL(tw[s], 1 + u * 9), 1, { w: 1.3, dash: [3, 6], alpha: pa * (1 - u) * .9 }); } });
    label(ctx, cam, [-98.98, 19.66], '天花 · 1520 年秋', { dx: 60, dy: -40, alpha: pa * vis(t, T('c6_1') + .6, E('c6_2') + 1.5), weight: 500, id: 'l-pox' });
  }
  town(ctx, cam, tw.tenochtitlan, 'triple', { alpha: A });
  label(ctx, cam, tw.tenochtitlan, '奎特拉瓦克去世 · 1520 年 12 月', { dx: -60, dy: -80, alpha: A * vis(t, T('c6_3') + .2, E('c6_3') + 1.4), id: 'l-cdie' });
  label(ctx, cam, tw.tenochtitlan, '夸乌特莫克继位', { dx: -60, dy: -80, alpha: A * vis(t, T('c6_4') + .2, E('c6_4') + 2), weight: 500, id: 'l-cuau' });
  // 13 艘船，扛过山
  const ba = A * vis(t, T('c6_6') - .2, E('c6_11') + 1.5);
  const R = G.route_boats, nK = kmLen(R.slice(0, 7)) / kmLen(R);
  const f = ss(seg(t, T('c6_7') - .3, E('c6_7') + 2.2)) * nK + (t > T('c6_11') ? ss(seg(t, T('c6_11'), E('c6_11') + .4)) * (1 - nK) : 0);
  if (ba > .01) {
    route(cam, R, f, { w: 2.4, dash: [9, 6], alpha: ba });
    ticks(cam, R, Math.min(f, nK), 10, { alpha: ba * .8 });
    const c = alongLL(R, f), [x, y] = P(cam, c);
    for (let i = 0; i < 13; i++) boat(x + (i % 5) * 26 - 52, y + Math.floor(i / 5) * 24 - 24, -.15, 1.35, ba * ss(seg(t, T('c6_6') + i * .08, T('c6_6') + .4 + i * .08)));
    town(ctx, cam, tw.tlaxcala, 'ally', { alpha: ba });
    label(ctx, cam, tw.tlaxcala, '特拉斯卡拉 · 造船', { dx: -60, dy: 80, alpha: ba * vis(t, T('c6_6'), E('c6_7') + 1), col: C.amber, id: 'l-tlx6' });
    readout(ctx, RX, RY + 60, { label: '13 艘帆船 · 拆成零件扛过山', value: fmt(kmLen(R) * Math.min(f, nK)), unit: 'km', note: '从特拉斯卡拉到特斯科科 · 沿推测路线测算', alpha: ba * vis(t, T('c6_7') - .2, E('c6_7') + 3.2), id: 'r-boats', rep: fmt(kmLen(R) * nK) });
  }
  // 特斯科科倒戈
  const tx = ss(seg(t, T('c6_8') + .6, T('c6_8') + 1.2));
  if (t > T('c6_6') - .5) { town(ctx, cam, tw.texcoco, tx > .5 ? 'ally' : 'triple', { alpha: A, s: 1 + .5 * Math.sin(Math.PI * tx) });
    label(ctx, cam, tw.texcoco, tx > .5 ? '特斯科科 · 一派倒向西班牙人' : '特斯科科 · 三城同盟', { dx: 60, dy: -60, alpha: A * vis(t, T('c6_7') + 1, E('c6_8') + 2.4), col: tx > .5 ? C.amber : C.ink, weight: 500, id: tx > .5 ? 'l-tex2' : 'l-tex1' }); }
  // 湖岸城镇一个个倒向西班牙人
  if (t > T('c6_9') - 1) {
    FLIP.forEach(([k, name], i) => { const u = ss(seg(t, flipT(i), flipT(i) + .4));
      town(ctx, cam, tw[k], u > .5 ? 'ally' : (k === 'tlacopan' ? 'triple' : 'town'), { alpha: A, s: 1 + .6 * Math.sin(Math.PI * u) });
      label(ctx, cam, tw[k], name, { dx: (i % 2 ? 50 : -50), dy: (i % 3 - 1) * 40 + 10, alpha: A * vis(t, flipT(i), E('c6_10') + 3.2, .3, .6), col: u > .5 ? C.amber : C.ink, dot: false, size: 22, id: 'flip' + i }); });
    const fl = A * vis(t, T('c6_9b') - .2, E('c6_9b') + .8);
    if (fl > .01) for (let k = 0; k < 3; k++) { const u = seg(t, T('c6_9b') + k * .6, T('c6_9b') + k * .6 + 2); if (u > 0 && u < 1) route(cam, circleLL(tw.iztapalapa, .8 + u * 4), 1, { w: 1.6, col: C.water, alpha: fl * (1 - u) }); }
    const iso = A * vis(t, T('c6_10') + .4, E('c6_11') + 1);
    if (iso > .01) { route(cam, circleLL(tw.tenochtitlan, 3.4), 1, { w: 1.6, dash: [6, 6], alpha: iso, off: t * 12 }); label(ctx, cam, tw.tenochtitlan, '特诺奇蒂特兰 · 孤立', { dx: -70, dy: -70, alpha: iso, weight: 500, id: 'l-iso' }); }
  }
}
function siegeFront(t) {   // 0 = 整座岛, 1 = 只剩特拉特洛尔科的核心；一步步收缩，越来越快
  const t0 = T('c7_6'), t1 = E('c7_11') + .5, n = 9;
  const st = []; for (let i = 0; i < n; i++) st.push(t0 + (t1 - t0) * (1 - Math.pow(1 - (i + 1) / n, 1.6)));
  let s = 0; for (let i = 0; i < n; i++) s += ss(seg(t, st[i] - .5, st[i])) / n;
  return { s, stages: st };
}
function chapter7(t, cam) {
  if (t < T('c7_1') - 1 || t > T('e1') + 2) return;
  const A = vis(t, T('c7_1') - .5, T('e1') + 1.5, 1, 1.2), tw = G.town;
  readout(ctx, RX, RY, { label: '围城开始', value: '1521.5', alpha: A * vis(t, T('c7_1') + .2, E('c7_1') + 1.4), id: 'r-siege' });
  readout(ctx, RX, RY, { label: '进攻方', value: '≈1,000', unit: '西班牙人', note: '原住民盟军：数以万计', note2: '估计从五万到二十万不等', alpha: A * vis(t, T('c7_2') + .1, E('c7_2') + 2.4), id: 'r-forces' });
  // 三个营地
  const camps = [['tlacopan', '阿尔瓦拉多'], ['coyoacan', '奥利德'], ['iztapalapa', '桑多瓦尔']];
  camps.forEach(([k, who], i) => { const t0 = T('c7_3') + .4 + i * .9, a = A * ss(seg(t, t0, t0 + .4)) * (1 - ss(seg(t, T('c7_13') + 3, E('c7_14'))));
    const [x, y] = P(cam, tw[k]); reticle(ctx, x, y, { r: 18, lock: ss(seg(t, t0, t0 + .5)), alpha: a, col: C.amber });
    label(ctx, cam, tw[k], who, { dx: i === 0 ? -50 : 50, dy: i === 0 ? -50 : -60, alpha: a * vis(t, t0, T('c7_5') + 1.5), col: C.amber, dot: false, weight: 500, id: 'camp' + i }); });
  for (const k of ['cause_tlacopan', 'cause_south', 'cause_coyoacan', 'cause_iztapalapa', 'cause_tepeyac']) route(cam, G[k], 1, { w: 2.2, alpha: A * .8 });
  // 引水渠
  const cut = ss(seg(t, T('c7_4') + .8, T('c7_4') + 1.3));
  route(cam, G.aqueduct, 1, { w: 2.4, dash: [8, 6], col: cut > .5 ? 'rgba(143,227,224,.35)' : C.aque, alpha: A * vis(t, T('c7_4') - .4, E('c7_14')) });
  if (cut > 0) { const [x, y] = P(cam, alongLL(G.aqueduct, .35)); const r = 12 * cut;
    hair(ctx, () => { ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); }, { w: 3, col: C.amber, alpha: A * vis(t, T('c7_4') + .8, E('c7_7')) }); }
  label(ctx, cam, G.town.chapultepec, '引水渠被切断', { dx: -40, dy: 80, alpha: A * vis(t, T('c7_4') + .9, E('c7_4') + 2.2), col: C.aque, id: 'l-aq' });
  // 13 艘帆船横扫湖面
  const sw = ss(seg(t, T('c7_5') - .6, E('c7_5') + 1.2)), ba = A * vis(t, T('c7_5') - .6, T('c7_12') - .5);
  if (ba > .01) {
    const from = [-98.99, 19.47], to = [-99.108, 19.442];
    for (let i = 0; i < 13; i++) { const off = [(i % 4 - 1.5) * .006, (Math.floor(i / 4) - 1.5) * .005];
      const ll = [lerp(from[0], to[0], sw) + off[0], lerp(from[1], to[1], sw) + off[1] + Math.sin(i * 1.7 + t * .4) * .0015]; const [x, y] = P(cam, ll);
      boat(x, y, Math.PI + .25, 1, ba); }
    drawCanoes(t, cam, A * vis(t, T('c7_5') - .6, E('c7_6') + 1) * (1 - sw * .7), { u: sw, ll: c => c.flee });
    label(ctx, cam, [-99.06, 19.455], '13 艘帆船', { dx: 40, dy: -70, alpha: A * vis(t, T('c7_5'), E('c7_5') + 2), weight: 500, id: 'l-brig' });
  }
  // 战线
  const { s, stages } = siegeFront(t);
  const front = lerpPoly(G.island, G.tlatelolco_core, s);
  if (t > T('c7_6') - .5) {
    const fa = A * (1 - ss(seg(t, T('e1') + .5, T('e1') + 2.5)));
    ctx.save(); ctx.globalAlpha = fa; ctx.beginPath(); poly(cam, G.island); poly(cam, front);
    ctx.fillStyle = 'rgba(8,10,12,.42)'; ctx.fill('evenodd'); ctx.restore();
    // 被拆平的街区：斜线
    ctx.save(); ctx.globalAlpha = fa * .5; ctx.beginPath(); poly(cam, G.island); poly(cam, front); ctx.clip('evenodd');
    ctx.strokeStyle = 'rgba(242,245,246,.35)'; ctx.lineWidth = 1; ctx.beginPath(); for (let x = -H; x < W; x += 9) { ctx.moveTo(x, 0); ctx.lineTo(x + H, H); } ctx.stroke(); ctx.restore();
    hair(ctx, () => poly(cam, front), { w: 2.2, alpha: fa });
    hair(ctx, () => poly(cam, G.island), { w: 1.4, alpha: fa * .7 });
  } else hair(ctx, () => poly(cam, G.island), { w: 1.8, alpha: A });
  label(ctx, cam, [-99.122, 19.425], '用瓦砾填平运河，一街一街推进', { dx: 120, dy: 80, alpha: A * vis(t, T('c7_7') + .2, E('c7_7') + 2.4), id: 'l-rubble' });
  // 伏击、献祭
  const am = A * vis(t, T('c7_8'), E('c7_9') + .8);
  if (am > .01) { const p = [-99.1415, 19.4505], [x, y] = P(cam, p); reticle(ctx, x, y, { r: 20, lock: ss(seg(t, T('c7_8') + .3, T('c7_8') + .9)), alpha: am, col: C.amber });
    label(ctx, cam, p, '伏击 · 1521 年 6 月底', { dx: -60, dy: -70, alpha: am, id: 'l-amb' }); }
  readout(ctx, RX, RY, { label: '一次伏击之后', value: '65', unit: '人被活捉', note: '据记载，在大神庙上被献祭', alpha: A * vis(t, T('c7_9') + .1, E('c7_9') + 2.6), id: 'r-capt' });
  label(ctx, cam, tw.tlatelolco, '特拉特洛尔科 · 最后的据点', { dx: -70, dy: -90, alpha: A * vis(t, T('c7_11') + .2, T('c7_13') - .5), weight: 500, id: 'l-last' });
  label(ctx, cam, [-99.128, 19.435], '无水 · 无粮 · 天花', { dx: 120, dy: 60, alpha: A * vis(t, T('c7_10') + .2, E('c7_10') + 2.2), id: 'l-hunger' });
  // 夸乌特莫克的独木舟被截住
  const cu = A * vis(t, T('c7_12') - .2, E('c7_12') + 2);
  if (cu > .01) { const u = ss(seg(t, T('c7_12') + .3, E('c7_12') - .6)), p0 = [-99.129, 19.456], stop = [-99.111, 19.468];
    const ll = [lerp(p0[0], stop[0], u), lerp(p0[1], stop[1], u)], [x, y] = P(cam, ll);
    route(cam, [p0, ll], 1, { w: 1.6, dash: [4, 5], alpha: cu });
    canoe(x, y, -.6, cu); const bl = [lerp(-99.085, stop[0] + .004, u), lerp(19.475, stop[1] + .002, u)], [bx, by] = P(cam, bl); boat(bx, by, Math.PI + .3, 1.1, cu);
    reticle(ctx, x, y, { r: 22, lock: ss(seg(t, E('c7_12') - .6, E('c7_12') - .1)), alpha: cu * ss(seg(t, E('c7_12') - 1, E('c7_12') - .5)), col: C.amber }); }
  readout(ctx, RX, RY, { label: '夸乌特莫克被截住 · 城破', value: '1521.8.13', alpha: A * vis(t, E('c7_12') - .2, T('c7_13') + 1.5), id: 'r-fall' });
  readout(ctx, RX, RY, { label: '围城持续', value: '≈80', unit: '天', note: '1521 年 5 月 26 日 – 8 月 13 日', alpha: A * vis(t, T('c7_13') + .4, E('c7_13') + 1.8), id: 'r-days' });
  readout(ctx, RX, RY, { label: '死者', value: '>100,000', unit: '人', note: '估计 · 包括平民', note2: '各家估算 10 万–24 万', alpha: A * vis(t, T('c7_14') + .1, E('c7_14') + 3), id: 'r-dead' });
}
function epilogue(t, cam) {
  if (t < T('e1') - 1) return;
  const A = vis(t, T('e1'), DUR + 5, 1, .5);
  const out = ss(seg(t, T('e2'), E('e4')));
  // 湖排干之后，只剩轮廓
  hair(ctx, () => poly(cam, G.island), { w: 1.6, alpha: A * lerp(.6, 1, out) });
  for (const k of ['cause_tepeyac', 'cause_tlacopan', 'cause_south', 'cause_coyoacan', 'cause_iztapalapa']) route(cam, G[k], 1, { w: 1.6, alpha: A * out * .9 });
  label(ctx, cam, [-99.1365, 19.398], '特拉尔潘大道', { dx: 120, dy: 30, alpha: A * vis(t, T('e3') + .2, E('e4') + .5), id: 'e-av' });
  label(ctx, cam, [-99.170, 19.4465], '墨西哥—塔库巴大道', { dx: -40, dy: -80, alpha: A * vis(t, T('e3') + .5, E('e4') + .5), id: 'e-tac' });
  label(ctx, cam, G.precinct, '宪法广场 · 大神庙遗址', { dx: 120, dy: -80, alpha: A * vis(t, T('e1') + .3, E('e4') + .5), id: 'e-zoc' });
  // 片尾
  const ea = ss(seg(t, E('e4') + 1, E('e4') + 2.4));
  if (ea > .01) {
    const cx = W / 2, cy = H / 2 - 30;
    brackets(ctx, cx - 470, cy - 150, cx + 470, cy + 150, { len: 36, alpha: ea, w: 2 });
    text(ctx, '湖上之城', cx, cy + 6, { font: '600 96px SS', align: 'center', alpha: ea, track: 12, id: 'end-t', halo: 14 });
    text(ctx, '特诺奇蒂特兰的陷落 · 1519—1521', cx, cy + 70, { font: '400 30px SC', align: 'center', alpha: ea * .95, track: 3, id: 'end-s' });
    text(ctx, '影像：NASA · Copernicus Sentinel-2 · EOX', cx, cy + 230, { font: '400 22px SC', align: 'center', alpha: ea * .8, id: 'end-c1' });
  }
}

// ------------------------------------------------------------------ 载入
async function init() {
  [G, TL, PL] = await Promise.all([json('assets/geo.json'), json('timeline.json'), json('assets/plates/plates.json')]);
  for (const l of TL.lines) LINE[l.id] = l;
  DUR = TL.dur; CUES = TL.cues; window.DUR = DUR;
  const names = ['world', 'gulf', 'highland', 'basin', 'city'];
  const imgs = await Promise.all([...names.map(n => load(`assets/plates/${n}.jpg`)), load('assets/plates/lake_basin.png'), load('assets/plates/lake_city.png'), load('assets/plates/map1524.jpg')]);
  names.forEach((n, i) => { gl.upload(n, imgs[i]); BB[n] = PL[n].bbox; });
  gl.upload('lake_basin', imgs[5]); gl.upload('lake_city', imgs[6]);
  MAP = { img: imgs[7], w: PL.map1524.w, h: PL.map1524.h };
  // 湖面判断（独木舟只放在水上）
  const lc = document.createElement('canvas'); lc.width = PL.lake_city.w; lc.height = PL.lake_city.h;
  const lg = lc.getContext('2d', { willReadFrequently: true }); lg.drawImage(imgs[6], 0, 0);
  const ld = lg.getImageData(0, 0, lc.width, lc.height).data, cb = PL.lake_city.bbox;
  WATER = (lon, lat) => { const x = Math.floor((lon - cb[0]) / (cb[2] - cb[0]) * lc.width), y = Math.floor((cb[3] - lat) / (cb[3] - cb[1]) * lc.height);
    if (x < 0 || y < 0 || x >= lc.width || y >= lc.height) return false; return ld[(y * lc.width + x) * 4] > 6; };
  const rnd = mulberry(1519), causeway = G.cause_tlacopan;
  while (CANOES.length < 240) {
    const ang = rnd() * Math.PI * 2, r = 1.2 + rnd() * 7.5, c = G.town.tenochtitlan, k = Math.cos(c[1] * Math.PI / 180) * KM;
    const ll = [c[0] + Math.cos(ang) * r / k, c[1] + Math.sin(ang) * r / KM];
    if (!WATER(...ll)) continue;
    const g = alongLL(causeway, rnd()), side = rnd() < .5 ? 1 : -1;
    const near = [g[0] + (rnd() * .006 + .002) * side * .7, g[1] - (rnd() * .006 + .002) * side];
    const flee = [ll[0] - .02 - rnd() * .02, ll[1] + (rnd() - .5) * .02];
    CANOES.push({ ll, ang: rnd() * Math.PI, ph: rnd() * 6, a: .55 + rnd() * .45, k: .6 + rnd() * .4, near, flee });
  }
  KEYS = camKeys();
  await Promise.all(['300 112px BC', '400 24px PM', '500 38px SC', '400 22px SC', '700 34px SC', '600 96px SS'].map(f => document.fonts.load(f, '湖上之城 0123456789 km')));
  window.CUES = CUES;
  window.EV = events();
  window.READY = true;
}

// ------------------------------------------------------------------ 声音事件（mix.py 读 events.json）
function events() {
  const ev = [], e = (t, type, x = {}) => ev.push({ t: +t.toFixed(3), type, ...x });
  e(.6, 'lock'); e(1.4, 'draw'); e(T('p2') + .2, 'scan', { dir: -1 }); e(T('p3') + .2, 'rise'); e(T('p4') + .8, 'tick');
  e(E('p5') + .8, 'open'); e(E('p5') + 1.4, 'title'); e(E('p5') + 6.7, 'rise', { long: 1 });
  e(T('c1_1') + .3, 'draw'); e(T('c1_2'), 'land'); for (const id of ['c1_4', 'c1_5']) e(T(id) - .3, 'tick');
  [0, 1, 2].forEach(i => e(T('c1_8') + i * .7 - .2, 'tick', { soft: 1 })); e(T('c1_9') - .1, 'lock'); e(T('c1_9') + .2, 'land');
  e(T('c2_1') - 2.4, 'dive'); e(T('c2_1') + .4, 'tick'); for (let i = 0; i < 4; i++) e(T('c2_2') + .7 + i * .35, 'sink');
  e(T('c2_3') + .2, 'draw', { long: 1 }); e(T('c2_7') - .3, 'lock', { amber: 1 }); e(T('c2_7') + .4, 'drum');
  e(T('c2_8') + .7, 'ally'); e(T('c2_9') - .2, 'suck'); e(E('c2_9') + .2, 'breath');
  e(T('c2_10') + .4, 'lock', { amber: 1 }); e(T('c2_11') - .3, 'suck'); e(T('c2_11') + .15, 'hit', { big: 1 }); e(E('c2_11') + .3, 'silence', { dur: 2.8 });
  e(T('c2_12') - 1.4, 'draw', { long: 1 }); e(T('c2_13') - .2, 'reveal');
  e(T('c3_1') - 4.5, 'dive'); e(T('c3_1') + .2, 'land'); e(T('c3_2') - .2, 'water'); e(T('c3_3') + .1, 'land'); e(T('c3_3b'), 'tick');
  e(T('c3_4') - 1.2, 'suck'); e(T('c3_4') - .5, 'lock'); e(T('c3_4') + .3, 'meet'); e(E('c3_4') + .3, 'silence', { dur: 4.2 });
  e(T('c3_6') + .3, 'paper'); e(T('c3_8') - 3.9, 'suck'); e(T('c3_8') - 3.4, 'tear');
  e(T('c3_8') - 1.1, 'whoosh'); e(T('c3_8') + .6, 'land'); e(T('c3_9') + .5, 'lock', { amber: 1 }); e(T('c3_10') + .1, 'scan', { soft: 1 });
  e(T('c3_11') - 2.1, 'whoosh'); e(T('c3_11') + .3, 'lock', { amber: 1 }); e(T('c3_11') + .5, 'drum'); e(T('c3_12'), 'drum'); e(T('c3_13') + .3, 'tick'); e(T('c3_14'), 'tick');
  e(T('c4_1') - 1.2, 'night'); e(T('c4_1') + .3, 'land'); e(T('c4_3') + .3, 'tick'); e(T('c4_4') - .2, 'rain'); e(T('c4_5') - .4, 'water', { big: 1 });
  e(E('c4_5') + .3, 'suck'); e(E('c4_5') + .7, 'silence', { dur: 3.8 }); e(T('c4_6') + .1, 'hit', { low: 1 });
  e(T('c4_7') + .1, 'land'); e(T('c4_8') + .4, 'title', { low: 1 });
  e(T('c5_1') - 2.6, 'dawn'); e(T('c5_1') + .3, 'draw', { long: 1 }); e(T('c5_2') - .1, 'lock', { amber: 1 }); e(T('c5_3') + .3, 'hit');
  e(T('c5_4') - .5, 'draw'); e(T('c5_4') + .2, 'ally');
  e(T('c6_1') + .2, 'scan', { soft: 1 }); e(T('c6_2') - .4, 'scan', { soft: 1 }); e(T('c6_3') + .2, 'tick'); e(T('c6_4') + .2, 'tick');
  e(T('c6_6') - .1, 'tick'); e(T('c6_7') - .3, 'draw', { long: 1 }); e(T('c6_8') + .7, 'ally');
  FLIP.forEach((_, i) => e(flipT(i), 'flip', { i })); e(T('c6_9b'), 'water'); e(T('c6_10') + .4, 'scan'); e(T('c6_11'), 'launch');
  e(T('c7_1') - 2.6, 'dive'); e(T('c7_1') + .2, 'land'); e(T('c7_2') + .1, 'land');
  [0, 1, 2].forEach(i => e(T('c7_3') + .4 + i * .9, 'lock', { amber: 1 })); e(T('c7_4') + .8, 'cut'); e(T('c7_5') - .6, 'fleet');
  siegeFront(T('c7_6')).stages.forEach((s, i) => e(s - .5, 'ring', { i }));
  e(T('c7_8') + .3, 'lock', { amber: 1 }); e(T('c7_8') + .5, 'hit'); e(T('c7_9') + .1, 'land');
  e(E('c7_12') - .6, 'lock', { amber: 1 }); e(E('c7_12') - .4, 'suck'); e(E('c7_12') - .05, 'hit', { big: 1, final: 1 }); e(E('c7_12') + .5, 'silence', { dur: 5.4 });
  e(T('c7_13') + .4, 'land'); e(T('c7_14') + .1, 'land');
  e(T('e1') + .8, 'drain'); e(E('e4') + 1, 'open'); e(E('e4') + 1.6, 'title', { end: 1 });
  // 段落（配乐读这些）
  const sec = (id, t0) => e(t0, 'section', { id });
  sec('pro', 0); sec('title', E('p5') + .8); sec('c1', T('c1_1') - 1.5); sec('c2', T('c2_1') - 2.5); sec('c3', T('c3_1') - 4.5);
  sec('c4', T('c4_1') - 1.2); sec('c5', T('c5_1') - 2.6); sec('c6', T('c6_1') - 1.5); sec('c7', T('c7_1') - 2.6); sec('fall', E('c7_12')); sec('epi', T('e1') - 1); sec('end', E('e4') + 1);
  return ev.sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------------ 每一帧
window.render = t => {
  const cp = camAt(t), cam = makeCamera(cp, W, H);
  const S = state(t, cam), bl = blurAt(t);
  gl.draw({ ...S, cam, blur: bl.blur, blurVec: bl.vec }, BB);
  ctx.clearRect(0, 0, W, H);
  beginTexts();
  const ov = 1 - Math.min(1, bl.blur / 30);
  ctx.save(); ctx.globalAlpha = ov;
  if (S.lake > .05 && cam.d < 520 && t > T('p3')) dike(cam, S.lake * (1 - ss(seg(S.drain, 3, 7))) * (t < E('p5') + .6 ? ss(seg(t, T('p3') + .2, T('p3') + 1.6)) : 1) * (1 - ss(seg(cam.d, 300, 520))));
  prologue(t, cam); chapter1(t, cam); chapter2(t, cam); chapter3(t, cam); chapter4(t, cam); chapter5(t, cam); chapter6(t, cam); chapter7(t, cam); epilogue(t, cam);
  ctx.restore();
  titleCard(t);
  instruments(t, cam, S);
  subs(t);
  window.__texts = endTexts();
};
window.TEXTS = t => { window.render(t); return window.__texts; };
init().catch(e => { console.error(e); throw e; });
