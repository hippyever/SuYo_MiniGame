const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { URL } = require("url");
const Busboy = require("busboy");
const nodemailer = require("nodemailer");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const STORE_FILE = path.resolve(process.env.MINIGAME_DATA_FILE || path.join(ROOT, "data", "minigame.json"));
const DATA_DIR = path.dirname(STORE_FILE);
const UPLOAD_DIR = path.resolve(process.env.MINIGAME_UPLOAD_DIR || path.join(DATA_DIR, "uploads"));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const TZ = process.env.MINIGAME_TZ || "Asia/Shanghai";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN || "114514";
const ADMIN_HOSTS = (process.env.ADMIN_HOSTS || process.env.ADMIN_HOST || `admin.localhost:${PORT}`)
  .split(",")
  .map(normalizeHost)
  .filter(Boolean);
const ADMIN_ROOT_ON_ADMIN_HOST = process.env.ADMIN_ROOT_ON_ADMIN_HOST !== "false";
const OTP_SECRET = process.env.OTP_SECRET || ADMIN_PASSWORD;
const OTP_TTL_MS = Math.max(2, Number(process.env.OTP_TTL_MINUTES || 10)) * 60 * 1000;
const OTP_RESEND_MS = Math.max(20, Number(process.env.OTP_RESEND_SECONDS || 60)) * 1000;
const OTP_MAX_REQUESTS_PER_HOUR = Math.max(2, Number(process.env.OTP_MAX_REQUESTS_PER_HOUR || 5));
const OTP_MAX_REQUESTS_PER_IP_PER_HOUR = Math.max(5, Number(process.env.OTP_MAX_REQUESTS_PER_IP_PER_HOUR || 20));
const MAX_COVER_BYTES = Math.max(1, Number(process.env.MAX_COVER_MB || 12)) * 1024 * 1024;
const MAX_AVATAR_BYTES = Math.max(1, Number(process.env.MAX_AVATAR_MB || 4)) * 1024 * 1024;
const MAX_VIDEO_BYTES = Math.max(10, Number(process.env.MAX_VIDEO_MB || 300)) * 1024 * 1024;
const SESSION_TTL_MS = Math.max(1, Number(process.env.SESSION_TTL_DAYS || 30)) * 24 * 60 * 60 * 1000;
const ALLOW_DEV_OTP = process.env.ALLOW_DEV_OTP === "true" || (process.env.ALLOW_DEV_OTP !== "false" && process.env.NODE_ENV !== "production");

const staticTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ico": "image/x-icon"
};

let writeQueue = Promise.resolve();
let mailTransport = null;

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function isoAfter(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function seedGames() {
  const createdAt = new Date().toISOString();
  return [
    {
      id: "gravity-seed",
      title: "引力种子",
      team: "远日点小组",
      shortDescription: "在坍缩之前，为一颗荒芜星球种下最后的生态。",
      description: "一款关于重力、生态与选择的微型建造游戏。每一次播种都会改变星体质量，也改变你下一次落脚的方向。",
      creationNote: "我们想验证，生态建造是否能直接改变玩家的移动方式，而不是只改变资源数字。",
      creators: [
        { id: "gravity-linye", name: "林野", role: "策划", avatarUrl: "", order: 0 },
        { id: "gravity-zhouyuan", name: "周原", role: "程序", avatarUrl: "", order: 1 },
        { id: "gravity-lizi", name: "栗子", role: "美术", avatarUrl: "", order: 2 }
      ],
      coverUrl: "https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?auto=format&fit=crop&w=1600&q=88",
      videoUrl: "",
      downloadUrl: "",
      tags: ["建造", "物理解谜"],
      featured: true,
      published: true,
      order: 10,
      isDemo: true,
      createdAt,
      updatedAt: createdAt
    },
    {
      id: "echo-orbit",
      title: "回声轨道",
      team: "无界电台",
      shortDescription: "驾驶一段无线电回声，穿过正在失联的星系。",
      description: "你无法控制飞船，只能改变广播的频率。让声音借行星引力转弯，找到仍在回应你的文明。",
      creationNote: "我们想知道，当玩家只能改变频率而不能控制方向时，声音能不能成为真正的导航方式。",
      creators: [
        { id: "echo-songke", name: "宋可", role: "主创", avatarUrl: "", order: 0 },
        { id: "echo-aluo", name: "阿落", role: "程序", avatarUrl: "", order: 1 },
        { id: "echo-sanyi", name: "叁一", role: "声音", avatarUrl: "", order: 2 }
      ],
      coverUrl: "https://images.unsplash.com/photo-1444703686981-a3abbc4d4fe3?auto=format&fit=crop&w=1600&q=88",
      videoUrl: "",
      downloadUrl: "",
      tags: ["声音", "叙事"],
      featured: false,
      published: true,
      order: 20,
      isDemo: true,
      createdAt,
      updatedAt: createdAt
    },
    {
      id: "moon-shift",
      title: "月面夜班",
      team: "低温办公室",
      shortDescription: "维护月球背面的自动售货机，直到地球再次升起。",
      description: "一场发生在月背的短篇工作模拟。补货、修理、倾听路过宇航员留下的语音便签。",
      creationNote: "我们想把一份普通夜班工作做成短暂而安静的相遇，让重复操作也能留下情绪。",
      creators: [
        { id: "moon-moyi", name: "莫一", role: "制作", avatarUrl: "", order: 0 },
        { id: "moon-jiaotang", name: "焦糖", role: "美术", avatarUrl: "", order: 1 },
        { id: "moon-rin", name: "Rin", role: "音乐", avatarUrl: "", order: 2 }
      ],
      coverUrl: "https://images.unsplash.com/photo-1614728263952-84ea256f9679?auto=format&fit=crop&w=1600&q=88",
      videoUrl: "",
      downloadUrl: "",
      tags: ["模拟", "短篇"],
      featured: false,
      published: true,
      order: 30,
      isDemo: true,
      createdAt,
      updatedAt: createdAt
    }
  ];
}

function creatorId(name, role, index) {
  return crypto.createHash("sha1").update(`${name}:${role}:${index}`).digest("hex").slice(0, 16);
}

function normalizeCreators(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || "")
      .split(/\s*[/|]\s*/)
      .filter(Boolean)
      .map((entry) => {
        const parts = entry.split(/[：:]/);
        return parts.length > 1 ? { role: parts.shift(), name: parts.join(":"), avatarUrl: "" } : { name: entry, role: "", avatarUrl: "" };
      });
  return source.slice(0, 12).map((creator, index) => {
    const name = cleanText(creator?.name, 40);
    const role = cleanText(creator?.role, 40);
    return {
      id: cleanText(creator?.id, 80) || creatorId(name, role, index),
      name,
      role,
      avatarUrl: cleanText(creator?.avatarUrl, 1000),
      order: Number.isFinite(Number(creator?.order)) ? Number(creator.order) : index
    };
  }).filter((creator) => creator.name).sort((a, b) => a.order - b.order);
}

function normalizedPersonName(value) {
  return cleanText(value, 80).normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function hashUnit(value) {
  return Number.parseInt(crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12), 16) / 0xffffffffffff;
}

function coordinateForGame(id, eventSeed, occupied = []) {
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const x = -0.88 + hashUnit(`${eventSeed}:${id}:x:${attempt}`) * 1.76;
    const y = -0.76 + hashUnit(`${eventSeed}:${id}:y:${attempt}`) * 1.52;
    const z = -0.92 + hashUnit(`${eventSeed}:${id}:z:${attempt}`) * 1.84;
    const clear = occupied.every((game) => {
      const point = game.coordinate;
      const pointZ = Number(point?.z ?? (Number(point?.depth ?? 0.5) * 2 - 1));
      return !point || Math.hypot(x - Number(point.x || 0), y - Number(point.y || 0), z - pointZ) >= 0.34;
    });
    if (clear || attempt === 47) return { x: Number(x.toFixed(5)), y: Number(y.toFixed(5)), z: Number(z.toFixed(5)) };
  }
  return { x: 0, y: 0, z: 0 };
}

function ensureGameCoordinates(store) {
  const occupied = [];
  for (const game of store.games) {
    const coordinate = game.coordinate;
    const valid = coordinate && Number.isFinite(Number(coordinate.x)) && Number.isFinite(Number(coordinate.y));
    game.coordinate = valid ? {
      x: Number(coordinate.x),
      y: Number(coordinate.y),
      z: Number.isFinite(Number(coordinate.z)) ? Number(coordinate.z) : Number.isFinite(Number(coordinate.depth)) ? Number(coordinate.depth) * 2 - 1 : 0
    } : coordinateForGame(game.id, store.settings.eventSeed, occupied);
    occupied.push(game);
  }
}

function createEmptyStore() {
  return {
    version: 4,
    createdAt: new Date().toISOString(),
    games: seedGames(),
    ballots: [],
    ballotOperations: {},
    verificationCodes: {},
    sessions: {},
    audit: [],
    settings: {
      eventTitle: "溯造 MiniGame 游戏开发大赛",
      theme: "宇宙",
      slogan: "溯求本源，造物不止",
      eventSeed: crypto.randomBytes(12).toString("hex"),
      startAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      endAt: isoAfter(14),
      resultsPublished: false,
      winnerGameIds: [],
      constellationGameIds: [],
      adjudication: null,
      publishedAt: null
    }
  };
}

function migrateStore(store) {
  const empty = createEmptyStore();
  const defaultDemoById = new Map(empty.games.map((game) => [game.id, game]));
  store.version = 4;
  store.games = (Array.isArray(store.games) ? store.games : empty.games).map((game) => ({
    ...game,
    creationNote: cleanText(game.creationNote, 600) || (game.isDemo ? cleanText(defaultDemoById.get(game.id)?.creationNote, 600) : ""),
    creators: normalizeCreators(game.creators),
    planetSeed: cleanText(game.planetSeed, 80) || crypto.createHash("sha256").update(String(game.id || randomId())).digest("hex").slice(0, 16)
  }));
  store.ballots = Array.isArray(store.ballots) ? store.ballots : [];
  store.ballots.forEach((ballot) => {
    ballot.gameIds = [...new Set(Array.isArray(ballot.gameIds) ? ballot.gameIds : [])].slice(0, 3);
    ballot.version = Math.max(1, Number(ballot.version || 1));
  });
  store.ballotOperations = store.ballotOperations && typeof store.ballotOperations === "object" && !Array.isArray(store.ballotOperations)
    ? store.ballotOperations
    : {};
  const operationCutoff = Date.now() - 45 * 24 * 60 * 60 * 1000;
  for (const [operationId, operation] of Object.entries(store.ballotOperations)) {
    if (!operation?.personKey || Date.parse(operation.createdAt || 0) < operationCutoff) delete store.ballotOperations[operationId];
  }
  store.verificationCodes = store.verificationCodes && typeof store.verificationCodes === "object" ? store.verificationCodes : {};
  store.sessions = store.sessions && typeof store.sessions === "object" ? store.sessions : {};
  store.audit = Array.isArray(store.audit) ? store.audit : [];
  store.settings = { ...empty.settings, ...(store.settings || {}) };
  if (store.settings.eventTitle === "溯造 MiniGame 2026") store.settings.eventTitle = empty.settings.eventTitle;
  if (!store.settings.eventSeed) store.settings.eventSeed = empty.settings.eventSeed;
  if (typeof store.settings.resultsPublished !== "boolean") store.settings.resultsPublished = store.settings.resultsVisibility === "always";
  store.settings.winnerGameIds = Array.isArray(store.settings.winnerGameIds) ? store.settings.winnerGameIds : [];
  store.settings.constellationGameIds = Array.isArray(store.settings.constellationGameIds) ? store.settings.constellationGameIds : [];
  ensureGameCoordinates(store);
  return store;
}

async function ensureStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  try {
    return migrateStore(JSON.parse(await fsp.readFile(STORE_FILE, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const store = createEmptyStore();
    await writeStore(store);
    return store;
  }
}

async function writeStore(store) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await fsp.rename(tempFile, STORE_FILE);
}

function mutateStore(mutator) {
  const operation = writeQueue.then(async () => {
    const store = await ensureStore();
    try {
      const result = await mutator(store);
      await writeStore(store);
      return result;
    } catch (error) {
      await writeStore(store);
      throw error;
    }
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}

function notFound(res) {
  return json(res, 404, { ok: false, error: "NOT_FOUND", message: "没有找到这个地址。" });
}

function methodNotAllowed(res) {
  return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", message: "请求方法不支持。" });
}

async function readJson(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
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

function cleanText(value, maxLength = 200) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function normalizeText(value) {
  return cleanText(value, 200).toLowerCase();
}

function normalizeEmail(value) {
  return cleanText(value, 180).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 180;
}

function personKey(name, team) {
  return `${normalizeText(team)}::${normalizeText(name)}`;
}

function identityKey(name, team, email) {
  return `${personKey(name, team)}::${normalizeEmail(email)}`;
}

function hashCode(email, code) {
  return crypto.createHmac("sha256", OTP_SECRET).update(`${normalizeEmail(email)}:${code}`).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return "";
}

function sessionHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function sessionCookie(token, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `suyo_minigame_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, maxAge)}${secure}`;
}

function sessionRecord(store, req) {
  const token = cookieValue(req, "suyo_minigame_session");
  if (!token) return null;
  const key = sessionHash(token);
  const session = store.sessions[key];
  if (!session || Date.now() >= Number(session.expiresAt || 0)) return null;
  return { key, session };
}

function publicIdentity(session) {
  return session ? { name: session.name, team: session.team, email: session.email } : null;
}

function ballotForSession(store, session) {
  if (!session) return null;
  return store.ballots.find((ballot) => ballot.email === session.email && ballot.personKey === session.personKey) || null;
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return typeof forwarded === "string" && forwarded.trim() ? forwarded.split(",")[0].trim() : req.socket.remoteAddress || "";
}

function normalizeHost(host) {
  return String(host || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function hostWithoutPort(host) {
  return normalizeHost(host).replace(/:\d+$/, "");
}

function requestHost(req) {
  const forwarded = req.headers["x-forwarded-host"];
  const host = Array.isArray(forwarded) ? forwarded[0] : forwarded || req.headers.host || "";
  return normalizeHost(String(host).split(",")[0]);
}

function isLoopbackHost(req) {
  return ["localhost", "127.0.0.1", "::1"].includes(hostWithoutPort(requestHost(req)));
}

function isAdminHost(req) {
  const host = requestHost(req);
  return ADMIN_HOSTS.some((allowed) => host === allowed || hostWithoutPort(host) === hostWithoutPort(allowed));
}

function adminSurfaceAllowed(req) {
  return isAdminHost(req) || (process.env.NODE_ENV !== "production" && isLoopbackHost(req));
}

function requireAdmin(req, url) {
  if (!adminSurfaceAllowed(req)) return false;
  const header = req.headers["x-admin-password"] || req.headers["x-admin-token"];
  const query = url.searchParams.get("password") || url.searchParams.get("token");
  return safeEqual(header, ADMIN_PASSWORD) || safeEqual(query, ADMIN_PASSWORD);
}

function votingState(settings, now = Date.now()) {
  if (settings.resultsPublished) return "published";
  const start = new Date(settings.startAt).getTime();
  const end = new Date(settings.endAt).getTime();
  if (Number.isFinite(start) && now < start) return "upcoming";
  if (Number.isFinite(end) && now >= end) return "locked";
  return "open";
}

function activeBallots(store) {
  return store.ballots.filter((ballot) => Array.isArray(ballot.gameIds) && ballot.gameIds.length > 0);
}

function voteCounts(store) {
  const counts = Object.fromEntries(store.games.map((game) => [game.id, 0]));
  for (const ballot of activeBallots(store)) {
    for (const id of ballot.gameIds || []) {
      if (Object.hasOwn(counts, id)) counts[id] += 1;
    }
  }
  return counts;
}

function rankedGames(store) {
  const counts = voteCounts(store);
  return store.games
    .filter((game) => game.published)
    .map((game) => ({ id: game.id, title: game.title, team: game.team, coverUrl: game.coverUrl, voteCount: counts[game.id] || 0 }))
    .sort((a, b) => b.voteCount - a.voteCount || a.title.localeCompare(b.title, "zh-Hans-CN"));
}

function resultPreview(store) {
  const ranked = rankedGames(store);
  const positive = ranked.filter((game) => game.voteCount > 0);
  const targetWinnerCount = Math.min(2, positive.length);
  let winnerIds = [];
  let boundaryCandidates = [];
  let unresolved = false;
  if (targetWinnerCount > 0) {
    const cutoff = positive[targetWinnerCount - 1].voteCount;
    const above = positive.filter((game) => game.voteCount > cutoff);
    boundaryCandidates = positive.filter((game) => game.voteCount === cutoff);
    const remainingSlots = targetWinnerCount - above.length;
    unresolved = boundaryCandidates.length > remainingSlots;
    if (!unresolved) {
      winnerIds = [...above, ...boundaryCandidates].slice(0, targetWinnerCount).map((game) => game.id);
    } else {
      const adjudicated = Array.isArray(store.settings.adjudication?.winnerIds) ? store.settings.adjudication.winnerIds : [];
      const allowed = new Set([...above, ...boundaryCandidates].map((game) => game.id));
      const includesAbove = above.every((game) => adjudicated.includes(game.id));
      if (adjudicated.length === targetWinnerCount && adjudicated.every((id) => allowed.has(id)) && includesAbove) {
        winnerIds = adjudicated;
        unresolved = false;
      }
    }
  }
  let constellationIds = positive.map((game) => game.id);
  if (positive.length > 5) {
    const cutoff = positive[4].voteCount;
    constellationIds = positive.filter((game) => game.voteCount >= cutoff).map((game) => game.id);
  }
  return {
    ranked,
    positiveCount: positive.length,
    winnerIds,
    constellationIds,
    unresolved,
    targetWinnerCount,
    boundaryCandidates: boundaryCandidates.map((game) => game.id),
    adjudication: store.settings.adjudication || null
  };
}

function publicSite(store) {
  const state = votingState(store.settings);
  const showResults = Boolean(store.settings.resultsPublished);
  ensureGameCoordinates(store);
  const games = store.games
    .filter((game) => game.published)
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || a.createdAt.localeCompare(b.createdAt))
    .map((game) => ({
      id: game.id,
      title: game.title,
      team: game.team,
      shortDescription: game.shortDescription,
      description: game.description,
      creationNote: game.creationNote || "",
      creators: normalizeCreators(game.creators),
      coverUrl: game.coverUrl,
      videoUrl: game.videoUrl,
      downloadUrl: game.downloadUrl,
      tags: game.tags || [],
      planetSeed: game.planetSeed,
      coordinate: game.coordinate
    }));
  const ranked = showResults ? rankedGames(store) : [];
  return {
    ok: true,
    settings: {
      eventTitle: store.settings.eventTitle,
      theme: store.settings.theme,
      slogan: store.settings.slogan,
      eventSeed: store.settings.eventSeed,
      startAt: store.settings.startAt,
      endAt: store.settings.endAt
    },
    votingState: state,
    resultsVisible: showResults,
    gameCount: games.length,
    games,
    results: ranked,
    totalVoters: showResults ? activeBallots(store).length : undefined,
    winnerIds: showResults ? store.settings.winnerGameIds || [] : [],
    constellationIds: showResults ? store.settings.constellationGameIds || [] : [],
    publishedAt: showResults ? store.settings.publishedAt : undefined
  };
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.MAIL_FROM);
}

function getMailTransport() {
  if (mailTransport) return mailTransport;
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465;
  const auth = process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined;
  mailTransport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure, auth });
  return mailTransport;
}

async function deliverCode({ email, name, code }) {
  if (!smtpConfigured()) {
    if (!ALLOW_DEV_OTP) {
      const error = new Error("邮件服务尚未配置，请联系活动管理员。");
      error.status = 503;
      throw error;
    }
    console.log(`[本地验证码] ${email} -> ${code}`);
    return { devCode: code };
  }
  await getMailTransport().sendMail({
    from: process.env.MAIL_FROM,
    to: email,
    subject: "溯造 MiniGame 投票验证码",
    text: `${name}，你好。你的投票验证码是 ${code}，${Math.round(OTP_TTL_MS / 60000)} 分钟内有效。请勿转发给他人。`,
    html: `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;max-width:520px;margin:auto;padding:32px;color:#171717"><p style="font-size:14px">${escapeHtml(name)}，你好</p><h1 style="font-size:42px;letter-spacing:8px;margin:24px 0">${code}</h1><p style="line-height:1.7;color:#555">这是你的溯造 MiniGame 投票验证码，${Math.round(OTP_TTL_MS / 60000)} 分钟内有效。请勿转发给他人。</p><p style="margin-top:30px;font-size:13px;color:#777">溯求本源，造物不止</p></div>`
  });
  return {};
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

async function handleRequestCode(req, res) {
  const body = await readJson(req);
  const name = cleanText(body.name, 30);
  const team = cleanText(body.team, 50);
  const email = normalizeEmail(body.email);
  if (!name || !team || !isValidEmail(email)) {
    return json(res, 400, { ok: false, error: "IDENTITY_REQUIRED", message: "请填写姓名、队伍和有效邮箱。" });
  }
  const store = await ensureStore();
  if (votingState(store.settings) !== "open") {
    return json(res, 409, { ok: false, error: "VOTING_CLOSED", message: "当前不在投票时间内。" });
  }
  const previous = store.verificationCodes[email];
  const now = Date.now();
  const sourceIp = clientIp(req);
  const sourceRequests = Object.values(store.verificationCodes).reduce((total, record) => {
    const withinWindow = now - Number(record.windowStartedAt || record.sentAt || 0) < 60 * 60 * 1000;
    return total + (withinWindow && record.ip === sourceIp ? Number(record.requestCount || 1) : 0);
  }, 0);
  if (sourceRequests >= OTP_MAX_REQUESTS_PER_IP_PER_HOUR) {
    return json(res, 429, { ok: false, error: "SOURCE_RATE_LIMIT", message: "当前网络的验证码请求过多，请稍后再试。" });
  }
  if (previous && now - Number(previous.sentAt || 0) < OTP_RESEND_MS) {
    const waitSeconds = Math.ceil((OTP_RESEND_MS - (now - previous.sentAt)) / 1000);
    return json(res, 429, { ok: false, error: "CODE_TOO_FAST", message: `请在 ${waitSeconds} 秒后重新发送。`, retryAfter: waitSeconds });
  }
  const windowStartedAt = previous && now - Number(previous.windowStartedAt || 0) < 60 * 60 * 1000 ? previous.windowStartedAt : now;
  const requestCount = previous && windowStartedAt === previous.windowStartedAt ? Number(previous.requestCount || 0) + 1 : 1;
  if (requestCount > OTP_MAX_REQUESTS_PER_HOUR) {
    return json(res, 429, { ok: false, error: "CODE_RATE_LIMIT", message: "验证码发送次数过多，请稍后再试。" });
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await mutateStore((current) => {
    current.verificationCodes[email] = {
      codeHash: hashCode(email, code),
      identityKey: identityKey(name, team, email),
      personKey: personKey(name, team),
      sentAt: now,
      expiresAt: now + OTP_TTL_MS,
      attempts: 0,
      requestCount,
      windowStartedAt,
      ip: sourceIp
    };
  });
  try {
    const delivery = await deliverCode({ email, name, code });
    return json(res, 200, { ok: true, message: "验证码已发送，请检查邮箱。", expiresIn: Math.round(OTP_TTL_MS / 1000), ...delivery });
  } catch (error) {
    await mutateStore((current) => {
      if (current.verificationCodes[email]?.codeHash === hashCode(email, code)) delete current.verificationCodes[email];
    });
    throw error;
  }
}

function verifyCode(store, { name, team, email, code }) {
  const record = store.verificationCodes[email];
  if (!record || Date.now() > Number(record.expiresAt || 0)) {
    delete store.verificationCodes[email];
    const error = new Error("验证码已失效，请重新发送。");
    error.status = 400;
    error.code = "CODE_EXPIRED";
    throw error;
  }
  if (record.identityKey !== identityKey(name, team, email)) {
    const error = new Error("身份信息已改变，请重新发送验证码。");
    error.status = 400;
    error.code = "IDENTITY_CHANGED";
    throw error;
  }
  if (!safeEqual(record.codeHash, hashCode(email, code))) {
    record.attempts = Number(record.attempts || 0) + 1;
    if (record.attempts >= 5) delete store.verificationCodes[email];
    const error = new Error(record.attempts >= 5 ? "验证码错误次数过多，请重新发送。" : "验证码不正确。");
    error.status = 400;
    error.code = "CODE_INVALID";
    throw error;
  }
  return record;
}

function ballotPayload(ballot) {
  return ballot ? {
    gameIds: ballot.gameIds || [],
    version: Number(ballot.version || 1),
    updatedAt: ballot.updatedAt
  } : { gameIds: [], version: 0, updatedAt: null };
}

function addAudit(store, event) {
  store.audit.push({ id: randomId(), createdAt: new Date().toISOString(), ...event });
  if (store.audit.length > 10000) store.audit = store.audit.slice(-10000);
}

async function handleAuthVerify(req, res) {
  const body = await readJson(req);
  const name = cleanText(body.name, 30);
  const team = cleanText(body.team, 50);
  const email = normalizeEmail(body.email);
  const code = cleanText(body.code, 6);
  if (!name || !team || !isValidEmail(email) || !/^\d{6}$/.test(code)) {
    return json(res, 400, { ok: false, error: "IDENTITY_REQUIRED", message: "请完整填写身份信息和 6 位验证码。" });
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const result = await mutateStore((store) => {
    if (votingState(store.settings) !== "open") {
      const error = new Error("当前不在投票时间内。");
      error.status = 409;
      error.code = "VOTING_CLOSED";
      throw error;
    }
    verifyCode(store, { name, team, email, code });
    const key = personKey(name, team);
    const byEmail = store.ballots.find((ballot) => ballot.email === email);
    const byPerson = store.ballots.find((ballot) => ballot.personKey === key && ballot.email !== email);
    if (byPerson) {
      const error = new Error("该姓名与队伍已经使用其他邮箱投票，请使用首次投票邮箱登录。");
      error.status = 409;
      error.code = "PERSON_ALREADY_VOTED";
      throw error;
    }
    if (byEmail && byEmail.personKey !== key) {
      const error = new Error("该邮箱已绑定其他姓名或队伍。");
      error.status = 409;
      error.code = "EMAIL_ALREADY_USED";
      throw error;
    }
    const now = Date.now();
    for (const [keyHash, session] of Object.entries(store.sessions)) {
      if (now >= Number(session.expiresAt || 0)) delete store.sessions[keyHash];
    }
    const session = {
      id: randomId(),
      name,
      team,
      email,
      personKey: key,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + SESSION_TTL_MS,
      ip: clientIp(req),
      userAgent: cleanText(req.headers["user-agent"], 300)
    };
    store.sessions[sessionHash(token)] = session;
    delete store.verificationCodes[email];
    addAudit(store, { action: "session_verified", actorType: "voter", actorId: session.id, voterEmail: email });
    return { session, ballot: ballotPayload(byEmail) };
  });
  return json(res, 200, {
    ok: true,
    authenticated: true,
    identity: publicIdentity(result.session),
    ballot: result.ballot,
    message: "身份验证成功。"
  }, { "set-cookie": sessionCookie(token) });
}

async function handlePublicSession(req, res) {
  if (req.method === "DELETE") {
    const token = cookieValue(req, "suyo_minigame_session");
    if (token) await mutateStore((store) => { delete store.sessions[sessionHash(token)]; });
    return json(res, 200, { ok: true, authenticated: false, message: "已退出登录。" }, { "set-cookie": sessionCookie("", 0) });
  }
  const store = await ensureStore();
  const record = sessionRecord(store, req);
  if (!record) {
    return json(res, 200, { ok: true, authenticated: false, ballot: ballotPayload(null) }, { "set-cookie": sessionCookie("", 0) });
  }
  return json(res, 200, {
    ok: true,
    authenticated: true,
    identity: publicIdentity(record.session),
    ballot: ballotPayload(ballotForSession(store, record.session))
  });
}

async function handleBallot(req, res) {
  if (req.method === "GET") {
    const store = await ensureStore();
    const record = sessionRecord(store, req);
    if (!record) return json(res, 401, { ok: false, error: "LOGIN_REQUIRED", message: "请先完成邮箱验证。" });
    return json(res, 200, { ok: true, ballot: ballotPayload(ballotForSession(store, record.session)) });
  }
  const body = await readJson(req);
  const operationId = cleanText(body.operationId, 100);
  const addGameId = cleanText(body.addGameId, 100);
  const removeGameId = cleanText(body.removeGameId, 100);
  const usesOperation = Boolean(operationId || addGameId || removeGameId);
  const legacyGameIds = [...new Set(Array.isArray(body.gameIds) ? body.gameIds.map((id) => cleanText(id, 100)).filter(Boolean) : [])];
  if (usesOperation && (!operationId || (!addGameId && !removeGameId))) {
    return json(res, 400, { ok: false, error: "INVALID_BALLOT_OPERATION", message: "选票操作缺少必要信息。" });
  }
  if (addGameId && removeGameId && addGameId === removeGameId) {
    return json(res, 400, { ok: false, error: "INVALID_BALLOT_OPERATION", message: "不能用同一款作品替换自身。" });
  }
  if (!usesOperation && legacyGameIds.length > 3) return json(res, 400, { ok: false, error: "VOTE_LIMIT", message: "每人最多选择三款游戏。" });
  const requestedVersion = Number.isFinite(Number(body.version)) ? Number(body.version) : null;
  const result = await mutateStore((store) => {
    if (votingState(store.settings) !== "open") {
      const error = new Error("投票已经结束或尚未开始。");
      error.status = 409;
      error.code = "VOTING_CLOSED";
      throw error;
    }
    const record = sessionRecord(store, req);
    if (!record) {
      const error = new Error("登录状态已失效，请重新验证邮箱。");
      error.status = 401;
      error.code = "LOGIN_REQUIRED";
      throw error;
    }
    const byPerson = store.ballots.find((ballot) => ballot.personKey === record.session.personKey && ballot.email !== record.session.email);
    if (byPerson) {
      const error = new Error("该姓名与队伍已经使用其他邮箱投票。");
      error.status = 409;
      error.code = "PERSON_ALREADY_VOTED";
      throw error;
    }
    let ballot = ballotForSession(store, record.session);
    if (usesOperation) {
      const previousOperation = store.ballotOperations[operationId];
      if (previousOperation) {
        if (previousOperation.personKey !== record.session.personKey) {
          const error = new Error("选票操作标识已被占用。");
          error.status = 409;
          error.code = "OPERATION_ID_CONFLICT";
          throw error;
        }
        return {
          ballot: ballotPayload(ballot),
          before: previousOperation.before || [],
          after: previousOperation.after || [],
          operationId,
          replayed: true
        };
      }
    }
    const currentVersion = Number(ballot?.version || 0);
    if (requestedVersion !== null && requestedVersion !== currentVersion) {
      const error = new Error("选票已在其他设备更新，请刷新后重试。");
      error.status = 409;
      error.code = "BALLOT_VERSION_CONFLICT";
      error.details = { ballot: ballotPayload(ballot) };
      throw error;
    }
    const before = ballot ? [...ballot.gameIds] : [];
    if (usesOperation && addGameId && before.includes(addGameId)) {
      const error = new Error("该可能性核心已经在你的轨道中。");
      error.status = 409;
      error.code = "ALREADY_VOTED";
      error.details = { ballot: ballotPayload(ballot) };
      throw error;
    }
    let gameIds = legacyGameIds;
    if (usesOperation) {
      gameIds = [...before];
      if (removeGameId) {
        if (!gameIds.includes(removeGameId)) {
          const error = new Error("准备交接的旧核心已不在当前轨道，请同步最新选票。");
          error.status = 409;
          error.code = "BALLOT_TARGET_CHANGED";
          error.details = { ballot: ballotPayload(ballot) };
          throw error;
        }
        gameIds = gameIds.filter((id) => id !== removeGameId);
      }
      if (addGameId && !gameIds.includes(addGameId)) gameIds.push(addGameId);
    }
    gameIds = [...new Set(gameIds)];
    if (gameIds.length > 3) {
      const error = new Error("三条投票轨道已经占满，请选择一颗旧核心完成交接。");
      error.status = 409;
      error.code = "VOTE_LIMIT";
      error.details = { ballot: ballotPayload(ballot) };
      throw error;
    }
    const publishedGames = store.games.filter((game) => game.published);
    const gameById = new Map(publishedGames.map((game) => [game.id, game]));
    if (gameIds.some((id) => !gameById.has(id))) {
      const error = new Error("选择中包含无效或已下架的游戏。");
      error.status = 400;
      error.code = "INVALID_GAME";
      throw error;
    }
    const voterName = normalizedPersonName(record.session.name);
    const selfVoted = gameIds.map((id) => gameById.get(id)).find((game) => normalizeCreators(game.creators).some((creator) => normalizedPersonName(creator.name) === voterName));
    if (selfVoted) {
      const error = new Error(`你参与了《${selfVoted.title}》的制作，不能为自己的作品投票。`);
      error.status = 409;
      error.code = "SELF_VOTE";
      throw error;
    }
    const now = new Date().toISOString();
    if (!ballot) {
      if (!gameIds.length) return { ballot: ballotPayload(null), before, after: [] };
      ballot = {
        id: randomId(),
        name: record.session.name,
        team: record.session.team,
        email: record.session.email,
        personKey: record.session.personKey,
        gameIds,
        version: 1,
        createdAt: now,
        updatedAt: now,
        ip: clientIp(req),
        userAgent: cleanText(req.headers["user-agent"], 300)
      };
      store.ballots.push(ballot);
    } else {
      ballot.gameIds = gameIds;
      ballot.version = currentVersion + 1;
      ballot.updatedAt = now;
      ballot.ip = clientIp(req);
    }
    addAudit(store, {
      action: "ballot_updated",
      actorType: "voter",
      actorId: record.session.id,
      voterId: ballot.id,
      before,
      after: [...gameIds],
      operationId: operationId || null
    });
    if (usesOperation) {
      store.ballotOperations[operationId] = {
        personKey: record.session.personKey,
        before,
        after: [...gameIds],
        addGameId: addGameId || null,
        removeGameId: removeGameId || null,
        createdAt: now
      };
      const operationEntries = Object.entries(store.ballotOperations);
      if (operationEntries.length > 2000) {
        operationEntries
          .sort((a, b) => Date.parse(a[1].createdAt || 0) - Date.parse(b[1].createdAt || 0))
          .slice(0, operationEntries.length - 2000)
          .forEach(([id]) => delete store.ballotOperations[id]);
      }
    }
    return { ballot: ballotPayload(ballot), before, after: [...gameIds], operationId: operationId || null, replayed: false };
  });
  return json(res, 200, {
    ok: true,
    ballot: result.ballot,
    operationId: result.operationId,
    replayed: result.replayed,
    message: "选票已更新。"
  });
}

async function handleVote(req, res) {
  const body = await readJson(req);
  const name = cleanText(body.name, 30);
  const team = cleanText(body.team, 50);
  const email = normalizeEmail(body.email);
  const code = cleanText(body.code, 6);
  const gameIds = [...new Set(Array.isArray(body.gameIds) ? body.gameIds.map((id) => cleanText(id, 100)) : [])];
  if (!name || !team || !isValidEmail(email) || !/^\d{6}$/.test(code)) {
    return json(res, 400, { ok: false, error: "IDENTITY_REQUIRED", message: "请完整填写身份信息和 6 位验证码。" });
  }
  if (gameIds.length < 1 || gameIds.length > 3) {
    return json(res, 400, { ok: false, error: "VOTE_LIMIT", message: "请选择 1 到 3 款不同游戏。" });
  }

  try {
    const result = await mutateStore((store) => {
      if (votingState(store.settings) !== "open") {
        const error = new Error("投票已经结束或尚未开始。");
        error.status = 409;
        error.code = "VOTING_CLOSED";
        throw error;
      }
      const validIds = new Set(store.games.filter((game) => game.published).map((game) => game.id));
      if (gameIds.some((id) => !validIds.has(id))) {
        const error = new Error("选择中包含无效或已下架的游戏。");
        error.status = 400;
        error.code = "INVALID_GAME";
        throw error;
      }
      const voterName = normalizedPersonName(name);
      const selfVoted = store.games.find((game) => gameIds.includes(game.id) && normalizeCreators(game.creators).some((creator) => normalizedPersonName(creator.name) === voterName));
      if (selfVoted) {
        const error = new Error(`你参与了《${selfVoted.title}》的制作，不能为自己的作品投票。`);
        error.status = 409;
        error.code = "SELF_VOTE";
        throw error;
      }
      const record = store.verificationCodes[email];
      if (!record || Date.now() > Number(record.expiresAt || 0)) {
        delete store.verificationCodes[email];
        const error = new Error("验证码已失效，请重新发送。");
        error.status = 400;
        error.code = "CODE_EXPIRED";
        throw error;
      }
      if (record.identityKey !== identityKey(name, team, email)) {
        const error = new Error("身份信息已改变，请重新发送验证码。");
        error.status = 400;
        error.code = "IDENTITY_CHANGED";
        throw error;
      }
      if (!safeEqual(record.codeHash, hashCode(email, code))) {
        record.attempts = Number(record.attempts || 0) + 1;
        if (record.attempts >= 5) delete store.verificationCodes[email];
        const error = new Error(record.attempts >= 5 ? "验证码错误次数过多，请重新发送。" : "验证码不正确。" );
        error.status = 400;
        error.code = "CODE_INVALID";
        throw error;
      }

      const key = personKey(name, team);
      const byEmail = store.ballots.find((ballot) => ballot.email === email);
      const byPerson = store.ballots.find((ballot) => ballot.personKey === key && ballot.email !== email);
      if (byPerson) {
        const error = new Error("该姓名与队伍已经提交过选票。如需修改，请使用首次投票邮箱。" );
        error.status = 409;
        error.code = "PERSON_ALREADY_VOTED";
        throw error;
      }
      const nowIso = new Date().toISOString();
      if (byEmail) {
        if (byEmail.personKey !== key) {
          const error = new Error("该邮箱已绑定其他姓名或队伍。" );
          error.status = 409;
          error.code = "EMAIL_ALREADY_USED";
          throw error;
        }
        byEmail.gameIds = gameIds;
        byEmail.version = Number(byEmail.version || 1) + 1;
        byEmail.updatedAt = nowIso;
        byEmail.ip = clientIp(req);
      } else {
        store.ballots.push({
          id: randomId(),
          name,
          team,
          email,
          personKey: key,
          gameIds,
          version: 1,
          createdAt: nowIso,
          updatedAt: nowIso,
          ip: clientIp(req),
          userAgent: cleanText(req.headers["user-agent"], 300)
        });
      }
      store.verificationCodes[email] = {
        ...record,
        codeHash: "",
        expiresAt: 0,
        attempts: 0,
        consumedAt: Date.now()
      };
      addAudit(store, { action: "ballot_updated", actorType: "voter", actorId: byEmail?.id || email, voterId: byEmail?.id || null, before: byEmail ? [] : [], after: [...gameIds] });
      return { updated: Boolean(byEmail), count: gameIds.length };
    });
    return json(res, 201, { ok: true, ...result, message: result.updated ? "选票已更新。" : "投票成功，感谢你的声音。" });
  } catch (error) {
    error.status ||= 400;
    throw error;
  }
}

function extensionFor(mime, originalName) {
  const known = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov"
  };
  return known[mime] || path.extname(originalName || "").toLowerCase().slice(0, 8);
}

async function parseGameMultipart(req) {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = {};
    const tasks = [];
    const createdFiles = [];
    let parseError = null;
    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { fields: 60, files: 14, fileSize: Math.max(MAX_COVER_BYTES, MAX_AVATAR_BYTES, MAX_VIDEO_BYTES) }
      });
    } catch (error) {
      error.status = 400;
      reject(error);
      return;
    }

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("file", (name, stream, info) => {
      const isCover = name === "cover";
      const isVideo = name === "video";
      const isAvatar = /^avatar-\d{1,2}$/.test(name);
      if ((!isCover && !isVideo && !isAvatar) || !info.filename) {
        stream.resume();
        return;
      }
      const validType = isCover || isAvatar ? info.mimeType.startsWith("image/") : info.mimeType.startsWith("video/");
      if (!validType) {
        parseError = Object.assign(new Error(isCover ? "封面必须是图片文件。" : isAvatar ? "成员头像必须是图片文件。" : "演示文件必须是视频。"), { status: 400 });
        stream.resume();
        return;
      }
      const limit = isCover ? MAX_COVER_BYTES : isAvatar ? MAX_AVATAR_BYTES : MAX_VIDEO_BYTES;
      let size = 0;
      let exceeded = false;
      const filename = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extensionFor(info.mimeType, info.filename)}`;
      const target = path.join(UPLOAD_DIR, filename);
      createdFiles.push(target);
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) exceeded = true;
      });
      const task = pipeline(stream, fs.createWriteStream(target)).then(() => {
        if (exceeded || stream.truncated) {
          const error = new Error(isCover
            ? `封面不能超过 ${Math.round(MAX_COVER_BYTES / 1024 / 1024)}MB。`
            : isAvatar
              ? `成员头像不能超过 ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)}MB。`
              : `视频不能超过 ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)}MB。`);
          error.status = 413;
          throw error;
        }
        files[name] = { url: `/uploads/${filename}`, target, mimeType: info.mimeType, originalName: info.filename, size };
      });
      tasks.push(task);
    });

    busboy.on("error", reject);
    busboy.on("close", async () => {
      try {
        await Promise.all(tasks);
        if (parseError) throw parseError;
        resolve({ fields, files, createdFiles });
      } catch (error) {
        await Promise.all(createdFiles.map((file) => fsp.unlink(file).catch(() => {})));
        reject(error);
      }
    });
    req.pipe(busboy);
  });
}

function cleanUrl(value) {
  const input = cleanText(value, 1000);
  if (!input) return "";
  try {
    const url = new URL(input);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function cleanAssetUrl(value) {
  const input = cleanText(value, 1000);
  if (/^\/uploads\/[A-Za-z0-9._-]+$/.test(input)) return input;
  return cleanUrl(input);
}

function creatorsFromFields(fields, files, existing = null) {
  let input = [];
  try {
    input = JSON.parse(String(fields.creatorsJson || "[]"));
  } catch {
    input = [];
  }
  if (!Array.isArray(input) || !input.length) input = normalizeCreators(fields.creators || existing?.creators || []);
  const previous = new Map(normalizeCreators(existing?.creators || []).map((creator) => [creator.id, creator]));
  return input.slice(0, 12).map((creator, index) => {
    const name = cleanText(creator?.name, 40);
    const role = cleanText(creator?.role, 40);
    const old = previous.get(cleanText(creator?.id, 80));
    return {
      id: cleanText(creator?.id, 80) || creatorId(name, role, index),
      name,
      role,
      avatarUrl: files[`avatar-${index}`]?.url || cleanAssetUrl(creator?.avatarUrl) || old?.avatarUrl || "",
      order: index
    };
  }).filter((creator) => creator.name);
}

function gameFromFields(fields, files, existing = null) {
  const title = cleanText(fields.title, 60);
  const team = cleanText(fields.team, 60);
  const shortDescription = cleanText(fields.shortDescription, 120);
  if (!title || !team || !shortDescription) {
    const error = new Error("游戏名称、制作团队和一句话介绍不能为空。" );
    error.status = 400;
    throw error;
  }
  const now = new Date().toISOString();
  const tags = cleanText(fields.tags, 120).split(/[,，]/).map((tag) => cleanText(tag, 16)).filter(Boolean).slice(0, 4);
  const creators = creatorsFromFields(fields, files, existing);
  return {
    id: existing?.id || `${title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "game"}-${crypto.randomBytes(3).toString("hex")}`,
    title,
    team,
    shortDescription,
    description: cleanText(fields.description, 1200),
    creationNote: cleanText(fields.creationNote, 600),
    creators,
    coverUrl: files.cover?.url || cleanUrl(fields.coverUrl) || existing?.coverUrl || "",
    videoUrl: files.video?.url || cleanUrl(fields.videoUrl) || existing?.videoUrl || "",
    downloadUrl: cleanUrl(fields.downloadUrl) || existing?.downloadUrl || "",
    tags,
    featured: fields.featured === "true" || fields.featured === "on",
    published: fields.published === "true" || fields.published === "on",
    order: Number.isFinite(Number(fields.order)) ? Number(fields.order) : Number(existing?.order || 100),
    planetSeed: existing?.planetSeed || crypto.createHash("sha256").update(`${title}:${team}:${Date.now()}`).digest("hex").slice(0, 16),
    coordinate: existing?.coordinate || null,
    isDemo: false,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

async function removeLocalAsset(url) {
  if (!String(url || "").startsWith("/uploads/")) return;
  const target = path.resolve(UPLOAD_DIR, path.basename(url));
  if (target.startsWith(UPLOAD_DIR)) await fsp.unlink(target).catch(() => {});
}

async function handleAdminSession(req, res, url) {
  const body = req.method === "POST" ? await readJson(req) : {};
  if (!safeEqual(body.password, ADMIN_PASSWORD) && !requireAdmin(req, url)) {
    return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "后台密码不正确。" });
  }
  return json(res, 200, { ok: true, adminHost: ADMIN_HOSTS[0] || "" });
}

function maskEmail(email) {
  const [local, domain] = String(email || "").split("@");
  if (!domain) return email;
  return `${local.slice(0, 2)}${"*".repeat(Math.max(2, Math.min(6, local.length - 2)))}@${domain}`;
}

async function handleAdminDashboard(req, res, url) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const store = await ensureStore();
  const counts = voteCounts(store);
  const games = store.games
    .slice()
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .map((game) => ({ ...game, voteCount: counts[game.id] || 0 }));
  const titleById = Object.fromEntries(store.games.map((game) => [game.id, game.title]));
  const ballots = activeBallots(store)
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((ballot) => ({
      id: ballot.id,
      name: ballot.name,
      team: ballot.team,
      email: maskEmail(ballot.email),
      emailSearch: ballot.email,
      gameIds: ballot.gameIds,
      games: ballot.gameIds.map((id) => titleById[id]).filter(Boolean),
      createdAt: ballot.createdAt,
      updatedAt: ballot.updatedAt,
      audit: store.audit
        .filter((item) => item.voterId === ballot.id)
        .slice(-8)
        .reverse()
        .map((item) => ({
          id: item.id,
          action: item.action,
          actorType: item.actorType,
          before: item.before,
          after: item.after,
          reason: item.reason || "",
          createdAt: item.createdAt
        }))
    }));
  const preview = resultPreview(store);
  return json(res, 200, {
    ok: true,
    settings: store.settings,
    votingState: votingState(store.settings),
    games,
    ballots,
    resultPreview: preview,
    recentAudit: store.audit.slice(-30).reverse(),
    stats: {
      games: games.length,
      publishedGames: games.filter((game) => game.published).length,
      voters: ballots.length,
      votes: ballots.reduce((sum, ballot) => sum + ballot.gameIds.length, 0)
    }
  });
}

async function handleAdminCreateGame(req, res, url) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const parsed = await parseGameMultipart(req);
  try {
    const game = gameFromFields(parsed.fields, parsed.files);
    await mutateStore((store) => {
      if (game.featured) store.games.forEach((item) => { item.featured = false; });
      game.coordinate = coordinateForGame(game.id, store.settings.eventSeed, store.games);
      store.games.push(game);
    });
    return json(res, 201, { ok: true, game, message: "游戏已加入展厅。" });
  } catch (error) {
    await Promise.all(parsed.createdFiles.map((file) => fsp.unlink(file).catch(() => {})));
    throw error;
  }
}

async function handleAdminUpdateGame(req, res, url, id) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const parsed = await parseGameMultipart(req);
  let oldAssets = [];
  try {
    const updated = await mutateStore((store) => {
      const index = store.games.findIndex((game) => game.id === id);
      if (index < 0) {
        const error = new Error("没有找到这款游戏。" );
        error.status = 404;
        throw error;
      }
      const existing = store.games[index];
      const game = gameFromFields(parsed.fields, parsed.files, existing);
      const retainedAvatars = new Set(game.creators.map((creator) => creator.avatarUrl).filter(Boolean));
      oldAssets = [
        parsed.files.cover ? existing.coverUrl : "",
        parsed.files.video ? existing.videoUrl : "",
        ...normalizeCreators(existing.creators).map((creator) => creator.avatarUrl).filter((urlValue) => urlValue && !retainedAvatars.has(urlValue))
      ].filter(Boolean);
      if (game.featured) store.games.forEach((item) => { item.featured = false; });
      store.games[index] = game;
      return game;
    });
    await Promise.all(oldAssets.map(removeLocalAsset));
    return json(res, 200, { ok: true, game: updated, message: "游戏信息已更新。" });
  } catch (error) {
    await Promise.all(parsed.createdFiles.map((file) => fsp.unlink(file).catch(() => {})));
    throw error;
  }
}

async function handleAdminDeleteGame(req, res, url, id) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const deleted = await mutateStore((store) => {
    const game = store.games.find((item) => item.id === id);
    if (!game) {
      const error = new Error("没有找到这款游戏。" );
      error.status = 404;
      throw error;
    }
    store.games = store.games.filter((item) => item.id !== id);
    store.ballots.forEach((ballot) => { ballot.gameIds = ballot.gameIds.filter((gameId) => gameId !== id); });
    return game;
  });
  await Promise.all([
    removeLocalAsset(deleted.coverUrl),
    removeLocalAsset(deleted.videoUrl),
    ...normalizeCreators(deleted.creators).map((creator) => removeLocalAsset(creator.avatarUrl))
  ]);
  return json(res, 200, { ok: true, message: "游戏已删除。" });
}

async function handleAdminRegeneratePlanet(req, res, url, id) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const game = await mutateStore((store) => {
    const target = store.games.find((item) => item.id === id);
    if (!target) {
      const error = new Error("没有找到这款游戏。");
      error.status = 404;
      throw error;
    }
    const before = { planetSeed: target.planetSeed, coordinate: target.coordinate };
    target.planetSeed = crypto.randomBytes(8).toString("hex");
    const occupied = store.games.filter((item) => item.id !== id);
    target.coordinate = coordinateForGame(`${target.id}:${target.planetSeed}`, store.settings.eventSeed, occupied);
    target.updatedAt = new Date().toISOString();
    addAudit(store, {
      action: "planet_regenerated",
      actorType: "admin",
      actorId: "admin",
      gameId: id,
      before,
      after: { planetSeed: target.planetSeed, coordinate: target.coordinate }
    });
    return { ...target };
  });
  return json(res, 200, { ok: true, game, message: "天体形态与固定坐标已经重新生成。" });
}

async function handleAdminSettings(req, res, url) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const body = await readJson(req);
  const startAt = new Date(body.startAt);
  const endAt = new Date(body.endAt);
  if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) {
    return json(res, 400, { ok: false, error: "INVALID_TIME", message: "请设置正确的开始与结束时间。" });
  }
  const settings = await mutateStore((store) => {
    store.settings = {
      ...store.settings,
      eventTitle: cleanText(body.eventTitle, 80) || store.settings.eventTitle,
      theme: cleanText(body.theme, 40) || "宇宙",
      slogan: cleanText(body.slogan, 80) || store.settings.slogan,
      eventSeed: cleanText(body.eventSeed, 80) || store.settings.eventSeed,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString()
    };
    return store.settings;
  });
  return json(res, 200, { ok: true, settings, message: "活动设置已保存。" });
}

async function handleAdminDeleteVoter(req, res, url, id) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const body = await readJson(req);
  const reason = cleanText(body.reason, 300);
  if (!reason) return json(res, 400, { ok: false, error: "REASON_REQUIRED", message: "请填写删除违规选票的原因。" });
  const removed = await mutateStore((store) => {
    if (store.settings.resultsPublished) {
      const error = new Error("结果发布后不能直接删除选票。" );
      error.status = 409;
      error.code = "RESULTS_ALREADY_PUBLISHED";
      throw error;
    }
    const ballot = store.ballots.find((item) => item.id === id);
    if (!ballot) {
      const error = new Error("没有找到这位投票者。" );
      error.status = 404;
      throw error;
    }
    store.ballots = store.ballots.filter((item) => item.id !== id);
    for (const [key, session] of Object.entries(store.sessions)) {
      if (session.email === ballot.email) delete store.sessions[key];
    }
    addAudit(store, {
      action: "voter_removed",
      actorType: "admin",
      actorId: "admin",
      voterId: ballot.id,
      voterEmail: ballot.email,
      before: [...ballot.gameIds],
      after: [],
      reason
    });
    return ballot;
  });
  return json(res, 200, { ok: true, removedId: removed.id, message: "违规投票者及其全部选票已删除。" });
}

async function handleAdminAdjudicate(req, res, url) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const body = await readJson(req);
  const winnerIds = [...new Set(Array.isArray(body.winnerIds) ? body.winnerIds.map((id) => cleanText(id, 100)).filter(Boolean) : [])];
  const note = cleanText(body.note, 500);
  if (winnerIds.length !== 2) return json(res, 400, { ok: false, error: "TWO_WINNERS_REQUIRED", message: "必须选择两款同等级获奖作品。" });
  if (!note) return json(res, 400, { ok: false, error: "ADJUDICATION_NOTE_REQUIRED", message: "请填写同票裁定说明。" });
  const result = await mutateStore((store) => {
    if (votingState(store.settings) !== "locked") {
      const error = new Error("只能在投票截止且结果未发布时进行裁定。" );
      error.status = 409;
      throw error;
    }
    const previous = store.settings.adjudication;
    store.settings.adjudication = null;
    const raw = resultPreview(store);
    store.settings.adjudication = previous;
    if (raw.positiveCount < 2) {
      const error = new Error("至少需要两款获得有效票的作品。" );
      error.status = 409;
      throw error;
    }
    const positive = raw.ranked.filter((game) => game.voteCount > 0);
    const cutoff = positive[1].voteCount;
    const above = positive.filter((game) => game.voteCount > cutoff).map((game) => game.id);
    const boundary = positive.filter((game) => game.voteCount === cutoff).map((game) => game.id);
    const allowed = new Set([...above, ...boundary]);
    if (!above.every((id) => winnerIds.includes(id)) || !winnerIds.every((id) => allowed.has(id))) {
      const error = new Error("获奖选择必须来自当前获奖边界候选。" );
      error.status = 400;
      error.code = "INVALID_ADJUDICATION";
      throw error;
    }
    store.settings.adjudication = {
      winnerIds,
      candidateIds: [...allowed],
      note,
      decidedAt: new Date().toISOString(),
      decidedBy: "admin"
    };
    addAudit(store, { action: "results_adjudicated", actorType: "admin", actorId: "admin", candidateIds: [...allowed], after: winnerIds, reason: note });
    return resultPreview(store);
  });
  return json(res, 200, { ok: true, resultPreview: result, message: "获奖作品裁定已保存。" });
}

async function handleAdminPublishResults(req, res, url) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const result = await mutateStore((store) => {
    if (votingState(store.settings) !== "locked") {
      const error = new Error(store.settings.resultsPublished ? "结果已经发布。" : "投票截止后才能发布结果。" );
      error.status = 409;
      throw error;
    }
    const preview = resultPreview(store);
    if (preview.positiveCount < 2) {
      const error = new Error("至少需要两款获得有效票的作品才能发布。" );
      error.status = 409;
      throw error;
    }
    if (preview.unresolved || preview.winnerIds.length !== 2) {
      const error = new Error("获奖边界仍有同票，请先完成管理员裁定。" );
      error.status = 409;
      error.code = "ADJUDICATION_REQUIRED";
      throw error;
    }
    store.settings.winnerGameIds = [...preview.winnerIds];
    store.settings.constellationGameIds = [...preview.constellationIds];
    store.settings.resultsPublished = true;
    store.settings.publishedAt = new Date().toISOString();
    addAudit(store, { action: "results_published", actorType: "admin", actorId: "admin", after: preview.winnerIds });
    return { winnerIds: preview.winnerIds, constellationIds: preview.constellationIds, publishedAt: store.settings.publishedAt };
  });
  return json(res, 200, { ok: true, ...result, message: "玩家之声结果已发布。" });
}

async function handleAdminWithdrawResults(req, res, url) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const body = await readJson(req);
  const reason = cleanText(body.reason, 500);
  if (!reason) return json(res, 400, { ok: false, error: "REASON_REQUIRED", message: "撤回结果必须填写更正原因。" });
  const result = await mutateStore((store) => {
    if (!store.settings.resultsPublished) {
      const error = new Error("当前没有已发布结果。" );
      error.status = 409;
      error.code = "RESULTS_NOT_PUBLISHED";
      throw error;
    }
    const before = {
      winnerIds: [...store.settings.winnerGameIds],
      constellationIds: [...store.settings.constellationGameIds],
      publishedAt: store.settings.publishedAt
    };
    store.settings.resultsPublished = false;
    store.settings.winnerGameIds = [];
    store.settings.constellationGameIds = [];
    store.settings.publishedAt = null;
    store.settings.adjudication = null;
    addAudit(store, {
      action: "results_withdrawn",
      actorType: "admin",
      actorId: "admin",
      before,
      after: { resultsPublished: false },
      reason
    });
    return before;
  });
  return json(res, 200, { ok: true, previous: result, message: "已撤回公开结果，前台恢复为锁票复核状态。" });
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function handleAdminExport(req, res, url) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const store = await ensureStore();
  const titleById = Object.fromEntries(store.games.map((game) => [game.id, game.title]));
  const rows = [["姓名", "队伍", "邮箱", "选择作品", "票数", "首次提交", "最后更新"]];
  for (const ballot of activeBallots(store)) {
    rows.push([ballot.name, ballot.team, ballot.email, ballot.gameIds.map((id) => titleById[id] || id).join(" / "), ballot.gameIds.length, ballot.createdAt, ballot.updatedAt]);
  }
  const content = `\uFEFF${rows.map((row) => row.map(csvValue).join(",")).join("\r\n")}\r\n`;
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": 'attachment; filename="suyo-minigame-votes.csv"',
    "cache-control": "no-store"
  });
  res.end(content);
}

async function handleAdminAuditExport(req, res, url) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const store = await ensureStore();
  const rows = [["时间", "事件", "操作者类型", "操作者", "投票者", "作品", "变更前", "变更后", "原因"]];
  for (const item of store.audit) {
    rows.push([
      item.createdAt,
      item.action,
      item.actorType,
      item.actorId,
      item.voterEmail || item.voterId || "",
      item.gameId || "",
      JSON.stringify(item.before ?? ""),
      JSON.stringify(item.after ?? ""),
      item.reason || ""
    ]);
  }
  const content = `\uFEFF${rows.map((row) => row.map(csvValue).join(",")).join("\r\n")}\r\n`;
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": 'attachment; filename="suyo-minigame-audit.csv"',
    "cache-control": "no-store"
  });
  res.end(content);
}

function htmlAttribute(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

async function servePublicIndex(req, res, url) {
  let content = await fsp.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const gameId = cleanText(url.searchParams.get("game"), 100);
  if (gameId) {
    const store = await ensureStore();
    const game = store.games.find((item) => item.id === gameId && item.published);
    if (game) {
      const protocol = cleanText(req.headers["x-forwarded-proto"], 12) || "http";
      const origin = `${protocol}://${req.headers.host || `localhost:${PORT}`}`;
      const title = `${game.title} / ${store.settings.eventTitle}`;
      const description = `${game.team}制作。${game.shortDescription || "进入共享宇宙观测这款 MiniGame 作品。"}`;
      const image = String(game.coverUrl || "/assets/suyo-studio.png").startsWith("/") ? `${origin}${game.coverUrl || "/assets/suyo-studio.png"}` : game.coverUrl;
      content = content
        .replace(/<title>[^<]*<\/title>/, `<title>${htmlAttribute(title)}</title>`)
        .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${htmlAttribute(description)}" />`)
        .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${htmlAttribute(title)}" />`)
        .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${htmlAttribute(description)}" />`)
        .replace(/<meta property="og:image" content="[^"]*" \/>/, `<meta property="og:image" content="${htmlAttribute(image)}" />`);
    }
  }
  const body = Buffer.from(content);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  if (req.method === "HEAD") return res.end();
  res.end(body);
}

async function serveFile(res, requestedPath, options = {}) {
  try {
    const stat = await fsp.stat(requestedPath);
    if (!stat.isFile()) return notFound(res);
    const ext = path.extname(requestedPath).toLowerCase();
    const headers = {
      "content-type": staticTypes[ext] || "application/octet-stream",
      "cache-control": options.noStore ? "no-store" : "public, max-age=300",
      "x-content-type-options": "nosniff"
    };
    if (options.range && /^bytes=\d*-\d*$/.test(options.range)) {
      const [startText, endText] = options.range.replace("bytes=", "").split("-");
      const start = startText ? Number(startText) : 0;
      const end = endText ? Math.min(Number(endText), stat.size - 1) : stat.size - 1;
      if (start <= end && start < stat.size) {
        res.writeHead(206, { ...headers, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${stat.size}`, "content-length": end - start + 1 });
        fs.createReadStream(requestedPath, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(200, { ...headers, "content-length": stat.size, "accept-ranges": "bytes" });
    fs.createReadStream(requestedPath).pipe(res);
  } catch (error) {
    if (error.code === "ENOENT") return notFound(res);
    throw error;
  }
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith("/uploads/")) {
    const requested = path.resolve(UPLOAD_DIR, path.basename(pathname));
    if (!requested.startsWith(UPLOAD_DIR)) return notFound(res);
    return serveFile(res, requested, { range: req.headers.range });
  }
  const adminHost = isAdminHost(req);
  if (pathname === "/") pathname = adminHost && ADMIN_ROOT_ON_ADMIN_HOST ? "/admin.html" : "/index.html";
  if (pathname === "/admin" || pathname === "/admin.html") {
    if (!adminSurfaceAllowed(req)) return notFound(res);
    pathname = "/admin.html";
  }
  if (pathname === "/index.html" && !adminHost) return servePublicIndex(req, res, url);
  const requested = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!requested.startsWith(PUBLIC_DIR)) return notFound(res);
  return serveFile(res, requested, { noStore: [".html", ".css", ".js"].includes(path.extname(requested).toLowerCase()) });
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/admin/") && !adminSurfaceAllowed(req)) return notFound(res);
    if (url.pathname === "/api/health") return json(res, 200, { ok: true, time: new Date().toISOString(), timeZone: TZ });
    if (url.pathname === "/api/site") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return json(res, 200, publicSite(await ensureStore()));
    }
    if (url.pathname === "/api/verification/request") {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleRequestCode(req, res);
    }
    if (url.pathname === "/api/auth/verify") {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleAuthVerify(req, res);
    }
    if (url.pathname === "/api/session") {
      if (req.method !== "GET" && req.method !== "DELETE") return methodNotAllowed(res);
      return await handlePublicSession(req, res);
    }
    if (url.pathname === "/api/ballot") {
      if (req.method !== "GET" && req.method !== "PUT") return methodNotAllowed(res);
      return await handleBallot(req, res);
    }
    if (url.pathname === "/api/votes") {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleVote(req, res);
    }
    if (url.pathname === "/api/admin/session") {
      if (req.method !== "POST" && req.method !== "GET") return methodNotAllowed(res);
      return await handleAdminSession(req, res, url);
    }
    if (url.pathname === "/api/admin/dashboard") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return await handleAdminDashboard(req, res, url);
    }
    if (url.pathname === "/api/admin/games") {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleAdminCreateGame(req, res, url);
    }
    const gameMatch = url.pathname.match(/^\/api\/admin\/games\/([^/]+)$/);
    if (gameMatch) {
      const id = decodeURIComponent(gameMatch[1]);
      if (req.method === "PUT") return await handleAdminUpdateGame(req, res, url, id);
      if (req.method === "DELETE") return await handleAdminDeleteGame(req, res, url, id);
      return methodNotAllowed(res);
    }
    const regenerateGameMatch = url.pathname.match(/^\/api\/admin\/games\/([^/]+)\/regenerate-planet$/);
    if (regenerateGameMatch) {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleAdminRegeneratePlanet(req, res, url, decodeURIComponent(regenerateGameMatch[1]));
    }
    if (url.pathname === "/api/admin/settings") {
      if (req.method !== "PUT") return methodNotAllowed(res);
      return await handleAdminSettings(req, res, url);
    }
    const voterMatch = url.pathname.match(/^\/api\/admin\/voters\/([^/]+)$/);
    if (voterMatch) {
      if (req.method !== "DELETE") return methodNotAllowed(res);
      return await handleAdminDeleteVoter(req, res, url, decodeURIComponent(voterMatch[1]));
    }
    if (url.pathname === "/api/admin/results/adjudicate") {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleAdminAdjudicate(req, res, url);
    }
    if (url.pathname === "/api/admin/results/publish") {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleAdminPublishResults(req, res, url);
    }
    if (url.pathname === "/api/admin/results/withdraw") {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleAdminWithdrawResults(req, res, url);
    }
    if (url.pathname === "/api/admin/export/votes.csv") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return await handleAdminExport(req, res, url);
    }
    if (url.pathname === "/api/admin/export/audit.csv") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return await handleAdminAuditExport(req, res, url);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res);
    return await serveStatic(req, res, url);
  } catch (error) {
    const status = error.status || 500;
    console.error(error);
    return json(res, status, {
      ok: false,
      error: error.code || "SERVER_ERROR",
      message: status >= 500 ? "服务器开小差了，请稍后再试。" : error.message,
      ...(status < 500 && error.details ? error.details : {})
    });
  }
}

ensureStore()
  .then(() => {
    http.createServer(router).listen(PORT, HOST, () => {
      console.log(`溯造 MiniGame 已启动：http://${HOST}:${PORT}`);
      console.log(`管理后台：http://${ADMIN_HOSTS[0] || `admin.localhost:${PORT}`}/`);
      if (!smtpConfigured() && ALLOW_DEV_OTP) console.log("本地开发模式：验证码会打印在终端，并返回到前端提示。");
    });
  })
  .catch((error) => {
    console.error("启动失败：", error);
    process.exit(1);
  });
