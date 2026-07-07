"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "data", "geofence-hbut.json");
const OUTPUT_DIR = path.join(ROOT, "outputs");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "hbut-geofence-preview.svg");

const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

const width = 1500;
const height = 1100;
const mapBox = { x: 70, y: 90, width: 1040, height: 890 };
const sideBox = { x: 1150, y: 90, width: 290, height: 890 };
const titleY = 42;
const lat0 =
  data.allowedAreas[0].coordinates[0].reduce((sum, point) => sum + point[1], 0) /
  data.allowedAreas[0].coordinates[0].length;
const lonMeters = 111320 * Math.cos((lat0 * Math.PI) / 180);
const latMeters = 110540;

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function collectPoints() {
  const points = [];
  for (const area of [...data.allowedAreas, ...data.excludedAreas]) {
    for (const ring of area.coordinates) {
      points.push(...ring);
    }
  }
  for (const item of data.candidateExcludedBuildings) {
    const b = item.bounds;
    points.push([b.minLon, b.minLat], [b.maxLon, b.maxLat]);
  }
  return points;
}

const sourcePoints = collectPoints();
const minLon = Math.min(...sourcePoints.map((point) => point[0]));
const maxLon = Math.max(...sourcePoints.map((point) => point[0]));
const minLat = Math.min(...sourcePoints.map((point) => point[1]));
const maxLat = Math.max(...sourcePoints.map((point) => point[1]));

const sourceWidthM = (maxLon - minLon) * lonMeters;
const sourceHeightM = (maxLat - minLat) * latMeters;
const padM = 45;
const totalWidthM = sourceWidthM + padM * 2;
const totalHeightM = sourceHeightM + padM * 2;
const scale = Math.min(mapBox.width / totalWidthM, mapBox.height / totalHeightM);
const usedWidth = totalWidthM * scale;
const usedHeight = totalHeightM * scale;
const offsetX = mapBox.x + (mapBox.width - usedWidth) / 2;
const offsetY = mapBox.y + (mapBox.height - usedHeight) / 2;

function project(point) {
  const [lon, lat] = point;
  const xM = (lon - minLon) * lonMeters + padM;
  const yM = (maxLat - lat) * latMeters + padM;
  return [offsetX + xM * scale, offsetY + yM * scale];
}

function ringPath(ring) {
  return ring
    .map((point, index) => {
      const [x, y] = project(point);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function polygonPath(area) {
  return area.coordinates.map((ring) => `${ringPath(ring)} Z`).join(" ");
}

function rectanglePath(bounds) {
  const ring = [
    [bounds.minLon, bounds.minLat],
    [bounds.maxLon, bounds.minLat],
    [bounds.maxLon, bounds.maxLat],
    [bounds.minLon, bounds.maxLat],
    [bounds.minLon, bounds.minLat]
  ];
  return ringPath(ring) + " Z";
}

function centroid(area) {
  const ring = area.coordinates[0];
  const uniqueRing =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
  const sum = uniqueRing.reduce(
    (acc, point) => {
      acc.lon += point[0];
      acc.lat += point[1];
      return acc;
    },
    { lon: 0, lat: 0 }
  );
  return [sum.lon / uniqueRing.length, sum.lat / uniqueRing.length];
}

function gridLines() {
  const lines = [];
  const stepM = 100;
  const startX = Math.ceil((-padM) / stepM) * stepM;
  const endX = Math.ceil(totalWidthM / stepM) * stepM;
  const startY = Math.ceil((-padM) / stepM) * stepM;
  const endY = Math.ceil(totalHeightM / stepM) * stepM;

  for (let xM = startX; xM <= endX; xM += stepM) {
    const x = offsetX + (xM + padM) * scale;
    if (x >= mapBox.x && x <= mapBox.x + mapBox.width) {
      lines.push(
        `<line class="grid-line" x1="${x.toFixed(2)}" y1="${mapBox.y}" x2="${x.toFixed(2)}" y2="${mapBox.y + mapBox.height}" />`
      );
    }
  }
  for (let yM = startY; yM <= endY; yM += stepM) {
    const y = offsetY + (yM + padM) * scale;
    if (y >= mapBox.y && y <= mapBox.y + mapBox.height) {
      lines.push(
        `<line class="grid-line" x1="${mapBox.x}" y1="${y.toFixed(2)}" x2="${mapBox.x + mapBox.width}" y2="${y.toFixed(2)}" />`
      );
    }
  }
  return lines.join("\n");
}

function scaleBar() {
  const meters = 200;
  const x = mapBox.x + 34;
  const y = mapBox.y + mapBox.height - 42;
  const barW = meters * scale;
  return `
    <g class="scale-bar">
      <line x1="${x}" y1="${y}" x2="${(x + barW).toFixed(2)}" y2="${y}" />
      <line x1="${x}" y1="${y - 8}" x2="${x}" y2="${y + 8}" />
      <line x1="${(x + barW).toFixed(2)}" y1="${y - 8}" x2="${(x + barW).toFixed(2)}" y2="${y + 8}" />
      <text x="${(x + barW / 2).toFixed(2)}" y="${y - 14}" text-anchor="middle">200m</text>
    </g>`;
}

const allowedMarkup = data.allowedAreas
  .map(
    (area) =>
      `<path class="allowed-area" d="${polygonPath(area)}"><title>${escapeXml(area.name)}</title></path>`
  )
  .join("\n");

const excludedMarkup = data.excludedAreas
  .map(
    (area) =>
      `<path class="excluded-area" d="${polygonPath(area)}"><title>${escapeXml(area.name)}</title></path>`
  )
  .join("\n");

const buildingMarkup = data.candidateExcludedBuildings
  .map(
    (item) =>
      `<path class="candidate-building" d="${rectanglePath(item.bounds)}"><title>${escapeXml(item.name)}</title></path>`
  )
  .join("\n");

const labelMarkup = data.excludedAreas
  .map((area) => {
    const [x, y] = project(centroid(area));
    return `<g class="zone-label" transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">
      <rect x="-68" y="-18" width="136" height="32" rx="5" />
      <text text-anchor="middle" y="4">${escapeXml(area.name)}</text>
    </g>`;
  })
  .join("\n");

const sideRows = data.excludedAreas
  .map((area, index) => {
    const y = sideBox.y + 230 + index * 56;
    return `
      <g class="side-row">
        <rect x="${sideBox.x}" y="${y - 20}" width="18" height="18" />
        <text x="${sideBox.x + 28}" y="${y - 5}">${escapeXml(area.name)}</text>
      </g>`;
  })
  .join("\n");

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="湖北工业大学校内非宿舍打卡范围复核图">
  <style>
    * { box-sizing: border-box; }
    svg { background: #f7faf9; font-family: "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif; }
    .title { fill: #16251f; font-size: 30px; font-weight: 700; }
    .subtitle { fill: #5d6e66; font-size: 15px; }
    .map-frame, .side-panel { fill: #ffffff; stroke: #d8e3df; stroke-width: 1.2; }
    .grid-line { stroke: #dfe9e5; stroke-width: 1; }
    .allowed-area { fill: #cfeedd; stroke: #167351; stroke-width: 3; }
    .excluded-area { fill: #ef4444; fill-opacity: 0.38; stroke: #b91c1c; stroke-width: 2.4; }
    .candidate-building { fill: none; stroke: #7f1d1d; stroke-width: 1.2; stroke-opacity: 0.76; }
    .campus-label { fill: #0f5138; font-size: 22px; font-weight: 700; }
    .zone-label rect { fill: #ffffff; fill-opacity: 0.88; stroke: #b91c1c; stroke-width: 1; }
    .zone-label text { fill: #7f1d1d; font-size: 14px; font-weight: 700; }
    .legend-title { fill: #17241f; font-size: 20px; font-weight: 700; }
    .legend-text { fill: #34423d; font-size: 15px; }
    .legend-muted { fill: #66756f; font-size: 13px; }
    .legend-swatch-allowed { fill: #cfeedd; stroke: #167351; stroke-width: 2; }
    .legend-swatch-excluded { fill: #ef4444; fill-opacity: 0.38; stroke: #b91c1c; stroke-width: 2; }
    .legend-swatch-building { fill: none; stroke: #7f1d1d; stroke-width: 2; }
    .side-row rect { fill: #ef4444; fill-opacity: 0.38; stroke: #b91c1c; }
    .side-row text { fill: #26342f; font-size: 15px; font-weight: 600; }
    .note { fill: #4c5c56; font-size: 13px; }
    .scale-bar line { stroke: #18251f; stroke-width: 2; }
    .scale-bar text { fill: #18251f; font-size: 13px; font-weight: 700; }
    .north text { fill: #18251f; font-size: 16px; font-weight: 700; }
    .north path { fill: #18251f; }
  </style>

  <text class="title" x="70" y="${titleY}">湖北工业大学打卡范围复核图</text>
  <text class="subtitle" x="70" y="${titleY + 28}">绿色为校内可签到区域，红色为宿舍/公寓不可签到排除区；深红细框为 OSM 候选宿舍楼边界框。</text>

  <rect class="map-frame" x="${mapBox.x}" y="${mapBox.y}" width="${mapBox.width}" height="${mapBox.height}" rx="8" />
  <clipPath id="mapClip">
    <rect x="${mapBox.x}" y="${mapBox.y}" width="${mapBox.width}" height="${mapBox.height}" rx="8" />
  </clipPath>
  <g clip-path="url(#mapClip)">
    ${gridLines()}
    ${allowedMarkup}
    ${excludedMarkup}
    ${buildingMarkup}
  </g>
  <text class="campus-label" x="${mapBox.x + mapBox.width / 2}" y="${mapBox.y + 42}" text-anchor="middle">湖北工业大学主校区</text>
  ${labelMarkup}
  ${scaleBar()}
  <g class="north" transform="translate(${mapBox.x + mapBox.width - 56} ${mapBox.y + 42})">
    <path d="M 0 -24 L 10 12 L 0 7 L -10 12 Z" />
    <text text-anchor="middle" y="36">北</text>
  </g>

  <rect class="side-panel" x="${sideBox.x}" y="${sideBox.y}" width="${sideBox.width}" height="${sideBox.height}" rx="8" />
  <text class="legend-title" x="${sideBox.x + 22}" y="${sideBox.y + 42}">图例</text>
  <rect class="legend-swatch-allowed" x="${sideBox.x + 22}" y="${sideBox.y + 70}" width="30" height="20" rx="3" />
  <text class="legend-text" x="${sideBox.x + 64}" y="${sideBox.y + 86}">校内可签到区域</text>
  <rect class="legend-swatch-excluded" x="${sideBox.x + 22}" y="${sideBox.y + 108}" width="30" height="20" rx="3" />
  <text class="legend-text" x="${sideBox.x + 64}" y="${sideBox.y + 124}">不可签到排除区</text>
  <rect class="legend-swatch-building" x="${sideBox.x + 22}" y="${sideBox.y + 146}" width="30" height="20" rx="3" />
  <text class="legend-text" x="${sideBox.x + 64}" y="${sideBox.y + 162}">候选宿舍楼框</text>

  <text class="legend-title" x="${sideBox.x + 22}" y="${sideBox.y + 205}">排除区清单</text>
  ${sideRows}

  <text class="legend-title" x="${sideBox.x + 22}" y="${sideBox.y + 560}">建议判定</text>
  <text class="legend-text" x="${sideBox.x + 22}" y="${sideBox.y + 590}">1. 必须在校园边界内</text>
  <text class="legend-text" x="${sideBox.x + 22}" y="${sideBox.y + 620}">2. 不能落入红色区域</text>
  <text class="legend-text" x="${sideBox.x + 22}" y="${sideBox.y + 650}">3. 靠近边界按精度复核</text>
  <text class="legend-muted" x="${sideBox.x + 22}" y="${sideBox.y + 690}">精度建议：≤50m 通过</text>
  <text class="legend-muted" x="${sideBox.x + 22}" y="${sideBox.y + 714}">50-150m 复核 / 重定位</text>
  <text class="legend-muted" x="${sideBox.x + 22}" y="${sideBox.y + 738}">&gt;150m 拒绝或重新定位</text>

  <text class="note" x="${sideBox.x + 22}" y="${sideBox.y + 805}">数据：OpenStreetMap / ODbL</text>
  <text class="note" x="${sideBox.x + 22}" y="${sideBox.y + 830}">坐标系：WGS84，经纬度投影预览</text>
  <text class="note" x="${sideBox.x + 22}" y="${sideBox.y + 855}">生成日期：${escapeXml(data.generatedAt)}</text>
</svg>
`;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(OUTPUT_FILE, svg, "utf8");
console.log(OUTPUT_FILE);
