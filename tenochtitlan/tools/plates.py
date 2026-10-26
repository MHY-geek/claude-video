"""Build the film's plates from assets/raw/ into assets/plates/.

- imagery plates (JPEG) and their lon/lat boxes in plates.json
- the 1524 Nuremberg map, cropped to Tenochtitlan and turned north-up
- lake fields for the basin and the city: the 1519 lakes from the DEM (2248 m contour inside the basin,
  the south lakes capped by a hand-drawn outline), islands and shore towns kept as land.
  RGB = distance inside the water / distance outside (km / SCALE), B = 1 where the water is salt.
Run with the library's venv: $LIB/.venv/bin/python tools/plates.py
"""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW, OUT = os.path.join(HERE, 'assets/raw'), os.path.join(HERE, 'assets/plates')
os.makedirs(OUT, exist_ok=True)
Image.MAX_IMAGE_PIXELS = None
G = json.load(open(os.path.join(HERE, 'assets/geo.json'), encoding='utf-8'))

PLATES = {
    'world':    ('world.jpg',    [-180, -90, 180, 90]),
    'gulf':     ('gulf.jpg',     [-102.5, 14.45, -83.5, 24.52]),
    'highland': ('highland.jpg', [-99.60, 18.70, -95.90, 20.10]),
    'basin':    ('basin.jpg',    [-99.43, 19.20, -98.19, 19.86]),
    'city':     ('city.png',     [-99.27, 19.34, -98.97, 19.50]),
}
meta = {}
for name, (src, bbox) in PLATES.items():
    im = Image.open(os.path.join(RAW, src)).convert('RGB')
    if name == 'city':   # nodata edges of the Sentinel crop: fill from the nearest valid pixel
        a = np.asarray(im).astype(np.float32)
        bad = a.sum(2) < 3
        if bad.any():
            idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
            a = a[idx[0], idx[1]]
        im = Image.fromarray(a.astype(np.uint8))
    im.save(os.path.join(OUT, name + '.jpg'), quality=92)
    meta[name] = {'bbox': bbox, 'w': im.width, 'h': im.height}
    print(name, im.size)

# ---- 1524 map: crop the Tenochtitlan half, turn north-up (the woodcut has west at the top)
m = Image.open(os.path.join(RAW, 'map1524.jpg')).convert('RGB')
crop = m.crop((1000, 0, m.width, m.height)).rotate(90, expand=True)   # counter-clockwise: west goes left, north up
crop.save(os.path.join(OUT, 'map1524.jpg'), quality=90)
# where the temple precinct sits in the turned image (pixels), measured on the woodcut
px, py = 2120 - 1000, 946
meta['map1524'] = {'w': crop.width, 'h': crop.height, 'precinct_px': [py, (m.width - 1000) - 1 - px]}
print('map1524', crop.size, meta['map1524']['precinct_px'])

# ---- DEM (Terrarium z12) mosaic
Z = 12
def merc(lon, lat):
    n = 2 ** Z * 256; r = np.radians(lat)
    return (lon + 180) / 360 * n, (1 - np.log(np.tan(r) + 1 / np.cos(r)) / np.pi) / 2 * n
tiles = [f for f in os.listdir(os.path.join(RAW, 'dem')) if f.endswith('.png')]
xs = sorted({int(f.split('_')[1]) for f in tiles}); ys = sorted({int(f.split('_')[2][:-4]) for f in tiles})
X0, Y0 = xs[0], ys[0]
dem = np.zeros(((ys[-1] - Y0 + 1) * 256, (xs[-1] - X0 + 1) * 256), np.float32)
for f in tiles:
    _, x, y = f[:-4].split('_'); x, y = int(x), int(y)
    a = np.asarray(Image.open(os.path.join(RAW, 'dem', f)).convert('RGB')).astype(np.float32)
    dem[(y - Y0) * 256:(y - Y0 + 1) * 256, (x - X0) * 256:(x - X0 + 1) * 256] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
def elev(lon, lat):
    mx, my = merc(lon, lat)
    return ndimage.map_coordinates(dem, [my - Y0 * 256 - 0.5, mx - X0 * 256 - 0.5], order=1, mode='nearest')

LEVEL = 2248.0
KM_LAT = 111.32
def lake_field(name, bbox, W, H, scale_km):
    w, s, e, n = bbox
    lon = w + (np.arange(W) + 0.5) / W * (e - w)
    lat = n - (np.arange(H) + 0.5) / H * (n - s)
    LON, LAT = np.meshgrid(lon, lat)
    km_lon = KM_LAT * math.cos(math.radians((s + n) / 2))
    pxkm = W / ((e - w) * km_lon)                      # pixels per km
    P = lambda pts: [((x - w) / (e - w) * W, (n - y) / (n - s) * H) for x, y in pts]
    reg = Image.new('L', (W, H), 0); d = ImageDraw.Draw(reg)
    d.polygon(P(G['basin_region']), fill=255)
    cut = int((n - 19.300) / (n - s) * H)              # the basin region only north of 19.30, the south lakes from their cap
    reg = np.asarray(reg) > 127; reg[max(cut, 0):] = False
    cap = Image.new('L', (W, H), 0); ImageDraw.Draw(cap).polygon(P(G['south_cap']), fill=255)
    reg |= np.asarray(cap) > 127
    water = reg & (elev(LON, LAT) < LEVEL)
    water = ndimage.gaussian_filter(water.astype(np.float32), max(1.0, 0.12 * pxkm)) > 0.5
    lab, k = ndimage.label(water); sizes = ndimage.sum(water, lab, range(1, k + 1))
    water &= np.isin(lab, 1 + np.nonzero(sizes >= 0.3 * pxkm * pxkm)[0])
    land = ~water; lab, k = ndimage.label(land); sizes = ndimage.sum(land, lab, range(1, k + 1))
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
    for i, sz in enumerate(sizes, 1):
        if sz < 0.08 * pxkm * pxkm and i not in edge: water[lab == i] = True
    holes = Image.new('L', (W, H), 0); d = ImageDraw.Draw(holes)
    d.polygon(P(G['island']), fill=255)
    for t, r in G['islands']:
        lo, la = G['town'][t]
        d.polygon(P([(lo + math.cos(a) * r * (1 + .18 * math.sin(3 * a + 1)) / km_lon, la + math.sin(a) * r / KM_LAT) for a in np.linspace(0, 2 * math.pi, 28)]), fill=255)
    for t in G['shore_towns']:
        lo, la = G['town'][t]; (x, y), = P([(lo, la)]); rr = 0.35 * pxkm
        d.ellipse((x - rr, y - rr, x + rr, y + rr), fill=255)
    water &= ~(np.asarray(holes) > 127)
    din = ndimage.distance_transform_edt(water) / pxkm
    dout = ndimage.distance_transform_edt(~water) / pxkm
    # salt: east of the dike between its ends, and the whole lake north of it; fresh: west of the dike and the south lakes
    dike = np.array(G['dike'])
    dlon = np.interp(LAT, dike[::-1, 1], dike[::-1, 0])
    fresh = ((LAT <= 19.56) & (LON < dlon)) | (LAT < 19.353)
    salt = water & ~fresh
    rgb = np.stack([np.clip(din / scale_km, 0, 1), np.clip(dout / scale_km, 0, 1), salt.astype(np.float32)], -1)
    Image.fromarray((rgb * 255 + .5).astype(np.uint8)).save(os.path.join(OUT, f'lake_{name}.png'))
    meta['lake_' + name] = {'bbox': bbox, 'w': W, 'h': H, 'scale_km': scale_km}
    print('lake', name, W, H, 'water %.1f km2' % (water.sum() / pxkm / pxkm))

lake_field('basin', PLATES['basin'][1], 4096, 2180, 12.0)
lake_field('city', PLATES['city'][1], 4096, 2185, 6.0)
json.dump(meta, open(os.path.join(OUT, 'plates.json'), 'w'), indent=1)
