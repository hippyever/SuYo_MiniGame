const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const STORE_FILE = path.resolve(process.env.CHECKIN_DATA_FILE || path.join(ROOT, "data", "checkins.json"));
const GEOFENCE_FILE = path.resolve(process.env.CHECKIN_GEOFENCE_FILE || path.join(ROOT, "data", "geofence-hbut.json"));
const DATA_DIR = path.dirname(STORE_FILE);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const TZ = process.env.CHECKIN_TZ || "Asia/Shanghai";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN || "114514";
const ADMIN_HOSTS = (process.env.ADMIN_HOSTS || process.env.ADMIN_HOST || `admin.localhost:${PORT}`)
  .split(",")
  .map(normalizeHost)
  .filter(Boolean);
const ADMIN_ROOT_ON_ADMIN_HOST = process.env.ADMIN_ROOT_ON_ADMIN_HOST !== "false";
const CHECKIN_COOLDOWN_MS = Number(process.env.CHECKIN_COOLDOWN_MS || 15000);
const METERS_PER_DEGREE_LAT = 110540;
let geofenceCache = null;
let geofenceLoadPromise = null;

const staticTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function createEmptyStore() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    checkins: [],
    devices: {},
    fingerprints: {}
  };
}

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const text = await fs.readFile(STORE_FILE, "utf8");
    const store = JSON.parse(text);
    store.checkins ||= [];
    store.devices ||= {};
    store.fingerprints ||= {};
    return store;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const store = createEmptyStore();
    await writeStore(store);
    return store;
  }
}

async function writeStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await fs.rename(tmp, STORE_FILE);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(payload);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { ok: false, error: "NOT_FOUND", message: "没有找到这个地址。" });
}

function methodNotAllowed(res) {
  json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", message: "请求方法不支持。" });
}

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function localParts(date = new Date()) {
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const timeParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);

  const pick = (parts, type) => parts.find((part) => part.type === type)?.value || "";
  const localDate = `${pick(dateParts, "year")}-${pick(dateParts, "month")}-${pick(dateParts, "day")}`;
  const localTime = `${pick(timeParts, "hour")}:${pick(timeParts, "minute")}:${pick(timeParts, "second")}`;
  return { localDate, localTime, timeZone: TZ };
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function personKey(name, team) {
  return `${normalizeText(team)}::${normalizeText(name)}`;
}

function cleanText(value, maxLength) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function isValidDeviceId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{16,160}$/.test(value);
}

function isValidFingerprint(value) {
  return typeof value === "string" && /^[a-f0-9]{32,128}$/.test(value);
}

function normalizeLocation(location) {
  if (!location || typeof location !== "object") return null;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  const accuracy = Number(location.accuracy);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return {
    latitude,
    longitude,
    accuracy: Number.isFinite(accuracy) ? Math.max(0, Math.round(accuracy)) : null
  };
}

async function loadGeofence() {
  if (geofenceCache !== null) return geofenceCache;
  if (!geofenceLoadPromise) {
    geofenceLoadPromise = fs
      .readFile(GEOFENCE_FILE, "utf8")
      .then((text) => JSON.parse(text))
      .catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
  }
  geofenceCache = await geofenceLoadPromise;
  return geofenceCache;
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

function lonMetersPerDegree(latitude) {
  return 111320 * Math.cos((latitude * Math.PI) / 180);
}

function projectToMeters(point, originLat) {
  const [lon, lat] = point;
  return {
    x: lon * lonMetersPerDegree(originLat),
    y: lat * METERS_PER_DEGREE_LAT
  };
}

function distancePointToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  const x = start.x + t * dx;
  const y = start.y + t * dy;
  return Math.hypot(point.x - x, point.y - y);
}

function distanceToPolygonBoundaryMeters(point, area) {
  const originLat = point[1];
  const projectedPoint = projectToMeters(point, originLat);
  let minDistance = Infinity;
  for (const ring of polygonRings(area)) {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const start = projectToMeters(ring[i], originLat);
      const end = projectToMeters(ring[i + 1], originLat);
      minDistance = Math.min(minDistance, distancePointToSegment(projectedPoint, start, end));
    }
  }
  return Number.isFinite(minDistance) ? Math.round(minDistance) : null;
}

async function evaluateGeofence(location) {
  const geofence = await loadGeofence();
  const result = {
    enabled: Boolean(geofence),
    insideAllowedArea: false,
    allowedArea: "",
    excludedArea: "",
    confirmedExcludedArea: false,
    distanceToExcludedBoundaryMeters: null,
    block: false,
    riskNotes: []
  };

  if (!geofence) {
    result.riskNotes.push("地理围栏数据未加载");
    return result;
  }

  const point = [location.longitude, location.latitude];
  const accuracy = Number.isFinite(location.accuracy) ? location.accuracy : Infinity;
  const allowedArea = (geofence.allowedAreas || []).find((area) => pointInPolygon(point, area));
  result.insideAllowedArea = Boolean(allowedArea);
  result.allowedArea = allowedArea?.name || "";

  if (!allowedArea) {
    result.riskNotes.push("位置不在湖北工业大学校区边界内，后台复核");
  }

  const excludedHits = (geofence.excludedAreas || [])
    .filter((area) => pointInPolygon(point, area))
    .map((area) => ({
      area,
      distanceToBoundaryMeters: distanceToPolygonBoundaryMeters(point, area)
    }))
    .sort((a, b) => (b.distanceToBoundaryMeters || 0) - (a.distanceToBoundaryMeters || 0));

  if (!excludedHits.length) {
    const policy = geofence.recommendedAccuracyPolicy || {};
    const reviewLimit = Number(policy.reviewWhenAccuracyMetersAtMost || 150);
    if (Number.isFinite(accuracy) && accuracy > reviewLimit) {
      result.riskNotes.push(`定位精度约 ${accuracy}m，宿舍/校区边界判断需复核`);
    }
    return result;
  }

  const hit = excludedHits[0];
  const distanceToBoundary = hit.distanceToBoundaryMeters || 0;
  result.excludedArea = hit.area.name || hit.area.id || "宿舍排除区";
  result.distanceToExcludedBoundaryMeters = distanceToBoundary;
  result.confirmedExcludedArea = Number.isFinite(accuracy) && accuracy <= distanceToBoundary;

  if (result.confirmedExcludedArea) {
    result.block = true;
    result.riskNotes.push(`确认位于宿舍排除区：${result.excludedArea}`);
  } else {
    const accuracyText = Number.isFinite(accuracy) ? `${accuracy}m` : "未知";
    result.riskNotes.push(`疑似位于宿舍排除区：${result.excludedArea}，定位精度约 ${accuracyText}，未禁止`);
  }

  return result;
}

function buildRisk(location, geofenceResult) {
  const notes = [];
  if (location.accuracy && location.accuracy > 500) notes.push("定位精度较低");
  notes.push(...(geofenceResult?.riskNotes || []));
  return [...new Set(notes)].join("；");
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      const error = new Error("请求体过大。");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求体不是合法 JSON。");
    error.status = 400;
    throw error;
  }
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "";
}

function normalizeHost(host) {
  return String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

function hostWithoutPort(host) {
  return normalizeHost(host).replace(/:\d+$/, "");
}

function requestHost(req) {
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost || req.headers.host || "";
  return normalizeHost(String(host).split(",")[0]);
}

function hostMatches(host, allowedHost) {
  return host === allowedHost || hostWithoutPort(host) === allowedHost || host === hostWithoutPort(allowedHost);
}

function isAdminHost(req) {
  const host = requestHost(req);
  return ADMIN_HOSTS.some((allowedHost) => hostMatches(host, allowedHost));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, url) {
  if (!isAdminHost(req)) return false;
  const headerPassword = req.headers["x-admin-password"] || req.headers["x-admin-token"];
  const queryPassword = url.searchParams.get("password") || url.searchParams.get("token");
  return safeEqual(headerPassword, ADMIN_PASSWORD) || safeEqual(queryPassword, ADMIN_PASSWORD);
}

function compactPublicCheckin(record) {
  return {
    id: record.id,
    name: record.name,
    team: record.team,
    localDate: record.localDate,
    localTime: record.localTime,
    createdAt: record.createdAt,
    deviceTail: record.deviceId.slice(-8),
    location: record.location
  };
}

function recordPersonKey(record) {
  return record.personKey || personKey(record.name, record.team);
}

function buildSummary(checkins, date) {
  const groups = new Map();
  for (const item of checkins) {
    if (date && item.localDate !== date) continue;
    const key = recordPersonKey(item);
    if (!groups.has(key)) {
      groups.set(key, {
        personKey: key,
        name: item.name,
        team: item.team,
        date: item.localDate,
        first: item,
        last: item,
        count: 0,
        devices: new Set(),
        riskNotes: new Set()
      });
    }
    const group = groups.get(key);
    group.count += 1;
    group.devices.add(item.deviceId);
    if (item.risk) group.riskNotes.add(item.risk);
    if (item.timestamp < group.first.timestamp) group.first = item;
    if (item.timestamp > group.last.timestamp) group.last = item;
  }

  return [...groups.values()]
    .map((group) => {
      const durationMs = Math.max(0, group.last.timestamp - group.first.timestamp);
      return {
        personKey: group.personKey,
        name: group.name,
        team: group.team,
        date: group.date,
        firstTime: group.first.localTime,
        lastTime: group.last.localTime,
        firstAt: group.first.createdAt,
        lastAt: group.last.createdAt,
        durationMs,
        durationText: formatDuration(durationMs),
        checkinCount: group.count,
        deviceCount: group.devices.size,
        devices: [...group.devices].map((id) => id.slice(-8)).join(", "),
        firstLocation: group.first.location,
        lastLocation: group.last.location,
        riskNotes: [...group.riskNotes].join("；")
      };
    })
    .sort((a, b) => {
      const teamCompare = a.team.localeCompare(b.team, "zh-Hans-CN");
      if (teamCompare) return teamCompare;
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });
}

function adminFilteredCheckins(checkins, url, options = {}) {
  const date = options.date ?? url.searchParams.get("date") ?? "";
  const selectedPersonKey = cleanText(url.searchParams.get("personKey"), 160);
  return checkins.filter((item) => {
    if (date && item.localDate !== date) return false;
    if (selectedPersonKey && recordPersonKey(item) !== selectedPersonKey) return false;
    return true;
  });
}

function buildPeople(checkins, date) {
  const people = new Map();
  for (const item of checkins) {
    if (date && item.localDate !== date) continue;
    const key = recordPersonKey(item);
    if (!people.has(key)) {
      people.set(key, {
        personKey: key,
        name: item.name,
        team: item.team,
        count: 0,
        firstAt: item.createdAt,
        lastAt: item.createdAt
      });
    }
    const person = people.get(key);
    person.count += 1;
    if (item.createdAt < person.firstAt) person.firstAt = item.createdAt;
    if (item.createdAt > person.lastAt) person.lastAt = item.createdAt;
  }
  return [...people.values()].sort((a, b) => {
    const teamCompare = a.team.localeCompare(b.team, "zh-Hans-CN");
    if (teamCompare) return teamCompare;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
}

function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes} 分钟`;
  return `${hours} 小时 ${minutes} 分钟`;
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const textValue = String(value);
  if (/[",\r\n]/.test(textValue)) return `"${textValue.replace(/"/g, '""')}"`;
  return textValue;
}

function csv(rows) {
  return `\uFEFF${rows.map((row) => row.map(csvValue).join(",")).join("\r\n")}\r\n`;
}

function locationText(location) {
  if (!location) return "";
  const accuracy = location.accuracy === null ? "" : ` ±${location.accuracy}m`;
  return `${location.latitude},${location.longitude}${accuracy}`;
}

async function handleCreateCheckin(req, res) {
  const body = await readBody(req);
  const name = cleanText(body.name, 40);
  const team = cleanText(body.team, 40);
  const deviceId = cleanText(body.deviceId, 180);
  const fingerprint = cleanText(body.fingerprint, 140);
  const location = normalizeLocation(body.location);

  if (!name || !team) {
    return json(res, 400, { ok: false, error: "PROFILE_REQUIRED", message: "请填写姓名和队伍。" });
  }
  if (!isValidDeviceId(deviceId)) {
    return json(res, 400, { ok: false, error: "DEVICE_REQUIRED", message: "设备码无效，请刷新页面后重试。" });
  }
  if (!location) {
    return json(res, 400, { ok: false, error: "LOCATION_REQUIRED", message: "需要获取定位后才能打卡。" });
  }

  const geofenceResult = await evaluateGeofence(location);
  if (geofenceResult.block) {
    return json(res, 403, {
      ok: false,
      error: "DORMITORY_AREA_BLOCKED",
      message: `定位确认在${geofenceResult.excludedArea}，宿舍区内不能签到。`,
      geofence: geofenceResult
    });
  }

  const store = await ensureStore();
  const key = personKey(name, team);
  const now = new Date();
  const { localDate, localTime, timeZone } = localParts(now);
  const deviceBinding = store.devices[deviceId];

  if (deviceBinding && deviceBinding.personKey !== key) {
    return json(res, 409, {
      ok: false,
      error: "DEVICE_BOUND",
      message: `这台设备已经绑定给 ${deviceBinding.team} / ${deviceBinding.name}，不能为其他人打卡。`
    });
  }

  if (fingerprint && isValidFingerprint(fingerprint)) {
    const fingerprintBinding = store.fingerprints[fingerprint];
    if (fingerprintBinding && fingerprintBinding.personKey !== key) {
      return json(res, 409, {
        ok: false,
        error: "FINGERPRINT_BOUND",
        message: `当前浏览器环境已绑定给 ${fingerprintBinding.team} / ${fingerprintBinding.name}，不能为其他人打卡。`
      });
    }
  }

  const previousForDevice = [...store.checkins]
    .reverse()
    .find((item) => item.deviceId === deviceId);
  if (previousForDevice && now.getTime() - previousForDevice.timestamp < CHECKIN_COOLDOWN_MS) {
    return json(res, 429, {
      ok: false,
      error: "TOO_FAST",
      message: "刚刚已经打过卡了，请稍等几秒再试。"
    });
  }

  store.devices[deviceId] ||= {
    deviceId,
    personKey: key,
    name,
    team,
    firstSeenAt: now.toISOString()
  };
  store.devices[deviceId].lastSeenAt = now.toISOString();

  if (fingerprint && isValidFingerprint(fingerprint)) {
    store.fingerprints[fingerprint] ||= {
      fingerprint,
      personKey: key,
      name,
      team,
      firstSeenAt: now.toISOString()
    };
    store.fingerprints[fingerprint].lastSeenAt = now.toISOString();
  }

  const record = {
    id: randomId(),
    name,
    team,
    personKey: key,
    deviceId,
    fingerprint: isValidFingerprint(fingerprint) ? fingerprint : "",
    createdAt: now.toISOString(),
    timestamp: now.getTime(),
    localDate,
    localTime,
    timeZone,
    clientTime: cleanText(body.clientTime, 80),
    location,
    ip: clientIp(req),
    userAgent: cleanText(req.headers["user-agent"], 400),
    deviceMeta: typeof body.deviceMeta === "object" && body.deviceMeta ? body.deviceMeta : {},
    geofence: geofenceResult,
    risk: buildRisk(location, geofenceResult)
  };

  store.checkins.push(record);
  await writeStore(store);

  return json(res, 201, {
    ok: true,
    checkin: compactPublicCheckin(record),
    message: "打卡成功"
  });
}

async function handleAdminLogs(req, res, url) {
  if (!requireAdmin(req, url)) {
    return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台访问密码。" });
  }
  const store = await ensureStore();
  const date = url.searchParams.get("date") || "";
  const personKeyFilter = cleanText(url.searchParams.get("personKey"), 160);
  const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get("limit") || 500)));
  const filtered = adminFilteredCheckins(store.checkins, url, { date });
  const logs = filtered
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
  json(res, 200, {
    ok: true,
    logs,
    total: store.checkins.length,
    filteredTotal: filtered.length,
    date,
    personKey: personKeyFilter,
    hasAdminToken: true
  });
}

async function handleAdminPeople(req, res, url) {
  if (!requireAdmin(req, url)) {
    return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台访问密码。" });
  }
  const store = await ensureStore();
  const date = url.searchParams.get("date") || "";
  return json(res, 200, {
    ok: true,
    date,
    people: buildPeople(store.checkins, date)
  });
}

async function handleAdminGeofence(req, res, url) {
  if (!requireAdmin(req, url)) {
    return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台访问密码。" });
  }
  const geofence = await loadGeofence();
  return json(res, 200, {
    ok: true,
    geofence
  });
}

async function handleAdminSession(req, res, url) {
  const body = req.method === "POST" ? await readBody(req) : {};
  const bodyPassword = cleanText(body.password, 120);
  const authorized = safeEqual(bodyPassword, ADMIN_PASSWORD) || requireAdmin(req, url);
  if (!authorized) {
    return json(res, 401, {
      ok: false,
      error: "ADMIN_PASSWORD_REQUIRED",
      message: "后台访问密码不正确。"
    });
  }
  return json(res, 200, {
    ok: true,
    adminHost: ADMIN_HOSTS[0] || `admin.localhost:${PORT}`
  });
}

async function handleAdminSummary(req, res, url) {
  if (!requireAdmin(req, url)) {
    return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台访问密码。" });
  }
  const store = await ensureStore();
  const requestedDate = url.searchParams.get("date") || localParts().localDate;
  const personKeyFilter = cleanText(url.searchParams.get("personKey"), 160);
  const filtered = adminFilteredCheckins(store.checkins, url, { date: requestedDate });
  const rows = buildSummary(filtered, requestedDate);
  const logsForDate = filtered;
  const totalDuration = rows.reduce((sum, row) => sum + row.durationMs, 0);
  const lowAccuracyCount = logsForDate.filter((item) => item.location?.accuracy > 500).length;

  json(res, 200, {
    ok: true,
    date: requestedDate,
    personKey: personKeyFilter,
    timeZone: TZ,
    rows,
    stats: {
      people: rows.length,
      logs: logsForDate.length,
      devices: new Set(logsForDate.map((item) => item.deviceId)).size,
      averageDurationText: rows.length ? formatDuration(totalDuration / rows.length) : "0 分钟",
      lowAccuracyCount
    },
    hasAdminToken: true
  });
}

async function handleExportLogs(req, res, url) {
  if (!requireAdmin(req, url)) {
    return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台访问密码。" });
  }
  const store = await ensureStore();
  const date = url.searchParams.get("date") || "";
  const personKeyFilter = cleanText(url.searchParams.get("personKey"), 160);
  const rows = [
    ["日志ID", "姓名", "队伍", "日期", "时间", "服务器时间", "客户端时间", "设备码", "指纹码", "纬度", "经度", "精度(米)", "IP", "浏览器", "风险提示"]
  ];
  for (const item of adminFilteredCheckins(store.checkins, url, { date })) {
    rows.push([
      item.id,
      item.name,
      item.team,
      item.localDate,
      item.localTime,
      item.createdAt,
      item.clientTime,
      item.deviceId,
      item.fingerprint,
      item.location?.latitude,
      item.location?.longitude,
      item.location?.accuracy,
      item.ip,
      item.userAgent,
      item.risk
    ]);
  }
  const personSuffix = personKeyFilter ? "-person" : "";
  const suffix = date ? `-${date}${personSuffix}` : personSuffix;
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="suzao-checkin-logs${suffix}.csv"`,
    "cache-control": "no-store"
  });
  res.end(csv(rows));
}

async function handleExportSummary(req, res, url) {
  if (!requireAdmin(req, url)) {
    return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台访问密码。" });
  }
  const store = await ensureStore();
  const date = url.searchParams.get("date") || localParts().localDate;
  const personKeyFilter = cleanText(url.searchParams.get("personKey"), 160);
  const summary = buildSummary(adminFilteredCheckins(store.checkins, url, { date }), date);
  const rows = [
    ["姓名", "队伍", "日期", "最早打卡", "最晚打卡", "今日出勤时间", "打卡次数", "设备数", "设备尾号", "首次位置", "末次位置", "风险提示"]
  ];
  for (const item of summary) {
    rows.push([
      item.name,
      item.team,
      item.date,
      item.firstTime,
      item.lastTime,
      item.durationText,
      item.checkinCount,
      item.deviceCount,
      item.devices,
      locationText(item.firstLocation),
      locationText(item.lastLocation),
      item.riskNotes
    ]);
  }
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="suzao-daily-summary-${date}${personKeyFilter ? "-person" : ""}.csv"`,
    "cache-control": "no-store"
  });
  res.end(csv(rows));
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  const adminHost = isAdminHost(req);
  if (pathname === "/") pathname = adminHost && ADMIN_ROOT_ON_ADMIN_HOST ? "/admin.html" : "/index.html";
  if (pathname === "/admin" || pathname === "/admin.html") {
    if (!adminHost) {
      return json(res, 404, {
        ok: false,
        error: "ADMIN_HOST_REQUIRED",
        message: `后台只能通过专属域名访问：http://${ADMIN_HOSTS[0] || `admin.localhost:${PORT}`}/`
      });
    }
    pathname = "/admin.html";
  }
  const requestedPath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!requestedPath.startsWith(PUBLIC_DIR)) return notFound(res);

  try {
    const stat = await fs.stat(requestedPath);
    if (!stat.isFile()) return notFound(res);
    const ext = path.extname(requestedPath).toLowerCase();
    const contentType = staticTypes[ext] || "application/octet-stream";
    const body = await fs.readFile(requestedPath);
    const noStore = [".html", ".css", ".js"].includes(ext);
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": noStore ? "no-store" : "public, max-age=300"
    });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") return notFound(res);
    throw error;
  }
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/admin/") && !isAdminHost(req)) {
      return json(res, 404, {
        ok: false,
        error: "ADMIN_HOST_REQUIRED",
        message: `后台接口只能通过专属域名访问：http://${ADMIN_HOSTS[0] || `admin.localhost:${PORT}`}/`
      });
    }
    if (url.pathname === "/api/health") {
      return json(res, 200, { ok: true, time: new Date().toISOString(), local: localParts() });
    }
    if (url.pathname === "/api/checkins") {
      if (req.method !== "POST") return methodNotAllowed(res);
      return handleCreateCheckin(req, res);
    }
    if (url.pathname === "/api/admin/session") {
      if (req.method !== "POST" && req.method !== "GET") return methodNotAllowed(res);
      return handleAdminSession(req, res, url);
    }
    if (url.pathname === "/api/admin/logs") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return handleAdminLogs(req, res, url);
    }
    if (url.pathname === "/api/admin/people") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return handleAdminPeople(req, res, url);
    }
    if (url.pathname === "/api/admin/geofence") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return handleAdminGeofence(req, res, url);
    }
    if (url.pathname === "/api/admin/summary") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return handleAdminSummary(req, res, url);
    }
    if (url.pathname === "/api/admin/export/logs.csv") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return handleExportLogs(req, res, url);
    }
    if (url.pathname === "/api/admin/export/summary.csv") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return handleExportSummary(req, res, url);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res);
    return serveStatic(req, res, url);
  } catch (error) {
    const status = error.status || 500;
    console.error(error);
    return json(res, status, {
      ok: false,
      error: "SERVER_ERROR",
      message: status >= 500 ? "服务器开小差了，请稍后再试。" : error.message
    });
  }
}

ensureStore()
  .then(() => {
    http.createServer(router).listen(PORT, HOST, () => {
      console.log(`溯造 MiniGame 打卡系统已启动：http://${HOST}:${PORT}`);
      console.log(`后台专属域名：http://${ADMIN_HOSTS[0] || `admin.localhost:${PORT}`}/`);
    });
  })
  .catch((error) => {
    console.error("启动失败：", error);
    process.exit(1);
  });
