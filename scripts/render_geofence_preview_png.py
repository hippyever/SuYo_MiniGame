import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "data" / "geofence-hbut.json"
OUTPUT_DIR = ROOT / "outputs"
OUTPUT_FILE = OUTPUT_DIR / "hbut-geofence-preview.png"

WIDTH = 1500
HEIGHT = 1100
SCALE_FACTOR = 2
MAP_BOX = (70, 90, 1040, 890)
SIDE_BOX = (1150, 90, 290, 890)


def load_font(size, bold=False):
    candidates = [
        Path("C:/Windows/Fonts/msyhbd.ttc") if bold else Path("C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/simhei.ttf"),
        Path("C:/Windows/Fonts/arialbd.ttf") if bold else Path("C:/Windows/Fonts/arial.ttf"),
    ]
    for candidate in candidates:
        try:
            if candidate.exists():
                return ImageFont.truetype(str(candidate), size)
        except OSError:
            continue
    return ImageFont.load_default()


def text_size(draw, text, font):
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0], box[3] - box[1]


with DATA_FILE.open("r", encoding="utf-8") as f:
    data = json.load(f)

points = []
for area in data["allowedAreas"] + data["excludedAreas"]:
    for ring in area["coordinates"]:
        points.extend(ring)
for item in data["candidateExcludedBuildings"]:
    b = item["bounds"]
    points.extend([[b["minLon"], b["minLat"]], [b["maxLon"], b["maxLat"]]])

min_lon = min(p[0] for p in points)
max_lon = max(p[0] for p in points)
min_lat = min(p[1] for p in points)
max_lat = max(p[1] for p in points)

campus_ring = data["allowedAreas"][0]["coordinates"][0]
lat0 = sum(p[1] for p in campus_ring) / len(campus_ring)
lon_meters = 111320 * math.cos(math.radians(lat0))
lat_meters = 110540
source_width_m = (max_lon - min_lon) * lon_meters
source_height_m = (max_lat - min_lat) * lat_meters
pad_m = 45

map_x, map_y, map_w, map_h = MAP_BOX
total_width_m = source_width_m + pad_m * 2
total_height_m = source_height_m + pad_m * 2
scale = min(map_w / total_width_m, map_h / total_height_m)
used_w = total_width_m * scale
used_h = total_height_m * scale
offset_x = map_x + (map_w - used_w) / 2
offset_y = map_y + (map_h - used_h) / 2


def project(point):
    lon, lat = point
    x_m = (lon - min_lon) * lon_meters + pad_m
    y_m = (max_lat - lat) * lat_meters + pad_m
    return (offset_x + x_m * scale, offset_y + y_m * scale)


def tx(value):
    return int(round(value * SCALE_FACTOR))


def pt(point):
    x, y = project(point)
    return (tx(x), tx(y))


def ring_points(ring):
    return [pt(point) for point in ring]


def rect_points(bounds):
    return ring_points(
        [
            [bounds["minLon"], bounds["minLat"]],
            [bounds["maxLon"], bounds["minLat"]],
            [bounds["maxLon"], bounds["maxLat"]],
            [bounds["minLon"], bounds["maxLat"]],
            [bounds["minLon"], bounds["minLat"]],
        ]
    )


def centroid(area):
    ring = area["coordinates"][0]
    if ring[0] == ring[-1]:
        ring = ring[:-1]
    lon = sum(p[0] for p in ring) / len(ring)
    lat = sum(p[1] for p in ring) / len(ring)
    return [lon, lat]


def draw_round_rect(draw, xy, radius, fill, outline=None, width=1):
    scaled = tuple(tx(v) for v in xy)
    draw.rounded_rectangle(scaled, radius=tx(radius), fill=fill, outline=outline, width=tx(width))


img = Image.new("RGBA", (WIDTH * SCALE_FACTOR, HEIGHT * SCALE_FACTOR), (247, 250, 249, 255))
draw = ImageDraw.Draw(img)

font_title = load_font(30 * SCALE_FACTOR, bold=True)
font_subtitle = load_font(15 * SCALE_FACTOR)
font_label = load_font(14 * SCALE_FACTOR, bold=True)
font_campus = load_font(22 * SCALE_FACTOR, bold=True)
font_legend_title = load_font(20 * SCALE_FACTOR, bold=True)
font_legend = load_font(15 * SCALE_FACTOR)
font_small = load_font(13 * SCALE_FACTOR)

draw.text((tx(70), tx(34)), "湖北工业大学打卡范围复核图", fill=(22, 37, 31, 255), font=font_title)
draw.text(
    (tx(70), tx(62)),
    "绿色为校内可签到区域，红色为宿舍/公寓不可签到排除区；深红细框为 OSM 候选宿舍楼边界框。",
    fill=(93, 110, 102, 255),
    font=font_subtitle,
)

draw_round_rect(draw, (map_x, map_y, map_x + map_w, map_y + map_h), 8, (255, 255, 255, 255), (216, 227, 223, 255), 1)

grid_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
grid_draw = ImageDraw.Draw(grid_layer)
step_m = 100
start_x = math.ceil((-pad_m) / step_m) * step_m
end_x = math.ceil(total_width_m / step_m) * step_m
start_y = math.ceil((-pad_m) / step_m) * step_m
end_y = math.ceil(total_height_m / step_m) * step_m
for x_m in range(int(start_x), int(end_x) + step_m, step_m):
    x = offset_x + (x_m + pad_m) * scale
    if map_x <= x <= map_x + map_w:
        grid_draw.line((tx(x), tx(map_y), tx(x), tx(map_y + map_h)), fill=(223, 233, 229, 255), width=tx(1))
for y_m in range(int(start_y), int(end_y) + step_m, step_m):
    y = offset_y + (y_m + pad_m) * scale
    if map_y <= y <= map_y + map_h:
        grid_draw.line((tx(map_x), tx(y), tx(map_x + map_w), tx(y)), fill=(223, 233, 229, 255), width=tx(1))
img.alpha_composite(grid_layer)

for area in data["allowedAreas"]:
    ring = ring_points(area["coordinates"][0])
    draw.polygon(ring, fill=(207, 238, 221, 255))
    draw.line(ring, fill=(22, 115, 81, 255), width=tx(3), joint="curve")

excluded_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
excluded_draw = ImageDraw.Draw(excluded_layer)
for area in data["excludedAreas"]:
    ring = ring_points(area["coordinates"][0])
    excluded_draw.polygon(ring, fill=(239, 68, 68, 97))
    excluded_draw.line(ring, fill=(185, 28, 28, 255), width=tx(2), joint="curve")
img.alpha_composite(excluded_layer)

for item in data["candidateExcludedBuildings"]:
    ring = rect_points(item["bounds"])
    draw.line(ring, fill=(127, 29, 29, 190), width=tx(1))

campus_label = "湖北工业大学主校区"
label_w, _ = text_size(draw, campus_label, font_campus)
draw.text((tx(map_x + map_w / 2) - label_w // 2, tx(map_y + 24)), campus_label, fill=(15, 81, 56, 255), font=font_campus)

for area in data["excludedAreas"]:
    x, y = project(centroid(area))
    label = area["name"]
    box = (x - 68, y - 18, x + 68, y + 14)
    draw_round_rect(draw, box, 5, (255, 255, 255, 226), (185, 28, 28, 255), 1)
    w, h = text_size(draw, label, font_label)
    draw.text((tx(x) - w // 2, tx(y) - h // 2 - tx(1)), label, fill=(127, 29, 29, 255), font=font_label)

bar_m = 200
bar_x = map_x + 34
bar_y = map_y + map_h - 42
bar_w = bar_m * scale
draw.line((tx(bar_x), tx(bar_y), tx(bar_x + bar_w), tx(bar_y)), fill=(24, 37, 31, 255), width=tx(2))
draw.line((tx(bar_x), tx(bar_y - 8), tx(bar_x), tx(bar_y + 8)), fill=(24, 37, 31, 255), width=tx(2))
draw.line((tx(bar_x + bar_w), tx(bar_y - 8), tx(bar_x + bar_w), tx(bar_y + 8)), fill=(24, 37, 31, 255), width=tx(2))
scale_text = "200m"
scale_w, _ = text_size(draw, scale_text, font_small)
draw.text((tx(bar_x + bar_w / 2) - scale_w // 2, tx(bar_y - 30)), scale_text, fill=(24, 37, 31, 255), font=font_small)

north_x = map_x + map_w - 56
north_y = map_y + 42
draw.polygon(
    [
        (tx(north_x), tx(north_y - 24)),
        (tx(north_x + 10), tx(north_y + 12)),
        (tx(north_x), tx(north_y + 7)),
        (tx(north_x - 10), tx(north_y + 12)),
    ],
    fill=(24, 37, 31, 255),
)
north_w, _ = text_size(draw, "北", font_legend)
draw.text((tx(north_x) - north_w // 2, tx(north_y + 20)), "北", fill=(24, 37, 31, 255), font=font_legend)

side_x, side_y, side_w, side_h = SIDE_BOX
draw_round_rect(draw, (side_x, side_y, side_x + side_w, side_y + side_h), 8, (255, 255, 255, 255), (216, 227, 223, 255), 1)
draw.text((tx(side_x + 22), tx(side_y + 24)), "图例", fill=(23, 36, 31, 255), font=font_legend_title)

legend_items = [
    ("校内可签到区域", (207, 238, 221, 255), (22, 115, 81, 255), True),
    ("不可签到排除区", (239, 68, 68, 97), (185, 28, 28, 255), True),
    ("候选宿舍楼框", (255, 255, 255, 0), (127, 29, 29, 255), False),
]
for i, (label, fill, outline, filled) in enumerate(legend_items):
    y = side_y + 70 + i * 38
    draw.rounded_rectangle((tx(side_x + 22), tx(y), tx(side_x + 52), tx(y + 20)), radius=tx(3), fill=fill, outline=outline, width=tx(2))
    if not filled:
        draw.line((tx(side_x + 22), tx(y), tx(side_x + 52), tx(y), tx(side_x + 52), tx(y + 20), tx(side_x + 22), tx(y + 20), tx(side_x + 22), tx(y)), fill=outline, width=tx(2))
    draw.text((tx(side_x + 64), tx(y + 1)), label, fill=(52, 66, 61, 255), font=font_legend)

draw.text((tx(side_x + 22), tx(side_y + 187)), "排除区清单", fill=(23, 36, 31, 255), font=font_legend_title)
for i, area in enumerate(data["excludedAreas"]):
    y = side_y + 230 + i * 56
    draw.rounded_rectangle((tx(side_x), tx(y - 20), tx(side_x + 18), tx(y - 2)), radius=tx(2), fill=(239, 68, 68, 97), outline=(185, 28, 28, 255))
    draw.text((tx(side_x + 28), tx(y - 22)), area["name"], fill=(38, 52, 47, 255), font=font_legend)

draw.text((tx(side_x + 22), tx(side_y + 542)), "建议判定", fill=(23, 36, 31, 255), font=font_legend_title)
for i, line in enumerate(["1. 必须在校园边界内", "2. 不能落入红色区域", "3. 靠近边界按精度复核"]):
    draw.text((tx(side_x + 22), tx(side_y + 572 + i * 30)), line, fill=(52, 66, 61, 255), font=font_legend)
for i, line in enumerate(["精度建议：≤50m 通过", "50-150m 复核 / 重定位", ">150m 拒绝或重新定位"]):
    draw.text((tx(side_x + 22), tx(side_y + 672 + i * 24)), line, fill=(102, 117, 111, 255), font=font_small)

for i, line in enumerate(["数据：OpenStreetMap / ODbL", "坐标系：WGS84，经纬度投影预览", f"生成日期：{data['generatedAt']}"]):
    draw.text((tx(side_x + 22), tx(side_y + 805 + i * 25)), line, fill=(76, 92, 86, 255), font=font_small)

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
img = img.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
img.convert("RGB").save(OUTPUT_FILE, "PNG")
print(OUTPUT_FILE)
