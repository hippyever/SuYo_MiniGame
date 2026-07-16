const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const Busboy = require("busboy");
const sharp = require("sharp");

const COMMENT_IMAGE_LIMIT = 5;
const COMMENT_IMAGE_BYTES = 10 * 1024 * 1024;
const COMMENT_AVATAR_BYTES = 4 * 1024 * 1024;
const COMMENT_INTERVAL_MS = 10 * 1000;
const COMMENT_DAILY_LIMIT = 100;
const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function defaultCommentTags() {
  const groups = {
    "玩法": ["玩法有趣", "机制新颖", "节奏流畅", "关卡巧妙", "平衡待优化"],
    "视听": ["视听出色", "美术鲜明", "氛围沉浸", "音乐动人", "反馈清晰"],
    "操作": ["操作顺手", "引导清楚", "操作待优化", "适配良好"],
    "完成度": ["完成度高", "稳定流畅", "细节用心", "潜力很大"],
    "期待": ["希望继续开发", "期待新内容", "愿意再体验", "想看更多玩法"]
  };
  return Object.entries(groups).flatMap(([group, labels], groupIndex) => labels.map((label, index) => ({
    id: crypto.createHash("sha1").update(`${group}:${label}`).digest("hex").slice(0, 16),
    group,
    label,
    enabled: true,
    order: groupIndex * 20 + index,
    createdAt: new Date().toISOString()
  })));
}

function cleanText(value, max = 200) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function cleanBody(value, max) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, max)
    .trim();
}

function normalizeEmail(value) {
  return cleanText(value, 180).toLowerCase();
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function fail(message, status = 400, code = "COMMENT_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function avatarSeed(email) {
  const hash = crypto.createHash("sha256").update(normalizeEmail(email)).digest("hex");
  return {
    key: hash.slice(0, 12),
    hue: Number.parseInt(hash.slice(0, 4), 16) % 360,
    phase: Number.parseInt(hash.slice(4, 8), 16) % 100
  };
}

function makeCommentService(deps) {
  const {
    ensureStore, mutateStore, sessionRecord, participantRole, gameStatus,
    isGamePublic, requireAdmin, json, methodNotAllowed, addAudit, uploadDir, personKey
  } = deps;
  const imageDir = path.join(uploadDir, "comment-images");
  const avatarDir = path.join(uploadDir, "comment-avatars");

  function currentProfile(store, email, fallback = {}) {
    const normalized = normalizeEmail(email);
    const saved = store.commentProfiles?.[normalized] || {};
    let session = null;
    for (const item of Object.values(store.sessions || {})) {
      if (normalizeEmail(item.email) === normalized && (!session || Date.parse(item.createdAt || 0) > Date.parse(session.createdAt || 0))) session = item;
    }
    return {
      email: normalized,
      name: cleanText(saved.name || session?.name || fallback.name || "观测者", 40),
      team: cleanText(saved.team || session?.team || fallback.team, 60),
      avatarUrl: cleanText(saved.avatarUrl, 1000),
      avatarSeed: avatarSeed(normalized),
      notificationPreferences: {
        replies: saved.notificationPreferences?.replies !== false,
        likes: saved.notificationPreferences?.likes !== false,
        gameComments: saved.notificationPreferences?.gameComments || {}
      }
    };
  }

  function isDeveloper(store, gameId, email) {
    const game = store.games.find((item) => item.id === gameId);
    return Boolean(game && participantRole(game, email));
  }

  function publicAuthor(store, comment) {
    const profile = currentProfile(store, comment.authorEmail, comment.identitySnapshot);
    return {
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      avatarSeed: profile.avatarSeed,
      developer: isDeveloper(store, comment.gameId, comment.authorEmail)
    };
  }

  function visibleStatus(comment, admin = false) {
    if (comment.status === "hidden") return admin ? "hidden" : "hidden-placeholder";
    if (comment.status === "deleted") return "deleted-placeholder";
    return "active";
  }

  function publicComment(store, comment, viewerEmail = "", { admin = false, includeReplies = true, replyLimit = 1 } = {}) {
    const allReplies = store.comments
      .filter((item) => item.rootId === comment.id && item.id !== comment.id && (admin || !(item.status === "deleted" && item.deleteMode === "removed")))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const status = visibleStatus(comment, admin);
    const payload = {
      id: comment.id,
      gameId: comment.gameId,
      rootId: comment.rootId,
      replyToId: comment.replyToId || "",
      replyToName: cleanText(comment.replyToSnapshot?.name, 40),
      author: publicAuthor(store, comment),
      body: status === "active" || admin ? comment.body : "",
      images: status === "active" || admin ? (comment.images || []).filter((image) => !image.removedAt).map((image) => ({ id: image.id, url: image.url, thumbnailUrl: image.thumbnailUrl, width: image.width, height: image.height })) : [],
      removedImageCount: (comment.images || []).filter((image) => image.removedAt).length,
      tags: status === "active" || admin ? (comment.tags || []).filter((tag) => !tag.removedAt).map(({ id, label, group, custom }) => ({ id, label, group, custom })) : [],
      status,
      createdAt: comment.createdAt,
      likeCount: (comment.likeEmails || []).length,
      likedByMe: Boolean(viewerEmail && (comment.likeEmails || []).includes(normalizeEmail(viewerEmail))),
      mine: Boolean(viewerEmail && normalizeEmail(comment.authorEmail) === normalizeEmail(viewerEmail)),
      replyCount: allReplies.length,
      identitySnapshot: admin ? comment.identitySnapshot : undefined,
      authorEmail: admin ? comment.authorEmail : undefined,
      moderation: admin ? comment.moderation || [] : undefined
    };
    if (includeReplies && !comment.replyToId) payload.replies = allReplies.slice(0, replyLimit).map((reply) => publicComment(store, reply, viewerEmail, { admin, includeReplies: false }));
    return payload;
  }

  function commentAvailability(store, game) {
    if (!game) return { readable: false, writable: false, reason: "作品不存在" };
    if (!isGamePublic(game) && gameStatus(game) !== "withdrawn") return { readable: false, writable: false, reason: "作品尚未公开" };
    if (gameStatus(game) === "withdrawn") return { readable: true, writable: false, reason: "作品已撤回，观测回声暂时只读" };
    if (store.settings.commentsPaused) return { readable: true, writable: false, reason: "观测站已暂停发送新回声" };
    if (game.commentsReadOnly) return { readable: true, writable: false, reason: "本作品讨论空间当前为只读" };
    return { readable: true, writable: true, reason: "" };
  }

  function requireSession(store, req) {
    const record = sessionRecord(store, req);
    if (!record) throw fail("请先完成邮箱验证。", 401, "LOGIN_REQUIRED");
    return record;
  }

  function ensureCanPost(store, game, session, kind) {
    const availability = commentAvailability(store, game);
    if (!availability.writable) throw fail(availability.reason, 409, "COMMENTS_READ_ONLY");
    if (kind === "root" && participantRole(game, session.email)) throw fail("开发者可在自己的作品下回应观测者，但不能发表一级评价。", 403, "DEVELOPER_REPLY_ONLY");
    const mute = store.commentMutes?.[normalizeEmail(session.email)];
    if (mute && (mute.permanent || Date.parse(mute.until || 0) > Date.now())) throw fail(mute.permanent ? "你的回声发送权限已被永久暂停。" : `你的回声发送权限暂停至 ${mute.until}。`, 403, "COMMENT_MUTED");
    const authored = store.comments.filter((item) => normalizeEmail(item.authorEmail) === normalizeEmail(session.email));
    const latest = authored.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (latest && Date.now() - Date.parse(latest.createdAt) < COMMENT_INTERVAL_MS) throw fail("两次发送回声至少间隔 10 秒。", 429, "COMMENT_RATE_LIMIT");
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    if (authored.filter((item) => Date.parse(item.createdAt) >= dayAgo).length >= COMMENT_DAILY_LIMIT) throw fail("今天发送的回声已达到 100 条上限。", 429, "COMMENT_DAILY_LIMIT");
  }

  async function parseMultipart(req, { maxBody = 2000, avatar = false } = {}) {
    await fsp.mkdir(avatar ? avatarDir : imageDir, { recursive: true });
    return new Promise((resolve, reject) => {
      let busboy;
      try { busboy = Busboy({ headers: req.headers, limits: { files: avatar ? 1 : COMMENT_IMAGE_LIMIT, fields: 20, fileSize: avatar ? COMMENT_AVATAR_BYTES : COMMENT_IMAGE_BYTES } }); }
      catch (error) { reject(fail("上传请求格式不正确。", 400, "INVALID_MULTIPART")); return; }
      const fields = {};
      const pending = [];
      const files = [];
      const created = [];
      let rejected = null;
      busboy.on("field", (name, value) => { fields[name] = String(value).slice(0, Math.max(maxBody + 1000, 10000)); });
      busboy.on("file", (name, stream, info) => {
        if ((avatar && name !== "avatar") || (!avatar && name !== "images")) { stream.resume(); return; }
        if (!ALLOWED_IMAGE_MIME.has(info.mimeType)) { rejected ||= fail("仅支持 JPG、PNG 或 WebP 图片。", 415, "IMAGE_TYPE_INVALID"); stream.resume(); return; }
        const temp = path.join(avatar ? avatarDir : imageDir, `.upload-${randomId()}`);
        created.push(temp);
        let bytes = 0;
        const write = fs.createWriteStream(temp, { flags: "wx" });
        stream.on("data", (chunk) => { bytes += chunk.length; });
        stream.on("limit", () => { rejected ||= fail(avatar ? "头像不能超过 4MB。" : "每张图片不能超过 10MB。", 413, "IMAGE_TOO_LARGE"); });
        const done = new Promise((resDone, rejDone) => {
          write.on("finish", async () => {
            try {
              if (rejected) return resDone();
              const id = randomId();
              const fullName = `${avatar ? "avatar" : "comment"}-${id}.webp`;
              const thumbName = avatar ? fullName : `comment-${id}-thumb.webp`;
              const fullPath = path.join(avatar ? avatarDir : imageDir, fullName);
              const thumbPath = path.join(avatar ? avatarDir : imageDir, thumbName);
              const base = sharp(temp, { failOn: "error" }).rotate();
              const metadata = await base.metadata();
              if (!ALLOWED_IMAGE_MIME.has(`image/${metadata.format === "jpg" ? "jpeg" : metadata.format}`)) throw fail("图片内容无法识别。", 415, "IMAGE_CONTENT_INVALID");
              if (avatar) {
                await base.resize(512, 512, { fit: "cover", position: "attention" }).webp({ quality: 88 }).toFile(fullPath);
                created.push(fullPath);
                files.push({ id, url: `/uploads/comment-avatars/${fullName}`, thumbnailUrl: `/uploads/comment-avatars/${fullName}`, width: 512, height: 512, originalName: cleanText(info.filename, 200), size: bytes });
              } else {
                const fullInfo = await base.resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true }).webp({ quality: 90 }).toFile(fullPath);
                const thumbInfo = await sharp(temp).rotate().resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toFile(thumbPath);
                created.push(fullPath, thumbPath);
                files.push({ id, url: `/uploads/comment-images/${fullName}`, thumbnailUrl: `/uploads/comment-images/${thumbName}`, width: fullInfo.width, height: fullInfo.height, thumbnailWidth: thumbInfo.width, thumbnailHeight: thumbInfo.height, originalName: cleanText(info.filename, 200), size: bytes });
              }
              resDone();
            } catch (error) { rejDone(error); }
          });
          write.on("error", rejDone);
          stream.on("error", rejDone);
        });
        stream.pipe(write);
        pending.push(done);
      });
      busboy.on("error", reject);
      busboy.on("finish", async () => {
        try {
          await Promise.all(pending);
          await Promise.all(created.filter((file) => path.basename(file).startsWith(".upload-")).map((file) => fsp.unlink(file).catch(() => {})));
          if (rejected) throw rejected;
          resolve({ fields, files, created: created.filter((file) => !path.basename(file).startsWith(".upload-")) });
        } catch (error) {
          await Promise.all(created.map((file) => fsp.unlink(file).catch(() => {})));
          reject(error);
        }
      });
      req.pipe(busboy);
    });
  }

  function parseTags(store, raw) {
    let values = [];
    try { values = JSON.parse(raw || "[]"); } catch { throw fail("观测标记格式不正确。", 400, "TAGS_INVALID"); }
    if (!Array.isArray(values) || values.length > 5) throw fail("每条评价最多选择 5 个观测标记。", 400, "TAGS_LIMIT");
    return values.map((item) => {
      const id = cleanText(item.id, 80);
      const label = cleanText(item.label, 8);
      const official = store.commentTags.find((tag) => tag.id === id && tag.enabled);
      if (official) return { id: official.id, label: official.label, group: official.group, custom: false };
      if (!label || [...label].length > 8) throw fail("自定义标记最多 8 个字。", 400, "CUSTOM_TAG_INVALID");
      return { id: randomId(), label, group: "自定义", custom: true };
    });
  }

  function makeNotification(store, data) {
    const recipient = normalizeEmail(data.recipientEmail);
    if (!recipient || recipient === normalizeEmail(data.actorEmail)) return;
    const profile = currentProfile(store, recipient);
    if (data.type === "reply" && profile.notificationPreferences.replies === false) return;
    if (data.type === "like" && profile.notificationPreferences.likes === false) return;
    if (data.type === "game_comment" && !profile.notificationPreferences.gameComments?.[data.gameId]) return;
    store.commentNotifications.push({ id: randomId(), createdAt: new Date().toISOString(), readAt: "", ...data, recipientEmail: recipient, actorEmail: normalizeEmail(data.actorEmail) });
  }

  function notifyGameMembers(store, game, comment) {
    const emails = new Set([normalizeEmail(game.ownerEmail), ...(game.teamMembers || []).filter((member) => member.active !== false).map((member) => normalizeEmail(member.email))]);
    for (const email of emails) makeNotification(store, { type: "game_comment", recipientEmail: email, actorEmail: comment.authorEmail, gameId: game.id, commentId: comment.id, rootId: comment.id });
  }

  async function createComment(req, res, gameId, replyToId = "") {
    const parsed = await parseMultipart(req, { maxBody: replyToId ? 1000 : 2000 });
    try {
      const result = await mutateStore((store) => {
        const session = requireSession(store, req).session;
        const game = store.games.find((item) => item.id === gameId);
        if (!game) throw fail("没有找到这款作品。", 404, "GAME_NOT_FOUND");
        ensureCanPost(store, game, session, replyToId ? "reply" : "root");
        const body = cleanBody(parsed.fields.body, replyToId ? 1000 : 2000);
        if (!body && !parsed.files.length) throw fail("请留下文字或至少一张图片。", 400, "COMMENT_EMPTY");
        const tags = replyToId ? [] : parseTags(store, parsed.fields.tags);
        let target = null;
        let rootId = "";
        if (replyToId) {
          target = store.comments.find((item) => item.id === replyToId && item.gameId === gameId);
          if (!target) throw fail("要回应的信号已经不存在。", 404, "COMMENT_NOT_FOUND");
          if (target.status !== "active") throw fail("这段信号暂不可回应。", 409, "COMMENT_NOT_ACTIVE");
          rootId = target.replyToId ? target.rootId : target.id;
        }
        const duplicate = store.comments.find((item) => item.authorEmail === normalizeEmail(session.email) && item.gameId === gameId && item.body === body && Date.now() - Date.parse(item.createdAt) < 60 * 1000);
        if (duplicate) return { comment: duplicate, duplicate: true, session };
        const profile = currentProfile(store, session.email, session);
        const now = new Date().toISOString();
        const comment = {
          id: randomId(), gameId, rootId: rootId || "", replyToId: target?.id || "", authorEmail: normalizeEmail(session.email),
          body, images: parsed.files, tags, status: "active", likeEmails: [], createdAt: now, updatedAt: now,
          identitySnapshot: { name: profile.name, team: profile.team, avatarUrl: profile.avatarUrl, developer: Boolean(participantRole(game, session.email)) },
          replyToSnapshot: target ? { id: target.id, name: publicAuthor(store, target).name, email: target.authorEmail } : null,
          moderation: []
        };
        if (!comment.rootId) comment.rootId = comment.id;
        store.comments.push(comment);
        addAudit(store, { action: replyToId ? "comment_reply_created" : "comment_created", actorType: "participant", actorId: session.id, actorEmail: session.email, gameId, commentId: comment.id, after: { body, images: parsed.files.map((image) => image.url), tags, identitySnapshot: comment.identitySnapshot } });
        if (target) makeNotification(store, { type: "reply", recipientEmail: target.authorEmail, actorEmail: session.email, gameId, commentId: comment.id, rootId: comment.rootId, targetCommentId: target.id });
        else notifyGameMembers(store, game, comment);
        return { comment, duplicate: false, session };
      });
      return json(res, result.duplicate ? 200 : 201, { ok: true, duplicate: result.duplicate, comment: publicComment(await ensureStore(), result.comment, result.session.email, { includeReplies: false }), message: result.duplicate ? "这段回声已经发送过。" : "回声已进入观测频段。" });
    } catch (error) {
      await Promise.all(parsed.created.map((file) => fsp.unlink(file).catch(() => {})));
      throw error;
    }
  }

  async function listComments(req, res, url, gameId) {
    const store = await ensureStore();
    const game = store.games.find((item) => item.id === gameId);
    const availability = commentAvailability(store, game);
    if (!availability.readable) throw fail("讨论空间尚未开放。", 404, "COMMENTS_NOT_PUBLIC");
    const session = sessionRecord(store, req)?.session;
    const limit = Math.max(1, Math.min(30, Number(url.searchParams.get("limit") || 15)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    const roots = store.comments.filter((item) => item.gameId === gameId && !item.replyToId && !(item.status === "deleted" && item.deleteMode === "removed")).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const page = roots.slice(offset, offset + limit).map((comment) => publicComment(store, comment, session?.email, { replyLimit: 1 }));
    return json(res, 200, { ok: true, comments: page, total: roots.length, nextOffset: offset + page.length < roots.length ? offset + page.length : null, availability, tags: store.commentTags.filter((tag) => tag.enabled).sort((a, b) => a.order - b.order), identity: session ? currentProfile(store, session.email, session) : null, viewerDeveloper: Boolean(session && participantRole(game, session.email)) });
  }

  async function listReplies(req, res, commentId) {
    const store = await ensureStore();
    const root = store.comments.find((item) => item.id === commentId && !item.replyToId);
    if (!root) throw fail("没有找到这段回声。", 404, "COMMENT_NOT_FOUND");
    const game = store.games.find((item) => item.id === root.gameId);
    if (!commentAvailability(store, game).readable) throw fail("讨论空间尚未开放。", 404, "COMMENTS_NOT_PUBLIC");
    const session = sessionRecord(store, req)?.session;
    const replies = store.comments.filter((item) => item.rootId === root.id && item.id !== root.id && !(item.status === "deleted" && item.deleteMode === "removed")).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map((item) => publicComment(store, item, session?.email, { includeReplies: false }));
    return json(res, 200, { ok: true, root: publicComment(store, root, session?.email, { includeReplies: false }), replies, availability: commentAvailability(store, game) });
  }

  async function deleteComment(req, res, id) {
    const result = await mutateStore((store) => {
      const session = requireSession(store, req).session;
      const comment = store.comments.find((item) => item.id === id);
      if (!comment) throw fail("没有找到这段回声。", 404, "COMMENT_NOT_FOUND");
      if (normalizeEmail(comment.authorEmail) !== normalizeEmail(session.email)) throw fail("只能收回自己发出的回声。", 403, "COMMENT_NOT_OWNED");
      if (comment.status !== "active") throw fail("这段回声已经被收回或隐藏。", 409, "COMMENT_NOT_ACTIVE");
      const hasDependants = store.comments.some((item) => item.replyToId === id || (comment.replyToId === "" && item.rootId === id && item.id !== id));
      comment.status = "deleted";
      comment.deletedAt = new Date().toISOString();
      comment.deletedBy = session.email;
      comment.deleteMode = hasDependants ? "soft" : "removed";
      store.commentNotifications = store.commentNotifications.filter((item) => item.commentId !== id && item.targetCommentId !== id && item.rootId !== id);
      addAudit(store, { action: "comment_deleted_by_author", actorType: "participant", actorId: session.id, actorEmail: session.email, gameId: comment.gameId, commentId: id, before: { body: comment.body, images: comment.images, tags: comment.tags }, after: { status: "deleted", deleteMode: comment.deleteMode } });
      return comment;
    });
    return json(res, 200, { ok: true, comment: publicComment(await ensureStore(), result, "", { includeReplies: false }), message: "这段回声已收回。" });
  }

  async function toggleLike(req, res, id, liked) {
    const result = await mutateStore((store) => {
      const session = requireSession(store, req).session;
      const comment = store.comments.find((item) => item.id === id);
      if (!comment || comment.status !== "active") throw fail("这段信号暂不可共鸣。", 404, "COMMENT_NOT_FOUND");
      const email = normalizeEmail(session.email);
      if (email === normalizeEmail(comment.authorEmail)) throw fail("不能为自己的回声共鸣。", 409, "SELF_LIKE_DISABLED");
      const before = new Set(comment.likeEmails || []);
      if (liked) before.add(email); else before.delete(email);
      comment.likeEmails = [...before];
      if (liked) makeNotification(store, { type: "like", recipientEmail: comment.authorEmail, actorEmail: email, gameId: comment.gameId, commentId: comment.id, rootId: comment.rootId });
      else store.commentNotifications = store.commentNotifications.filter((item) => !(item.type === "like" && item.commentId === id && item.actorEmail === email));
      return { count: comment.likeEmails.length };
    });
    return json(res, 200, { ok: true, liked, likeCount: result.count });
  }

  async function commentProfile(req, res) {
    if (req.method === "GET") {
      const store = await ensureStore();
      const session = requireSession(store, req).session;
      return json(res, 200, { ok: true, profile: currentProfile(store, session.email, session) });
    }
    const parsed = await parseMultipart(req, { avatar: true, maxBody: 200 });
    try {
      const profile = await mutateStore((store) => {
        const record = requireSession(store, req);
        const email = normalizeEmail(record.session.email);
        const before = currentProfile(store, email, record.session);
        const name = cleanText(parsed.fields.name, 40) || before.name;
        const next = { ...before, name, avatarUrl: parsed.fields.clearAvatar === "true" ? "" : parsed.files[0]?.url || before.avatarUrl, updatedAt: new Date().toISOString() };
        store.commentProfiles[email] = { ...(store.commentProfiles[email] || {}), name: next.name, team: next.team, avatarUrl: next.avatarUrl, notificationPreferences: next.notificationPreferences, updatedAt: next.updatedAt };
        for (const session of Object.values(store.sessions)) if (normalizeEmail(session.email) === email) { session.name = name; session.personKey = personKey(name, session.team); }
        const ballot = store.ballots.find((item) => normalizeEmail(item.email) === email);
        if (ballot) { ballot.name = name; ballot.personKey = personKey(name, ballot.team); }
        const assigned = store.games.find((game) => participantRole(game, email));
        if (assigned) {
          const role = participantRole(assigned, email);
          const creatorId = role.role === "owner" ? assigned.ownerCreatorId : role.member.creatorId;
          const creator = assigned.creators.find((item) => item.id === creatorId);
          if (creator) creator.name = name;
        }
        addAudit(store, { action: "comment_profile_updated", actorType: "participant", actorId: record.session.id, actorEmail: email, before: { name: before.name, avatarUrl: before.avatarUrl }, after: { name, avatarUrl: next.avatarUrl } });
        return next;
      });
      return json(res, 200, { ok: true, profile, message: "观测者资料已同步。" });
    } catch (error) {
      await Promise.all(parsed.created.map((file) => fsp.unlink(file).catch(() => {})));
      throw error;
    }
  }

  async function notifications(req, res, url) {
    const store = await ensureStore();
    const session = requireSession(store, req).session;
    const email = normalizeEmail(session.email);
    const valid = store.commentNotifications.filter((item) => item.recipientEmail === email && store.comments.some((comment) => comment.id === item.commentId && comment.status === "active"));
    const grouped = [];
    const likeGroups = new Map();
    for (const item of valid.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
      if (item.type !== "like") { grouped.push(item); continue; }
      const key = `like:${item.commentId}`;
      const group = likeGroups.get(key) || { ...item, actorCount: 0, actorEmails: [] };
      group.actorCount += 1;
      group.actorEmails.push(item.actorEmail);
      if (!item.readAt) group.readAt = "";
      likeGroups.set(key, group);
    }
    grouped.push(...likeGroups.values());
    grouped.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const participantGames = store.games
      .filter((game) => participantRole(game, email))
      .map((game) => ({ id: game.id, title: game.title || "未命名作品" }));
    return json(res, 200, { ok: true, notifications: grouped.slice(0, 80).map((item) => ({ ...item, actors: (item.actorEmails || [item.actorEmail]).slice(0, 3).map((actor) => publicAuthor(store, { authorEmail: actor, gameId: item.gameId, identitySnapshot: {} })) })), unreadCount: valid.filter((item) => !item.readAt).length, preferences: currentProfile(store, email, session).notificationPreferences, participantGames });
  }

  async function updateNotifications(req, res, action) {
    const body = await deps.readJson(req);
    const result = await mutateStore((store) => {
      const session = requireSession(store, req).session;
      const email = normalizeEmail(session.email);
      if (action === "read-all") {
        const now = new Date().toISOString();
        store.commentNotifications.forEach((item) => { if (item.recipientEmail === email) item.readAt ||= now; });
      } else if (action === "preferences") {
        const current = currentProfile(store, email, session);
        const prefs = {
          replies: body.replies !== false,
          likes: body.likes !== false,
          gameComments: Object.fromEntries(Object.entries(body.gameComments || {}).filter(([gameId]) => store.games.some((game) => game.id === gameId && participantRole(game, email))).map(([gameId, enabled]) => [gameId, Boolean(enabled)]))
        };
        store.commentProfiles[email] = { ...(store.commentProfiles[email] || {}), name: current.name, team: current.team, avatarUrl: current.avatarUrl, notificationPreferences: prefs, updatedAt: new Date().toISOString() };
      }
      return currentProfile(store, email, session);
    });
    return json(res, 200, { ok: true, profile: result });
  }

  async function adminList(req, res, url) {
    if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
    const store = await ensureStore();
    const comments = store.comments.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((item) => publicComment(store, item, "", { admin: true, includeReplies: false }));
    const titleById = Object.fromEntries(store.games.map((game) => [game.id, game.title]));
    return json(res, 200, { ok: true, comments: comments.map((item) => ({ ...item, gameTitle: titleById[item.gameId] || "已归档作品" })), tags: store.commentTags, mutes: store.commentMutes, settings: { commentsPaused: Boolean(store.settings.commentsPaused), games: store.games.map((game) => ({ id: game.id, title: game.title, commentsReadOnly: Boolean(game.commentsReadOnly) })) } });
  }

  async function adminSettings(req, res, url, gameId = "") {
    if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
    const body = await deps.readJson(req);
    const reason = cleanText(body.reason, 500);
    if (!reason) return json(res, 400, { ok: false, error: "REASON_REQUIRED", message: "请填写调整原因。" });
    await mutateStore((store) => {
      if (gameId) {
        const game = store.games.find((item) => item.id === gameId);
        if (!game) throw fail("没有找到作品。", 404, "GAME_NOT_FOUND");
        const before = Boolean(game.commentsReadOnly);
        game.commentsReadOnly = Boolean(body.readOnly);
        addAudit(store, { action: "game_comments_readonly_updated", actorType: "admin", actorId: "admin", gameId, reason, before, after: game.commentsReadOnly });
      } else {
        const before = Boolean(store.settings.commentsPaused);
        store.settings.commentsPaused = Boolean(body.paused);
        addAudit(store, { action: "global_comments_paused_updated", actorType: "admin", actorId: "admin", reason, before, after: store.settings.commentsPaused });
      }
    });
    return json(res, 200, { ok: true, message: "评论空间状态已更新。" });
  }

  async function adminTag(req, res, url, id = "") {
    if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
    const body = await deps.readJson(req);
    const result = await mutateStore((store) => {
      if (!id) {
        const label = cleanText(body.label, 8);
        const group = cleanText(body.group, 20) || "其他";
        if (!label) throw fail("标签不能为空。", 400, "TAG_REQUIRED");
        if (store.commentTags.some((tag) => tag.label === label)) throw fail("标签已经存在。", 409, "TAG_EXISTS");
        const tag = { id: randomId(), label, group, enabled: true, order: Number(body.order || store.commentTags.length), createdAt: new Date().toISOString() };
        store.commentTags.push(tag);
        addAudit(store, { action: "comment_tag_created", actorType: "admin", actorId: "admin", after: tag });
        return tag;
      }
      const tag = store.commentTags.find((item) => item.id === id);
      if (!tag) throw fail("没有找到标签。", 404, "TAG_NOT_FOUND");
      const before = { ...tag };
      if (body.label !== undefined) tag.label = cleanText(body.label, 8) || tag.label;
      if (body.group !== undefined) tag.group = cleanText(body.group, 20) || tag.group;
      if (body.enabled !== undefined) tag.enabled = Boolean(body.enabled);
      if (body.order !== undefined) tag.order = Number(body.order || 0);
      addAudit(store, { action: "comment_tag_updated", actorType: "admin", actorId: "admin", before, after: { ...tag } });
      return tag;
    });
    return json(res, id ? 200 : 201, { ok: true, tag: result });
  }

  async function adminModerate(req, res, url, id) {
    if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
    const body = await deps.readJson(req);
    const reason = cleanText(body.reason, 500);
    const action = cleanText(body.action, 40);
    if (!reason) return json(res, 400, { ok: false, error: "REASON_REQUIRED", message: "每次管理操作都必须填写原因。" });
    const result = await mutateStore((store) => {
      const comment = store.comments.find((item) => item.id === id);
      if (!comment) throw fail("没有找到评论。", 404, "COMMENT_NOT_FOUND");
      const before = { status: comment.status, images: comment.images, tags: comment.tags };
      if (action === "hide") comment.status = "hidden";
      else if (action === "restore") comment.status = "active";
      else if (action === "remove-image") {
        const image = (comment.images || []).find((item) => item.id === cleanText(body.imageId, 100));
        if (!image) throw fail("没有找到图片。", 404, "IMAGE_NOT_FOUND");
        image.removedAt = new Date().toISOString(); image.removedReason = reason;
      } else if (action === "remove-custom-tag") {
        const tag = (comment.tags || []).find((item) => item.id === cleanText(body.tagId, 100) && item.custom);
        if (!tag) throw fail("没有找到自定义标签。", 404, "TAG_NOT_FOUND");
        tag.removedAt = new Date().toISOString(); tag.removedReason = reason;
      } else throw fail("不支持的管理操作。", 400, "MODERATION_ACTION_INVALID");
      comment.moderation ||= [];
      comment.moderation.push({ id: randomId(), action, reason, createdAt: new Date().toISOString(), actor: "admin" });
      if (["hide"].includes(action)) store.commentNotifications = store.commentNotifications.filter((item) => item.commentId !== id && item.targetCommentId !== id && item.rootId !== id);
      addAudit(store, { action: `comment_admin_${action}`, actorType: "admin", actorId: "admin", gameId: comment.gameId, commentId: id, reason, before, after: { status: comment.status, images: comment.images, tags: comment.tags } });
      return comment;
    });
    return json(res, 200, { ok: true, comment: publicComment(await ensureStore(), result, "", { admin: true, includeReplies: false }), message: "管理操作已记录。" });
  }

  async function adminMute(req, res, url, email, unmute = false) {
    if (!requireAdmin(req, url)) return json(res, 401, { ok: false, error: "ADMIN_PASSWORD_REQUIRED", message: "请输入后台密码。" });
    const body = await deps.readJson(req);
    const reason = cleanText(body.reason, 500);
    if (!reason) return json(res, 400, { ok: false, error: "REASON_REQUIRED", message: "禁言与解禁都必须填写原因。" });
    const normalized = normalizeEmail(email);
    await mutateStore((store) => {
      const before = store.commentMutes[normalized] || null;
      if (unmute) delete store.commentMutes[normalized];
      else {
        const duration = cleanText(body.duration, 20);
        const hours = { "1h": 1, "1d": 24, "7d": 168 }[duration];
        if (!hours && duration !== "permanent") throw fail("请选择 1 小时、1 天、7 天或永久。", 400, "MUTE_DURATION_INVALID");
        store.commentMutes[normalized] = { email: normalized, permanent: duration === "permanent", until: hours ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : "", reason, createdAt: new Date().toISOString() };
      }
      addAudit(store, { action: unmute ? "comment_user_unmuted" : "comment_user_muted", actorType: "admin", actorId: "admin", actorEmail: normalized, reason, before, after: store.commentMutes[normalized] || null });
    });
    return json(res, 200, { ok: true, message: unmute ? "已解除回声发送限制。" : "回声发送限制已生效。" });
  }

  async function route(req, res, url) {
    const gameComments = url.pathname.match(/^\/api\/games\/([^/]+)\/comments$/);
    if (gameComments) {
      const gameId = decodeURIComponent(gameComments[1]);
      if (req.method === "GET") { await listComments(req, res, url, gameId); return true; }
      if (req.method === "POST") { await createComment(req, res, gameId); return true; }
      methodNotAllowed(res); return true;
    }
    const repliesList = url.pathname.match(/^\/api\/comments\/([^/]+)\/replies$/);
    if (repliesList) {
      const id = decodeURIComponent(repliesList[1]);
      if (req.method === "GET") { await listReplies(req, res, id); return true; }
      if (req.method === "POST") {
        const store = await ensureStore();
        const target = store.comments.find((item) => item.id === id);
        if (!target) throw fail("没有找到要回应的信号。", 404, "COMMENT_NOT_FOUND");
        await createComment(req, res, target.gameId, id); return true;
      }
      methodNotAllowed(res); return true;
    }
    const like = url.pathname.match(/^\/api\/comments\/([^/]+)\/like$/);
    if (like) {
      if (req.method === "PUT") { await toggleLike(req, res, decodeURIComponent(like[1]), true); return true; }
      if (req.method === "DELETE") { await toggleLike(req, res, decodeURIComponent(like[1]), false); return true; }
      methodNotAllowed(res); return true;
    }
    const single = url.pathname.match(/^\/api\/comments\/([^/]+)$/);
    if (single) { if (req.method === "DELETE") { await deleteComment(req, res, decodeURIComponent(single[1])); return true; } methodNotAllowed(res); return true; }
    if (url.pathname === "/api/comment-profile") {
      if (["GET", "PUT"].includes(req.method)) { await commentProfile(req, res); return true; }
      methodNotAllowed(res); return true;
    }
    if (url.pathname === "/api/comment-notifications") { if (req.method === "GET") { await notifications(req, res, url); return true; } methodNotAllowed(res); return true; }
    if (url.pathname === "/api/comment-notifications/read-all") { if (req.method === "POST") { await updateNotifications(req, res, "read-all"); return true; } methodNotAllowed(res); return true; }
    if (url.pathname === "/api/comment-notifications/preferences") { if (req.method === "PUT") { await updateNotifications(req, res, "preferences"); return true; } methodNotAllowed(res); return true; }
    if (url.pathname === "/api/admin/comments") { if (req.method === "GET") { await adminList(req, res, url); return true; } methodNotAllowed(res); return true; }
    if (url.pathname === "/api/admin/comments/settings") { if (req.method === "PUT") { await adminSettings(req, res, url); return true; } methodNotAllowed(res); return true; }
    const gameSettings = url.pathname.match(/^\/api\/admin\/games\/([^/]+)\/comments\/settings$/);
    if (gameSettings) { if (req.method === "PUT") { await adminSettings(req, res, url, decodeURIComponent(gameSettings[1])); return true; } methodNotAllowed(res); return true; }
    if (url.pathname === "/api/admin/comments/tags") { if (req.method === "POST") { await adminTag(req, res, url); return true; } methodNotAllowed(res); return true; }
    const tag = url.pathname.match(/^\/api\/admin\/comments\/tags\/([^/]+)$/);
    if (tag) { if (req.method === "PUT") { await adminTag(req, res, url, decodeURIComponent(tag[1])); return true; } methodNotAllowed(res); return true; }
    const moderate = url.pathname.match(/^\/api\/admin\/comments\/([^/]+)\/moderate$/);
    if (moderate) { if (req.method === "POST") { await adminModerate(req, res, url, decodeURIComponent(moderate[1])); return true; } methodNotAllowed(res); return true; }
    const mute = url.pathname.match(/^\/api\/admin\/comment-mutes\/([^/]+)$/);
    if (mute) {
      if (req.method === "POST") { await adminMute(req, res, url, decodeURIComponent(mute[1]), false); return true; }
      if (req.method === "DELETE") { await adminMute(req, res, url, decodeURIComponent(mute[1]), true); return true; }
      methodNotAllowed(res); return true;
    }
    return false;
  }

  return { route, publicComment, commentAvailability };
}

function createCommentService(deps) {
  return makeCommentService(deps);
}

module.exports = { createCommentService, defaultCommentTags };
