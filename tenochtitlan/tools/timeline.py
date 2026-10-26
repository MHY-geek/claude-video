"""One timeline for picture, subtitles and sound: line i starts after line i-1 ends plus its own pre gap.
Reads voice/lines.json + voice/dur.json, writes timeline.json (lines, cues, dur) and cues.json for srt.py."""
import json, os, re
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
L = json.load(open(os.path.join(HERE, 'voice/lines.json'), encoding='utf-8'))
D = json.load(open(os.path.join(HERE, 'voice/dur.json'), encoding='utf-8'))
END_HOLD = 9.0          # the end card after the last line
MAXC = 19               # characters per subtitle line
t, lines, cues = 0.0, [], []
def split(s):
    s = s.rstrip('。')
    parts = [p for p in re.split(r'(?<=[，。：；！？])', s) if p]
    out, cur = [], ''
    for p in parts:
        if cur and len(cur) + len(p) > MAXC: out.append(cur); cur = p
        else: cur += p
    if cur: out.append(cur)
    res = []
    for o in out:                                  # still too long: cut in the middle
        while len(o) > MAXC + 3: res.append(o[:len(o) // 2 + 1]); o = o[len(o) // 2 + 1:]
        res.append(o)
    return [r.rstrip('，。：；') for r in res]
for l in L:
    t += l['pre']; t0 = round(t, 3); t1 = round(t + D[l['id']], 3)
    lines.append({'id': l['id'], 't0': t0, 't1': t1, 'text': l['text']})
    segs = split(l['text']); n = sum(len(s) for s in segs); a = t0
    for i, s in enumerate(segs):
        b = t1 if i == len(segs) - 1 else a + (t1 - t0) * len(s) / n
        cues.append({'id': f"{l['id']}.{i}", 't0': round(a, 3), 't1': round(max(b, a + 0.1), 3), 'text': s})
        a = b
    t = t1
dur = round(t + END_HOLD, 3)
# hold each cue a little past the speech (at least 1.8 s, never into the next cue)
for i, c in enumerate(cues):
    nxt = cues[i + 1]['t0'] if i + 1 < len(cues) else dur
    c['t1'] = round(min(max(c['t1'] + 0.35, c['t0'] + 1.8), nxt - 0.04, dur), 3)
json.dump({'dur': dur, 'lines': lines, 'cues': cues}, open(os.path.join(HERE, 'timeline.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
json.dump(cues, open(os.path.join(HERE, 'cues.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print(f'{len(lines)} lines, {len(cues)} cues, dur {dur:.1f}s = {int(dur // 60)}:{dur % 60:04.1f}', 'longest cue', max(len(c["text"]) for c in cues))
