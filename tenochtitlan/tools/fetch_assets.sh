#!/bin/sh
# 下载全部原始影像到 assets/raw/（不进 git，随时可重新下载）
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
RAW="$HERE/assets/raw"; mkdir -p "$RAW/dem"
get() { [ -s "$2" ] && [ -z "$FETCH" ] && return 0; echo "↓ $2"; curl -sfL --retry 4 --retry-all-errors -A "tenochtitlan-film/1.0 (personal project)" -o "$2" "$1"; }
GIBS='https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&CRS=EPSG:4326&STYLES=&FORMAT=image/jpeg'
EOX='https://tiles.maps.eox.at/wms?service=WMS&version=1.1.1&request=GetMap&styles=&srs=EPSG:4326&format=image/jpeg&layers=s2cloudless'
# 地球（NASA Blue Marble，公有领域）
get "$GIBS&LAYERS=BlueMarble_NextGeneration&BBOX=-90,-180,90,180&WIDTH=8192&HEIGHT=4096" "$RAW/world.jpg"
# 墨西哥湾（NASA Blue Marble 地形与海底地形，公有领域）
get "$GIBS&LAYERS=BlueMarble_ShadedRelief_Bathymetry&BBOX=14.45,-102.5,24.52,-83.5&WIDTH=4096&HEIGHT=2172" "$RAW/gulf.jpg"
# 高原、湖盆（Sentinel-2 cloudless 2016 by EOX，CC BY 4.0）
get "$EOX&bbox=-99.60,18.70,-95.90,20.10&width=4096&height=1550" "$RAW/highland.jpg"
get "$EOX&bbox=-99.43,19.20,-98.19,19.86&width=4096&height=2180" "$RAW/basin.jpg"
# 城市（Copernicus Sentinel-2 L2A，2026-02-09，经 Microsoft Planetary Computer）
get "https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/-99.27,19.34,-98.97,19.50/4096x2185.png?collection=sentinel-2-l2a&item=S2C_MSIL2A_20260209T170441_R069_T14QMG_20260209T195708&assets=visual&asset_bidx=visual%7C1%2C2%2C3&nodata=0" "$RAW/city.png"
# 1524 年纽伦堡版特诺奇蒂特兰地图（公有领域，Wikimedia Commons / Newberry Library）
get "https://upload.wikimedia.org/wikipedia/commons/c/c3/Map_of_Tenochtitlan%2C_1524.jpg" "$RAW/map1524.jpg"
# 海拔（Terrarium 地形瓦片，z12，AWS Open Data）
python3 -I - "$RAW/dem" <<'PY'
import math, os, sys, urllib.request, subprocess
out = sys.argv[1]
def t(lon, lat, z):
    n = 2 ** z; r = math.radians(lat)
    return int((lon + 180) / 360 * n), int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)
x0, y0 = t(-99.43, 19.86, 12); x1, y1 = t(-98.19, 19.20, 12)
for x in range(x0, x1 + 1):
    for y in range(y0, y1 + 1):
        p = f'{out}/12_{x}_{y}.png'
        if not os.path.exists(p):
            subprocess.run(['curl', '-sf', '-o', p, f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/{x}/{y}.png'], check=True)
PY
ls -la "$RAW" | head -20
