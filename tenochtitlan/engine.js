// 卫星简报引擎：一个看着球形地球的透视相机，影像版图按经纬度在 WebGL2 着色器里采样，
// 2D 标注层用同一套相机数学（project），所以线条始终贴在地面上。
// 在库里 satellite-briefing 示例引擎的写法上改的：版图换成这支片的五层，加了 1519 年的湖面图层、夜色和排干。

export const R = 6371.0088;
const D2R = Math.PI / 180;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => mul(a, 1 / Math.hypot(a[0], a[1], a[2]));

export function ecef(lat, lon, h = 0) {
  const p = lat * D2R, l = lon * D2R, r = R + h;
  return [r * Math.cos(p) * Math.cos(l), r * Math.cos(p) * Math.sin(l), r * Math.sin(p)];
}
function enu(lat, lon) {
  const p = lat * D2R, l = lon * D2R;
  const up = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  const east = [-Math.sin(l), Math.cos(l), 0];
  return { up, east, north: cross(up, east) };
}
// 相机：从距离 d（km）看地面点 (lat, lon)；tilt 偏离垂直向下的角度，heading 朝向（北为 0，顺时针），
// sx/sy 镜头平移（像素），让目标可以偏离画面中心
export function makeCamera({ lat, lon, d, tilt = 0, heading = 0, fov = 30, sx = 0, sy = 0 }, W = 1920, H = 1080) {
  const T = ecef(lat, lon, 0);
  const { up, east, north } = enu(lat, lon);
  const hd = heading * D2R, tl = tilt * D2R;
  const Hdir = add(mul(north, Math.cos(hd)), mul(east, Math.sin(hd)));
  const C = add(T, mul(add(mul(up, Math.cos(tl)), mul(Hdir, -Math.sin(tl))), d));
  const f = norm(sub(T, C));
  let u = norm(add(mul(Hdir, Math.cos(tl)), mul(up, Math.sin(tl))));
  u = norm(sub(u, mul(f, dot(u, f))));
  const r = norm(cross(f, u));
  const F = (H / 2) / Math.tan(fov * D2R / 2);
  const h = Math.hypot(C[0], C[1], C[2]) - R;
  return { C, f, u, r, F, W, H, sx, sy, Cc: mul(C, -1), c2: h * (2 * R + h), alt: h, d, tgt: { lat, lon } };
}
export function project(cam, lat, lon, hgt = 0) {
  const P = ecef(lat, lon, hgt), q = sub(P, cam.C), z = dot(q, cam.f);
  return [cam.W / 2 + cam.sx + cam.F * dot(q, cam.r) / z, cam.H / 2 + cam.sy - cam.F * dot(q, cam.u) / z, z > 0 && dot(P, mul(q, -1)) > 0];
}
export function unproject(cam, x, y) {
  const nx = (x - cam.W / 2 - cam.sx) / cam.F, ny = -(y - cam.H / 2 - cam.sy) / cam.F;
  const d = norm(add(cam.f, add(mul(cam.r, nx), mul(cam.u, ny))));
  const b = dot(d, cam.Cc), disc = b * b - cam.c2;
  if (disc < 0) return null;
  const Q = sub(mul(d, b - Math.sqrt(disc)), cam.Cc);
  return [Math.asin(Q[2] / R) / D2R, Math.atan2(Q[1], Q[0]) / D2R];
}
// 画面中心处每像素多少公里（比例尺用）
export function kmPerPx(cam) {
  const a = unproject(cam, cam.W / 2 + cam.sx - 50, cam.H / 2 + cam.sy), b = unproject(cam, cam.W / 2 + cam.sx + 50, cam.H / 2 + cam.sy);
  if (!a || !b) return cam.alt / cam.F;
  const k = Math.cos(a[0] * D2R) * 111.32;
  return Math.hypot((b[1] - a[1]) * k, (b[0] - a[0]) * 111.32) / 100;
}

const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`;

const FS = `#version 300 es
precision highp float; precision highp sampler2D;
out vec4 o;
uniform vec2 uRes; uniform vec2 uShift; uniform float uF;
uniform vec3 uR, uU, uFw, uCc; uniform float uC2;
uniform sampler2D t0, t1, t2, t3, t4, t5, t6;     // world, gulf, highland, basin, city, lake_basin, lake_city
uniform vec4 b1, b2, b3, b4;                      // plate boxes (w, s, e, n)
uniform float a1, a2, a3, a4;
uniform float uGrey, uShade, uExpo, uDetail, uClarity, uContrast, uDim, uNight;
uniform vec2 uBlurVec; uniform float uBlur;
uniform float uLake, uLakeScan, uLakeDir, uDrain, uLakeBright;
uniform vec3 uFocus;                              // dim everything outside a circle (lon, lat, radius deg); z<0 = off
uniform float uFocusAmt;
const float RE = 6371.0088;

float lum(vec3 c){ return dot(c, vec3(.299, .587, .114)); }
vec2 uvOf(vec4 b, vec2 ll){ return vec2((ll.y - b.x) / (b.z - b.x), (b.w - ll.x) / (b.w - b.y)); }
float inside(vec2 uv, float f){ vec2 e = smoothstep(vec2(0.), vec2(f), uv) * smoothstep(vec2(0.), vec2(f), 1. - uv); return e.x * e.y; }
vec4 samp(sampler2D t, vec2 uv){
  vec3 c = texture(t, uv).rgb; float l = lum(c);
  float m1 = lum(texture(t, uv, 1.6).rgb), m2 = lum(texture(t, uv, 4.0).rgb), m3 = lum(texture(t, uv, 6.5).rgb);
  float d = l + uDetail * (0.7 * (l - m1) + 0.45 * (m1 - m2));
  d = m3 + (d - m3) * (1. + uClarity);
  return vec4(c, d);
}
vec4 ground(vec2 ll){
  vec4 col = samp(t0, vec2((ll.y + 180.) / 360., (90. - ll.x) / 180.));
  vec2 u; float w;
  u = uvOf(b1, ll); w = inside(u, .04) * a1; if (w > 0.) col = mix(col, samp(t1, u), w);
  u = uvOf(b2, ll); w = inside(u, .05) * a2; if (w > 0.) col = mix(col, samp(t2, u), w);
  u = uvOf(b3, ll); w = inside(u, .05) * a3; if (w > 0.) col = mix(col, samp(t3, u), w);
  u = uvOf(b4, ll); w = inside(u, .06) * a4; if (w > 0.) col = mix(col, samp(t4, u), w);
  return col;
}
vec3 grade(vec4 c){
  float d = clamp((c.a - 0.05) / 0.85, 0., 1.);
  d = (1. - exp(-1.9 * d)) / (1. - exp(-1.9));
  d = d * d * (3. - 2. * d) * .30 + d * .70;
  d = pow(d, 1.12);
  d = clamp((d - .5) * uContrast + .5, 0., 1.);
  vec3 grey = mix(vec3(.026, .036, .044), vec3(.63, .655, .665), d);
  grey += (c.rgb - lum(c.rgb)) * 0.22;
  return mix(c.rgb, grey, uGrey);
}
// ---- 1519 年的湖：印刷地图式的蓝（主张层），岸线墨线、沿岸水线、网点
vec4 lake(vec2 ll){
  vec2 ub = uvOf(b3, ll), uc = uvOf(b4, ll);
  float wb = inside(ub, .002), wc = inside(uc, .02);
  if (wb + wc <= 0.) return vec4(0.);
  vec3 fb = texture(t5, ub).rgb, fc = texture(t6, uc).rgb;
  float sdb = (fb.r - fb.g) * 12., sdc = (fc.r - fc.g) * 6.;         // km, + inside the water
  float sd = mix(sdb, sdc, wc), salt = mix(fb.b, fc.b, wc);
  float din = max(sd, 0.);
  sd -= uDrain;                                                       // 排干：水从岸边往里退
  float fw = max(fwidth(sd), 1e-5);
  float water = smoothstep(-fw, fw, sd) * max(wb, wc);
  vec3 fresh = vec3(.20, .45, .74), saltc = vec3(.22, .36, .58);
  vec3 c = mix(fresh, saltc, smoothstep(.3, .7, salt));
  c *= uLakeBright;
  vec2 sc = gl_FragCoord.xy * .7071; vec2 hp = fract(vec2(sc.x + sc.y, sc.x - sc.y) / 7.0) - .5;
  float dotm = smoothstep(.30, .22, length(hp));
  c = mix(c, c * 1.2 + .02, dotm * .32);
  float wl = 0.;
  for (int k = 1; k <= 4; k++) { float dk = .18 * float(k * k) + .12; wl = max(wl, (1. - smoothstep(fw * .5, fw * 1.8, abs(sd - dk))) * (1. - float(k) / 5.5)); }
  c = mix(c, vec3(.62, .78, .95), wl * .35 * water);
  float coast = 1. - smoothstep(fw * .8, fw * 2.6, abs(sd));
  float reveal = smoothstep(-fwidth(ll.x) * 3., fwidth(ll.x) * 3., uLakeDir * (uLakeScan - ll.x));
  float coastA = coast * .95 * max(wb, wc) * (1. - smoothstep(5., 9., uDrain));
  float A = max(water * .78, coastA) * uLake * reveal;
  return vec4(mix(c, vec3(.70, .84, 1.), coast), A);
}
vec3 shade(vec2 frag){
  vec2 n = (frag - uRes * .5 - uShift * vec2(1., -1.)) / uF;
  vec3 dir = normalize(uFw + n.x * uR + n.y * uU);
  float b = dot(dir, uCc), disc = b * b - uC2;
  vec3 space = vec3(.010, .015, .021);
  if (disc < 0.) {
    float dmin = sqrt(max(dot(uCc, uCc) - b * b, 0.));
    float glow = exp(-(dmin - RE) / 90.) * step(0., b);
    return space + glow * mix(vec3(.30, .55, .95), vec3(.75, .80, .85), uGrey) * .55;
  }
  vec3 Q = (b - sqrt(disc)) * dir - uCc;
  vec2 ll = vec2(degrees(asin(clamp(Q.z / RE, -1., 1.))), degrees(atan(Q.y, Q.x)));
  vec3 col = grade(ground(ll));
  if (uLake > 0.001) { vec4 L = lake(ll); col = mix(col, L.rgb, L.a); }
  if (uFocus.z > 0.) {
    float dd = length(vec2((ll.y - uFocus.x) * cos(radians(ll.x)), ll.x - uFocus.y));
    col *= 1. - uFocusAmt * .5 * smoothstep(uFocus.z * .7, uFocus.z * 1.8, dd);
  }
  float mu = clamp(dot(normalize(Q), -dir), 0., 1.);
  col *= mix(1., mix(.55, 1., pow(mu, .35)), uShade);
  col += uShade * pow(1. - mu, 3.) * mix(vec3(.25, .45, .85), vec3(.6, .65, .7), uGrey) * .55;
  return col;
}
void main(){
  vec2 frag = gl_FragCoord.xy; vec3 col;
  if (uBlur > .5) { col = vec3(0.); for (int i = 0; i < 12; i++) { float k = (float(i) / 11. - .5) * uBlur; col += shade(frag + k * uBlurVec * vec2(1., -1.)); } col /= 12.; }
  else col = shade(frag);
  col *= uExpo;
  col = mix(col, col * vec3(.36, .42, .58), uNight);                  // 夜色
  vec2 q = frag / uRes - .5; col *= 1. - .38 * dot(q, q) * 1.2;
  col *= (1. - uDim);
  o = vec4(max(col, 0.), 1.);
}`;

export class Engine {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl; this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.p = p; gl.useProgram(p);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.U = {}; this.tex = {};
    for (let i = 0; i < 7; i++) gl.uniform1i(gl.getUniformLocation(p, 't' + i), i);
  }
  u(n) { return this.U[n] ?? (this.U[n] = this.gl.getUniformLocation(this.p, n)); }
  upload(name, img, { mip = true } = {}) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    if (mip && this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    this.tex[name] = t;
  }
  draw(S, BB) {
    const gl = this.gl, c = S.cam;
    gl.viewport(0, 0, c.W, c.H);
    gl.uniform2f(this.u('uRes'), c.W, c.H); gl.uniform2f(this.u('uShift'), c.sx, c.sy); gl.uniform1f(this.u('uF'), c.F);
    gl.uniform3f(this.u('uR'), ...c.r); gl.uniform3f(this.u('uU'), ...c.u); gl.uniform3f(this.u('uFw'), ...c.f);
    gl.uniform3f(this.u('uCc'), ...c.Cc); gl.uniform1f(this.u('uC2'), c.c2);
    ['world', 'gulf', 'highland', 'basin', 'city', 'lake_basin', 'lake_city'].forEach((n, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, this.tex[n]); });
    gl.uniform4f(this.u('b1'), ...BB.gulf); gl.uniform4f(this.u('b2'), ...BB.highland); gl.uniform4f(this.u('b3'), ...BB.basin); gl.uniform4f(this.u('b4'), ...BB.city);
    gl.uniform1f(this.u('a1'), S.a.gulf); gl.uniform1f(this.u('a2'), S.a.highland); gl.uniform1f(this.u('a3'), S.a.basin); gl.uniform1f(this.u('a4'), S.a.city);
    const f = (n, v) => gl.uniform1f(this.u(n), v);
    f('uGrey', S.grey); f('uShade', S.shade); f('uExpo', S.expo ?? 1); f('uDetail', S.detail ?? .8); f('uClarity', S.clarity ?? .4);
    f('uContrast', S.contrast ?? 1); f('uDim', S.dim ?? 0); f('uNight', S.night ?? 0);
    f('uLake', S.lake ?? 0); f('uLakeScan', S.lakeScan ?? 90); f('uLakeDir', S.lakeDir ?? 1); f('uDrain', S.drain ?? 0); f('uLakeBright', S.lakeBright ?? 1);
    gl.uniform3f(this.u('uFocus'), ...(S.focus || [0, 0, -1])); f('uFocusAmt', S.focusAmt ?? 0);
    f('uBlur', S.blur ?? 0); gl.uniform2f(this.u('uBlurVec'), ...(S.blurVec || [1, 0]));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
