import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const temp = path.join(root, `.tmp-comment-test-${crypto.randomUUID()}`);
const dataFile = path.join(temp, "minigame.json");
const port = 3197;
const now = new Date();
const gameId = "comment-test-game";

const store = {
  version: 9,
  createdAt: now.toISOString(),
  games: [{
    id: gameId, title: "回声测试行星", team: "测试队", shortDescription: "测试评论", description: "测试评论", creationNote: "",
    creators: [{ id: "owner", name: "开发者", role: "负责人", order: 0 }], ownerEmail: "dev@example.com", ownerCreatorId: "owner",
    historicalOwnerEmails: ["dev@example.com"], teamMembers: [], historicalTeamEmails: [], status: "submitted", published: true,
    firstSubmittedAt: now.toISOString(), submittedAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(),
    tags: [], coverUrl: "", videoUrl: "", videoExternalUrl: "", downloadUrl: "", coordinate: { x: 0, y: 0, z: 0 }, planetSeed: "echo-test", order: 1
  }],
  ballots: [], ballotOperations: {}, verificationCodes: {}, sessions: {}, emailVerifications: {}, audit: [], retiredAssets: [],
  comments: [], commentProfiles: {}, commentNotifications: [], commentMutes: {}, commentTags: [],
  settings: { eventTitle: "评论测试", theme: "宇宙", slogan: "溯求本源，造物不止", eventSeed: "test", startAt: new Date(Date.now() - 3600000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString(), submissionEndAt: new Date(Date.now() + 3600000).toISOString(), resultsPublished: false, winnerGameIds: [], constellationGameIds: [], commentsPaused: false }
};

await mkdir(temp, { recursive: true });
await writeFile(dataFile, `${JSON.stringify(store, null, 2)}\n`);

const server = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MINIGAME_DATA_FILE: dataFile, MINIGAME_UPLOAD_DIR: path.join(temp, "uploads"), MINIGAME_PRIVATE_DOCUMENT_DIR: path.join(temp, "private"), MINIGAME_UPLOAD_SESSION_DIR: path.join(temp, "sessions"), ADMIN_PASSWORD: "comment-test-admin", ALLOW_DEV_OTP: "true", SESSION_COOKIE_SECURE: "false", NODE_ENV: "development" },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
server.stderr.on("data", (chunk) => { stderr += chunk; });
const base = `http://127.0.0.1:${port}`;

async function waitForServer() {
  for (let index = 0; index < 80; index += 1) {
    try { const response = await fetch(`${base}/api/health`); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server failed to start: ${stderr}`);
}

async function api(url, options = {}, cookie = "") {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${base}${url}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${body.error}: ${body.message}`);
  return { body, cookie: response.headers.get("set-cookie")?.split(";")[0] || cookie };
}

async function login(name, team, email) {
  const request = await api("/api/verification/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, team, email }) });
  const verified = await api("/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, team, email, code: request.body.devCode }) });
  return verified.cookie;
}

function commentForm(body, tags = []) {
  const form = new FormData();
  form.set("body", body);
  form.set("tags", JSON.stringify(tags));
  return form;
}

try {
  await waitForServer();
  const observerCookie = await login("观测者甲", "访客队", "observer@example.com");
  const rootComment = await api(`/api/games/${gameId}/comments`, { method: "POST", body: commentForm("玩法反馈清晰，期待继续开发。", [{ label: "期待更新" }]) }, observerCookie);
  if (!rootComment.body.comment?.id) throw new Error("root comment was not created");
  const commentId = rootComment.body.comment.id;

  const developerCookie = await login("开发者", "测试队", "dev@example.com");
  let developerRootBlocked = false;
  try { await api(`/api/games/${gameId}/comments`, { method: "POST", body: commentForm("开发者不应发一级评论") }, developerCookie); } catch (error) { developerRootBlocked = error.message.includes("DEVELOPER_REPLY_ONLY"); }
  if (!developerRootBlocked) throw new Error("developer root comment was not blocked");

  const reply = await api(`/api/comments/${commentId}/replies`, { method: "POST", body: commentForm("感谢观测，我们会继续校准操作反馈。") }, developerCookie);
  if (!reply.body.comment?.author?.developer) throw new Error("developer badge was not resolved dynamically");
  await api(`/api/comments/${commentId}/like`, { method: "PUT" }, developerCookie);

  const notifications = await api("/api/comment-notifications", {}, observerCookie);
  if (!notifications.body.notifications.some((item) => item.type === "reply") || !notifications.body.notifications.some((item) => item.type === "like")) throw new Error("reply/like notifications missing");

  await api(`/api/admin/comments/${reply.body.comment.id}/moderate`, { method: "POST", headers: { "content-type": "application/json", "x-admin-password": "comment-test-admin" }, body: JSON.stringify({ action: "hide", reason: "自动化回归" }) });
  const replies = await api(`/api/comments/${commentId}/replies`, {}, observerCookie);
  if (replies.body.replies[0]?.status !== "hidden-placeholder") throw new Error("hidden comment placeholder missing");

  await api("/api/admin/comments/settings", { method: "PUT", headers: { "content-type": "application/json", "x-admin-password": "comment-test-admin" }, body: JSON.stringify({ paused: true, reason: "自动化回归" }) });
  const list = await api(`/api/games/${gameId}/comments?limit=15`, {}, observerCookie);
  if (list.body.availability.writable !== false) throw new Error("global read-only state missing");

  console.log("comment regression passed");
} finally {
  server.kill();
  if (server.exitCode === null && server.signalCode === null) {
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1500))
    ]);
  }
  await rm(temp, { recursive: true, force: true });
}
