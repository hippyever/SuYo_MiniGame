const adminLogin = document.querySelector("#adminLogin");
const adminApp = document.querySelector("#adminApp");
const adminLoginForm = document.querySelector("#adminLoginForm");
const adminPasswordInput = document.querySelector("#adminPasswordInput");
const adminLoginError = document.querySelector("#adminLoginError");
const adminLogoutButton = document.querySelector("#adminLogoutButton");
const dateInput = document.querySelector("#dateInput");
const refreshButton = document.querySelector("#refreshButton");
const exportSummaryButton = document.querySelector("#exportSummaryButton");
const exportLogsButton = document.querySelector("#exportLogsButton");
const peopleStat = document.querySelector("#peopleStat");
const logsStat = document.querySelector("#logsStat");
const devicesStat = document.querySelector("#devicesStat");
const durationStat = document.querySelector("#durationStat");
const summaryMeta = document.querySelector("#summaryMeta");
const summaryBody = document.querySelector("#summaryBody");
const logsBody = document.querySelector("#logsBody");
const personSelect = document.querySelector("#personSelect");
const locationMap = document.querySelector("#locationMap");
const mapMeta = document.querySelector("#mapMeta");
const mapPointList = document.querySelector("#mapPointList");

const adminPasswordKey = "suzao.minigame.adminPassword";
let currentPassword = "";
let currentPeople = [];
let currentLogs = [];
let currentGeofence = null;

function todayLocal() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60000);
  return local.toISOString().slice(0, 10);
}

function password() {
  return currentPassword || adminPasswordInput.value.trim();
}

function savePassword(value) {
  currentPassword = value;
  localStorage.setItem(adminPasswordKey, value);
}

function clearPassword() {
  currentPassword = "";
  localStorage.removeItem(adminPasswordKey);
}

function adminHeaders() {
  return {
    "x-admin-password": password()
  };
}

function selectedDate() {
  return dateInput.value || todayLocal();
}

function selectedPersonKey() {
  return personSelect.value || "";
}

function buildAdminQuery(options = {}) {
  const params = new URLSearchParams();
  const date = options.date || selectedDate();
  const personKey = options.personKey ?? selectedPersonKey();
  if (date) params.set("date", date);
  if (personKey) params.set("personKey", personKey);
  return params.toString();
}

function withPassword(url) {
  const value = password();
  if (!value) return url;
  const glue = url.includes("?") ? "&" : "?";
  return `${url}${glue}password=${encodeURIComponent(value)}`;
}

function showLogin(message = "") {
  adminLogin.hidden = false;
  adminApp.hidden = true;
  if (message) {
    adminLoginError.hidden = false;
    adminLoginError.textContent = message;
  } else {
    adminLoginError.hidden = true;
    adminLoginError.textContent = "";
  }
  adminPasswordInput.focus();
}

function showApp() {
  adminLogin.hidden = true;
  adminApp.hidden = false;
  adminLoginError.hidden = true;
}

async function validatePassword(value) {
  const response = await fetch("/api/admin/session", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ password: value })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.message || "后台访问密码不正确。");
  }
  return result;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: adminHeaders()
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    if (response.status === 401) {
      clearPassword();
      showLogin(result.message || "后台访问密码不正确。");
    }
    throw new Error(result.message || "后台接口请求失败。");
  }
  return result;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function personLabel(person) {
  return `${person.team} / ${person.name}`;
}

async function loadPeople(date) {
  const previousValue = selectedPersonKey();
  const result = await fetchJson(`/api/admin/people?date=${encodeURIComponent(date)}`);
  currentPeople = result.people || [];
  personSelect.innerHTML = [
    '<option value="">全部人员</option>',
    ...currentPeople.map((person) => {
      const label = personLabel(person);
      return `<option value="${escapeHtml(person.personKey)}">${escapeHtml(label)} (${person.count})</option>`;
    })
  ].join("");

  if (currentPeople.some((person) => person.personKey === previousValue)) {
    personSelect.value = previousValue;
  } else {
    personSelect.value = "";
  }
}

async function loadGeofence() {
  if (currentGeofence) return currentGeofence;
  const result = await fetchJson("/api/admin/geofence");
  currentGeofence = result.geofence || null;
  return currentGeofence;
}

function locationCell(location) {
  if (!location) return "";
  return `${Number(location.latitude).toFixed(5)}, ${Number(location.longitude).toFixed(5)}<br><span class="meta-text">约 ${Math.round(location.accuracy || 0)}m</span>`;
}

function renderSummary(data) {
  peopleStat.textContent = data.stats.people;
  logsStat.textContent = data.stats.logs;
  devicesStat.textContent = data.stats.devices;
  durationStat.textContent = data.stats.averageDurationText;
  summaryMeta.textContent = `${data.date} / ${data.timeZone}`;

  if (!data.rows.length) {
    summaryBody.innerHTML = '<tr><td colspan="8" class="meta-text">这一天还没有打卡记录。</td></tr>';
    return;
  }
  summaryBody.innerHTML = data.rows
    .map((row) => {
      const riskClass = row.riskNotes ? "warn" : row.checkinCount > 1 ? "ok" : "";
      const riskText = row.riskNotes || (row.checkinCount > 1 ? "正常" : "单次记录");
      return `
        <tr>
          <td>${escapeHtml(row.name)}</td>
          <td>${escapeHtml(row.team)}</td>
          <td>${escapeHtml(row.firstTime)}</td>
          <td>${escapeHtml(row.lastTime)}</td>
          <td><strong>${escapeHtml(row.durationText)}</strong></td>
          <td>${row.checkinCount}</td>
          <td>${row.deviceCount}<br><span class="meta-text">${escapeHtml(row.devices)}</span></td>
          <td><span class="tag ${riskClass}">${escapeHtml(riskText)}</span></td>
        </tr>
      `;
    })
    .join("");
}

function renderLogs(data) {
  if (!data.logs.length) {
    logsBody.innerHTML = '<tr><td colspan="7" class="meta-text">暂无日志。</td></tr>';
    return;
  }
  logsBody.innerHTML = data.logs
    .map((item) => {
      return `
        <tr>
          <td>${escapeHtml(item.localDate)} ${escapeHtml(item.localTime)}</td>
          <td>${escapeHtml(item.name)}</td>
          <td>${escapeHtml(item.team)}</td>
          <td>${escapeHtml(item.deviceId.slice(-8))}</td>
          <td>${locationCell(item.location)}</td>
          <td>${escapeHtml(item.ip)}</td>
          <td><span class="tag ${item.risk ? "warn" : "ok"}">${escapeHtml(item.risk || "正常")}</span></td>
        </tr>
      `;
    })
    .join("");
}

function locationPoint(item) {
  const location = item.location || {};
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    ...item,
    latitude,
    longitude,
    accuracy: Number(location.accuracy) || 0
  };
}

function cssToken(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function prepareCanvas() {
  const rect = locationMap.getBoundingClientRect();
  const width = Math.max(780, Math.round(rect.width || 1100));
  const height = Math.max(520, Math.round(rect.height || 620));
  const ratio = window.devicePixelRatio || 1;
  const scaledWidth = Math.round(width * ratio);
  const scaledHeight = Math.round(height * ratio);
  if (locationMap.width !== scaledWidth || locationMap.height !== scaledHeight) {
    locationMap.width = scaledWidth;
    locationMap.height = scaledHeight;
  }
  const context = locationMap.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

function polygonRings(area) {
  return Array.isArray(area?.coordinates) ? area.coordinates : [];
}

function pointInRing(point, ring) {
  const [lon, lat] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, area) {
  const rings = polygonRings(area);
  if (!rings.length || !pointInRing(point, rings[0])) return false;
  return !rings.slice(1).some((ring) => pointInRing(point, ring));
}

function pushAreaCoordinates(target, area) {
  for (const ring of polygonRings(area)) {
    for (const coordinate of ring) target.push(coordinate);
  }
}

function geofenceBounds(geofence) {
  const coordinates = [];
  for (const area of geofence?.allowedAreas || []) pushAreaCoordinates(coordinates, area);
  for (const area of geofence?.excludedAreas || []) pushAreaCoordinates(coordinates, area);
  for (const building of geofence?.candidateExcludedBuildings || []) {
    const bounds = building.bounds;
    if (!bounds) continue;
    coordinates.push([bounds.minLon, bounds.minLat], [bounds.maxLon, bounds.maxLat]);
  }
  if (!coordinates.length) return null;
  return {
    minLon: Math.min(...coordinates.map((coordinate) => coordinate[0])),
    maxLon: Math.max(...coordinates.map((coordinate) => coordinate[0])),
    minLat: Math.min(...coordinates.map((coordinate) => coordinate[1])),
    maxLat: Math.max(...coordinates.map((coordinate) => coordinate[1]))
  };
}

function buildCampusProjection(geofence, width, height) {
  const bounds = geofenceBounds(geofence);
  if (!bounds) return null;
  const pad = { left: 52, right: 40, top: 42, bottom: 54 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  const lonFactor = Math.cos((centerLat * Math.PI) / 180);
  let minX = bounds.minLon * lonFactor;
  let maxX = bounds.maxLon * lonFactor;
  let minY = bounds.minLat;
  let maxY = bounds.maxLat;
  const targetAspect = plotWidth / plotHeight;
  const currentAspect = (maxX - minX) / (maxY - minY);

  if (currentAspect > targetAspect) {
    const wantedHeight = (maxX - minX) / targetAspect;
    const extra = (wantedHeight - (maxY - minY)) / 2;
    minY -= extra;
    maxY += extra;
  } else {
    const wantedWidth = (maxY - minY) * targetAspect;
    const extra = (wantedWidth - (maxX - minX)) / 2;
    minX -= extra;
    maxX += extra;
  }

  const project = (lon, lat) => {
    const x = lon * lonFactor;
    const y = lat;
    return {
      x: pad.left + ((x - minX) / (maxX - minX)) * plotWidth,
      y: pad.top + ((maxY - y) / (maxY - minY)) * plotHeight
    };
  };

  return {
    pad,
    plotWidth,
    plotHeight,
    minX,
    maxX,
    minY,
    maxY,
    centerLat,
    pxPerMeter: Math.min(plotWidth / ((maxX - minX) * 111320), plotHeight / ((maxY - minY) * 110540)),
    project
  };
}

function traceArea(context, area, projection) {
  for (const ring of polygonRings(area)) {
    ring.forEach(([lon, lat], index) => {
      const point = projection.project(lon, lat);
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.closePath();
  }
}

function drawArea(context, area, projection, fillStyle, strokeStyle, lineWidth = 2) {
  context.beginPath();
  traceArea(context, area, projection);
  context.fillStyle = fillStyle;
  context.fill("evenodd");
  context.strokeStyle = strokeStyle;
  context.lineWidth = lineWidth;
  context.stroke();
}

function areaCenter(area, projection) {
  const ring = polygonRings(area)[0] || [];
  if (!ring.length) return null;
  const projected = ring.map(([lon, lat]) => projection.project(lon, lat));
  return {
    x: projected.reduce((sum, point) => sum + point.x, 0) / projected.length,
    y: projected.reduce((sum, point) => sum + point.y, 0) / projected.length
  };
}

function areaTopLabelPoint(area, projection) {
  const ring = polygonRings(area)[0] || [];
  if (!ring.length) return null;
  const projected = ring.map(([lon, lat]) => projection.project(lon, lat));
  return {
    x: projected.reduce((sum, point) => sum + point.x, 0) / projected.length,
    y: Math.min(...projected.map((point) => point.y)) + 28
  };
}

function drawLabel(context, text, x, y, options = {}) {
  if (!text) return;
  const color = options.color || "#10201b";
  const background = options.background || "rgba(255,255,255,0.88)";
  const border = options.border || "rgba(21,116,95,0.35)";
  context.font = options.font || "800 13px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  const paddingX = options.paddingX || 10;
  const paddingY = options.paddingY || 6;
  const width = context.measureText(text).width + paddingX * 2;
  const height = 26 + paddingY;
  const radius = 6;
  const left = x - width / 2;
  const top = y - height / 2;
  context.beginPath();
  context.roundRect(left, top, width, height, radius);
  context.fillStyle = background;
  context.fill();
  context.strokeStyle = border;
  context.lineWidth = 1;
  context.stroke();
  context.fillStyle = color;
  context.fillText(text, x, y + 1);
}

function drawMapGrid(context, projection, width, height) {
  const surface = cssToken("--bg-soft", "#f7faf8");
  context.clearRect(0, 0, width, height);
  context.fillStyle = surface;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(113, 139, 129, 0.2)";
  context.lineWidth = 1;

  const left = projection.pad.left;
  const right = width - projection.pad.right;
  const top = projection.pad.top;
  const bottom = height - projection.pad.bottom;
  for (let i = 0; i <= 10; i += 1) {
    const x = left + (i / 10) * projection.plotWidth;
    context.beginPath();
    context.moveTo(x, top);
    context.lineTo(x, bottom);
    context.stroke();
  }
  for (let i = 0; i <= 8; i += 1) {
    const y = top + (i / 8) * projection.plotHeight;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();
  }
}

function drawBuildingBounds(context, building, projection) {
  const bounds = building.bounds;
  if (!bounds) return;
  const topLeft = projection.project(bounds.minLon, bounds.maxLat);
  const bottomRight = projection.project(bounds.maxLon, bounds.minLat);
  context.strokeStyle = "rgba(78, 24, 24, 0.58)";
  context.fillStyle = "rgba(78, 24, 24, 0.05)";
  context.lineWidth = 1;
  context.beginPath();
  context.rect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  context.fill();
  context.stroke();
}

function drawNorthArrow(context, width) {
  const x = width - 64;
  const y = 42;
  context.fillStyle = cssToken("--ink", "#10201b");
  context.beginPath();
  context.moveTo(x, y - 24);
  context.lineTo(x + 10, y + 16);
  context.lineTo(x, y + 8);
  context.lineTo(x - 10, y + 16);
  context.closePath();
  context.fill();
  context.font = "800 13px system-ui, sans-serif";
  context.textAlign = "center";
  context.fillText("北", x, y + 40);
}

function drawScaleBar(context, projection, height) {
  const meters = 200;
  const length = Math.max(80, meters * projection.pxPerMeter);
  const x = projection.pad.left + 16;
  const y = height - 34;
  context.strokeStyle = cssToken("--ink", "#10201b");
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x + length, y);
  context.moveTo(x, y - 8);
  context.lineTo(x, y + 8);
  context.moveTo(x + length, y - 8);
  context.lineTo(x + length, y + 8);
  context.stroke();
  context.font = "700 12px system-ui, sans-serif";
  context.textAlign = "center";
  context.fillStyle = cssToken("--ink", "#10201b");
  context.fillText(`${meters}m`, x + length / 2, y - 14);
}

function pointCampusStatus(point, geofence) {
  const coordinate = [point.longitude, point.latitude];
  const allowedArea = (geofence?.allowedAreas || []).find((area) => pointInPolygon(coordinate, area));
  const excludedArea = (geofence?.excludedAreas || []).find((area) => pointInPolygon(coordinate, area));
  return {
    insideCampus: Boolean(allowedArea),
    allowedArea: allowedArea?.name || "",
    excludedArea: excludedArea?.name || ""
  };
}

function pointStatus(point) {
  if (!point.mapStatus?.insideCampus) return { className: "offsite", label: "校外未上图" };
  if (point.mapStatus.excludedArea) return { className: "excluded", label: "排除区复核" };
  if (point.accuracy > 150 || point.risk) return { className: "warn", label: "低精度复核" };
  return { className: "ok", label: "校内上图" };
}

function drawEmptyMap(message) {
  const { context, width, height } = prepareCanvas();
  const surface = cssToken("--bg-soft", "#f7faf8");
  const muted = cssToken("--muted", "#61706a");
  context.clearRect(0, 0, width, height);
  context.fillStyle = surface;
  context.fillRect(0, 0, width, height);
  context.fillStyle = muted;
  context.font = "600 16px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(message, width / 2, height / 2);
}

function renderLocationMap(logs) {
  const geofence = currentGeofence;
  const points = logs
    .map(locationPoint)
    .filter(Boolean)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .map((point) => ({
      ...point,
      mapStatus: pointCampusStatus(point, geofence)
    }));

  const campusPoints = points.filter((point) => point.mapStatus.insideCampus);
  const offCampusPoints = points.filter((point) => !point.mapStatus.insideCampus);
  mapMeta.textContent = `${campusPoints.length} 个校内点上图 / ${offCampusPoints.length} 个校外点除外 / ${logs.length} 条日志`;

  if (!geofence) {
    drawEmptyMap("校区范围数据未加载");
    mapPointList.innerHTML = '<p class="empty">校区范围数据未加载。</p>';
    return;
  }

  const { context, width, height } = prepareCanvas();
  const projection = buildCampusProjection(geofence, width, height);
  if (!projection) {
    drawEmptyMap("校区范围数据为空");
    mapPointList.innerHTML = '<p class="empty">校区范围数据为空。</p>';
    return;
  }

  drawMapGrid(context, projection, width, height);

  for (const area of geofence.allowedAreas || []) {
    drawArea(context, area, projection, "rgba(21, 116, 95, 0.18)", "rgba(10, 107, 79, 0.98)", 2.5);
    const center = areaTopLabelPoint(area, projection);
    if (center) drawLabel(context, area.name, center.x, Math.max(32, center.y), { color: "#0f5949", background: "rgba(247, 250, 248, 0.7)", border: "transparent", font: "900 18px system-ui, sans-serif" });
  }

  for (const building of geofence.candidateExcludedBuildings || []) {
    drawBuildingBounds(context, building, projection);
  }

  for (const area of geofence.excludedAreas || []) {
    drawArea(context, area, projection, "rgba(232, 56, 61, 0.24)", "rgba(203, 23, 34, 0.95)", 2);
    const center = areaCenter(area, projection);
    if (center) drawLabel(context, area.name, center.x, center.y, { color: "#9b1118", background: "rgba(255, 255, 255, 0.94)", border: "rgba(203, 23, 34, 0.78)", font: "800 12px system-ui, sans-serif" });
  }

  if (campusPoints.length > 1) {
    context.beginPath();
    campusPoints.forEach((point, index) => {
      const projected = projection.project(point.longitude, point.latitude);
      if (index === 0) context.moveTo(projected.x, projected.y);
      else context.lineTo(projected.x, projected.y);
    });
    context.strokeStyle = "rgba(21, 116, 95, 0.3)";
    context.lineWidth = 2;
    context.stroke();
  }

  campusPoints.forEach((point, index) => {
    point.mapIndex = index + 1;
    const projected = projection.project(point.longitude, point.latitude);
    const status = pointStatus(point);
    const pointColor = status.className === "excluded" ? "#d92c34" : status.className === "warn" ? "#b47711" : "#15745f";
    const accuracyRadius = point.accuracy > 0 ? Math.min(92, Math.max(9, point.accuracy * projection.pxPerMeter)) : 0;

    if (accuracyRadius) {
      context.beginPath();
      context.arc(projected.x, projected.y, accuracyRadius, 0, Math.PI * 2);
      context.fillStyle = status.className === "ok" ? "rgba(21, 116, 95, 0.09)" : "rgba(217, 44, 52, 0.1)";
      context.fill();
      context.strokeStyle = status.className === "ok" ? "rgba(21, 116, 95, 0.22)" : "rgba(217, 44, 52, 0.28)";
      context.lineWidth = 1;
      context.stroke();
    }

    context.beginPath();
    context.arc(projected.x, projected.y, index === campusPoints.length - 1 ? 8 : 6, 0, Math.PI * 2);
    context.fillStyle = pointColor;
    context.fill();
    context.lineWidth = 3;
    context.strokeStyle = "#ffffff";
    context.stroke();
    context.fillStyle = "#ffffff";
    context.font = "800 10px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(index + 1), projected.x, projected.y + 0.5);

    if (index === campusPoints.length - 1) {
      drawLabel(context, `${point.localTime} 最新`, projected.x + 42, projected.y - 18, { color: "#10201b", background: "rgba(255, 255, 255, 0.9)", border: "rgba(21, 116, 95, 0.35)", font: "800 12px system-ui, sans-serif" });
    }
  });

  drawNorthArrow(context, width);
  drawScaleBar(context, projection, height);

  const legendHtml = `
    <div class="map-legend-panel">
      <strong>图例</strong>
      <span><i class="legend-swatch campus"></i>校内可签到区域</span>
      <span><i class="legend-swatch blocked"></i>不可签到排除区</span>
      <span><i class="legend-swatch building"></i>候选宿舍楼框</span>
      <span><i class="legend-swatch point"></i>校内签到点</span>
    </div>
  `;

  const pointCards = points.length
    ? points
        .slice()
        .reverse()
        .slice(0, 36)
        .map((point) => {
          const status = pointStatus(point);
          const mapUrl = `https://www.openstreetmap.org/?mlat=${point.latitude}&mlon=${point.longitude}#map=18/${point.latitude}/${point.longitude}`;
          const mapIndex = point.mapIndex ? `图上 #${point.mapIndex}` : "未上图";
          const areaText = point.mapStatus.excludedArea || point.mapStatus.allowedArea || "校区外";
          return `
            <article class="map-point-item ${status.className}">
              <div class="point-row">
                <strong>${escapeHtml(point.localDate)} ${escapeHtml(point.localTime)}</strong>
                <span class="point-badge ${status.className}">${status.label}</span>
              </div>
              <span>${escapeHtml(point.team)} / ${escapeHtml(point.name)} · ${escapeHtml(mapIndex)}</span>
              <span>${escapeHtml(areaText)}</span>
              <span>${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)} / 约 ${Math.round(point.accuracy)}m</span>
              <a href="${mapUrl}" target="_blank" rel="noreferrer">打开地图</a>
            </article>
          `;
        })
        .join("")
    : '<p class="empty">暂无定位点。</p>';

  mapPointList.innerHTML = `${legendHtml}${pointCards}`;
}

async function refresh() {
  const date = selectedDate();
  await Promise.all([loadPeople(date), loadGeofence()]);
  const query = buildAdminQuery({ date });
  const summaryUrl = `/api/admin/summary?${query}`;
  const logsUrl = `/api/admin/logs?${query}&limit=5000`;
  const [summary, logs] = await Promise.all([fetchJson(summaryUrl), fetchJson(logsUrl)]);
  currentLogs = logs.logs || [];
  renderSummary(summary);
  renderLogs(logs);
  renderLocationMap(currentLogs);
}

function download(url) {
  window.location.href = withPassword(url);
}

async function login(value) {
  await validatePassword(value);
  savePassword(value);
  showApp();
  await refresh();
}

function init() {
  dateInput.value = todayLocal();
  const cachedPassword = localStorage.getItem(adminPasswordKey) || "";
  adminPasswordInput.value = cachedPassword;

  adminLoginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = adminPasswordInput.value.trim();
    if (!value) {
      showLogin("请输入后台访问密码。");
      return;
    }
    login(value).catch((error) => {
      clearPassword();
      showLogin(error.message || "后台访问密码不正确。");
    });
  });

  adminLogoutButton.addEventListener("click", () => {
    clearPassword();
    adminPasswordInput.value = "";
    showLogin("已退出后台。");
  });

  refreshButton.addEventListener("click", () => {
    refresh().catch((error) => {
      summaryBody.innerHTML = `<tr><td colspan="8" class="meta-text">${escapeHtml(error.message)}</td></tr>`;
      drawEmptyMap("数据加载失败");
    });
  });

  dateInput.addEventListener("change", () => {
    refresh().catch((error) => {
      summaryBody.innerHTML = `<tr><td colspan="8" class="meta-text">${escapeHtml(error.message)}</td></tr>`;
      drawEmptyMap("数据加载失败");
    });
  });

  personSelect.addEventListener("change", () => {
    refresh().catch((error) => {
      summaryBody.innerHTML = `<tr><td colspan="8" class="meta-text">${escapeHtml(error.message)}</td></tr>`;
      drawEmptyMap("数据加载失败");
    });
  });

  exportSummaryButton.addEventListener("click", () => {
    download(`/api/admin/export/summary.csv?${buildAdminQuery()}`);
  });
  exportLogsButton.addEventListener("click", () => {
    download(`/api/admin/export/logs.csv?${buildAdminQuery()}`);
  });

  window.addEventListener("resize", () => {
    renderLocationMap(currentLogs);
  });

  if (cachedPassword) {
    login(cachedPassword).catch(() => {
      clearPassword();
      adminPasswordInput.value = "";
      showLogin("登录已失效，请重新输入访问密码。");
    });
  } else {
    showLogin();
  }
}

init();
