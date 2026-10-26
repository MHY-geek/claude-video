"""配乐、音效、底噪、旁白 → out/mix.wav（和 out/stems/）。
所有时间来自 events.json（画面导出的事件）和 timeline.json（旁白）：画面和声音用同一条时间线。
运行：$LIB/.venv/bin/python mix.py（从任何目录都行）"""
import json, os, sys
import numpy as np, soundfile as sf, soxr
from scipy.signal import butter, sosfilt
from scipy.ndimage import maximum_filter1d, uniform_filter1d

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB') or os.path.expanduser('~/lemo-opuscar')
sys.path.insert(0, LIB)
from core.audio import sampler as S, sfx as X
from core.audio.sfx import SR, add

S.seed(1519); X._rng = np.random.default_rng(1521); RNG = np.random.default_rng(8)
EVD = json.load(open(os.path.join(HERE, 'events.json'))); TL = json.load(open(os.path.join(HERE, 'timeline.json'), encoding='utf-8'))
DUR = EVD['dur']; EV = EVD['ev']; N = int((DUR + 2) * SR)
OUT = os.path.join(HERE, 'out'); os.makedirs(os.path.join(OUT, 'stems'), exist_ok=True)
stem = lambda: np.zeros((N, 2), np.float32)
music, pulse, foley, beds, voice = stem(), stem(), stem(), stem(), stem()

def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x, axis=0)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x, axis=0)
def bp(x, a, b, o=2): return sosfilt(butter(o, [a, b], 'band', fs=SR, output='sos'), x, axis=0)
def tt(d): return np.arange(int(d * SR)) / SR
def hz(m): return 440 * 2 ** ((m - 69) / 12)
def fade(x, a=.01, r=.05):
    n, na, nr = len(x), int(a * SR), int(r * SR)
    if na: x[:na] *= np.linspace(0, 1, na)[:, None] if x.ndim == 2 else np.linspace(0, 1, na)
    if nr: x[-nr:] *= np.linspace(1, 0, nr)[:, None] if x.ndim == 2 else np.linspace(1, 0, nr)
    return x
def put(buf, x, at, g=1., pan=0.):
    if x.ndim == 2:
        s = int(at * SR); e = min(N, s + len(x))
        if s < N and e > max(s, 0): buf[max(s, 0):e] += (x[max(0, -s):e - s] * g).astype(np.float32)
    else: add(buf, x.astype(np.float32), at, g, pan)

# ------------------------------------------------------------------ 段落和调性（84 BPM，两小节一个和弦）
BPM = 84; BEAT = 60 / BPM; BAR = 4 * BEAT
sec = [(e['t'], e['id']) for e in EV if e['type'] == 'section'] + [(DUR + 2, 'stop')]
def span(id_):
    for i, (t0, s) in enumerate(sec[:-1]):
        if s == id_: return t0, sec[i + 1][0]
    return None
D, F_, G_, A_, Bb, C_, Eb = 50, 53, 55, 57, 46, 48, 51   # 和弦根音（D3 = 50）
m = lambda r: (r, [0, 3, 7]); M = lambda r: (r, [0, 4, 7])
PLAN = {   # 段落: (和弦进行, 脉冲低音 None/8/16, FM 拨弦 None/4/8, 定音鼓每小节, 底噪)
  'pro':   ([m(D), m(D), M(Bb), M(Bb)], None, 4, False, 'city'),
  'title': ([m(D)], None, None, False, 'city'),
  'c1':    ([m(D), M(F_), M(C_), M(Bb)], 8, 8, False, 'orbit'),
  'c2':    ([m(D), M(C_), M(Bb), M(A_)], 8, 8, True, 'wind'),
  'c3':    ([m(G_), m(D), M(Eb), M(D)], None, 4, False, 'water'),
  'c4':    ([], None, None, False, 'rain'),
  'c5':    ([m(D), M(C_), M(Bb), M(C_)], 16, 8, True, 'wind'),
  'c6':    ([m(D), M(Bb), M(F_), M(A_)], 8, 4, False, 'orbit'),
  'c7':    ([m(D), M(Bb), m(G_), M(A_)], 8, 8, True, 'water'),
  'fall':  ([], None, None, False, 'water'),
  'epi':   ([M(Bb), M(F_), m(D), M(D)], None, 4, False, 'city'),
  'end':   ([m(D)], None, None, False, 'city'),
}

def saw(f, d, det=0.):
    t = tt(d); ph = (t * f * 2 ** (det / 1200) + RNG.random()) % 1
    return 2 * ph - 1
def pad_chord(root, iv, d):
    x = np.zeros(int(d * SR))
    for k, i in enumerate(iv + [12]):
        f = hz(root + i + (12 if root < 48 else 0))
        for det in (-7, 0, 6): x[:len(x)] += saw(f, d, det)[:len(x)] * (.5 if k == 3 else 1)
    x = lp(x, 900); x /= np.abs(x).max() + 1e-9
    a = np.minimum(1, tt(d) / 1.2) * np.minimum(1, (d - tt(d)) / 1.6)
    return x * a
def pluck(f, d=.42, v=1.):   # FM 遥测拨弦
    t = tt(d); idx = 2.4 * np.exp(-t / .05)
    return np.sin(2 * np.pi * f * t + idx * np.sin(2 * np.pi * f * 2 * t)) * np.exp(-t / .12) * v
def pulse_note(f, d, v=1.):  # 带 2、3 次谐波的脉冲低音
    t = tt(d); x = np.sin(2 * np.pi * f * t) + .55 * np.sin(4 * np.pi * f * t) + .32 * np.sin(6 * np.pi * f * t)
    return x * np.exp(-t / .16) * np.minimum(1, t / .004) * v

for name, (chords, pz, pk, timp, bed) in PLAN.items():
    sp = span(name)
    if not sp: continue
    t0, t1 = sp
    if chords:
        seg = 2 * BAR; k = 0; t = t0
        while t < t1 - .5:
            r, iv = chords[k % len(chords)]; d = min(seg + 1.6, t1 - t + 1.2)
            put(music, pad_chord(r, iv, d), t, .16, (-.25 if k % 2 else .25))
            # 拨弦：和弦音上行
            if pk:
                step = BEAT if pk == 4 else BEAT / 2
                notes = [r + 24 + i for i in iv] + [r + 36]
                for j in range(int(seg / step)):
                    tj = t + j * step
                    if tj >= t1 - .2: break
                    put(pulse, pluck(hz(notes[j % len(notes)]), .4, .9 if j % 4 == 0 else .6), tj, .07, (-.5 + (j % 3) * .5))
            if pz:
                step = BEAT / (2 if pz == 8 else 4)
                for j in range(int(seg / step)):
                    tj = t + j * step
                    if tj >= t1 - .2: break
                    put(pulse, pulse_note(hz(r - 12), step * .95, 1 if j % 2 == 0 else .7), tj, .2)
            if timp:
                for b in range(2): put(music, S.hit('timpani', 0, .55), t + b * BAR, .5, .1)
            t += seg; k += 1
    if name in ('c4', 'fall'):   # 只剩低频长音
        d = t1 - t0 + 1
        for f, g in ((hz(26), .5), (hz(33), .35), (hz(38), .25)):
            x = lp(np.sin(2 * np.pi * f * tt(d)) + .4 * np.sin(4 * np.pi * f * tt(d)), 400) * np.minimum(1, tt(d) / 2) * np.minimum(1, (d - tt(d)) / 2)
            put(music, x, t0, .22 * g)
        if name == 'c4':
            for tb in np.arange(t0 + 2, t1, 2 * BEAT): put(music, X.heartbeat(.6), tb, .35)

# ------------------------------------------------------------------ 底噪
def bed_noise(kind, d):
    n = RNG.standard_normal(int(d * SR))
    t = tt(d); am = .7 + .3 * np.sin(2 * np.pi * .07 * t + RNG.random() * 6)
    if kind == 'orbit': x = lp(n, 300) * .5 + np.sin(2 * np.pi * 55 * t) * .25 + bp(n, 2500, 6000) * .05
    elif kind == 'wind': x = bp(n, 180, 900) * am * 1.2
    elif kind == 'water': x = lp(n, 700) * (.6 + .4 * np.abs(np.sin(2 * np.pi * .23 * t))) * .9
    elif kind == 'rain': x = hp(n, 1800) * .45 + lp(n, 400) * .4
    else: x = lp(n, 500) * .4 + bp(n, 1500, 4000) * .04
    return x / (np.abs(x).max() + 1e-9)
for name, (_, _, _, _, bed) in PLAN.items():
    sp = span(name)
    if sp:
        d = sp[1] - sp[0] + 1.5
        x = bed_noise(bed, d) * np.minimum(1, tt(d) / 1.2) * np.minimum(1, (d - tt(d)) / 1.2)
        put(beds, np.stack([x, np.roll(x, 2400)], 1), sp[0], .5)

# ------------------------------------------------------------------ 音效
def ping(f, v=1., d=.9):
    t = tt(d); return (np.sin(2 * np.pi * f * t) + .3 * np.sin(2 * np.pi * f * 2.01 * t)) * np.exp(-t / .22) * v
def ratchet(d, rate=11, v=1.):
    x = np.zeros(int(d * SR))
    for k in range(int(d * rate)):
        c = X.click(1.4 + .2 * (k % 2), .6); s = int(k / rate * SR); x[s:s + len(c)] += c[:len(x) - s]
    return x * v
def sweep(d, up=False, v=1.):
    n = RNG.standard_normal(int(d * SR)); out = np.zeros_like(n); blk = 960
    for i in range(0, len(n), blk):
        u = i / len(n); f = 300 * 2 ** ((u if up else 1 - u) * 4)
        out[i:i + blk] = bp(n[max(0, i - 4000):i + blk], f * .7, min(f * 1.4, 20000))[-len(out[i:i + blk]):]
    return out / (np.abs(out).max() + 1e-9) * np.sin(np.pi * tt(d) / d) ** 1.5 * v
def riser(d, v=1.):
    t = tt(d); f = 80 * 2 ** (t / d * 3)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * .4 + sweep(d, True) * .6
    return x * (t / d) ** 2 * v
def water_lap(v=1.):
    d = 1.4; n = RNG.standard_normal(int(d * SR)); t = tt(d)
    return lp(n, 900) * np.exp(-((t - .4) / .25) ** 2) * v + bp(n, 600, 2000) * np.exp(-((t - .9) / .15) ** 2) * .4 * v
def brass(chord, d=1.2, v=.9):
    x = np.zeros(int((d + 1.5) * SR))
    for inst, p in zip(['tuba', 'trombone', 'trombone', 'horn'], chord):
        y = S.note(inst, p, d, vel=v); x[:len(y)] += y[:len(x)]
    return x
DM_LOW = ['D2', 'D3', 'A3', 'F4']
last_hit = {}
for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'lock': put(foley, ping(880 if e.get('amber') else 1175, 1), t, .22, .1)
    elif ty == 'tick': put(foley, X.click(1.2, .5 if e.get('soft') else .7), t, .25, .2)
    elif ty == 'land':
        put(foley, X.thump(.6, 110), t, .3); put(foley, ping(1760, .6, .6), t + .02, .1)
    elif ty == 'draw': put(foley, ratchet(4 if e.get('long') else 2.2, 10, .5), t, .14, -.2)
    elif ty == 'scan': put(foley, sweep(1.4, e.get('dir', 1) < 0, .7 if e.get('soft') else 1), t, .3)
    elif ty in ('dive', 'rise', 'dawn'): d = 2.4 if ty == 'dive' else (2.0 if e.get('long') else 1.5); put(foley, riser(d, .8), t - (d - .2 if ty == 'dive' else 0), .28)
    elif ty == 'whoosh': put(foley, X.whoosh(1.0, 1), t, .5)
    elif ty == 'open': put(foley, ping(392, .5, 1.4) + ping(587, .3, 1.4), t, .2)
    elif ty == 'title':
        put(music, S.hit('timpani', 0, .8), t, .9); put(music, S.hit('gong', 0, .5 if e.get('end') else .4), t, .5)
        if not e.get('low'): put(music, brass(DM_LOW, 2.2, .55), t, .35)
    elif ty == 'meet': put(music, S.note('vibraphone_bowed', 'D5', 5, vel=.7), t, .5, .2); put(music, S.note('vibraphone_bowed', 'A4', 5, vel=.6), t + .4, .4, -.2)
    elif ty == 'reveal':
        for k, p in enumerate(['D5', 'A5', 'F5', 'E5']): put(music, S.note('vibraphone_bowed', p, 2.6, vel=.6), t + k * .9, .45, (-.3 + k * .2))
    elif ty == 'paper': put(foley, bp(RNG.standard_normal(int(.9 * SR)), 1500, 7000) * np.exp(-tt(.9) / .3), t, .25)
    elif ty == 'tear':
        put(foley, sweep(.5, False, 1), t, .7); put(music, S.hit('bass_drum', 0, .9), t, .9); put(music, S.hit('gran_cassa', 0, .9), t, .8)
        put(music, brass(DM_LOW, 1.4, .95), t, .6); put(music, S.hit('crash', 0, .8), t, .35)
    elif ty == 'hit':
        put(music, S.hit('timpani', 0, .9), t, 1.0); put(music, S.hit('gran_cassa', 0, .85), t, .8)
        if not e.get('low'): put(music, S.hit('bass_drum', 0, .9), t, .9)
        if e.get('big'): put(music, brass(DM_LOW, 1.8 if e.get('final') else 1.2, 1.0), t, .75); put(music, S.hit('crash', 0, .8), t, .4)
        if e.get('final'): put(music, S.hit('gong', 0, .9), t, .7)
    elif ty == 'drum':
        for k in range(3): put(music, S.hit('timpani', 0, .6 + k * .1), t + k * BEAT / 2, .55)
    elif ty == 'ally': put(music, S.note('vibraphone', 'A4', 1.5, vel=.6), t, .45, -.2); put(music, S.note('vibraphone', 'D5', 1.5, vel=.6), t + .08, .45, .2)
    elif ty == 'flip': put(music, S.note('vibraphone', ['D5', 'F5', 'A5', 'C6', 'D6', 'A5', 'F5', 'E5', 'D5', 'A4'][e['i']], 1.2, vel=.55), t, .38, (-.5 + e['i'] * .1))
    elif ty == 'ring':
        i = e['i']; put(music, S.hit('timpani', 0, .55 + .05 * i), t, .6); put(foley, sweep(.9, False, .8), t - .5, .2)
        put(music, S.hit('sus_cymbal', 0, .3 + .04 * i), t, .2, .3)
        if i % 3 == 2: put(music, brass(['D2', 'A2', 'D3', 'F3'], .7, .6 + .04 * i), t, .4)
    elif ty == 'sink': put(foley, X.thump(.7, 60) + 0, t, .4); put(foley, water_lap(.8), t + .1, .35)
    elif ty == 'water': put(foley, water_lap(1.2 if e.get('big') else .8), t, .5); put(foley, water_lap(.6), t + .9, .4, .3)
    elif ty == 'cut': put(music, S.hit('gong2', 0, .6), t, .4); put(foley, X.thump(.9, 80), t, .5)
    elif ty == 'fleet': put(music, S.note('horn', 'A3', 2.4, vel=.7), t, .35, -.2); put(music, S.note('horn', 'D4', 2.4, vel=.7), t + .3, .35, .2); put(foley, ratchet(2.2, 14, .6), t, .15)
    elif ty == 'launch': put(foley, water_lap(1.2), t, .5); put(music, S.note('horn', 'D4', 2, vel=.6), t + .2, .3)
    elif ty == 'drain':
        g = S.hit('gong', 0, .7); g = g[::-1].copy(); put(music, g, t, .45)
        put(beds, np.stack([lp(RNG.standard_normal(int(9 * SR)), 500) * np.sin(np.pi * tt(9) / 9)] * 2, 1), t, .25)
    elif ty == 'rain':
        sp = span('c4'); d = sp[1] - t
        r = hp(RNG.standard_normal(int(d * SR)), 2500) * np.minimum(1, tt(d) / 1.5) * np.minimum(1, (d - tt(d)) / 2)
        put(beds, np.stack([r, np.roll(r, 3000)], 1), t, .35)

# ------------------------------------------------------------------ 旁白
for l in TL['lines']:
    x, sr = sf.read(os.path.join(HERE, 'voice', l['id'] + '.wav'), dtype='float32')
    if x.ndim > 1: x = x.mean(1)
    x = soxr.resample(x, sr, SR)
    put(voice, x, l['t0'], 1.0)
v = voice[:, 0].copy()
env = uniform_filter1d(maximum_filter1d(np.abs(v), int(.01 * SR)), int(.02 * SR))
thr = .12; g = np.where(env > thr, (thr + (env - thr) / 3.0) / np.maximum(env, 1e-9), 1.0)
v = v * uniform_filter1d(g, int(.005 * SR))
v = hp(v, 80); rms = np.sqrt(np.mean(v[np.abs(v) > .01] ** 2)); v *= .18 / rms
voice[:, 0] = v; voice[:, 1] = v

# ------------------------------------------------------------------ 抽空与静默、旁白避让
def gain_curve(kind):
    gcur = np.ones(N, np.float32)
    for e in EV:
        if e['type'] == 'suck':
            s, d = int(e['t'] * SR), int(.38 * SR); gcur[s:s + d] = np.minimum(gcur[s:s + d], .06)
        if e['type'] == 'silence':
            a, b = e['t'], e['t'] + e['dur']; s0, s1 = int(a * SR), int(b * SR)
            lvl = .05 if kind != 'beds' else .35
            k = np.ones(s1 - s0) * lvl; f = int(.4 * SR); k[:f] = np.linspace(1, lvl, f); k[-f:] = np.linspace(lvl, 1, f)
            gcur[s0:s1] = np.minimum(gcur[s0:s1], k)
    return uniform_filter1d(gcur, int(.03 * SR))[:, None]
vact = uniform_filter1d((np.abs(voice[:, 0]) > .02).astype(np.float32), int(.6 * SR))
duck = (1 - .45 * np.clip(vact * 3, 0, 1))[:, None]
music *= gain_curve('music') * duck; pulse *= gain_curve('music') * duck; beds *= gain_curve('beds'); foley *= gain_curve('foley')

# 低频：高通 38 Hz，62 Hz 以下压低一些（旁白除外）
def tame(x): return hp(x, 38, 4) * .82 + lp(hp(x, 62, 2), 20000) * .18
music, pulse, beds = tame(music), tame(pulse), tame(beds)
mix = music * 1.0 + pulse * .8 + beds * .14 + foley * .7 + voice * 1.0
for k in range(2): mix[:, k] = X.limit(mix[:, k] * 1.05, .5, .003)   # 峰值留足余量：响度标准化后真峰值不超过 -1.2 dB
mix = mix[:int(DUR * SR)]
sf.write(os.path.join(OUT, 'mix.wav'), mix, SR, subtype='PCM_24')
for n_, s_ in (('music', music), ('pulse', pulse), ('beds', beds), ('foley', foley), ('voice', voice)):
    sf.write(os.path.join(OUT, 'stems', n_ + '.wav'), s_[:int(DUR * SR)], SR, subtype='PCM_16')
print('mix', os.path.join(OUT, 'mix.wav'), f'{DUR:.1f}s', 'peak', float(np.abs(mix).max()))
