const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { URL } = require("url");
const Busboy = require("busboy");
const nodemailer = require("nodemailer");
const { ZipArchive } = require("archiver");
const ExcelJS = require("exceljs");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const STORE_FILE = path.resolve(process.env.MINIGAME_DATA_FILE || path.join(ROOT, "data", "minigame.json"));
const DATA_DIR = path.dirname(STORE_FILE);
const UPLOAD_DIR = path.resolve(process.env.MINIGAME_UPLOAD_DIR || path.join(DATA_DIR, "uploads"));
const PRIVATE_DOCUMENT_DIR = path.resolve(process.env.MINIGAME_PRIVATE_DOCUMENT_DIR || path.join(DATA_DIR, "private-documents"));
const UPLOAD_SESSION_DIR = path.resolve(process.env.MINIGAME_UPLOAD_SESSION_DIR || path.join(DATA_DIR, "upload-sessions"));
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
const MAX_VIDEO_BYTES = Math.max(10, Number(process.env.MAX_VIDEO_MB || 200)) * 1024 * 1024;
const MAX_GAME_FILE_BYTES = Math.max(100, Number(process.env.MAX_GAME_FILE_MB || 2048)) * 1024 * 1024;
const MAX_DEVELOPMENT_DOCUMENT_BYTES = Math.max(1, Number(process.env.MAX_DEVELOPMENT_DOCUMENT_MB || 200)) * 1024 * 1024;
const RESUMABLE_CHUNK_BYTES = Math.min(64, Math.max(1, Number(process.env.RESUMABLE_UPLOAD_CHUNK_MB || 8))) * 1024 * 1024;
const RESUMABLE_UPLOAD_TTL_MS = Math.max(1, Number(process.env.RESUMABLE_UPLOAD_TTL_HOURS || 48)) * 60 * 60 * 1000;
const UPLOAD_PER_REQUEST_BYTES_PER_SEC = Math.max(0, Number(process.env.UPLOAD_PER_REQUEST_MBIT || 150)) * 125000;
const UPLOAD_TOTAL_BYTES_PER_SEC = Math.max(0, Number(process.env.UPLOAD_TOTAL_MBIT || 180)) * 125000;
const VIDEO_RETENTION_MS = Math.max(1, Number(process.env.VIDEO_RETENTION_DAYS || 7)) * 24 * 60 * 60 * 1000;
const GAME_FILE_RETENTION_MS = Math.max(1, Number(process.env.GAME_FILE_RETENTION_DAYS || 2)) * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = Math.max(1, Number(process.env.SESSION_TTL_DAYS || 30)) * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === "true"
  || (process.env.SESSION_COOKIE_SECURE !== "false" && process.env.NODE_ENV === "production");
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
const exportTickets = new Map();

const DEVELOPMENT_DOCUMENT_EXTENSIONS = new Set([
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".pdf", ".txt", ".md", ".zip", ".7z", ".rar"
]);

const activeUploads = new Set();
const activeResumableUploads = new Set();

class FairUploadTransform extends Transform {
  constructor() {
    super();
    this.registered = false;
    this.nextAvailableAt = Date.now();
  }

  _transform(chunk, encoding, callback) {
    if (!this.registered) {
      this.registered = true;
      activeUploads.add(this);
    }
    const activeCount = Math.max(1, activeUploads.size);
    const sharedRate = UPLOAD_TOTAL_BYTES_PER_SEC > 0 ? UPLOAD_TOTAL_BYTES_PER_SEC / activeCount : Infinity;
    const rate = Math.min(UPLOAD_PER_REQUEST_BYTES_PER_SEC || Infinity, sharedRate);
    if (!Number.isFinite(rate)) return callback(null, chunk);
    const now = Date.now();
    const startsAt = Math.max(now, this.nextAvailableAt);
    this.nextAvailableAt = startsAt + (chunk.length / rate) * 1000;
    setTimeout(() => callback(null, chunk), Math.max(0, Math.ceil(startsAt - now)));
  }

  _destroy(error, callback) {
    activeUploads.delete(this);
    callback(error);
  }

  _flush(callback) {
    activeUploads.delete(this);
    callback();
  }
}

class ByteLimitTransform extends Transform {
  constructor(limit, message) {
    super();
    this.limit = limit;
    this.message = message;
    this.bytes = 0;
    this.exceeded = false;
  }

  _transform(chunk, encoding, callback) {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      this.exceeded = true;
      callback();
      return;
    }
    callback(null, chunk);
  }
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function isoAfter(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
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
      contribution: cleanMultilineText(creator?.contribution, 300),
      avatarUrl: cleanText(creator?.avatarUrl, 1000),
      order: Number.isFinite(Number(creator?.order)) ? Number(creator.order) : index
    };
  }).filter((creator) => creator.name).sort((a, b) => a.order - b.order);
}

function normalizeTeamMembers(value) {
  return (Array.isArray(value) ? value : []).slice(0, 12).map((member) => ({
    id: cleanText(member?.id, 80) || randomId(),
    email: normalizeEmail(member?.email),
    creatorId: cleanText(member?.creatorId, 80),
    active: member?.active !== false,
    addedAt: cleanText(member?.addedAt, 60) || new Date().toISOString(),
    removedAt: cleanText(member?.removedAt, 60),
    firstLoginAt: cleanText(member?.firstLoginAt, 60)
  })).filter((member) => isValidEmail(member.email));
}

function normalizeDevelopmentDocuments(value) {
  return (Array.isArray(value) ? value : []).map((document) => ({
    id: cleanText(document?.id, 80) || randomId(),
    originalName: cleanText(document?.originalName, 240) || "未命名资料",
    storageName: path.basename(cleanText(document?.storageName, 260)),
    mimeType: cleanText(document?.mimeType, 120) || "application/octet-stream",
    size: Math.max(0, Number(document?.size || 0)),
    sha256: cleanText(document?.sha256, 64),
    uploadedBy: normalizeEmail(document?.uploadedBy),
    uploadedAt: cleanText(document?.uploadedAt, 60),
    updatedAt: cleanText(document?.updatedAt, 60) || cleanText(document?.uploadedAt, 60)
  })).filter((document) => document.storageName && DEVELOPMENT_DOCUMENT_EXTENSIONS.has(path.extname(document.originalName).toLowerCase()));
}

function normalizeEmailVerification(value) {
  if (!value || typeof value !== "object") return null;
  const firstVerifiedAt = cleanText(value.firstVerifiedAt, 60);
  const lastVerifiedAt = cleanText(value.lastVerifiedAt, 60) || firstVerifiedAt;
  if (!firstVerifiedAt) return null;
  return { firstVerifiedAt, lastVerifiedAt };
}

function recordEmailVerification(store, email, verifiedAt) {
  const normalized = normalizeEmail(email);
  const timestamp = cleanText(verifiedAt, 60);
  if (!normalized || !timestamp) return null;
  store.emailVerifications ||= {};
  const current = normalizeEmailVerification(store.emailVerifications[normalized]);
  const times = [current?.firstVerifiedAt, current?.lastVerifiedAt, timestamp]
    .filter(Boolean)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const record = { firstVerifiedAt: times[0], lastVerifiedAt: times.at(-1) };
  store.emailVerifications[normalized] = record;
  return record;
}

function firstEmailVerificationAt(store, email) {
  return normalizeEmailVerification(store.emailVerifications?.[normalizeEmail(email)])?.firstVerifiedAt || "";
}

function backfillEmailVerifications(store) {
  store.emailVerifications = store.emailVerifications && typeof store.emailVerifications === "object" && !Array.isArray(store.emailVerifications)
    ? Object.fromEntries(Object.entries(store.emailVerifications)
      .map(([email, value]) => [normalizeEmail(email), normalizeEmailVerification(value)])
      .filter(([email, value]) => isValidEmail(email) && value))
    : {};
  for (const event of store.audit) {
    if (event?.action !== "session_verified") continue;
    recordEmailVerification(store, event.voterEmail || event.actorEmail, event.createdAt);
  }
  for (const session of Object.values(store.sessions)) {
    recordEmailVerification(store, session?.email, session?.createdAt);
  }
  for (const game of store.games) {
    for (const member of game.teamMembers) {
      member.firstLoginAt ||= firstEmailVerificationAt(store, member.email);
    }
  }
}

function normalizeAssetMeta(value) {
  if (!value || typeof value !== "object") return null;
  return {
    url: cleanAssetUrl(value.url),
    originalName: cleanText(value.originalName, 240),
    mimeType: cleanText(value.mimeType, 100),
    size: Math.max(0, Number(value.size || 0)),
    sha256: cleanText(value.sha256, 64),
    uploadedBy: normalizeEmail(value.uploadedBy),
    uploadedAt: cleanText(value.uploadedAt, 60) || new Date().toISOString(),
    deleteAfter: cleanText(value.deleteAfter, 60)
  };
}

function gameStatus(game) {
  if (["draft", "submitted", "withdrawn", "abandoned"].includes(game?.status)) return game.status;
  return game?.published ? "submitted" : "draft";
}

function isGamePublic(game) {
  return gameStatus(game) === "submitted" && game.published !== false;
}

function gameMemberEmails(game, { historical = false } = {}) {
  const emails = new Set();
  const owner = normalizeEmail(game.ownerEmail);
  if (owner) emails.add(owner);
  for (const member of normalizeTeamMembers(game.teamMembers)) {
    if (historical || member.active) emails.add(member.email);
  }
  if (historical) {
    for (const email of Array.isArray(game.historicalTeamEmails) ? game.historicalTeamEmails : []) {
      const normalized = normalizeEmail(email);
      if (normalized) emails.add(normalized);
    }
    for (const email of Array.isArray(game.historicalOwnerEmails) ? game.historicalOwnerEmails : []) {
      const normalized = normalizeEmail(email);
      if (normalized) emails.add(normalized);
    }
  }
  return emails;
}

function participantRole(game, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  if (normalizeEmail(game.ownerEmail) === normalized) return { role: "owner", member: null };
  const member = normalizeTeamMembers(game.teamMembers).find((item) => item.active && item.email === normalized);
  return member ? { role: "member", member } : null;
}

function participantGame(store, email) {
  for (const game of store.games) {
    const access = participantRole(game, email);
    if (access) return { game, ...access };
  }
  return null;
}

function isDiscardableDraft(game) {
  return gameStatus(game) === "draft" && !cleanText(game.firstSubmittedAt, 60) && !cleanText(game.submittedAt, 60);
}

function abandonDraftAndReleaseOwnership(game, { now = new Date().toISOString(), reason = "", actorType = "participant", actorId = "", actorEmail = "" } = {}) {
  const releasedEmails = [...gameMemberEmails(game)];
  const ownerEmail = normalizeEmail(game.ownerEmail);
  const members = normalizeTeamMembers(game.teamMembers);
  if (ownerEmail) game.historicalOwnerEmails = [...new Set([...(game.historicalOwnerEmails || []), ownerEmail])];
  for (const member of members) {
    if (member.email) game.historicalTeamEmails = [...new Set([...(game.historicalTeamEmails || []), member.email])];
    if (member.active) {
      member.active = false;
      member.removedAt = now;
    }
  }
  game.ownerEmail = "";
  game.ownerCreatorId = "";
  game.teamMembers = members;
  game.status = "abandoned";
  game.published = false;
  game.abandonedAt = now;
  game.abandonedReason = cleanText(reason, 500);
  game.abandonedBy = { type: actorType, id: cleanText(actorId, 100), email: normalizeEmail(actorEmail) };
  game.updatedAt = now;
  game.revision = Number(game.revision || 1) + 1;
  return releasedEmails;
}

function submissionDeadlineMs(settings) {
  return Date.parse(settings.submissionEndAt || settings.endAt || 0);
}

function isAfterSubmissionDeadline(settings, now = Date.now()) {
  const deadline = submissionDeadlineMs(settings);
  return Number.isFinite(deadline) && Math.floor(now / 1000) > Math.floor(deadline / 1000);
}

function markLateSubmission(store, game, reason, actor) {
  const now = new Date().toISOString();
  game.lateSubmission = true;
  game.lateMarkedAt = now;
  game.lateReasons = Array.isArray(game.lateReasons) ? game.lateReasons : [];
  game.lateReasons.push({ id: randomId(), reason, createdAt: now, actorEmail: normalizeEmail(actor?.email), actorType: actor?.type || "participant" });
  addAudit(store, {
    action: "game_marked_late",
    actorType: actor?.type || "participant",
    actorId: actor?.id || actor?.email || "system",
    actorEmail: normalizeEmail(actor?.email),
    gameId: game.id,
    reason,
    after: { lateSubmission: true }
  });
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
    version: 7,
    createdAt: new Date().toISOString(),
    games: [],
    ballots: [],
    ballotOperations: {},
    verificationCodes: {},
    sessions: {},
    emailVerifications: {},
    audit: [],
    retiredAssets: [],
    settings: {
      eventTitle: "溯造 MiniGame 游戏开发大赛",
      theme: "宇宙",
      slogan: "溯求本源，造物不止",
      eventSeed: crypto.randomBytes(12).toString("hex"),
      startAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      endAt: isoAfter(14),
      submissionEndAt: isoAfter(7),
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
  store.version = 7;
  store.games = (Array.isArray(store.games) ? store.games : empty.games).map((game) => {
    const status = gameStatus(game);
    const legacyVideo = cleanAssetUrl(game.videoUrl);
    const uploadedVideoUrl = cleanAssetUrl(game.uploadedVideoUrl) || (legacyVideo.startsWith("/uploads/") ? legacyVideo : "");
    const videoExternalUrl = cleanUrl(game.videoExternalUrl) || (!legacyVideo.startsWith("/uploads/") ? legacyVideo : "");
    const submittedAt = cleanText(game.submittedAt, 60) || (status === "submitted" ? cleanText(game.updatedAt || game.createdAt, 60) : "");
    const ownerEmail = normalizeEmail(game.ownerEmail);
    return {
      ...game,
      status,
      published: status === "submitted" && game.published !== false,
      ownerEmail,
      ownerCreatorId: cleanText(game.ownerCreatorId, 80),
      historicalOwnerEmails: [...new Set([ownerEmail, ...(Array.isArray(game.historicalOwnerEmails) ? game.historicalOwnerEmails : [])].map(normalizeEmail).filter(Boolean))],
      teamMembers: normalizeTeamMembers(game.teamMembers),
      historicalTeamEmails: [...new Set((Array.isArray(game.historicalTeamEmails) ? game.historicalTeamEmails : []).map(normalizeEmail).filter(Boolean))],
      firstSubmittedAt: cleanText(game.firstSubmittedAt, 60) || submittedAt,
      submittedAt,
      withdrawnAt: cleanText(game.withdrawnAt, 60),
      abandonedAt: cleanText(game.abandonedAt, 60),
      abandonedReason: cleanText(game.abandonedReason, 500),
      abandonedBy: game.abandonedBy && typeof game.abandonedBy === "object" ? {
        type: cleanText(game.abandonedBy.type, 30),
        id: cleanText(game.abandonedBy.id, 100),
        email: normalizeEmail(game.abandonedBy.email)
      } : null,
      lateSubmission: Boolean(game.lateSubmission),
      lateMarkedAt: cleanText(game.lateMarkedAt, 60),
      lateReasons: Array.isArray(game.lateReasons) ? game.lateReasons : [],
      revision: Math.max(1, Number(game.revision || 1)),
      uploadedVideoUrl,
      videoExternalUrl,
      videoUrl: uploadedVideoUrl || videoExternalUrl,
      downloadUrl: cleanAssetUrl(game.downloadUrl),
      assetMeta: game.assetMeta && typeof game.assetMeta === "object" ? game.assetMeta : {},
      assetHistory: Array.isArray(game.assetHistory) ? game.assetHistory : [],
      downloadHistory: Array.isArray(game.downloadHistory) ? game.downloadHistory : [],
      developmentDocuments: normalizeDevelopmentDocuments(game.developmentDocuments),
      creationNote: cleanMultilineText(game.creationNote, 600) || (game.isDemo ? cleanMultilineText(defaultDemoById.get(game.id)?.creationNote, 600) : ""),
      creators: normalizeCreators(game.creators),
      planetSeed: cleanText(game.planetSeed, 80) || crypto.createHash("sha256").update(String(game.id || randomId())).digest("hex").slice(0, 16)
    };
  });
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
  backfillEmailVerifications(store);
  store.retiredAssets = (Array.isArray(store.retiredAssets) ? store.retiredAssets : []).map(normalizeAssetMeta).filter((asset) => asset?.url);
  const previousSettings = store.settings && typeof store.settings === "object" ? store.settings : {};
  store.settings = { ...empty.settings, ...previousSettings };
  if (!previousSettings.submissionEndAt) store.settings.submissionEndAt = previousSettings.endAt || empty.settings.submissionEndAt;
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
  await fsp.mkdir(PRIVATE_DOCUMENT_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_SESSION_DIR, { recursive: true });
  try {
    const store = migrateStore(JSON.parse(await fsp.readFile(STORE_FILE, "utf8")));
    const expired = store.retiredAssets.filter((asset) => asset.deleteAfter && Date.parse(asset.deleteAfter) <= Date.now());
    if (expired.length) {
      await Promise.all(expired.map((asset) => removeLocalAsset(asset.url)));
      const expiredUrls = new Set(expired.map((asset) => asset.url));
      store.retiredAssets = store.retiredAssets.filter((asset) => !expiredUrls.has(asset.url));
      await writeStore(store);
    }
    return store;
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

function cleanMultilineText(value, maxLength = 200) {
  const normalized = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, maxLength);
  return normalized.trim() ? normalized : "";
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
  const secure = SESSION_COOKIE_SECURE ? "; Secure" : "";
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

function selfBlockedGameIds(store, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  return store.games.filter((game) => gameMemberEmails(game, { historical: true }).has(normalized)).map((game) => game.id);
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
    .filter(isGamePublic)
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
    .filter(isGamePublic)
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
      videoExternalUrl: game.videoExternalUrl || "",
      downloadUrl: game.downloadUrl ? `/api/games/${encodeURIComponent(game.id)}/download` : "",
      lateSubmission: Boolean(game.lateSubmission),
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
      endAt: store.settings.endAt,
      submissionEndAt: store.settings.submissionEndAt
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
    subject: "溯造 MiniGame 身份验证码",
    text: `${name}，你好。你的身份验证码是 ${code}，${Math.round(OTP_TTL_MS / 60000)} 分钟内有效。请勿转发给他人。`,
    html: `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;max-width:520px;margin:auto;padding:32px;color:#171717"><p style="font-size:14px">${escapeHtml(name)}，你好</p><h1 style="font-size:42px;letter-spacing:8px;margin:24px 0">${code}</h1><p style="line-height:1.7;color:#555">这是你的溯造 MiniGame 身份验证码，可用于投票或管理参展作品，${Math.round(OTP_TTL_MS / 60000)} 分钟内有效。请勿转发给他人。</p><p style="margin-top:30px;font-size:13px;color:#777">溯求本源，造物不止</p></div>`
  });
  return {};
}

async function deliverTeamInvitation({ email, name, eventTitle, gameTitle, ownerName, loginUrl }) {
  if (!smtpConfigured()) return { skipped: true };
  await getMailTransport().sendMail({
    from: process.env.MAIL_FROM,
    to: email,
    subject: `${eventTitle}：你已加入《${gameTitle}》制作队伍`,
    text: `${name}，你好。${ownerName} 已在${eventTitle}中将你加入《${gameTitle}》制作队伍。使用此邮箱登录后即可编辑作品。登录入口：${loginUrl}`,
    html: `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;max-width:560px;margin:auto;padding:32px;color:#171717"><p>${escapeHtml(name)}，你好。</p><p style="font-size:13px;color:#777">${escapeHtml(eventTitle)}</p><h1 style="font-size:26px;margin:22px 0">你已加入《${escapeHtml(gameTitle)}》</h1><p style="line-height:1.8;color:#555">${escapeHtml(ownerName)} 已将你加入作品制作队伍。无需接受邀请，使用此邮箱完成验证码登录后即可编辑作品。</p><p style="margin:28px 0"><a href="${escapeHtml(loginUrl)}" style="display:inline-block;padding:12px 18px;background:#b7d64a;color:#111;text-decoration:none">进入参赛作品工作台</a></p><p style="font-size:13px;color:#777">溯求本源，造物不止</p></div>`
  });
  return { skipped: false };
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

async function handleRequestCode(req, res) {
  const body = await readJson(req);
  const submittedName = cleanText(body.name, 30);
  const submittedTeam = cleanText(body.team, 50);
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) {
    return json(res, 400, { ok: false, error: "IDENTITY_REQUIRED", message: "请填写姓名、队伍和有效邮箱。" });
  }
  const store = await ensureStore();
  const invitedIdentity = membershipIdentity(store, email);
  const name = invitedIdentity?.name || submittedName;
  const team = invitedIdentity?.team || submittedTeam;
  if (!name || !team) {
    return json(res, 400, { ok: false, error: "IDENTITY_REQUIRED", message: "请填写姓名、队伍和有效邮箱。" });
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
      ip: sourceIp,
      resolvedName: name,
      resolvedTeam: team,
      identitySource: invitedIdentity ? "team_membership" : "submitted",
      invitedGameId: invitedIdentity?.gameId || "",
      invitedMemberId: invitedIdentity?.memberId || ""
    };
  });
  try {
    const delivery = await deliverCode({ email, name, code });
    return json(res, 200, {
      ok: true,
      message: invitedIdentity ? "检测到受邀制作人员身份，验证后将同步队伍资料。" : "验证码已发送，请检查邮箱。",
      invitedIdentityDetected: Boolean(invitedIdentity),
      expiresIn: Math.round(OTP_TTL_MS / 1000),
      ...delivery
    });
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
  const usesMembershipIdentity = record.identitySource === "team_membership";
  const resolvedName = usesMembershipIdentity ? cleanText(record.resolvedName, 40) : cleanText(name, 30);
  const resolvedTeam = usesMembershipIdentity ? cleanText(record.resolvedTeam, 60) : cleanText(team, 50);
  if (!resolvedName || !resolvedTeam) {
    const error = new Error("请完整填写身份信息。");
    error.status = 400;
    error.code = "IDENTITY_REQUIRED";
    throw error;
  }
  if (record.identityKey !== identityKey(resolvedName, resolvedTeam, email)) {
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
  return { ...record, resolvedName, resolvedTeam, usesMembershipIdentity };
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
}

function membershipIdentity(store, email) {
  const assigned = participantGame(store, email);
  if (!assigned || assigned.role !== "member" || !assigned.member?.active) return null;
  const creator = normalizeCreators(assigned.game.creators).find((item) => item.id === assigned.member.creatorId);
  const name = cleanText(creator?.name, 40);
  const team = cleanText(assigned.game.team, 60);
  if (!name || !team) return null;
  return {
    email: normalizeEmail(email),
    name,
    team,
    personKey: personKey(name, team),
    gameId: assigned.game.id,
    memberId: assigned.member.id
  };
}

function synchronizeMembershipIdentity(store, identity, actor = {}) {
  if (!identity?.email || !identity.name || !identity.team) return { ballot: null, invalidated: false, identityChanged: false };
  const email = normalizeEmail(identity.email);
  const now = new Date().toISOString();
  const nextPersonKey = personKey(identity.name, identity.team);
  const ballot = store.ballots.find((item) => normalizeEmail(item.email) === email) || null;
  const beforeIdentity = ballot
    ? { name: ballot.name, team: ballot.team, personKey: ballot.personKey }
    : Object.values(store.sessions).find((session) => normalizeEmail(session.email) === email)
      ? (() => {
          const session = Object.values(store.sessions).find((item) => normalizeEmail(item.email) === email);
          return { name: session.name, team: session.team, personKey: session.personKey };
        })()
      : null;
  const ballotBefore = ballot ? [...(ballot.gameIds || [])] : [];
  const invalidated = Boolean(ballot && identity.gameId && ballotBefore.includes(identity.gameId));
  const identityChanged = Boolean(beforeIdentity && (
    beforeIdentity.name !== identity.name
    || beforeIdentity.team !== identity.team
    || beforeIdentity.personKey !== nextPersonKey
  ));

  if (ballot) {
    if (invalidated) ballot.gameIds = ballotBefore.filter((id) => id !== identity.gameId);
    ballot.name = identity.name;
    ballot.team = identity.team;
    ballot.personKey = nextPersonKey;
    if (invalidated || identityChanged) {
      ballot.version = Number(ballot.version || 1) + 1;
      ballot.updatedAt = now;
    }
  }

  for (const session of Object.values(store.sessions)) {
    if (normalizeEmail(session.email) !== email) continue;
    session.name = identity.name;
    session.team = identity.team;
    session.personKey = nextPersonKey;
  }

  const pendingCode = store.verificationCodes?.[email];
  if (pendingCode) {
    pendingCode.identityKey = identityKey(identity.name, identity.team, email);
    pendingCode.personKey = nextPersonKey;
    pendingCode.resolvedName = identity.name;
    pendingCode.resolvedTeam = identity.team;
    pendingCode.identitySource = "team_membership";
    pendingCode.invitedGameId = identity.gameId;
    pendingCode.invitedMemberId = identity.memberId;
  }

  if (invalidated) {
    addAudit(store, {
      action: "ballot_invalidated_by_team_membership",
      actorType: "system",
      actorId: "system",
      actorEmail: normalizeEmail(actor.email),
      gameId: identity.gameId,
      memberId: identity.memberId,
      memberEmail: email,
      voterId: ballot.id,
      voterEmail: email,
      before: ballotBefore,
      after: [...ballot.gameIds]
    });
  }

  if (identityChanged) {
    addAudit(store, {
      action: "participant_identity_synchronized_by_team_membership",
      actorType: actor.type || "system",
      actorId: actor.id || "system",
      actorEmail: normalizeEmail(actor.email),
      gameId: identity.gameId,
      memberId: identity.memberId,
      memberEmail: email,
      before: beforeIdentity,
      after: { name: identity.name, team: identity.team, personKey: nextPersonKey }
    });
  }

  return { ballot, invalidated, identityChanged };
}

async function handleAuthVerify(req, res) {
  const body = await readJson(req);
  const submittedName = cleanText(body.name, 30);
  const submittedTeam = cleanText(body.team, 50);
  const email = normalizeEmail(body.email);
  const code = cleanText(body.code, 6);
  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
    return json(res, 400, { ok: false, error: "IDENTITY_REQUIRED", message: "请完整填写身份信息和 6 位验证码。" });
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const result = await mutateStore((store) => {
    const currentMembershipIdentity = membershipIdentity(store, email);
    if (currentMembershipIdentity) synchronizeMembershipIdentity(store, currentMembershipIdentity);
    const verification = verifyCode(store, { name: submittedName, team: submittedTeam, email, code });
    const name = verification.resolvedName;
    const team = verification.resolvedTeam;
    const key = personKey(name, team);
    const byEmail = store.ballots.find((ballot) => ballot.email === email);
    const byPerson = store.ballots.find((ballot) => ballot.personKey === key && ballot.email !== email);
    if (byPerson && !verification.usesMembershipIdentity) {
      const error = new Error("该姓名与队伍已经使用其他邮箱投票，请使用首次投票邮箱登录。");
      error.status = 409;
      error.code = "PERSON_ALREADY_VOTED";
      throw error;
    }
    if (byEmail && byEmail.personKey !== key && !verification.usesMembershipIdentity) {
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
    const emailVerification = recordEmailVerification(store, email, session.createdAt);
    for (const game of store.games) {
      const member = normalizeTeamMembers(game.teamMembers).find((item) => item.active && item.email === email);
      if (!member || member.firstLoginAt) continue;
      const storedMember = game.teamMembers.find((item) => item.id === member.id);
      if (storedMember) storedMember.firstLoginAt = emailVerification.firstVerifiedAt;
      addAudit(store, {
        action: "team_member_first_login",
        actorType: "participant",
        actorId: session.id,
        actorEmail: email,
        gameId: game.id,
        memberId: member.id
      });
    }
    delete store.verificationCodes[email];
    addAudit(store, { action: "session_verified", actorType: "voter", actorId: session.id, voterEmail: email });
    return { session, ballot: ballotPayload(byEmail), selfBlockedGameIds: selfBlockedGameIds(store, email) };
  });
  return json(res, 200, {
    ok: true,
    authenticated: true,
    identity: publicIdentity(result.session),
    ballot: result.ballot,
    selfBlockedGameIds: result.selfBlockedGameIds,
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
    ballot: ballotPayload(ballotForSession(store, record.session)),
    selfBlockedGameIds: selfBlockedGameIds(store, record.session.email)
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
    const publishedGames = store.games.filter(isGamePublic);
    const gameById = new Map(publishedGames.map((game) => [game.id, game]));
    if (gameIds.some((id) => !gameById.has(id))) {
      const error = new Error("选择中包含无效或已下架的游戏。");
      error.status = 400;
      error.code = "INVALID_GAME";
      throw error;
    }
    const voterEmail = normalizeEmail(record.session.email);
    const selfVoted = gameIds.map((id) => gameById.get(id)).find((game) => gameMemberEmails(game, { historical: true }).has(voterEmail));
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
  const submittedName = cleanText(body.name, 30);
  const submittedTeam = cleanText(body.team, 50);
  const email = normalizeEmail(body.email);
  const code = cleanText(body.code, 6);
  const gameIds = [...new Set(Array.isArray(body.gameIds) ? body.gameIds.map((id) => cleanText(id, 100)) : [])];
  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
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
      const validIds = new Set(store.games.filter(isGamePublic).map((game) => game.id));
      if (gameIds.some((id) => !validIds.has(id))) {
        const error = new Error("选择中包含无效或已下架的游戏。");
        error.status = 400;
        error.code = "INVALID_GAME";
        throw error;
      }
      const selfVoted = store.games.find((game) => gameIds.includes(game.id) && gameMemberEmails(game, { historical: true }).has(email));
      if (selfVoted) {
        const error = new Error(`你参与了《${selfVoted.title}》的制作，不能为自己的作品投票。`);
        error.status = 409;
        error.code = "SELF_VOTE";
        throw error;
      }
      const currentMembershipIdentity = membershipIdentity(store, email);
      if (currentMembershipIdentity) synchronizeMembershipIdentity(store, currentMembershipIdentity);
      const record = verifyCode(store, { name: submittedName, team: submittedTeam, email, code });
      const name = record.resolvedName;
      const team = record.resolvedTeam;
      const key = personKey(name, team);
      const byEmail = store.ballots.find((ballot) => ballot.email === email);
      const byPerson = store.ballots.find((ballot) => ballot.personKey === key && ballot.email !== email);
      if (byPerson && !record.usesMembershipIdentity) {
        const error = new Error("该姓名与队伍已经提交过选票。如需修改，请使用首次投票邮箱。" );
        error.status = 409;
        error.code = "PERSON_ALREADY_VOTED";
        throw error;
      }
      const nowIso = new Date().toISOString();
      if (byEmail) {
        if (byEmail.personKey !== key && !record.usesMembershipIdentity) {
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

function decodeMultipartFilename(value) {
  const input = String(value || "");
  if (!input || /[^\u0000-\u00ff]/.test(input)) return input;
  const decoded = Buffer.from(input, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? input : decoded;
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
        limits: { fields: 60, files: 15, fileSize: Math.max(MAX_COVER_BYTES, MAX_AVATAR_BYTES, MAX_VIDEO_BYTES, MAX_GAME_FILE_BYTES) }
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
      info.filename = decodeMultipartFilename(info.filename);
      const isCover = name === "cover";
      const isVideo = name === "video";
      const isGameFile = name === "gameFile";
      const isAvatar = /^avatar-\d{1,2}$/.test(name) || name === "profileAvatar";
      if ((!isCover && !isVideo && !isGameFile && !isAvatar) || !info.filename) {
        stream.resume();
        return;
      }
      const gameExtension = path.extname(info.filename || "").toLowerCase();
      const validType = isCover || isAvatar
        ? info.mimeType.startsWith("image/")
        : isVideo
          ? info.mimeType.startsWith("video/")
          : [".zip", ".7z", ".rar"].includes(gameExtension);
      if (!validType) {
        parseError = Object.assign(new Error(isCover
          ? "封面必须是图片文件。"
          : isAvatar
            ? "成员头像必须是图片文件。"
            : isVideo
              ? "演示文件必须是视频。"
              : "作品文件仅支持 ZIP、7Z 或 RAR 压缩包。"), { status: 400 });
        stream.resume();
        return;
      }
      const limit = isCover ? MAX_COVER_BYTES : isAvatar ? MAX_AVATAR_BYTES : isVideo ? MAX_VIDEO_BYTES : MAX_GAME_FILE_BYTES;
      let size = 0;
      const digest = crypto.createHash("sha256");
      const kind = isCover ? "cover" : isAvatar ? "avatar" : isVideo ? "video" : "game";
      const filename = `${kind}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}${isGameFile ? gameExtension : extensionFor(info.mimeType, info.filename)}`;
      const target = path.join(UPLOAD_DIR, filename);
      createdFiles.push(target);
      stream.on("data", (chunk) => {
        size += chunk.length;
        digest.update(chunk);
      });
      const limitMessage = isCover
        ? `封面不能超过 ${Math.round(MAX_COVER_BYTES / 1024 / 1024)}MB。`
        : isAvatar
          ? `成员头像不能超过 ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)}MB。`
          : isVideo
            ? `视频不能超过 ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)}MB。`
            : `作品文件不能超过 ${Math.round(MAX_GAME_FILE_BYTES / 1024 / 1024)}MB。`;
      const limiter = new ByteLimitTransform(limit, limitMessage);
      const task = pipeline(stream, limiter, fs.createWriteStream(target))
        .then(() => {
          if (limiter.exceeded || stream.truncated) {
            const error = new Error(limitMessage);
            error.status = 413;
            throw error;
          }
          files[name] = { url: `/uploads/${filename}`, target, mimeType: info.mimeType, originalName: info.filename, size, sha256: digest.digest("hex") };
        })
        .catch((error) => {
          parseError ||= error;
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
    const fairUpload = new FairUploadTransform();
    fairUpload.on("error", reject);
    req.pipe(fairUpload).pipe(busboy);
  });
}

async function parseDevelopmentDocumentsMultipart(req, maxFiles = 20) {
  await fsp.mkdir(PRIVATE_DOCUMENT_DIR, { recursive: true });
  return new Promise((resolve, reject) => {
    const documents = [];
    const tasks = [];
    const createdFiles = [];
    let parseError = null;
    let busboy;
    try {
      busboy = Busboy({ headers: req.headers, limits: { fields: 5, files: maxFiles, fileSize: MAX_DEVELOPMENT_DOCUMENT_BYTES } });
    } catch (error) {
      error.status = 400;
      reject(error);
      return;
    }
    busboy.on("file", (name, stream, info) => {
      info.filename = decodeMultipartFilename(info.filename);
      if (!info.filename || !["documents", "document"].includes(name)) {
        stream.resume();
        return;
      }
      const extension = path.extname(info.filename).toLowerCase();
      if (!DEVELOPMENT_DOCUMENT_EXTENSIONS.has(extension)) {
        parseError ||= Object.assign(new Error("开发文档格式不受支持。请上传 DOC/DOCX、XLS/XLSX、PPT/PPTX、PDF、TXT/MD、ZIP/7Z/RAR。"), { status: 415, code: "DEVELOPMENT_DOCUMENT_TYPE_INVALID" });
        stream.resume();
        return;
      }
      const storageName = `development-${Date.now()}-${crypto.randomBytes(10).toString("hex")}${extension}`;
      const target = path.join(PRIVATE_DOCUMENT_DIR, storageName);
      const digest = crypto.createHash("sha256");
      let size = 0;
      createdFiles.push(target);
      stream.on("data", (chunk) => { size += chunk.length; digest.update(chunk); });
      const limitMessage = `每份开发文档不能超过 ${Math.round(MAX_DEVELOPMENT_DOCUMENT_BYTES / 1024 / 1024)}MB。`;
      const limiter = new ByteLimitTransform(MAX_DEVELOPMENT_DOCUMENT_BYTES, limitMessage);
      const task = pipeline(stream, limiter, fs.createWriteStream(target)).then(() => {
        if (limiter.exceeded || stream.truncated) throw Object.assign(new Error(limitMessage), { status: 413, code: "DEVELOPMENT_DOCUMENT_TOO_LARGE" });
        documents.push({
          id: randomId(), originalName: cleanText(info.filename, 240), storageName,
          mimeType: cleanText(info.mimeType, 120) || "application/octet-stream", size, sha256: digest.digest("hex")
        });
      }).catch((error) => { parseError ||= error; });
      tasks.push(task);
    });
    busboy.on("filesLimit", () => { parseError ||= Object.assign(new Error(`一次最多上传 ${maxFiles} 份开发文档。`), { status: 400 }); });
    busboy.on("error", reject);
    busboy.on("close", async () => {
      try {
        await Promise.all(tasks);
        if (parseError) throw parseError;
        if (!documents.length) throw Object.assign(new Error("请选择需要上传的开发文档。"), { status: 400, code: "DEVELOPMENT_DOCUMENT_REQUIRED" });
        resolve({ documents, createdFiles });
      } catch (error) {
        await Promise.all(createdFiles.map((file) => fsp.unlink(file).catch(() => {})));
        reject(error);
      }
    });
    const fairUpload = new FairUploadTransform();
    fairUpload.on("error", reject);
    req.pipe(fairUpload).pipe(busboy);
  });
}

function privateDocumentPath(storageName) {
  const safeName = path.basename(cleanText(storageName, 260));
  const target = path.resolve(PRIVATE_DOCUMENT_DIR, safeName);
  return safeName && target.startsWith(`${PRIVATE_DOCUMENT_DIR}${path.sep}`) ? target : "";
}

async function removePrivateDocument(storageName) {
  const target = privateDocumentPath(storageName);
  if (target) await fsp.unlink(target).catch(() => {});
}

function resumableUploadSettings(kind, filename, mimeType) {
  const extension = path.extname(filename || "").toLowerCase();
  if (kind === "game") {
    if (![".zip", ".7z", ".rar"].includes(extension)) return null;
    return { limit: MAX_GAME_FILE_BYTES, destination: UPLOAD_DIR, prefix: "game", publicUrl: true };
  }
  if (kind === "video") {
    if (!String(mimeType || "").startsWith("video/")) return null;
    return { limit: MAX_VIDEO_BYTES, destination: UPLOAD_DIR, prefix: "video", publicUrl: true };
  }
  if (kind === "developmentDocument") {
    if (!DEVELOPMENT_DOCUMENT_EXTENSIONS.has(extension)) return null;
    return { limit: MAX_DEVELOPMENT_DOCUMENT_BYTES, destination: PRIVATE_DOCUMENT_DIR, prefix: "development", publicUrl: false };
  }
  return null;
}

function validResumableUploadId(value) {
  const id = cleanText(value, 100);
  return /^[a-f0-9-]{16,80}$/i.test(id) ? id : "";
}

function resumableUploadMetaPath(id) {
  const safeId = validResumableUploadId(id);
  return safeId ? path.join(UPLOAD_SESSION_DIR, `${safeId}.json`) : "";
}

function resumableUploadDataPath(id) {
  const safeId = validResumableUploadId(id);
  return safeId ? path.join(UPLOAD_SESSION_DIR, `${safeId}.part`) : "";
}

async function readResumableUpload(id) {
  const metaPath = resumableUploadMetaPath(id);
  if (!metaPath) return null;
  try {
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
    const safeId = validResumableUploadId(meta?.id);
    const settings = resumableUploadSettings(cleanText(meta?.kind, 40), cleanText(meta?.originalName, 240), cleanText(meta?.mimeType, 120));
    if (!safeId || safeId !== id || !settings) return null;
    const dataPath = resumableUploadDataPath(id);
    const stat = await fsp.stat(dataPath).catch(() => ({ size: 0 }));
    return {
      ...meta,
      id: safeId,
      originalName: cleanText(meta.originalName, 240),
      ownerEmail: normalizeEmail(meta.ownerEmail),
      size: Math.max(0, Number(meta.size || 0)),
      receivedBytes: Math.min(Math.max(0, Number(stat.size || 0)), Math.max(0, Number(meta.size || 0))),
      completed: Boolean(meta.completed),
      createdAt: cleanText(meta.createdAt, 60),
      updatedAt: cleanText(meta.updatedAt, 60),
      settings
    };
  } catch {
    return null;
  }
}

async function writeResumableUpload(meta) {
  const metaPath = resumableUploadMetaPath(meta?.id);
  if (!metaPath) throw Object.assign(new Error("上传会话无效。"), { status: 400 });
  const tempPath = `${metaPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, metaPath);
}

async function removeResumableUpload(meta) {
  await Promise.all([resumableUploadMetaPath(meta?.id), resumableUploadDataPath(meta?.id)].filter(Boolean).map((file) => fsp.unlink(file).catch(() => {})));
}

async function cleanExpiredResumableUploads() {
  const cutoff = Date.now() - RESUMABLE_UPLOAD_TTL_MS;
  const entries = await fsp.readdir(UPLOAD_SESSION_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -5);
    const meta = await readResumableUpload(id);
    if (!meta || Date.parse(meta.updatedAt || meta.createdAt || 0) < cutoff) await removeResumableUpload(meta || { id });
  }
}

function resumableUploadPayload(meta) {
  return {
    id: meta.id,
    kind: meta.kind,
    originalName: meta.originalName,
    size: meta.size,
    uploadedBytes: meta.receivedBytes,
    completed: Boolean(meta.completed),
    chunkBytes: RESUMABLE_CHUNK_BYTES,
    expiresAt: new Date(Date.parse(meta.updatedAt || meta.createdAt || Date.now()) + RESUMABLE_UPLOAD_TTL_MS).toISOString()
  };
}

async function requireResumableUpload(req, id) {
  const store = await ensureStore();
  const record = requireParticipantSession(store, req);
  const meta = await readResumableUpload(id);
  if (!meta || meta.ownerEmail !== normalizeEmail(record.session.email)) {
    const error = new Error("没有找到可继续的上传任务。请重新选择文件后开始上传。" );
    error.status = 404;
    error.code = "RESUMABLE_UPLOAD_NOT_FOUND";
    throw error;
  }
  if (Date.parse(meta.updatedAt || meta.createdAt || 0) + RESUMABLE_UPLOAD_TTL_MS < Date.now()) {
    await removeResumableUpload(meta);
    const error = new Error("上传任务已过期，请重新选择文件后开始上传。" );
    error.status = 410;
    error.code = "RESUMABLE_UPLOAD_EXPIRED";
    throw error;
  }
  return { record, meta };
}

async function materializeResumableUpload(id, ownerEmail, expectedKind) {
  const meta = await readResumableUpload(id);
  if (!meta || meta.ownerEmail !== normalizeEmail(ownerEmail) || meta.kind !== expectedKind || !meta.completed || meta.receivedBytes !== meta.size) {
    const error = new Error("上传文件尚未完成，请继续上传后再保存作品。" );
    error.status = 409;
    error.code = "RESUMABLE_UPLOAD_INCOMPLETE";
    throw error;
  }
  const extension = path.extname(meta.originalName).toLowerCase() || extensionFor(meta.mimeType, meta.originalName);
  const filename = `${meta.settings.prefix}-${Date.now()}-${crypto.randomBytes(10).toString("hex")}${extension}`;
  const source = resumableUploadDataPath(meta.id);
  const target = path.join(meta.settings.destination, filename);
  try {
    await fsp.link(source, target);
  } catch {
    await fsp.copyFile(source, target);
  }
  return {
    meta,
    target,
    file: {
      ...(meta.settings.publicUrl ? { url: `/uploads/${filename}` } : { storageName: filename }),
      target,
      mimeType: meta.mimeType,
      originalName: meta.originalName,
      size: meta.size,
      sha256: meta.sha256 || ""
    }
  };
}

async function finalizeResumableUploads(items) {
  await Promise.all((items || []).map((item) => removeResumableUpload(item.meta)));
}

async function attachResumableFilesToParsed(parsed, email) {
  const items = [];
  const gameUploadId = validResumableUploadId(parsed.fields.resumableGameFileId);
  const videoUploadId = validResumableUploadId(parsed.fields.resumableVideoId);
  if (gameUploadId) {
    const item = await materializeResumableUpload(gameUploadId, email, "game");
    parsed.files.gameFile = item.file;
    parsed.createdFiles.push(item.target);
    items.push(item);
  }
  if (videoUploadId) {
    const item = await materializeResumableUpload(videoUploadId, email, "video");
    parsed.files.video = item.file;
    parsed.createdFiles.push(item.target);
    items.push(item);
  }
  return items;
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
    const contribution = creator && typeof creator === "object" && Object.hasOwn(creator, "contribution")
      ? cleanMultilineText(creator.contribution, 300)
      : old?.contribution || "";
    return {
      id: cleanText(creator?.id, 80) || creatorId(name, role, index),
      name,
      role,
      contribution,
      avatarUrl: files[`avatar-${index}`]?.url || cleanAssetUrl(creator?.avatarUrl) || old?.avatarUrl || "",
      order: index
    };
  }).filter((creator) => creator.name);
}

function fileAssetMeta(file, uploadedBy = "") {
  if (!file) return null;
  return {
    url: file.url,
    originalName: cleanText(file.originalName, 240),
    mimeType: cleanText(file.mimeType, 100),
    size: Math.max(0, Number(file.size || 0)),
    sha256: cleanText(file.sha256, 64),
    uploadedBy: normalizeEmail(uploadedBy),
    uploadedAt: new Date().toISOString()
  };
}

function gameFromFields(fields, files, existing = null, options = {}) {
  const title = cleanText(fields.title, 60);
  const team = cleanText(fields.team, 60);
  const shortDescription = cleanText(fields.shortDescription, 120);
  if (!title || (!options.allowDraft && (!team || !shortDescription))) {
    const error = new Error("游戏名称、制作团队和一句话介绍不能为空。" );
    error.status = 400;
    throw error;
  }
  const now = new Date().toISOString();
  const tags = cleanText(fields.tags, 120).split(/[,，]/).map((tag) => cleanText(tag, 16)).filter(Boolean).slice(0, 4);
  const creators = creatorsFromFields(fields, files, existing);
  const hasCoverUrl = Object.hasOwn(fields, "coverUrl");
  const hasDownloadUrl = Object.hasOwn(fields, "downloadUrl");
  const hasVideoExternalUrl = Object.hasOwn(fields, "videoExternalUrl") || Object.hasOwn(fields, "videoUrl");
  const uploadedVideoUrl = files.video?.url
    || (fields.removeUploadedVideo === "true" ? "" : cleanAssetUrl(existing?.uploadedVideoUrl || (String(existing?.videoUrl || "").startsWith("/uploads/") ? existing.videoUrl : "")));
  const videoExternalInput = Object.hasOwn(fields, "videoExternalUrl") ? fields.videoExternalUrl : fields.videoUrl;
  const videoExternalUrl = hasVideoExternalUrl
    ? cleanUrl(videoExternalInput)
    : cleanUrl(existing?.videoExternalUrl || (!String(existing?.videoUrl || "").startsWith("/uploads/") ? existing?.videoUrl : ""));
  const assetMeta = { ...(existing?.assetMeta || {}) };
  if (files.cover) assetMeta.cover = fileAssetMeta(files.cover, options.actorEmail);
  if (files.video) assetMeta.video = fileAssetMeta(files.video, options.actorEmail);
  if (files.gameFile) assetMeta.gameFile = fileAssetMeta(files.gameFile, options.actorEmail);
  return {
    id: existing?.id || `${title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "game"}-${crypto.randomBytes(3).toString("hex")}`,
    title,
    team,
    shortDescription,
    description: cleanMultilineText(fields.description, 1200),
    creationNote: cleanMultilineText(fields.creationNote, 600),
    creators,
    coverUrl: files.cover?.url || (hasCoverUrl ? cleanAssetUrl(fields.coverUrl) : cleanAssetUrl(existing?.coverUrl)) || "",
    uploadedVideoUrl,
    videoExternalUrl,
    videoUrl: uploadedVideoUrl || videoExternalUrl,
    downloadUrl: files.gameFile?.url || (hasDownloadUrl ? cleanAssetUrl(fields.downloadUrl) : cleanAssetUrl(existing?.downloadUrl)),
    tags,
    featured: fields.featured === "true" || fields.featured === "on",
    published: options.preservePublication ? Boolean(existing?.published) : fields.published === "true" || fields.published === "on",
    order: Number.isFinite(Number(fields.order)) ? Number(fields.order) : Number(existing?.order || 100),
    planetSeed: existing?.planetSeed || crypto.createHash("sha256").update(`${title}:${team}:${Date.now()}`).digest("hex").slice(0, 16),
    coordinate: existing?.coordinate || null,
    status: existing ? gameStatus(existing) : "draft",
    ownerEmail: normalizeEmail(existing?.ownerEmail),
    ownerCreatorId: cleanText(existing?.ownerCreatorId, 80),
    historicalOwnerEmails: Array.isArray(existing?.historicalOwnerEmails) ? existing.historicalOwnerEmails : [],
    teamMembers: normalizeTeamMembers(existing?.teamMembers),
    historicalTeamEmails: Array.isArray(existing?.historicalTeamEmails) ? existing.historicalTeamEmails : [],
    firstSubmittedAt: cleanText(existing?.firstSubmittedAt, 60),
    submittedAt: cleanText(existing?.submittedAt, 60),
    withdrawnAt: cleanText(existing?.withdrawnAt, 60),
    abandonedAt: cleanText(existing?.abandonedAt, 60),
    abandonedReason: cleanText(existing?.abandonedReason, 500),
    abandonedBy: existing?.abandonedBy && typeof existing.abandonedBy === "object" ? { ...existing.abandonedBy } : null,
    lateSubmission: Boolean(existing?.lateSubmission),
    lateMarkedAt: cleanText(existing?.lateMarkedAt, 60),
    lateReasons: Array.isArray(existing?.lateReasons) ? existing.lateReasons : [],
    revision: Math.max(1, Number(existing?.revision || 0) + 1),
    assetMeta,
    assetHistory: Array.isArray(existing?.assetHistory) ? existing.assetHistory : [],
    downloadHistory: Array.isArray(existing?.downloadHistory) ? existing.downloadHistory : [],
    developmentDocuments: normalizeDevelopmentDocuments(existing?.developmentDocuments),
    isDemo: false,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

function gameAuditSnapshot(game) {
  return {
    title: game.title,
    team: game.team,
    shortDescription: game.shortDescription,
    description: game.description,
    creationNote: game.creationNote,
    creators: normalizeCreators(game.creators),
    coverUrl: game.coverUrl,
    uploadedVideoUrl: game.uploadedVideoUrl || "",
    videoExternalUrl: game.videoExternalUrl || "",
    downloadUrl: game.downloadUrl,
    gameFileMeta: game.assetMeta?.gameFile || null,
    tags: game.tags || [],
    status: gameStatus(game),
    published: Boolean(game.published),
    ownerEmail: normalizeEmail(game.ownerEmail),
    teamMembers: normalizeTeamMembers(game.teamMembers),
    firstSubmittedAt: cleanText(game.firstSubmittedAt, 60),
    submittedAt: cleanText(game.submittedAt, 60),
    abandonedAt: cleanText(game.abandonedAt, 60),
    abandonedReason: cleanText(game.abandonedReason, 500),
    lateSubmission: Boolean(game.lateSubmission),
    revision: Number(game.revision || 1)
  };
}

function changedGameFields(before, after) {
  const changes = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after[key])) changes[key] = { before: before?.[key], after: after[key] };
  }
  return changes;
}

function submissionMissingFields(game) {
  const missing = [];
  if (!cleanText(game.title, 60)) missing.push("游戏名称");
  if (!cleanText(game.team, 60)) missing.push("队伍名称");
  if (!cleanMultilineText(game.description, 1200)) missing.push("游戏简介");
  if (!cleanAssetUrl(game.coverUrl)) missing.push("游戏封面");
  if (!cleanAssetUrl(game.uploadedVideoUrl) && !cleanUrl(game.videoExternalUrl)) missing.push("演示视频");
  if (!cleanAssetUrl(game.downloadUrl)) missing.push("作品文件");
  if (!normalizeCreators(game.creators).length) missing.push("制作人员");
  return missing;
}

function participantGamePayload(game, access, settings) {
  if (!game) return null;
  return {
    ...gameAuditSnapshot(game),
    id: game.id,
    coordinate: game.coordinate,
    planetSeed: game.planetSeed,
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
    firstSubmittedAt: game.firstSubmittedAt || "",
    submittedAt: game.submittedAt || "",
    withdrawnAt: game.withdrawnAt || "",
    developmentDocuments: normalizeDevelopmentDocuments(game.developmentDocuments),
    lateMarkedAt: game.lateMarkedAt || "",
    role: access.role,
    editableCreatorId: access.member?.creatorId || game.ownerCreatorId || "",
    submissionEndAt: settings.submissionEndAt,
    afterSubmissionDeadline: isAfterSubmissionDeadline(settings),
    missingFields: submissionMissingFields(game)
  };
}

function scheduleReplacedAssets(store, existing, updated, files, actorEmail = "") {
  const now = new Date().toISOString();
  updated.assetHistory = Array.isArray(existing.assetHistory) ? [...existing.assetHistory] : [];
  if (files.cover && existing.assetMeta?.cover) updated.assetHistory.push({ kind: "cover", ...existing.assetMeta.cover, replacedAt: now });
  if ((files.video || existing.uploadedVideoUrl !== updated.uploadedVideoUrl) && existing.assetMeta?.video) {
    const retired = { kind: "video", ...existing.assetMeta.video, replacedAt: now, deleteAfter: new Date(Date.now() + VIDEO_RETENTION_MS).toISOString() };
    updated.assetHistory.push(retired);
    if (retired.url?.startsWith("/uploads/")) store.retiredAssets.push(retired);
  }
  if (files.gameFile && existing.assetMeta?.gameFile) {
    const retired = { kind: "gameFile", ...existing.assetMeta.gameFile, replacedAt: now, deleteAfter: new Date(Date.now() + GAME_FILE_RETENTION_MS).toISOString() };
    updated.assetHistory.push(retired);
    if (retired.url?.startsWith("/uploads/")) store.retiredAssets.push(retired);
  }
  for (const [name, file] of Object.entries(files)) {
    if (!/^avatar-\d{1,2}$/.test(name)) continue;
    const index = Number(name.split("-")[1]);
    const oldCreator = normalizeCreators(existing.creators)[index];
    if (oldCreator?.avatarUrl) updated.assetHistory.push({ kind: "avatar", url: oldCreator.avatarUrl, creatorId: oldCreator.id, replacedAt: now });
    const creator = normalizeCreators(updated.creators)[index];
    if (creator) {
      updated.assetMeta.avatars ||= {};
      updated.assetMeta.avatars[creator.id] = fileAssetMeta(file, actorEmail);
    }
  }
}

async function removeLocalAsset(url) {
  if (!String(url || "").startsWith("/uploads/")) return;
  const target = path.resolve(UPLOAD_DIR, path.basename(url));
  if (target.startsWith(UPLOAD_DIR)) await fsp.unlink(target).catch(() => {});
}

function requireParticipantSession(store, req) {
  const record = sessionRecord(store, req);
  if (!record) {
    const error = new Error("登录状态已失效，请重新完成邮箱验证。");
    error.status = 401;
    error.code = "LOGIN_REQUIRED";
    throw error;
  }
  return record;
}

function requestOrigin(req) {
  const protocol = cleanText(req.headers["x-forwarded-proto"], 12) || (SESSION_COOKIE_SECURE ? "https" : "http");
  const host = cleanText(req.headers["x-forwarded-host"] || req.headers.host, 200) || `localhost:${PORT}`;
  return `${protocol}://${host.split(",")[0].trim()}`;
}

async function handleCreateResumableUpload(req, res) {
  const store = await ensureStore();
  const record = requireParticipantSession(store, req);
  const body = await readJson(req);
  const kind = cleanText(body.kind, 40);
  const originalName = decodeMultipartFilename(cleanText(body.originalName, 240));
  const mimeType = cleanText(body.mimeType, 120) || "application/octet-stream";
  const size = Math.max(0, Number(body.size || 0));
  const settings = resumableUploadSettings(kind, originalName, mimeType);
  if (!settings || !Number.isSafeInteger(size) || size < 1 || size > settings.limit) {
    return json(res, 400, { ok: false, error: "RESUMABLE_UPLOAD_INVALID", message: "文件类型或大小不符合上传要求。" });
  }
  const resumeId = validResumableUploadId(body.resumeId);
  if (resumeId) {
    const existing = await readResumableUpload(resumeId);
    if (existing && existing.ownerEmail === normalizeEmail(record.session.email)
      && existing.kind === kind && existing.originalName === originalName && existing.size === size && existing.mimeType === mimeType) {
      return json(res, 200, { ok: true, upload: resumableUploadPayload(existing), resumed: true });
    }
  }
  await cleanExpiredResumableUploads();
  const now = new Date().toISOString();
  const meta = {
    id: randomId(), ownerEmail: record.session.email, kind, originalName, mimeType, size,
    receivedBytes: 0, completed: false, sha256: "", createdAt: now, updatedAt: now
  };
  await fsp.writeFile(resumableUploadDataPath(meta.id), Buffer.alloc(0));
  await writeResumableUpload(meta);
  return json(res, 201, { ok: true, upload: resumableUploadPayload(meta), resumed: false });
}

async function handleResumableUploadStatus(req, res, id) {
  const { meta } = await requireResumableUpload(req, id);
  return json(res, 200, { ok: true, upload: resumableUploadPayload(meta) });
}

async function handleResumableUploadChunk(req, res, id) {
  const { meta } = await requireResumableUpload(req, id);
  if (meta.completed) return json(res, 409, { ok: false, error: "RESUMABLE_UPLOAD_COMPLETED", message: "该文件已上传完成。" });
  if (activeResumableUploads.has(meta.id)) return json(res, 409, { ok: false, error: "RESUMABLE_UPLOAD_BUSY", message: "该文件正在写入上一段数据，请稍后重试。" });
  const offset = Number(req.headers["x-upload-offset"]);
  if (!Number.isSafeInteger(offset) || offset !== meta.receivedBytes) {
    return json(res, 409, { ok: false, error: "RESUMABLE_UPLOAD_OFFSET_CONFLICT", message: "上传进度已变化，请从服务器记录的位置继续。", upload: resumableUploadPayload(meta) });
  }
  const remaining = meta.size - meta.receivedBytes;
  const maximumChunkLength = Math.min(RESUMABLE_CHUNK_BYTES, remaining);
  const declaredLength = req.headers["content-length"] === undefined ? null : Number(req.headers["content-length"]);
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > maximumChunkLength)) {
    return json(res, 400, { ok: false, error: "RESUMABLE_UPLOAD_CHUNK_INVALID", message: "上传分片大小无效。" });
  }
  const dataPath = resumableUploadDataPath(meta.id);
  activeResumableUploads.add(meta.id);
  try {
    const limiter = new ByteLimitTransform(maximumChunkLength, "上传分片超过预期大小。");
    await pipeline(req, new FairUploadTransform(), limiter, fs.createWriteStream(dataPath, { flags: "a" }));
    if (limiter.exceeded) throw Object.assign(new Error("上传分片超过预期大小。"), { status: 413 });
    const stat = await fsp.stat(dataPath);
    const receivedLength = stat.size - offset;
    if (receivedLength < 1 || receivedLength > maximumChunkLength || (declaredLength !== null && receivedLength !== declaredLength) || stat.size > meta.size) {
      throw Object.assign(new Error("上传分片长度不一致。"), { status: 409 });
    }
    meta.receivedBytes = stat.size;
    meta.updatedAt = new Date().toISOString();
    await writeResumableUpload(meta);
    return json(res, 200, { ok: true, upload: resumableUploadPayload(meta) });
  } catch (error) {
    await fsp.truncate(dataPath, offset).catch(() => {});
    throw error;
  } finally {
    activeResumableUploads.delete(meta.id);
  }
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

async function handleCompleteResumableUpload(req, res, id) {
  await readJson(req).catch(() => ({}));
  const { meta } = await requireResumableUpload(req, id);
  const dataPath = resumableUploadDataPath(meta.id);
  const stat = await fsp.stat(dataPath).catch(() => ({ size: 0 }));
  if (stat.size !== meta.size) {
    meta.receivedBytes = Math.min(stat.size, meta.size);
    meta.updatedAt = new Date().toISOString();
    await writeResumableUpload(meta);
    return json(res, 409, { ok: false, error: "RESUMABLE_UPLOAD_INCOMPLETE", message: "文件尚未传完，请继续上传。", upload: resumableUploadPayload(meta) });
  }
  if (!meta.completed) {
    meta.sha256 = await sha256File(dataPath);
    meta.completed = true;
    meta.updatedAt = new Date().toISOString();
    await writeResumableUpload(meta);
  }
  return json(res, 200, { ok: true, upload: resumableUploadPayload(meta) });
}

async function handleParticipantWorkspace(req, res) {
  const store = await ensureStore();
  const record = requireParticipantSession(store, req);
  const access = participantGame(store, record.session.email);
  return json(res, 200, {
    ok: true,
    identity: publicIdentity(record.session),
    canCreate: !access,
    game: access ? participantGamePayload(access.game, access, store.settings) : null,
    settings: {
      submissionEndAt: store.settings.submissionEndAt,
      votingStartAt: store.settings.startAt,
      votingEndAt: store.settings.endAt,
      timeZone: TZ,
      maxVideoBytes: MAX_VIDEO_BYTES,
      maxGameFileBytes: MAX_GAME_FILE_BYTES,
      maxDevelopmentDocumentBytes: MAX_DEVELOPMENT_DOCUMENT_BYTES,
      videoRetentionDays: Math.round(VIDEO_RETENTION_MS / 86400000)
    }
  });
}

async function handleParticipantCreateGame(req, res) {
  const parsed = await parseGameMultipart(req);
  try {
    const created = await mutateStore((store) => {
      const record = requireParticipantSession(store, req);
      if (participantGame(store, record.session.email)) {
        const error = new Error("每个邮箱只能负责或加入一款参展作品。");
        error.status = 409;
        error.code = "PARTICIPANT_ALREADY_ASSIGNED";
        throw error;
      }
      parsed.fields.team ||= record.session.team;
      const game = gameFromFields(parsed.fields, parsed.files, null, { allowDraft: true, actorEmail: record.session.email });
      const ownerCreator = { id: randomId(), name: record.session.name, role: "负责人", contribution: "", avatarUrl: "", order: 0 };
      game.creators = [ownerCreator];
      game.ownerEmail = record.session.email;
      game.ownerCreatorId = ownerCreator.id;
      game.status = "draft";
      game.published = false;
      game.teamMembers = [];
      game.historicalTeamEmails = [];
      game.historicalOwnerEmails = [record.session.email];
      game.coordinate = coordinateForGame(game.id, store.settings.eventSeed, store.games);
      store.games.push(game);
      addAudit(store, {
        action: "game_draft_created",
        actorType: "participant",
        actorId: record.session.id,
        actorEmail: record.session.email,
        gameId: game.id,
        after: gameAuditSnapshot(game)
      });
      return { game, access: { role: "owner", member: null } };
    });
    return json(res, 201, { ok: true, game: participantGamePayload(created.game, created.access, (await ensureStore()).settings), message: "作品草稿已建立。" });
  } catch (error) {
    await Promise.all(parsed.createdFiles.map((file) => fsp.unlink(file).catch(() => {})));
    throw error;
  }
}

async function handleParticipantUpdateGame(req, res, id) {
  const parsed = await parseGameMultipart(req);
  let resumableItems = [];
  try {
    const preflightStore = await ensureStore();
    const preflightRecord = requireParticipantSession(preflightStore, req);
    const preflightGame = preflightStore.games.find((game) => game.id === id);
    if (!preflightGame || !participantRole(preflightGame, preflightRecord.session.email)) {
      const error = new Error("权限已变更，你已不能修改这款作品。" );
      error.status = 403;
      error.code = "PARTICIPANT_PERMISSION_CHANGED";
      throw error;
    }
    resumableItems = await attachResumableFilesToParsed(parsed, preflightRecord.session.email);
    const result = await mutateStore((store) => {
      const record = requireParticipantSession(store, req);
      const index = store.games.findIndex((game) => game.id === id);
      if (index < 0) {
        const error = new Error("没有找到这款作品。");
        error.status = 404;
        throw error;
      }
      const existing = store.games[index];
      const access = participantRole(existing, record.session.email);
      if (!access) {
        const error = new Error("权限已变更，你已不能修改这款作品。");
        error.status = 403;
        error.code = "PARTICIPANT_PERMISSION_CHANGED";
        throw error;
      }
      const expectedRevision = Number(parsed.fields.revision || 0);
      if (expectedRevision && expectedRevision !== Number(existing.revision || 1)) {
        const error = new Error("作品已在另一个页面更新，请刷新后重试。");
        error.status = 409;
        error.code = "GAME_REVISION_CONFLICT";
        error.details = { game: participantGamePayload(existing, access, store.settings) };
        throw error;
      }
      parsed.fields.creatorsJson = JSON.stringify(existing.creators || []);
      const before = gameAuditSnapshot(existing);
      const updated = gameFromFields(parsed.fields, parsed.files, existing, {
        allowDraft: true,
        preservePublication: true,
        actorEmail: record.session.email
      });
      updated.status = gameStatus(existing);
      updated.published = isGamePublic(existing);
      const downloadChanged = cleanAssetUrl(existing.downloadUrl) !== cleanAssetUrl(updated.downloadUrl);
      if (downloadChanged && existing.firstSubmittedAt && isAfterSubmissionDeadline(store.settings)) {
        if (parsed.fields.confirmLateDownload !== "true") {
          const error = new Error("截止后替换作品文件会永久产生补交标记，请确认后再次保存。");
          error.status = 409;
          error.code = "LATE_DOWNLOAD_CONFIRM_REQUIRED";
          throw error;
        }
        markLateSubmission(store, updated, "download_url_changed_after_deadline", { type: "participant", id: record.session.id, email: record.session.email });
      }
      if (downloadChanged) {
        updated.downloadHistory = [...(existing.downloadHistory || []), {
          id: randomId(),
          before: cleanAssetUrl(existing.downloadUrl),
          after: cleanAssetUrl(updated.downloadUrl),
          actorEmail: record.session.email,
          createdAt: new Date().toISOString()
        }];
      }
      scheduleReplacedAssets(store, existing, updated, parsed.files, record.session.email);
      const after = gameAuditSnapshot(updated);
      const changes = changedGameFields(before, after);
      store.games[index] = updated;
      addAudit(store, {
        action: "game_content_updated",
        actorType: "participant",
        actorId: record.session.id,
        actorEmail: record.session.email,
        gameId: id,
        before,
        after,
        changes
      });
      if (cleanText(existing.team, 60) !== cleanText(updated.team, 60) && cleanText(updated.team, 60)) {
        const creators = normalizeCreators(updated.creators);
        for (const member of normalizeTeamMembers(updated.teamMembers).filter((item) => item.active)) {
          const creator = creators.find((item) => item.id === member.creatorId);
          if (!creator?.name) continue;
          synchronizeMembershipIdentity(store, {
            email: member.email,
            name: creator.name,
            team: cleanText(updated.team, 60),
            personKey: personKey(creator.name, updated.team),
            gameId: updated.id,
            memberId: member.id
          }, { type: "participant", id: record.session.id, email: record.session.email });
        }
      }
      return { game: updated, access };
    });
    await finalizeResumableUploads(resumableItems);
    const store = await ensureStore();
    return json(res, 200, { ok: true, game: participantGamePayload(result.game, result.access, store.settings), message: "作品详情已保存。" });
  } catch (error) {
    await Promise.all(parsed.createdFiles.map((file) => fsp.unlink(file).catch(() => {})));
    throw error;
  }
}

async function handleParticipantSubmitGame(req, res, id) {
  const result = await mutateStore((store) => {
    const record = requireParticipantSession(store, req);
    const game = store.games.find((item) => item.id === id);
    if (!game) {
      const error = new Error("没有找到这款作品。");
      error.status = 404;
      throw error;
    }
    const access = participantRole(game, record.session.email);
    if (!access || access.role !== "owner") {
      const error = new Error("只有作品负责人可以提交参展。");
      error.status = 403;
      throw error;
    }
    if (gameStatus(game) === "submitted") {
      const error = new Error("作品已经提交参展。");
      error.status = 409;
      throw error;
    }
    const missing = submissionMissingFields(game);
    if (missing.length) {
      const error = new Error(`提交前请补充：${missing.join("、")}。`);
      error.status = 400;
      error.code = "SUBMISSION_INCOMPLETE";
      error.details = { missingFields: missing };
      throw error;
    }
    const now = new Date().toISOString();
    const before = gameAuditSnapshot(game);
    game.status = "submitted";
    game.published = true;
    game.firstSubmittedAt ||= now;
    game.submittedAt = now;
    game.withdrawnAt = "";
    game.updatedAt = now;
    game.revision = Number(game.revision || 1) + 1;
    if (isAfterSubmissionDeadline(store.settings)) {
      markLateSubmission(store, game, before.status === "withdrawn" ? "resubmitted_after_deadline" : "submitted_after_deadline", {
        type: "participant",
        id: record.session.id,
        email: record.session.email
      });
    }
    addAudit(store, {
      action: before.status === "withdrawn" ? "game_resubmitted" : "game_submitted",
      actorType: "participant",
      actorId: record.session.id,
      actorEmail: record.session.email,
      gameId: id,
      before,
      after: gameAuditSnapshot(game)
    });
    return { game, access };
  });
  const store = await ensureStore();
  return json(res, 200, { ok: true, game: participantGamePayload(result.game, result.access, store.settings), message: result.game.lateSubmission ? "作品已提交，并标记为补交。" : "作品已提交参展并立即公开。" });
}

async function handleParticipantWithdrawGame(req, res, id) {
  const result = await mutateStore((store) => {
    const record = requireParticipantSession(store, req);
    const game = store.games.find((item) => item.id === id);
    if (!game) {
      const error = new Error("没有找到这款作品。");
      error.status = 404;
      throw error;
    }
    const access = participantRole(game, record.session.email);
    if (!access || access.role !== "owner") {
      const error = new Error("只有作品负责人可以撤回作品。");
      error.status = 403;
      throw error;
    }
    if (gameStatus(game) !== "submitted") {
      const error = new Error("当前作品不在公开参展状态。");
      error.status = 409;
      throw error;
    }
    const now = new Date().toISOString();
    const before = gameAuditSnapshot(game);
    game.status = "withdrawn";
    game.published = false;
    game.withdrawnAt = now;
    game.updatedAt = now;
    game.revision = Number(game.revision || 1) + 1;
    for (const ballot of store.ballots) {
      if (!ballot.gameIds.includes(id)) continue;
      const ballotBefore = [...ballot.gameIds];
      ballot.gameIds = ballot.gameIds.filter((gameId) => gameId !== id);
      ballot.version = Number(ballot.version || 1) + 1;
      ballot.updatedAt = now;
      addAudit(store, {
        action: "ballot_invalidated_by_game_withdrawal",
        actorType: "system",
        actorId: "system",
        gameId: id,
        voterId: ballot.id,
        voterEmail: ballot.email,
        before: ballotBefore,
        after: [...ballot.gameIds]
      });
    }
    addAudit(store, {
      action: "game_withdrawn",
      actorType: "participant",
      actorId: record.session.id,
      actorEmail: record.session.email,
      gameId: id,
      before,
      after: gameAuditSnapshot(game)
    });
    return { game, access };
  });
  const store = await ensureStore();
  return json(res, 200, { ok: true, game: participantGamePayload(result.game, result.access, store.settings), ballot: ballotPayload(null), message: "作品已撤回，相关可能性核心已经归还给投票者。" });
}

async function handleParticipantAbandonDraft(req, res, id) {
  const result = await mutateStore((store) => {
    const record = requireParticipantSession(store, req);
    const game = store.games.find((item) => item.id === id);
    if (!game) {
      const error = new Error("没有找到这款作品。");
      error.status = 404;
      throw error;
    }
    const access = participantRole(game, record.session.email);
    if (!access || access.role !== "owner") {
      const error = new Error("只有作品负责人可以放弃草稿。");
      error.status = 403;
      error.code = "OWNER_REQUIRED";
      throw error;
    }
    if (!isDiscardableDraft(game)) {
      const error = new Error("只能放弃从未提交的草稿。曾提交过的作品请使用撤回流程。");
      error.status = 409;
      error.code = "DRAFT_NOT_DISCARDABLE";
      throw error;
    }
    const before = gameAuditSnapshot(game);
    const releasedEmails = abandonDraftAndReleaseOwnership(game, {
      actorType: "participant",
      actorId: record.session.id,
      actorEmail: record.session.email
    });
    addAudit(store, {
      action: "game_draft_abandoned",
      actorType: "participant",
      actorId: record.session.id,
      actorEmail: record.session.email,
      gameId: id,
      before,
      after: { ...gameAuditSnapshot(game), releasedEmails }
    });
    return { releasedEmails };
  });
  return json(res, 200, { ok: true, releasedEmails: result.releasedEmails, message: "草稿已作废；你和所有队员的邮箱归属已解除，可以创建或加入其他作品。" });
}

async function handleParticipantAddMember(req, res, id) {
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  const name = cleanText(body.name, 40);
  const role = cleanText(body.role, 40);
  const contribution = cleanMultilineText(body.contribution, 300);
  if (!isValidEmail(email) || !name) return json(res, 400, { ok: false, error: "MEMBER_REQUIRED", message: "请填写队友姓名和有效邮箱。" });
  const result = await mutateStore((store) => {
    const record = requireParticipantSession(store, req);
    const game = store.games.find((item) => item.id === id);
    if (!game) {
      const error = new Error("没有找到这款作品。");
      error.status = 404;
      throw error;
    }
    const access = participantRole(game, record.session.email);
    if (!access || access.role !== "owner") {
      const error = new Error("只有作品负责人可以管理队友。");
      error.status = 403;
      throw error;
    }
    if (email === normalizeEmail(game.ownerEmail)) {
      const error = new Error("负责人邮箱不能重复添加为队友。");
      error.status = 409;
      throw error;
    }
    const occupied = participantGame(store, email);
    if (occupied && occupied.game.id !== id) {
      const error = new Error("该邮箱已经负责或加入另一款作品。");
      error.status = 409;
      error.code = "MEMBER_ALREADY_ASSIGNED";
      throw error;
    }
    const members = normalizeTeamMembers(game.teamMembers);
    if (members.filter((member) => member.active).length >= 11) {
      const error = new Error("一款作品最多包含 12 位制作人员。");
      error.status = 409;
      throw error;
    }
    const existingMember = members.find((member) => member.email === email);
    if (existingMember?.active) {
      const error = new Error("该邮箱已经是当前队友。可在成员资料中修改姓名、职能与工作简述。");
      error.status = 409;
      error.code = "MEMBER_ALREADY_ACTIVE";
      throw error;
    }
    const creator = { id: existingMember?.creatorId || randomId(), name, role, contribution, avatarUrl: "", order: normalizeCreators(game.creators).length };
    const firstLoginAt = firstEmailVerificationAt(store, email);
    game.creators = [...normalizeCreators(game.creators).filter((item) => item.id !== creator.id), creator];
    let storedMember;
    if (existingMember) {
      storedMember = game.teamMembers.find((member) => member.id === existingMember.id);
      Object.assign(storedMember, { active: true, removedAt: "", creatorId: creator.id, addedAt: new Date().toISOString(), firstLoginAt: storedMember.firstLoginAt || firstLoginAt });
    } else {
      storedMember = { id: randomId(), email, creatorId: creator.id, active: true, addedAt: new Date().toISOString(), removedAt: "", firstLoginAt };
      game.teamMembers.push(storedMember);
    }
    game.historicalTeamEmails = [...new Set([...(game.historicalTeamEmails || []), email])];
    const identitySync = synchronizeMembershipIdentity(store, {
      email,
      name: creator.name,
      team: cleanText(game.team, 60),
      personKey: personKey(creator.name, game.team),
      gameId: game.id,
      memberId: storedMember.id
    }, { type: "participant", id: record.session.id, email: record.session.email });
    game.updatedAt = new Date().toISOString();
    game.revision = Number(game.revision || 1) + 1;
    addAudit(store, {
      action: existingMember ? "team_member_restored" : "team_member_added",
      actorType: "participant",
      actorId: record.session.id,
      actorEmail: record.session.email,
      gameId: id,
      memberEmail: email,
      after: { email, name, role, contribution, creatorId: creator.id }
    });
    return { game, access, ownerName: record.session.name, voteInvalidated: identitySync.invalidated };
  });
  const store = await ensureStore();
  const loginUrl = `${requestOrigin(req)}/submit`;
  try {
    await deliverTeamInvitation({ email, name, eventTitle: store.settings.eventTitle, gameTitle: result.game.title, ownerName: result.ownerName, loginUrl });
  } catch (error) {
    await mutateStore((store) => addAudit(store, { action: "team_invitation_email_failed", actorType: "system", actorId: "system", gameId: id, memberEmail: email, reason: cleanText(error.message, 300) }));
  }
  return json(res, 201, {
    ok: true,
    game: participantGamePayload(result.game, result.access, store.settings),
    voteInvalidated: result.voteInvalidated,
    message: result.voteInvalidated
      ? "队友权限已生效，该成员投给本作品的可能性核心已自动归还。"
      : "队友权限已立即生效，通知邮件已安排发送。"
  });
}

async function handleParticipantRemoveMember(req, res, id, memberId) {
  const result = await mutateStore((store) => {
    const record = requireParticipantSession(store, req);
    const game = store.games.find((item) => item.id === id);
    if (!game) {
      const error = new Error("没有找到这款作品。");
      error.status = 404;
      throw error;
    }
    const access = participantRole(game, record.session.email);
    if (!access || access.role !== "owner") {
      const error = new Error("只有作品负责人可以管理队友。");
      error.status = 403;
      throw error;
    }
    const member = game.teamMembers.find((item) => item.id === memberId && item.active !== false);
    if (!member) {
      const error = new Error("没有找到这位当前队友。");
      error.status = 404;
      throw error;
    }
    member.active = false;
    member.removedAt = new Date().toISOString();
    game.historicalTeamEmails = [...new Set([...(game.historicalTeamEmails || []), normalizeEmail(member.email)])];
    const removedCreator = normalizeCreators(game.creators).find((creator) => creator.id === member.creatorId);
    game.creators = normalizeCreators(game.creators).filter((creator) => creator.id !== member.creatorId);
    game.updatedAt = member.removedAt;
    game.revision = Number(game.revision || 1) + 1;
    addAudit(store, {
      action: "team_member_removed",
      actorType: "participant",
      actorId: record.session.id,
      actorEmail: record.session.email,
      gameId: id,
      memberId,
      memberEmail: member.email,
      before: { ...member, creator: removedCreator },
      after: { active: false, removedAt: member.removedAt }
    });
    return { game, access };
  });
  const store = await ensureStore();
  return json(res, 200, { ok: true, game: participantGamePayload(result.game, result.access, store.settings), message: "队友编辑权限已立即撤销。" });
}

async function handleParticipantProfile(req, res, id, memberId) {
  const parsed = await parseGameMultipart(req);
  try {
    const result = await mutateStore((store) => {
      const record = requireParticipantSession(store, req);
      const game = store.games.find((item) => item.id === id);
      if (!game) {
        const error = new Error("没有找到这款作品。");
        error.status = 404;
        throw error;
      }
      const access = participantRole(game, record.session.email);
      if (!access) {
        const error = new Error("权限已变更，你已不能修改这款作品。");
        error.status = 403;
        error.code = "PARTICIPANT_PERMISSION_CHANGED";
        throw error;
      }
      let creatorId = "";
      let targetMember = null;
      if (memberId === "owner") {
        if (access.role !== "owner") {
          const error = new Error("你只能修改自己的制作人员资料。");
          error.status = 403;
          throw error;
        }
        creatorId = game.ownerCreatorId;
      } else {
        targetMember = game.teamMembers.find((member) => member.id === memberId && member.active !== false);
        if (!targetMember || (access.role !== "owner" && access.member?.id !== targetMember.id)) {
          const error = new Error("你只能修改自己的制作人员资料。");
          error.status = 403;
          throw error;
        }
        creatorId = targetMember.creatorId;
      }
      const creators = normalizeCreators(game.creators);
      const index = creators.findIndex((creator) => creator.id === creatorId);
      const previous = index >= 0 ? creators[index] : { id: creatorId || randomId(), name: record.session.name, role: memberId === "owner" ? "负责人" : "", contribution: "", avatarUrl: "", order: creators.length };
      const next = {
        ...previous,
        name: cleanText(parsed.fields.name, 40) || previous.name,
        role: cleanText(parsed.fields.role, 40),
        contribution: cleanMultilineText(parsed.fields.contribution, 300),
        avatarUrl: parsed.files.profileAvatar?.url || previous.avatarUrl
      };
      if (index >= 0) creators[index] = next;
      else creators.push(next);
      game.creators = creators;
      if (memberId === "owner") game.ownerCreatorId = next.id;
      else targetMember.creatorId = next.id;
      if (parsed.files.profileAvatar) {
        game.assetHistory = Array.isArray(game.assetHistory) ? game.assetHistory : [];
        game.assetMeta = game.assetMeta && typeof game.assetMeta === "object" ? game.assetMeta : {};
        if (previous.avatarUrl) game.assetHistory.push({ kind: "avatar", url: previous.avatarUrl, creatorId: next.id, replacedAt: new Date().toISOString() });
        game.assetMeta.avatars ||= {};
        game.assetMeta.avatars[next.id] = fileAssetMeta(parsed.files.profileAvatar, record.session.email);
      }
      game.updatedAt = new Date().toISOString();
      game.revision = Number(game.revision || 1) + 1;
      addAudit(store, {
        action: "creator_profile_updated",
        actorType: "participant",
        actorId: record.session.id,
        actorEmail: record.session.email,
        gameId: id,
        memberId,
        before: previous,
        after: next
      });
      if (targetMember) {
        synchronizeMembershipIdentity(store, {
          email: targetMember.email,
          name: next.name,
          team: cleanText(game.team, 60),
          personKey: personKey(next.name, game.team),
          gameId: game.id,
          memberId: targetMember.id
        }, { type: "participant", id: record.session.id, email: record.session.email });
      }
      return { game, access };
    });
    const store = await ensureStore();
    return json(res, 200, { ok: true, game: participantGamePayload(result.game, result.access, store.settings), message: "制作人员资料已更新。" });
  } catch (error) {
    await Promise.all(parsed.createdFiles.map((file) => fsp.unlink(file).catch(() => {})));
    throw error;
  }
}

async function handleParticipantDevelopmentDocuments(req, res, id) {
  const parsed = await parseDevelopmentDocumentsMultipart(req, 20);
  try {
    const result = await mutateStore((store) => {
      const record = requireParticipantSession(store, req);
      const access = participantGame(store, record.session.email);
      if (!access || access.game.id !== id) throw Object.assign(new Error("你没有权限管理这款作品的开发文档。"), { status: 403, code: "GAME_ACCESS_DENIED" });
      const game = access.game;
      const now = new Date().toISOString();
      const added = parsed.documents.map((document) => ({ ...document, uploadedBy: record.session.email, uploadedAt: now, updatedAt: now }));
      game.developmentDocuments = [...normalizeDevelopmentDocuments(game.developmentDocuments), ...added];
      game.updatedAt = now;
      game.revision = Number(game.revision || 1) + 1;
      for (const document of added) addAudit(store, {
        action: "development_document_uploaded", actorType: "participant", actorId: record.session.id,
        actorEmail: record.session.email, gameId: game.id, documentId: document.id, after: { ...document }
      });
      return { game, access };
    });
    const store = await ensureStore();
    return json(res, 201, { ok: true, game: participantGamePayload(result.game, result.access, store.settings), message: `已将 ${parsed.documents.length} 份开发文档写入内部资料舱。` });
  } catch (error) {
    await Promise.all(parsed.createdFiles.map((file) => fsp.unlink(file).catch(() => {})));
    throw error;
  }
}

async function handleParticipantAttachDevelopmentDocuments(req, res, id) {
  const body = await readJson(req);
  const ids = [...new Set((Array.isArray(body.uploadIds) ? body.uploadIds : []).map(validResumableUploadId).filter(Boolean))].slice(0, 20);
  if (!ids.length) return json(res, 400, { ok: false, error: "RESUMABLE_UPLOAD_REQUIRED", message: "没有可写入的开发文档。" });
  const preflightStore = await ensureStore();
  const record = requireParticipantSession(preflightStore, req);
  const access = participantGame(preflightStore, record.session.email);
  if (!access || access.game.id !== id) return json(res, 403, { ok: false, error: "GAME_ACCESS_DENIED", message: "你没有权限管理这款作品的开发文档。" });
  const items = [];
  try {
    for (const uploadId of ids) items.push(await materializeResumableUpload(uploadId, record.session.email, "developmentDocument"));
    const result = await mutateStore((store) => {
      const currentRecord = requireParticipantSession(store, req);
      const currentAccess = participantGame(store, currentRecord.session.email);
      if (!currentAccess || currentAccess.game.id !== id) throw Object.assign(new Error("权限已变更，你已不能修改这款作品。"), { status: 403, code: "GAME_ACCESS_DENIED" });
      const game = currentAccess.game;
      const now = new Date().toISOString();
      const added = items.map((item) => ({
        id: randomId(), originalName: item.file.originalName, storageName: item.file.storageName,
        mimeType: item.file.mimeType, size: item.file.size, sha256: item.file.sha256,
        uploadedBy: currentRecord.session.email, uploadedAt: now, updatedAt: now
      }));
      game.developmentDocuments = [...normalizeDevelopmentDocuments(game.developmentDocuments), ...added];
      game.updatedAt = now;
      game.revision = Number(game.revision || 1) + 1;
      for (const document of added) addAudit(store, {
        action: "development_document_uploaded", actorType: "participant", actorId: currentRecord.session.id,
        actorEmail: currentRecord.session.email, gameId: game.id, documentId: document.id, after: { ...document }
      });
      return { game, access: currentAccess };
    });
    await finalizeResumableUploads(items);
    const store = await ensureStore();
    return json(res, 201, { ok: true, game: participantGamePayload(result.game, result.access, store.settings), message: `已将 ${items.length} 份开发文档写入内部资料舱。` });
  } catch (error) {
    await Promise.all(items.map((item) => fsp.unlink(item.target).catch(() => {})));
    throw error;
  }
}

async function handleParticipantReplaceDevelopmentDocument(req, res, id, documentId) {
  const parsed = await parseDevelopmentDocumentsMultipart(req, 1);
  const replacement = parsed.documents[0];
  let retiredStorageName = "";
  try {
    const result = await mutateStore((store) => {
      const record = requireParticipantSession(store, req);
      const access = participantGame(store, record.session.email);
      if (!access || access.game.id !== id) throw Object.assign(new Error("你没有权限管理这款作品的开发文档。"), { status: 403, code: "GAME_ACCESS_DENIED" });
      const game = access.game;
      const documents = normalizeDevelopmentDocuments(game.developmentDocuments);
      const index = documents.findIndex((document) => document.id === documentId);
      if (index < 0) throw Object.assign(new Error("没有找到需要替换的开发文档。"), { status: 404 });
      const before = documents[index];
      retiredStorageName = before.storageName;
      const now = new Date().toISOString();
      const after = { ...replacement, id: before.id, uploadedBy: record.session.email, uploadedAt: before.uploadedAt || now, updatedAt: now };
      documents[index] = after;
      game.developmentDocuments = documents;
      game.updatedAt = now;
      game.revision = Number(game.revision || 1) + 1;
      addAudit(store, {
        action: "development_document_replaced", actorType: "participant", actorId: record.session.id,
        actorEmail: record.session.email, gameId: game.id, documentId, before, after
      });
      return { game, access };
    });
    await removePrivateDocument(retiredStorageName);
    const store = await ensureStore();
    return json(res, 200, { ok: true, game: participantGamePayload(result.game, result.access, store.settings), message: "开发文档已替换；旧文件实体已清除，版本信息保留在审计记录中。" });
  } catch (error) {
    await Promise.all(parsed.createdFiles.map((file) => fsp.unlink(file).catch(() => {})));
    throw error;
  }
}

async function handleParticipantAttachReplacementDevelopmentDocument(req, res, id, documentId) {
  const body = await readJson(req);
  const uploadId = validResumableUploadId(body.uploadId);
  if (!uploadId) return json(res, 400, { ok: false, error: "RESUMABLE_UPLOAD_REQUIRED", message: "没有可替换的开发文档。" });
  const preflightStore = await ensureStore();
  const record = requireParticipantSession(preflightStore, req);
  const access = participantGame(preflightStore, record.session.email);
  if (!access || access.game.id !== id) return json(res, 403, { ok: false, error: "GAME_ACCESS_DENIED", message: "你没有权限管理这款作品的开发文档。" });
  let item;
  let retiredStorageName = "";
  try {
    item = await materializeResumableUpload(uploadId, record.session.email, "developmentDocument");
    const result = await mutateStore((store) => {
      const currentRecord = requireParticipantSession(store, req);
      const currentAccess = participantGame(store, currentRecord.session.email);
      if (!currentAccess || currentAccess.game.id !== id) throw Object.assign(new Error("权限已变更，你已不能修改这款作品。"), { status: 403, code: "GAME_ACCESS_DENIED" });
      const game = currentAccess.game;
      const documents = normalizeDevelopmentDocuments(game.developmentDocuments);
      const index = documents.findIndex((document) => document.id === documentId);
      if (index < 0) throw Object.assign(new Error("没有找到需要替换的开发文档。"), { status: 404 });
      const before = documents[index];
      retiredStorageName = before.storageName;
      const now = new Date().toISOString();
      const after = {
        id: before.id, originalName: item.file.originalName, storageName: item.file.storageName,
        mimeType: item.file.mimeType, size: item.file.size, sha256: item.file.sha256,
        uploadedBy: currentRecord.session.email, uploadedAt: before.uploadedAt || now, updatedAt: now
      };
      documents[index] = after;
      game.developmentDocuments = documents;
      game.updatedAt = now;
      game.revision = Number(game.revision || 1) + 1;
      addAudit(store, {
        action: "development_document_replaced", actorType: "participant", actorId: currentRecord.session.id,
        actorEmail: currentRecord.session.email, gameId: game.id, documentId, before, after
      });
      return { game, access: currentAccess };
    });
    await removePrivateDocument(retiredStorageName);
    await finalizeResumableUploads([item]);
    const store = await ensureStore();
    return json(res, 200, { ok: true, game: participantGamePayload(result.game, result.access, store.settings), message: "开发文档已替换；旧文件实体已清除，版本信息保留在审计记录中。" });
  } catch (error) {
    if (item?.target) await fsp.unlink(item.target).catch(() => {});
    throw error;
  }
}

async function handleParticipantDeleteDevelopmentDocument(req, res, id, documentId) {
  let removedStorageName = "";
  const result = await mutateStore((store) => {
    const record = requireParticipantSession(store, req);
    const access = participantGame(store, record.session.email);
    if (!access || access.game.id !== id) throw Object.assign(new Error("你没有权限管理这款作品的开发文档。"), { status: 403, code: "GAME_ACCESS_DENIED" });
    const game = access.game;
    const documents = normalizeDevelopmentDocuments(game.developmentDocuments);
    const index = documents.findIndex((document) => document.id === documentId);
    if (index < 0) throw Object.assign(new Error("没有找到需要移除的开发文档。"), { status: 404 });
    const [before] = documents.splice(index, 1);
    removedStorageName = before.storageName;
    game.developmentDocuments = documents;
    game.updatedAt = new Date().toISOString();
    game.revision = Number(game.revision || 1) + 1;
    addAudit(store, {
      action: "development_document_removed", actorType: "participant", actorId: record.session.id,
      actorEmail: record.session.email, gameId: game.id, documentId, before, after: null
    });
    return { game, access };
  });
  await removePrivateDocument(removedStorageName);
  const store = await ensureStore();
  return json(res, 200, { ok: true, game: participantGamePayload(result.game, result.access, store.settings), message: "开发文档已移除，文件实体已清除。" });
}

async function handleParticipantDownloadDevelopmentDocument(req, res, id, documentId) {
  const store = await ensureStore();
  const record = requireParticipantSession(store, req);
  const access = participantGame(store, record.session.email);
  if (!access || access.game.id !== id) return json(res, 403, { ok: false, error: "GAME_ACCESS_DENIED", message: "你没有权限下载这款作品的开发文档。" });
  const document = normalizeDevelopmentDocuments(access.game.developmentDocuments).find((item) => item.id === documentId);
  if (!document) return notFound(res);
  const target = privateDocumentPath(document.storageName);
  if (!target) return notFound(res);
  return serveFile(res, target, { noStore: true, downloadName: document.originalName });
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
      game.status = game.published ? "submitted" : "draft";
      if (game.status === "submitted") {
        game.firstSubmittedAt = game.createdAt;
        game.submittedAt = game.createdAt;
      }
      game.coordinate = coordinateForGame(game.id, store.settings.eventSeed, store.games);
      store.games.push(game);
      addAudit(store, { action: "game_created", actorType: "admin", actorId: "admin", gameId: game.id, after: gameAuditSnapshot(game) });
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
  try {
    const updated = await mutateStore((store) => {
      const index = store.games.findIndex((game) => game.id === id);
      if (index < 0) {
        const error = new Error("没有找到这款游戏。" );
        error.status = 404;
        throw error;
      }
      const existing = store.games[index];
      if (gameStatus(existing) === "abandoned") {
        const error = new Error("该草稿已作废并释放归属，不能再编辑或重新启用。");
        error.status = 409;
        error.code = "DRAFT_ABANDONED";
        throw error;
      }
      const before = gameAuditSnapshot(existing);
      const game = gameFromFields(parsed.fields, parsed.files, existing);
      game.status = game.published ? "submitted" : gameStatus(existing) === "withdrawn" ? "withdrawn" : "draft";
      if (game.status === "submitted") {
        game.firstSubmittedAt ||= new Date().toISOString();
        game.submittedAt ||= game.firstSubmittedAt;
      }
      scheduleReplacedAssets(store, existing, game, parsed.files, "");
      if (cleanAssetUrl(existing.downloadUrl) !== cleanAssetUrl(game.downloadUrl)) {
        game.downloadHistory = [...(existing.downloadHistory || []), { id: randomId(), before: cleanAssetUrl(existing.downloadUrl), after: cleanAssetUrl(game.downloadUrl), actorEmail: "", actorType: "admin", createdAt: new Date().toISOString() }];
      }
      if (game.featured) store.games.forEach((item) => { item.featured = false; });
      store.games[index] = game;
      addAudit(store, { action: "game_updated", actorType: "admin", actorId: "admin", gameId: id, before, after: gameAuditSnapshot(game), changes: changedGameFields(before, gameAuditSnapshot(game)) });
      return game;
    });
    return json(res, 200, { ok: true, game: updated, message: "游戏信息已更新。" });
  } catch (error) {
    await Promise.all(parsed.createdFiles.map((file) => fsp.unlink(file).catch(() => {})));
    throw error;
  }
}

async function handleAdminDiscardDraft(req, res, url, id) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const body = await readJson(req);
  const reason = cleanText(body.reason, 500);
  if (!reason) return json(res, 400, { ok: false, error: "REASON_REQUIRED", message: "请填写作废草稿的原因，以保留可追溯审计记录。" });
  const result = await mutateStore((store) => {
    const game = store.games.find((item) => item.id === id);
    if (!game) {
      const error = new Error("没有找到这款作品。");
      error.status = 404;
      throw error;
    }
    if (!isDiscardableDraft(game)) {
      const error = new Error("仅能作废从未提交的草稿；已提交或曾提交后撤回的作品必须保留归属。");
      error.status = 409;
      error.code = "DRAFT_NOT_DISCARDABLE";
      throw error;
    }
    const before = gameAuditSnapshot(game);
    const releasedEmails = abandonDraftAndReleaseOwnership(game, { reason, actorType: "admin", actorId: "admin" });
    addAudit(store, {
      action: "game_draft_discarded",
      actorType: "admin",
      actorId: "admin",
      gameId: id,
      reason,
      before,
      after: { ...gameAuditSnapshot(game), releasedEmails }
    });
    return { game: { ...game }, releasedEmails };
  });
  return json(res, 200, { ok: true, game: result.game, releasedEmails: result.releasedEmails, message: "草稿已作废，负责人和队员邮箱归属已解除；完整记录已写入审计日志。" });
}

async function handleAdminDeleteGame(req, res, url, id) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  return json(res, 409, { ok: false, error: "PHYSICAL_DELETE_DISABLED", message: "作品禁止物理删除，请使用撤回流程并保留审计记录。" });
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
  const submissionEndAt = new Date(body.submissionEndAt);
  if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || !Number.isFinite(submissionEndAt.getTime()) || endAt <= startAt) {
    return json(res, 400, { ok: false, error: "INVALID_TIME", message: "请设置正确的开始与结束时间。" });
  }
  const settings = await mutateStore((store) => {
    const before = { ...store.settings };
    store.settings = {
      ...store.settings,
      eventTitle: cleanText(body.eventTitle, 80) || store.settings.eventTitle,
      theme: cleanText(body.theme, 40) || "宇宙",
      slogan: cleanText(body.slogan, 80) || store.settings.slogan,
      eventSeed: cleanText(body.eventSeed, 80) || store.settings.eventSeed,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      submissionEndAt: submissionEndAt.toISOString()
    };
    addAudit(store, { action: "settings_updated", actorType: "admin", actorId: "admin", before, after: { ...store.settings } });
    return store.settings;
  });
  return json(res, 200, { ok: true, settings, message: "活动设置已保存。" });
}

async function handleAdminBindOwner(req, res, url, id) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return json(res, 400, { ok: false, error: "OWNER_EMAIL_REQUIRED", message: "请填写有效的负责人邮箱。" });
  const game = await mutateStore((store) => {
    const target = store.games.find((item) => item.id === id);
    if (!target) {
      const error = new Error("没有找到这款作品。");
      error.status = 404;
      throw error;
    }
    if (gameStatus(target) === "abandoned") {
      const error = new Error("该草稿已作废并释放归属，不能重新绑定负责人。");
      error.status = 409;
      error.code = "DRAFT_ABANDONED";
      throw error;
    }
    const occupied = participantGame(store, email);
    if (occupied && occupied.game.id !== id) {
      const error = new Error("该邮箱已经负责或加入另一款作品。");
      error.status = 409;
      error.code = "OWNER_ALREADY_ASSIGNED";
      throw error;
    }
    const before = { ownerEmail: normalizeEmail(target.ownerEmail), ownerCreatorId: target.ownerCreatorId || "" };
    if (before.ownerEmail && before.ownerEmail !== email) target.historicalOwnerEmails = [...new Set([...(target.historicalOwnerEmails || []), before.ownerEmail])];
    target.ownerEmail = email;
    target.historicalOwnerEmails = [...new Set([...(target.historicalOwnerEmails || []), email])];
    const member = target.teamMembers.find((item) => item.active !== false && normalizeEmail(item.email) === email);
    if (member) {
      target.ownerCreatorId = member.creatorId || target.ownerCreatorId;
      member.active = false;
      member.removedAt = new Date().toISOString();
      target.historicalTeamEmails = [...new Set([...(target.historicalTeamEmails || []), email])];
    }
    target.updatedAt = new Date().toISOString();
    target.revision = Number(target.revision || 1) + 1;
    addAudit(store, {
      action: "game_owner_bound",
      actorType: "admin",
      actorId: "admin",
      gameId: id,
      before,
      after: { ownerEmail: email, ownerCreatorId: target.ownerCreatorId || "" }
    });
    return { ...target };
  });
  return json(res, 200, { ok: true, game, message: "负责人邮箱已绑定并立即生效。" });
}

async function handleAdminClearLate(req, res, url, id) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const body = await readJson(req);
  const reason = cleanText(body.reason, 500);
  if (!reason) return json(res, 400, { ok: false, error: "REASON_REQUIRED", message: "请填写撤销补交标记的复核原因。" });
  const game = await mutateStore((store) => {
    const target = store.games.find((item) => item.id === id);
    if (!target) {
      const error = new Error("没有找到这款作品。");
      error.status = 404;
      throw error;
    }
    const before = { lateSubmission: Boolean(target.lateSubmission), lateMarkedAt: target.lateMarkedAt || "" };
    target.lateSubmission = false;
    target.lateClearedAt = new Date().toISOString();
    target.lateClearedReason = reason;
    target.updatedAt = target.lateClearedAt;
    target.revision = Number(target.revision || 1) + 1;
    addAudit(store, {
      action: "game_late_marker_cleared",
      actorType: "admin",
      actorId: "admin",
      gameId: id,
      reason,
      before,
      after: { lateSubmission: false, lateClearedAt: target.lateClearedAt }
    });
    return { ...target };
  });
  return json(res, 200, { ok: true, game, message: "补交标记已撤销。后续截止后替换作品文件仍会重新触发。" });
}

async function handleAdminAudit(req, res, url) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const store = await ensureStore();
  const gameId = cleanText(url.searchParams.get("gameId"), 100);
  const actorEmail = normalizeEmail(url.searchParams.get("email"));
  const action = cleanText(url.searchParams.get("action"), 100);
  const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") || 500)));
  const audit = store.audit.filter((item) => {
    if (gameId && item.gameId !== gameId) return false;
    if (actorEmail && ![item.actorEmail, item.voterEmail, item.memberEmail].map(normalizeEmail).includes(actorEmail)) return false;
    if (action && item.action !== action) return false;
    return true;
  }).slice(-limit).reverse();
  return json(res, 200, { ok: true, audit, total: audit.length });
}

function archiveSafeName(value, fallback = "未命名") {
  const cleaned = String(value || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim();
  return (cleaned || fallback).slice(0, 100);
}

function shanghaiTimestamp(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(date);
}

function exportMemberRows(game) {
  const creators = normalizeCreators(game.creators);
  const owner = creators.find((creator) => creator.id === game.ownerCreatorId) || creators[0] || {};
  const rows = [{
    身份: "负责人", 姓名: owner.name || "", 职能: owner.role || "负责人", 工作内容: owner.contribution || "",
    邮箱: normalizeEmail(game.ownerEmail), 当前权限: gameStatus(game) === "abandoned" ? "已释放" : "有效", 首次登录: ""
  }];
  for (const member of normalizeTeamMembers(game.teamMembers)) {
    const creator = creators.find((item) => item.id === member.creatorId) || {};
    rows.push({
      身份: "队友", 姓名: creator.name || "", 职能: creator.role || "", 工作内容: creator.contribution || "",
      邮箱: member.email, 当前权限: member.active ? "有效" : "已移除", 首次登录: shanghaiTimestamp(member.firstLoginAt)
    });
  }
  return rows;
}

async function buildGameInformationWorkbook(store, game, counts) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "溯造 MiniGame 轨道控制台";
  workbook.created = new Date();
  const info = workbook.addWorksheet("作品信息", { views: [{ state: "frozen", ySplit: 1 }] });
  info.columns = [{ header: "字段", key: "field", width: 25 }, { header: "内容", key: "value", width: 80 }];
  const rows = [
    ["作品 ID", game.id], ["游戏名称", game.title], ["队伍名称", game.team], ["一句话介绍", game.shortDescription],
    ["游戏简介", game.description], ["创作手记", game.creationNote], ["标签", (game.tags || []).join("、")],
    ["状态", gameStatus(game)], ["创建时间（北京时间）", shanghaiTimestamp(game.createdAt)],
    ["首次提交时间（北京时间）", shanghaiTimestamp(game.firstSubmittedAt)], ["当前提交时间（北京时间）", shanghaiTimestamp(game.submittedAt)],
    ["撤回时间（北京时间）", shanghaiTimestamp(game.withdrawnAt)], ["最后修改时间（北京时间）", shanghaiTimestamp(game.updatedAt)],
    ["补交状态", game.lateSubmission ? "是" : "否"], ["补交标记时间（北京时间）", shanghaiTimestamp(game.lateMarkedAt)],
    ["有效票数", counts[game.id] || 0], ["负责人邮箱", normalizeEmail(game.ownerEmail)]
  ];
  rows.forEach(([field, value]) => info.addRow({ field, value: value ?? "" }));
  const members = workbook.addWorksheet("制作人员", { views: [{ state: "frozen", ySplit: 1 }] });
  members.columns = Object.keys(exportMemberRows(game)[0]).map((key) => ({ header: key, key, width: key === "工作内容" ? 50 : key === "邮箱" ? 34 : 20 }));
  exportMemberRows(game).forEach((row) => members.addRow(row));
  const audits = workbook.addWorksheet("审计索引", { views: [{ state: "frozen", ySplit: 1 }] });
  audits.columns = [
    { header: "时间（北京时间）", key: "createdAt", width: 24 }, { header: "动作", key: "action", width: 34 },
    { header: "操作者类型", key: "actorType", width: 18 }, { header: "操作者邮箱/ID", key: "actor", width: 38 },
    { header: "原因", key: "reason", width: 50 }, { header: "审计记录 ID", key: "id", width: 40 }
  ];
  store.audit.filter((event) => event.gameId === game.id).forEach((event) => audits.addRow({
    createdAt: shanghaiTimestamp(event.createdAt), action: event.action || "", actorType: event.actorType || "",
    actor: event.actorEmail || event.actorId || "", reason: event.reason || "", id: event.id || ""
  }));
  for (const sheet of workbook.worksheets) {
    sheet.getRow(1).font = { bold: true, color: { argb: "FF11130F" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB8D94E" } };
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
    sheet.eachRow((row) => { row.alignment = { vertical: "top", wrapText: true }; });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function localUploadPath(url) {
  if (!String(url || "").startsWith("/uploads/")) return "";
  const target = path.resolve(UPLOAD_DIR, path.basename(url));
  return target.startsWith(`${UPLOAD_DIR}${path.sep}`) ? target : "";
}

async function appendFileIfPresent(archive, source, archiveName, missing) {
  if (!source) return false;
  try {
    const stat = await fsp.stat(source);
    if (!stat.isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
    archive.file(source, { name: archiveName });
    return true;
  } catch {
    missing.push(`${archiveName}（文件实体缺失）`);
    return false;
  }
}

async function appendGameArchive(archive, store, game, folder, counts) {
  const root = folder ? `${folder}/` : "";
  const audit = store.audit.filter((event) => event.gameId === game.id);
  archive.append(await buildGameInformationWorkbook(store, game, counts), { name: `${root}作品信息.xlsx` });
  archive.append(`${JSON.stringify(audit, null, 2)}\n`, { name: `${root}完整审计记录.json` });
  const missing = [];
  await appendFileIfPresent(archive, localUploadPath(game.coverUrl), `${root}封面/${archiveSafeName(game.assetMeta?.cover?.originalName || path.basename(game.coverUrl || "封面"), "封面")}`, missing);
  await appendFileIfPresent(archive, localUploadPath(game.uploadedVideoUrl), `${root}演示视频/${archiveSafeName(game.assetMeta?.video?.originalName || path.basename(game.uploadedVideoUrl || "演示视频"), "演示视频")}`, missing);
  await appendFileIfPresent(archive, localUploadPath(game.downloadUrl), `${root}游戏包体/${archiveSafeName(game.assetMeta?.gameFile?.originalName || path.basename(game.downloadUrl || "游戏包体"), "游戏包体")}`, missing);
  const creators = normalizeCreators(game.creators);
  for (let index = 0; index < creators.length; index += 1) {
    const creator = creators[index];
    if (!creator.avatarUrl) continue;
    const extension = path.extname(creator.avatarUrl) || ".bin";
    await appendFileIfPresent(archive, localUploadPath(creator.avatarUrl), `${root}成员头像/${String(index + 1).padStart(2, "0")}-${archiveSafeName(creator.name, "成员")}${extension}`, missing);
  }
  const usedDocumentNames = new Set();
  for (const document of normalizeDevelopmentDocuments(game.developmentDocuments)) {
    const safeName = archiveSafeName(document.originalName, "开发文档");
    const extension = path.extname(safeName);
    const stem = safeName.slice(0, safeName.length - extension.length) || "开发文档";
    let uniqueName = safeName;
    let sequence = 2;
    while (usedDocumentNames.has(uniqueName.toLowerCase())) uniqueName = `${stem}-${sequence++}${extension}`;
    usedDocumentNames.add(uniqueName.toLowerCase());
    await appendFileIfPresent(archive, privateDocumentPath(document.storageName), `${root}开发文档/${uniqueName}`, missing);
  }
  const external = [];
  if (cleanUrl(game.videoExternalUrl)) external.push(`公开视频链接：${game.videoExternalUrl}`);
  if (cleanUrl(game.coverUrl)) external.push(`外部封面链接：${game.coverUrl}`);
  if (cleanUrl(game.downloadUrl)) external.push(`外部游戏地址：${game.downloadUrl}`);
  archive.append(`${external.length ? external.join("\n") : "本作品没有需要单独记录的外部链接。"}\n`, { name: `${root}外部链接.txt` });
  if (missing.length) archive.append(`${missing.join("\n")}\n`, { name: `${root}缺失文件记录.txt` });
}

async function handleAdminCreateArchiveTicket(req, res, url) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const body = await readJson(req);
  const scope = body.scope === "all" ? "all" : "game";
  const store = await ensureStore();
  const gameId = cleanText(body.gameId, 100);
  if (scope === "game" && !store.games.some((game) => game.id === gameId)) return notFound(res);
  const token = crypto.randomBytes(32).toString("hex");
  exportTickets.set(token, { scope, gameId, expiresAt: Date.now() + 2 * 60 * 1000 });
  for (const [key, ticket] of exportTickets) if (ticket.expiresAt < Date.now()) exportTickets.delete(key);
  return json(res, 201, { ok: true, downloadUrl: `/api/admin/export/archive/${token}`, expiresInSeconds: 120 });
}

async function handleAdminArchiveDownload(req, res, token) {
  const ticket = exportTickets.get(token);
  exportTickets.delete(token);
  if (!ticket || ticket.expiresAt < Date.now()) return json(res, 410, { ok: false, error: "EXPORT_TICKET_EXPIRED", message: "导出凭证已失效，请重新点击导出。" });
  const store = await ensureStore();
  const games = ticket.scope === "all" ? store.games.slice() : store.games.filter((game) => game.id === ticket.gameId);
  if (!games.length && ticket.scope === "game") return notFound(res);
  const counts = voteCounts(store);
  const eventName = archiveSafeName(store.settings.eventTitle, "溯造MiniGame");
  const filename = ticket.scope === "all" ? `${eventName}-全部作品归档.zip` : `${archiveSafeName(games[0].title, "未命名作品")}-作品归档.zip`;
  res.writeHead(200, {
    "content-type": "application/zip", "content-disposition": `attachment; filename="minigame-archive.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "cache-control": "no-store", "x-content-type-options": "nosniff"
  });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on("warning", (error) => { if (error.code !== "ENOENT") res.destroy(error); });
  archive.on("error", (error) => res.destroy(error));
  archive.pipe(res);
  for (let index = 0; index < games.length; index += 1) {
    const game = games[index];
    const folder = ticket.scope === "all" ? `${String(index + 1).padStart(2, "0")}-${archiveSafeName(game.title, "未命名作品")}` : "";
    await appendGameArchive(archive, store, game, folder, counts);
  }
  await archive.finalize();
}

async function handleAdminDownloadDevelopmentDocument(req, res, url, id, documentId) {
  if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
  const store = await ensureStore();
  const game = store.games.find((item) => item.id === id);
  const document = normalizeDevelopmentDocuments(game?.developmentDocuments).find((item) => item.id === documentId);
  if (!document) return notFound(res);
  const target = privateDocumentPath(document.storageName);
  if (!target) return notFound(res);
  return serveFile(res, target, { noStore: true, downloadName: document.originalName });
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
    if (store.settings.resultsPublished) {
      const error = new Error("结果已经发布。如需重新裁定，请先撤回宇宙点亮。" );
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
    if (store.settings.resultsPublished) {
      const error = new Error("结果已经发布。" );
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
    if (options.downloadName) {
      const fallback = `game-file${ext || ".zip"}`;
      headers["content-disposition"] = `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(options.downloadName)}`;
    }
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

async function handleGameDownload(req, res, id) {
  if (req.method !== "GET") return methodNotAllowed(res);
  const store = await ensureStore();
  const game = store.games.find((item) => item.id === id && isGamePublic(item));
  if (!game?.downloadUrl) return notFound(res);
  if (!String(game.downloadUrl).startsWith("/uploads/")) {
    res.writeHead(302, { location: game.downloadUrl, "cache-control": "no-store" });
    return res.end();
  }
  const requested = path.resolve(UPLOAD_DIR, path.basename(game.downloadUrl));
  if (!requested.startsWith(UPLOAD_DIR)) return notFound(res);
  const originalName = cleanText(game.assetMeta?.gameFile?.originalName, 240) || `game-file${path.extname(requested)}`;
  return serveFile(res, requested, { range: req.headers.range, noStore: true, downloadName: originalName });
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith("/uploads/")) {
    const requested = path.resolve(UPLOAD_DIR, path.basename(pathname));
    if (!requested.startsWith(UPLOAD_DIR)) return notFound(res);
    const downloadName = path.basename(pathname).startsWith("game-") ? `game-file${path.extname(requested)}` : "";
    return serveFile(res, requested, { range: req.headers.range, downloadName });
  }
  const adminHost = isAdminHost(req);
  if (pathname === "/submit" || pathname === "/submit/") pathname = "/submit.html";
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
    const publicDownloadMatch = url.pathname.match(/^\/api\/games\/([^/]+)\/download$/);
    if (publicDownloadMatch) return await handleGameDownload(req, res, decodeURIComponent(publicDownloadMatch[1]));
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
    if (url.pathname === "/api/participant/workspace") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return await handleParticipantWorkspace(req, res);
    }
    if (url.pathname === "/api/participant/uploads") {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleCreateResumableUpload(req, res);
    }
    const resumableUploadMatch = url.pathname.match(/^\/api\/participant\/uploads\/([a-f0-9-]{16,80})$/i);
    if (resumableUploadMatch) {
      if (req.method !== "GET") return methodNotAllowed(res);
      return await handleResumableUploadStatus(req, res, resumableUploadMatch[1]);
    }
    const resumableUploadChunkMatch = url.pathname.match(/^\/api\/participant\/uploads\/([a-f0-9-]{16,80})\/chunk$/i);
    if (resumableUploadChunkMatch) {
      if (req.method !== "PUT") return methodNotAllowed(res);
      return await handleResumableUploadChunk(req, res, resumableUploadChunkMatch[1]);
    }
    const resumableUploadCompleteMatch = url.pathname.match(/^\/api\/participant\/uploads\/([a-f0-9-]{16,80})\/complete$/i);
    if (resumableUploadCompleteMatch) {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleCompleteResumableUpload(req, res, resumableUploadCompleteMatch[1]);
    }
    if (url.pathname === "/api/participant/games") {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleParticipantCreateGame(req, res);
    }
    const participantSubmitMatch = url.pathname.match(/^\/api\/participant\/games\/([^/]+)\/submit$/);
    if (participantSubmitMatch) {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleParticipantSubmitGame(req, res, decodeURIComponent(participantSubmitMatch[1]));
    }
    const participantWithdrawMatch = url.pathname.match(/^\/api\/participant\/games\/([^/]+)\/withdraw$/);
    if (participantWithdrawMatch) {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleParticipantWithdrawGame(req, res, decodeURIComponent(participantWithdrawMatch[1]));
    }
    const participantAbandonMatch = url.pathname.match(/^\/api\/participant\/games\/([^/]+)\/abandon$/);
    if (participantAbandonMatch) {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleParticipantAbandonDraft(req, res, decodeURIComponent(participantAbandonMatch[1]));
    }
    const participantMembersMatch = url.pathname.match(/^\/api\/participant\/games\/([^/]+)\/members$/);
    if (participantMembersMatch) {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleParticipantAddMember(req, res, decodeURIComponent(participantMembersMatch[1]));
    }
    const participantDocumentsMatch = url.pathname.match(/^\/api\/participant\/games\/([^/]+)\/development-documents$/);
    if (participantDocumentsMatch) {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleParticipantDevelopmentDocuments(req, res, decodeURIComponent(participantDocumentsMatch[1]));
    }
    const participantDocumentsAttachMatch = url.pathname.match(/^\/api\/participant\/games\/([^/]+)\/development-documents\/attach$/);
    if (participantDocumentsAttachMatch) {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleParticipantAttachDevelopmentDocuments(req, res, decodeURIComponent(participantDocumentsAttachMatch[1]));
    }
    const participantDocumentAttachMatch = url.pathname.match(/^\/api\/participant\/games\/([^/]+)\/development-documents\/([^/]+)\/attach$/);
    if (participantDocumentAttachMatch) {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleParticipantAttachReplacementDevelopmentDocument(req, res, decodeURIComponent(participantDocumentAttachMatch[1]), decodeURIComponent(participantDocumentAttachMatch[2]));
    }
    const participantDocumentMatch = url.pathname.match(/^\/api\/participant\/games\/([^/]+)\/development-documents\/([^/]+)$/);
    if (participantDocumentMatch) {
      const gameId = decodeURIComponent(participantDocumentMatch[1]);
      const documentId = decodeURIComponent(participantDocumentMatch[2]);
      if (req.method === "PUT") return await handleParticipantReplaceDevelopmentDocument(req, res, gameId, documentId);
      if (req.method === "DELETE") return await handleParticipantDeleteDevelopmentDocument(req, res, gameId, documentId);
      return methodNotAllowed(res);
    }
    const participantDocumentDownloadMatch = url.pathname.match(/^\/api\/participant\/games\/([^/]+)\/development-documents\/([^/]+)\/download$/);
    if (participantDocumentDownloadMatch) {
      if (req.method !== "GET") return methodNotAllowed(res);
      return await handleParticipantDownloadDevelopmentDocument(req, res, decodeURIComponent(participantDocumentDownloadMatch[1]), decodeURIComponent(participantDocumentDownloadMatch[2]));
    }
    const participantMemberMatch = url.pathname.match(/^\/api\/participant\/games\/([^/]+)\/members\/([^/]+)$/);
    if (participantMemberMatch) {
      const gameId = decodeURIComponent(participantMemberMatch[1]);
      const memberId = decodeURIComponent(participantMemberMatch[2]);
      if (req.method === "PUT") return await handleParticipantProfile(req, res, gameId, memberId);
      if (req.method === "DELETE") return await handleParticipantRemoveMember(req, res, gameId, memberId);
      return methodNotAllowed(res);
    }
    const participantGameMatch = url.pathname.match(/^\/api\/participant\/games\/([^/]+)$/);
    if (participantGameMatch) {
      if (req.method !== "PUT") return methodNotAllowed(res);
      return await handleParticipantUpdateGame(req, res, decodeURIComponent(participantGameMatch[1]));
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
    if (url.pathname === "/api/admin/export/archive-ticket") {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleAdminCreateArchiveTicket(req, res, url);
    }
    const archiveDownloadMatch = url.pathname.match(/^\/api\/admin\/export\/archive\/([a-f0-9]{64})$/);
    if (archiveDownloadMatch) {
      if (req.method !== "GET") return methodNotAllowed(res);
      return await handleAdminArchiveDownload(req, res, archiveDownloadMatch[1]);
    }
    const adminDevelopmentDocumentMatch = url.pathname.match(/^\/api\/admin\/games\/([^/]+)\/development-documents\/([^/]+)\/download$/);
    if (adminDevelopmentDocumentMatch) {
      if (req.method !== "GET") return methodNotAllowed(res);
      return await handleAdminDownloadDevelopmentDocument(req, res, url, decodeURIComponent(adminDevelopmentDocumentMatch[1]), decodeURIComponent(adminDevelopmentDocumentMatch[2]));
    }
    const discardDraftMatch = url.pathname.match(/^\/api\/admin\/games\/([^/]+)\/discard-draft$/);
    if (discardDraftMatch) {
      if (req.method !== "POST") return methodNotAllowed(res);
      return await handleAdminDiscardDraft(req, res, url, decodeURIComponent(discardDraftMatch[1]));
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
    const bindOwnerMatch = url.pathname.match(/^\/api\/admin\/games\/([^/]+)\/owner$/);
    if (bindOwnerMatch) {
      if (req.method !== "PUT") return methodNotAllowed(res);
      return await handleAdminBindOwner(req, res, url, decodeURIComponent(bindOwnerMatch[1]));
    }
    const clearLateMatch = url.pathname.match(/^\/api\/admin\/games\/([^/]+)\/late$/);
    if (clearLateMatch) {
      if (req.method !== "DELETE") return methodNotAllowed(res);
      return await handleAdminClearLate(req, res, url, decodeURIComponent(clearLateMatch[1]));
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
    if (url.pathname === "/api/admin/audit") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return await handleAdminAudit(req, res, url);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res);
    return await serveStatic(req, res, url);
  } catch (error) {
    const status = error.status || 500;
    console.error(error);
    if (res.headersSent) return res.destroy(error);
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
