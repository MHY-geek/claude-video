// 分析员的标注层：细线、准星、地名、读数、字幕条。贴在地面上的东西一律经过 engine.project。
import { project } from './engine.js';

export const C = {
  ink: '#F2F5F6', inkDim: 'rgba(242,245,246,.6)', amber: '#FFBE55', halo: 'rgba(3,6,8,.82)',
  water: 'rgba(176,210,248,.96)', aque: '#8FE3E0', dike: '#D8BE86',
};

let TX = null;
export function beginTexts() { TX = []; }
export function endTexts() { const r = TX; TX = null; return r; }

export function text(ctx, s, x, y, { font = '500 28px SC', col = C.ink, align = 'left', track = 0, halo = 7, alpha = 1, id = null, base = 'alphabetic', rep = null } = {}) {
  if (alpha <= 0.003 || !s) return 0;
  ctx.save();
  ctx.globalAlpha *= Math.min(1, alpha);
  ctx.font = font; ctx.textAlign = align; ctx.textBaseline = base; ctx.letterSpacing = track + 'px';
  const m = ctx.measureText(s), w = m.width;
  if (halo) { ctx.shadowColor = C.halo; ctx.shadowBlur = halo; }
  ctx.fillStyle = col; ctx.fillText(s, x, y);
  if (halo) { ctx.shadowBlur = halo * 0.35; ctx.fillText(s, x, y); }
  ctx.restore();
  if (id && TX && alpha > 0.5) {
    const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    const asc = m.actualBoundingBoxAscent || 20, des = m.actualBoundingBoxDescent || 6;
    TX.push({ id, text: rep ?? s, x0, y0: y - asc, x1: x0 + w, y1: y + des });
  }
  return w;
}
export function measure(ctx, s, font, track = 0) {
  ctx.save(); ctx.font = font; ctx.letterSpacing = track + 'px'; const w = ctx.measureText(s).width; ctx.restore(); return w;
}
export function hair(ctx, path, { w = 1.4, col = C.ink, alpha = 1, halo = 3.2, haloCol = 'rgba(3,6,8,.5)', dash = null, off = 0, cap = 'butt' } = {}) {
  if (alpha <= 0.003) return;
  ctx.save(); ctx.globalAlpha *= Math.min(1, alpha); ctx.lineJoin = 'round'; ctx.lineCap = cap;
  if (dash) { ctx.setLineDash(dash); ctx.lineDashOffset = off; }
  if (halo) { ctx.beginPath(); path(); ctx.strokeStyle = haloCol; ctx.lineWidth = w + halo; ctx.stroke(); }
  ctx.beginPath(); path(); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();
  ctx.restore();
}
// 经纬度折线 → 屏幕；frac 按长度画到一部分（线头前进），返回线头的屏幕坐标
export function lineLL(ctx, cam, pts, frac = 1, close = false) {
  if (!pts || pts.length < 2) return null;
  const P = pts.map(([lo, la]) => project(cam, la, lo));
  const L = [0]; for (let i = 1; i < P.length; i++) L.push(L[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const tot = L[L.length - 1], stop = tot * Math.min(1, Math.max(0, frac));
  ctx.moveTo(P[0][0], P[0][1]); let tip = [P[0][0], P[0][1]];
  for (let i = 1; i < P.length; i++) {
    if (L[i] <= stop) { ctx.lineTo(P[i][0], P[i][1]); tip = [P[i][0], P[i][1]]; continue; }
    const u = (stop - L[i - 1]) / Math.max(1e-6, L[i] - L[i - 1]);
    tip = [P[i - 1][0] + (P[i][0] - P[i - 1][0]) * u, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * u];
    ctx.lineTo(tip[0], tip[1]); break;
  }
  if (close && frac >= 1) ctx.closePath();
  return tip;
}
export function brackets(ctx, x0, y0, x1, y1, { len = 26, w = 1.6, alpha = 1, col = C.ink } = {}) {
  hair(ctx, () => {
    const L = Math.min(len, (x1 - x0) / 2, (y1 - y0) / 2);
    ctx.moveTo(x0, y0 + L); ctx.lineTo(x0, y0); ctx.lineTo(x0 + L, y0);
    ctx.moveTo(x1 - L, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + L);
    ctx.moveTo(x1, y1 - L); ctx.lineTo(x1, y1); ctx.lineTo(x1 - L, y1);
    ctx.moveTo(x0 + L, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - L);
  }, { w, alpha, col, halo: 2.4 });
}
// 准星：r 半径，lock 0..1（0 = 搜索中的大框，1 = 锁定）
export function reticle(ctx, x, y, { r = 26, lock = 1, alpha = 1, col = C.ink } = {}) {
  if (alpha <= 0.003) return;
  const rr = r * (1 + 1.6 * (1 - lock));
  brackets(ctx, x - rr, y - rr, x + rr, y + rr, { len: rr * 0.42, alpha, col, w: 1.7 });
  hair(ctx, () => { ctx.arc(x, y, 2.6, 0, 7); }, { w: 2.2, col, alpha: alpha * lock, halo: 2 });
}
// 地名：地面上的点 + 引线 + 文字
export function label(ctx, cam, ll, s, { dx = 40, dy = -30, size = 26, weight = 400, col = C.ink, alpha = 1, dot = true, id = null, font = 'SC' } = {}) {
  if (alpha <= 0.003) return;
  const [x, y, vis] = project(cam, ll[1], ll[0]); if (!vis) return;
  const tx = x + dx, ty = y + dy;
  hair(ctx, () => { ctx.moveTo(x, y); ctx.lineTo(tx, ty); }, { w: 1.2, col, alpha: alpha * 0.9, halo: 2.4 });
  if (dot) hair(ctx, () => { ctx.arc(x, y, 3, 0, 7); }, { w: 3, col, alpha, halo: 2 });
  text(ctx, s, tx + (dx < 0 ? -8 : 8), ty + size * 0.36, { font: `${weight} ${size}px ${font}`, col, align: dx < 0 ? 'right' : 'left', alpha, id });
}
// 城邦符号：triple 三城同盟双圈 / ally 西班牙人的盟友菱形 / town 白点 / battle 战场准星
export function town(ctx, cam, ll, kind, { alpha = 1, s = 1, col = null } = {}) {
  if (alpha <= 0.003) return;
  const [x, y, vis] = project(cam, ll[1], ll[0]); if (!vis) return;
  ctx.save(); ctx.globalAlpha *= alpha; ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 5;
  if (kind === 'triple') {
    ctx.strokeStyle = col || C.ink; ctx.lineWidth = 2.2 * s;
    ctx.beginPath(); ctx.arc(x, y, 11 * s, 0, 7); ctx.stroke();
    ctx.fillStyle = col || C.ink; ctx.beginPath(); ctx.arc(x, y, 5 * s, 0, 7); ctx.fill();
  } else if (kind === 'ally') {
    ctx.fillStyle = col || C.amber; const r = 10 * s;
    ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill();
  } else {
    ctx.fillStyle = col || C.ink; ctx.beginPath(); ctx.arc(x, y, 4.6 * s, 0, 7); ctx.fill();
  }
  ctx.restore();
}
// 一个读数：小标签、大号橙色数字、单位、出处
export function readout(ctx, x, y, { label = '', value = '', unit = '', note = '', note2 = '', alpha = 1, id = 'readout', size = 112, col = C.amber, rep = null } = {}) {
  if (alpha <= 0.003) return;
  text(ctx, label, x + 2, y - size * 0.86, { font: '500 28px SC', track: 1, alpha: alpha * 0.95, id: id + '-label' });
  const w = text(ctx, value, x, y, { font: `300 ${size}px BC`, col, track: -1, alpha, halo: 12, id: id + '-value', rep });
  if (unit) text(ctx, unit, x + w + 12, y, { font: `500 ${Math.round(size * 0.3)}px SC`, col, alpha, halo: 8, id: id + '-unit' });
  hair(ctx, () => { ctx.moveTo(x + 2, y + 22); ctx.lineTo(x + 2 + Math.max(260, w + 80), y + 22); }, { w: 1, alpha: alpha * 0.55, halo: 0 });
  if (note) text(ctx, note, x + 2, y + 58, { font: '400 23px SC', col: 'rgba(242,245,246,.84)', alpha, track: 0.5, id: id + '-note' });
  if (note2) text(ctx, note2, x + 2, y + 92, { font: '400 21px SC', col: 'rgba(242,245,246,.66)', alpha, track: 0.5, id: id + '-note2' });
}
// 字幕：左下角的转录条，一行
export const SUB = { x: 96, y: 990, font: '500 38px SC', track: 1, safe: 1360 };
export function subtitle(ctx, s, alpha) {
  if (alpha <= 0.003 || !s) return;
  const w = measure(ctx, s, SUB.font, SUB.track);
  ctx.save(); ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(SUB.x - 30, 0, SUB.x + w + 90, 0);
  g.addColorStop(0, 'rgba(5,8,11,.66)'); g.addColorStop(0.85, 'rgba(5,8,11,.52)'); g.addColorStop(1, 'rgba(5,8,11,0)');
  ctx.fillStyle = g; ctx.fillRect(SUB.x - 30, SUB.y - 50, w + 120, 70);
  ctx.fillStyle = C.ink; ctx.fillRect(SUB.x - 30, SUB.y - 50, 2, 70);
  ctx.restore();
  text(ctx, s, SUB.x, SUB.y, { font: SUB.font, track: SUB.track, alpha, halo: 4 });
}
