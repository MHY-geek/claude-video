"""Self-host the film's fonts in fonts/ (all OFL):
Barlow Condensed and IBM Plex Mono from github.com/google/fonts; Noto Sans SC / Noto Serif SC subset to the
characters the film uses (Google Fonts CSS API with &text=)."""
import os, re, json, urllib.request, urllib.parse
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, 'fonts'); os.makedirs(OUT, exist_ok=True)
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'}
def get(url):   # curl: the system Python here has no CA bundle
    import subprocess
    return subprocess.run(['curl', '-sfL', '--retry', '3', '-A', UA['User-Agent'], url], check=True, capture_output=True).stdout
GH = 'https://raw.githubusercontent.com/google/fonts/main/ofl/'
for path, name in [('barlowcondensed/BarlowCondensed-Light.ttf', 'BarlowCondensed-Light.ttf'), ('barlowcondensed/BarlowCondensed-Regular.ttf', 'BarlowCondensed-Regular.ttf'),
                   ('barlowcondensed/OFL.txt', 'OFL-barlow.txt'), ('ibmplexmono/IBMPlexMono-Regular.ttf', 'IBMPlexMono-Regular.ttf'), ('ibmplexmono/OFL.txt', 'OFL-ibmplexmono.txt')]:
    p = os.path.join(OUT, name)
    if not os.path.exists(p): open(p, 'wb').write(get(GH + path)); print('↓', name)
src = open(os.path.join(HERE, 'film.js'), encoding='utf-8').read() + open(os.path.join(HERE, 'timeline.json'), encoding='utf-8').read() + open(os.path.join(HERE, 'assets/geo.json'), encoding='utf-8').read()
chars = sorted({c for c in src if ord(c) > 127} | set(''.join(chr(c) for c in range(32, 127))) | set('·—–≈（）：，。'))
txt = ''.join(chars)
print(len(chars), 'characters')
for fam, wt, name in [('Noto+Sans+SC', 400, 'NotoSansSC-400.woff2'), ('Noto+Sans+SC', 500, 'NotoSansSC-500.woff2'), ('Noto+Sans+SC', 700, 'NotoSansSC-700.woff2'), ('Noto+Serif+SC', 600, 'NotoSerifSC-600.woff2')]:
    css = get(f'https://fonts.googleapis.com/css2?family={fam}:wght@{wt}&text=' + urllib.parse.quote(txt)).decode()
    urls = re.findall(r'url\((https://[^)]+)\)', css)
    data = b''.join(get(u) for u in urls[:1])
    if len(urls) != 1: print('warning:', len(urls), 'files for', name)
    open(os.path.join(OUT, name), 'wb').write(data); print('↓', name, len(data) // 1024, 'KB')
open(os.path.join(OUT, 'OFL-noto.txt'), 'w').write('Noto Sans SC and Noto Serif SC: Copyright Google / Adobe. SIL Open Font License 1.1 (https://openfontlicense.org)\n')
