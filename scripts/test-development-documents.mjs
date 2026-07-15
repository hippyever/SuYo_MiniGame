import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "suyo-development-documents-"));
const port = 3218 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
const adminPassword = "test-development-admin";
const child = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: {
    ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "test", ALLOW_DEV_OTP: "true",
    ADMIN_PASSWORD: adminPassword, MINIGAME_DATA_FILE: path.join(temp, "store.json"),
    MINIGAME_UPLOAD_DIR: path.join(temp, "uploads"), MINIGAME_PRIVATE_DOCUMENT_DIR: path.join(temp, "private-documents"),
    MAX_DEVELOPMENT_DOCUMENT_MB: "1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
child.stdout.on("data", (chunk) => { serverOutput += chunk; });
child.stderr.on("data", (chunk) => { serverOutput += chunk; });

async function request(route, { cookie = "", admin = false, raw = false, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set("cookie", cookie);
  if (admin) headers.set("x-admin-password", adminPassword);
  const response = await fetch(`${base}${route}`, { ...options, headers });
  const body = raw ? Buffer.from(await response.arrayBuffer()) : await response.json().catch(() => ({}));
  return { response, body, cookie: response.headers.get("set-cookie")?.split(";")[0] || cookie };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("test server did not start");
}

async function login(name, team, email) {
  const sent = await request("/api/verification/request", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, team, email })
  });
  assert.equal(sent.response.status, 200);
  const verified = await request("/api/auth/verify", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, team, email, code: sent.body.devCode })
  });
  assert.equal(verified.response.status, 200);
  return verified.cookie;
}

try {
  await waitForServer();
  const ownerCookie = await login("星野", "信号小组", "docs-owner@example.com");
  let form = new FormData();
  form.set("title", "私有资料测试星");
  let result = await request("/api/participant/games", { cookie: ownerCookie, method: "POST", body: form });
  assert.equal(result.response.status, 201);
  let game = result.body.game;

  result = await request("/api/participant/uploads", {
    cookie: ownerCookie, method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "game", originalName: "resumable-game.zip", mimeType: "application/zip", size: 10 })
  });
  assert.equal(result.response.status, 201);
  const resumableGameId = result.body.upload.id;
  result = await request(`/api/participant/uploads/${resumableGameId}/chunk`, {
    cookie: ownerCookie, method: "PUT", headers: { "content-type": "application/octet-stream", "x-upload-offset": "0" }, body: Buffer.from("first-")
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.upload.uploadedBytes, 6);
  result = await request("/api/participant/uploads", {
    cookie: ownerCookie, method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "game", originalName: "resumable-game.zip", mimeType: "application/zip", size: 10, resumeId: resumableGameId })
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.upload.uploadedBytes, 6);
  result = await request(`/api/participant/uploads/${resumableGameId}/chunk`, {
    cookie: ownerCookie, method: "PUT", headers: { "content-type": "application/octet-stream", "x-upload-offset": "6" }, body: Buffer.from("part")
  });
  assert.equal(result.response.status, 200);
  result = await request(`/api/participant/uploads/${resumableGameId}/complete`, { cookie: ownerCookie, method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(result.response.status, 200);

  result = await request("/api/participant/uploads", {
    cookie: ownerCookie, method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "developmentDocument", originalName: "可恢复资料.md", mimeType: "text/markdown", size: 10 })
  });
  const resumableDocumentId = result.body.upload.id;
  result = await request(`/api/participant/uploads/${resumableDocumentId}/chunk`, {
    cookie: ownerCookie, method: "PUT", headers: { "content-type": "application/octet-stream", "x-upload-offset": "0" }, body: Buffer.from("resume-doc")
  });
  assert.equal(result.response.status, 200);
  result = await request(`/api/participant/uploads/${resumableDocumentId}/complete`, { cookie: ownerCookie, method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(result.response.status, 200);
  result = await request(`/api/participant/games/${game.id}/development-documents/attach`, {
    cookie: ownerCookie, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uploadIds: [resumableDocumentId] })
  });
  assert.equal(result.response.status, 201);
  game = result.body.game;
  assert.equal(game.developmentDocuments.length, 1);

  result = await request(`/api/participant/games/${game.id}/members`, {
    cookie: ownerCookie, method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "轨道员", email: "docs-member@example.com", role: "程序" })
  });
  assert.equal(result.response.status, 201);

  form = new FormData();
  form.append("documents", new Blob([Buffer.from("design-v1")], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "玩法设计.docx");
  form.append("documents", new Blob([Buffer.from("schedule-v1")], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "开发排期.xlsx");
  result = await request(`/api/participant/games/${game.id}/development-documents`, { cookie: ownerCookie, method: "POST", body: form });
  assert.equal(result.response.status, 201);
  game = result.body.game;
  assert.equal(game.developmentDocuments.length, 3);
  assert.ok(!JSON.stringify((await request("/api/site")).body).includes("玩法设计.docx"));

  const first = game.developmentDocuments[1];
  const storedBefore = JSON.parse(await readFile(path.join(temp, "store.json"), "utf8")).games[0].developmentDocuments.find((item) => item.id === first.id).storageName;
  const memberCookie = await login("轨道员", "任意登录队伍", "docs-member@example.com");
  result = await request("/api/participant/workspace", { cookie: memberCookie });
  assert.equal(result.body.game.developmentDocuments.length, 3);
  result = await request(`/api/participant/games/${game.id}/development-documents/${first.id}/download`, { cookie: memberCookie, raw: true });
  assert.equal(result.response.status, 200);
  assert.ok(["design-v1", "schedule-v1"].includes(result.body.toString()));

  form = new FormData();
  form.set("document", new Blob([Buffer.from("design-v2")], { type: "application/pdf" }), "玩法设计-v2.pdf");
  result = await request(`/api/participant/games/${game.id}/development-documents/${first.id}`, { cookie: memberCookie, method: "PUT", body: form });
  assert.equal(result.response.status, 200);
  game = result.body.game;
  assert.equal(game.developmentDocuments.find((item) => item.id === first.id).originalName, "玩法设计-v2.pdf");
  assert.ok(!(await readdir(path.join(temp, "private-documents"))).includes(storedBefore));

  form = new FormData();
  form.set("documents", new Blob([Buffer.from("bad")]), "脚本.exe");
  result = await request(`/api/participant/games/${game.id}/development-documents`, { cookie: ownerCookie, method: "POST", body: form });
  assert.equal(result.response.status, 415);
  form = new FormData();
  form.set("documents", new Blob([Buffer.alloc(1024 * 1024 + 1)]), "超限资料.zip");
  result = await request(`/api/participant/games/${game.id}/development-documents`, { cookie: ownerCookie, method: "POST", body: form });
  assert.equal(result.response.status, 413);

  form = new FormData();
  form.set("revision", String(game.revision)); form.set("title", game.title); form.set("team", "信号小组");
  form.set("shortDescription", "测试私有资料归档"); form.set("description", "完整游戏简介"); form.set("creationNote", "测试记录");
  form.set("tags", "测试"); form.set("videoExternalUrl", "https://example.com/video"); form.set("coverUrl", "https://example.com/cover.png");
  form.set("resumableGameFileId", resumableGameId);
  result = await request(`/api/participant/games/${game.id}`, { cookie: ownerCookie, method: "PUT", body: form });
  assert.equal(result.response.status, 200);
  game = result.body.game;
  result = await request(`/api/participant/games/${game.id}/submit`, { cookie: ownerCookie, method: "POST" });
  assert.equal(result.response.status, 200);
  const publicAfterSubmission = await request("/api/site");
  assert.ok(publicAfterSubmission.body.games.some((item) => item.id === game.id));
  assert.ok(!JSON.stringify(publicAfterSubmission.body).includes("玩法设计-v2.pdf"));
  assert.ok(!JSON.stringify(publicAfterSubmission.body).includes("developmentDocuments"));
  result = await request(`/api/participant/games/${game.id}/withdraw`, { cookie: ownerCookie, method: "POST" });
  assert.equal(result.response.status, 200);

  result = await request(`/api/admin/games/${game.id}/development-documents/${first.id}/download`, { admin: true, raw: true });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.toString(), "design-v2");
  result = await request("/api/admin/export/archive-ticket", {
    admin: true, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "game", gameId: game.id })
  });
  assert.equal(result.response.status, 201);
  const single = await request(result.body.downloadUrl, { raw: true });
  assert.equal(single.response.status, 200);
  assert.equal(single.body.subarray(0, 2).toString(), "PK");
  assert.ok(single.body.includes(Buffer.from("玩法设计-v2.pdf")));
  assert.ok(single.body.includes(Buffer.from("作品信息.xlsx")));

  result = await request("/api/admin/export/archive-ticket", {
    admin: true, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "all" })
  });
  const all = await request(result.body.downloadUrl, { raw: true });
  assert.equal(all.response.status, 200);
  assert.ok(all.body.includes(Buffer.from("私有资料测试星")));
  const store = JSON.parse(await readFile(path.join(temp, "store.json"), "utf8"));
  assert.ok(store.audit.some((item) => item.action === "development_document_uploaded"));
  assert.ok(store.audit.some((item) => item.action === "development_document_replaced"));
  console.log("development document and archive flow passed");
} catch (error) {
  console.error(serverOutput);
  throw error;
} finally {
  child.kill();
  await rm(temp, { recursive: true, force: true });
}
