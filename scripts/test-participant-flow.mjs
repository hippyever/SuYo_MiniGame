import assert from "node:assert/strict";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3107";
const adminPassword = process.env.TEST_ADMIN_PASSWORD || "test-admin";

async function request(path, { cookie = "", admin = false, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set("cookie", cookie);
  if (admin) headers.set("x-admin-password", adminPassword);
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body, cookie: response.headers.get("set-cookie")?.split(";")[0] || cookie };
}

async function login(name, team, email) {
  const sent = await request("/api/verification/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, team, email })
  });
  assert.equal(sent.response.status, 200);
  assert.match(sent.body.devCode, /^\d{6}$/);
  const verified = await request("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, team, email, code: sent.body.devCode })
  });
  assert.equal(verified.response.status, 200);
  return verified.cookie;
}

function workForm(game, overrides = {}) {
  const values = {
    revision: game.revision,
    title: game.title || "引力种子",
    team: game.team || "远日点小组",
    shortDescription: game.shortDescription || "用脉冲改变一颗沉睡行星",
    description: game.description || "一款围绕引力、节奏与探索展开的短篇游戏。",
    creationNote: game.creationNote || "我们从轨道共振开始制作。",
    tags: "模拟，探索",
    coverUrl: game.coverUrl || "",
    videoExternalUrl: game.videoExternalUrl || "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ...overrides
  };
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, String(value ?? ""));
  return form;
}

const ownerEmail = "owner-flow@example.com";
const teammateEmail = "member-flow@example.com";
const voterEmail = "voter-flow@example.com";
const preverifiedEmail = "preverified-member@example.com";
const preverifiedCookie = await login("Preverified member", "Orbit team", preverifiedEmail);
const ownerCookie = await login("远夏", "远日点小组", ownerEmail);

let result = await request("/api/participant/games", {
  cookie: ownerCookie,
  method: "POST",
  body: (() => { const form = new FormData(); form.set("title", "引力种子"); return form; })()
});
assert.equal(result.response.status, 201);
let game = result.body.game;
assert.equal(game.status, "draft");
assert.equal(game.ownerEmail, ownerEmail);

const oversizedCoverForm = workForm(game);
oversizedCoverForm.set("cover", new Blob([Buffer.alloc(1024 * 1024 + 1)], { type: "image/png" }), "too-large.png");
result = await request(`/api/participant/games/${game.id}`, { cookie: ownerCookie, method: "PUT", body: oversizedCoverForm });
assert.equal(result.response.status, 413);

const mediaForm = workForm(game);
mediaForm.set("cover", new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")], { type: "image/png" }), "cover.png");
mediaForm.set("video", new Blob([Buffer.from("test-webm-payload")], { type: "video/webm" }), "demo.webm");
mediaForm.set("gameFile", new Blob([Buffer.from("game-v1")], { type: "application/zip" }), "game-v1.zip");
result = await request(`/api/participant/games/${game.id}`, { cookie: ownerCookie, method: "PUT", body: mediaForm });
assert.equal(result.response.status, 200);
game = result.body.game;
assert.match(game.coverUrl, /^\/uploads\//);
assert.match(game.uploadedVideoUrl, /^\/uploads\//);
assert.match(game.downloadUrl, /^\/uploads\/game-/);
assert.equal(game.gameFileMeta.originalName, "game-v1.zip");
assert.equal(game.videoExternalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");

result = await request(`/api/participant/games/${game.id}/members`, {
  cookie: ownerCookie,
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "林潮", email: teammateEmail, role: "程序" })
});
assert.equal(result.response.status, 201);
game = result.body.game;
const member = game.teamMembers.find((item) => item.email === teammateEmail && item.active);
assert.ok(member);

result = await request(`/api/participant/games/${game.id}/members`, {
  cookie: ownerCookie,
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Preverified member", email: preverifiedEmail, role: "Audio" })
});
assert.equal(result.response.status, 201);
game = result.body.game;
const preverifiedMember = game.teamMembers.find((item) => item.email === preverifiedEmail && item.active);
assert.match(preverifiedMember.firstLoginAt, /^\d{4}-\d{2}-\d{2}T/);
result = await request("/api/participant/workspace", { cookie: preverifiedCookie });
assert.equal(result.body.game.role, "member");

result = await request(`/api/participant/games/${game.id}/submit`, { cookie: ownerCookie, method: "POST" });
assert.equal(result.response.status, 200);
game = result.body.game;
assert.equal(game.status, "submitted");
assert.equal(game.lateSubmission, false);

const memberCookie = await login("林潮", "远日点小组", teammateEmail);
result = await request("/api/participant/workspace", { cookie: memberCookie });
assert.equal(result.body.game.role, "member");

const contribution = "负责核心玩法程序、关卡交互，以及 Demo 的性能优化。";
const memberProfile = new FormData();
memberProfile.set("name", "林潮");
memberProfile.set("role", "程序");
memberProfile.set("contribution", contribution);
result = await request(`/api/participant/games/${game.id}/members/${member.id}`, { cookie: memberCookie, method: "PUT", body: memberProfile });
assert.equal(result.response.status, 200);
game = result.body.game;
assert.equal(game.creators.find((creator) => creator.id === member.creatorId)?.contribution, contribution);

const ownerProfileAttempt = new FormData();
ownerProfileAttempt.set("name", "无权修改");
ownerProfileAttempt.set("role", "负责人");
ownerProfileAttempt.set("contribution", "不应写入");
result = await request(`/api/participant/games/${game.id}/members/owner`, { cookie: memberCookie, method: "PUT", body: ownerProfileAttempt });
assert.equal(result.response.status, 403);

result = await request("/api/site");
const publicGame = result.body.games.find((item) => item.id === game.id);
assert.equal(publicGame.creators.find((creator) => creator.id === member.creatorId)?.contribution, contribution);
assert.equal(publicGame.downloadUrl, `/api/games/${encodeURIComponent(game.id)}/download`);
result = await request(publicGame.downloadUrl);
assert.equal(result.response.status, 200);
assert.match(result.response.headers.get("content-disposition") || "", /attachment/);

result = await request(`/api/participant/games/${game.id}/withdraw`, { cookie: memberCookie, method: "POST" });
assert.equal(result.response.status, 403);

result = await request("/api/ballot", {
  cookie: ownerCookie,
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ addGameId: game.id, operationId: "owner-self-vote" })
});
assert.equal(result.response.status, 409);
assert.equal(result.body.error, "SELF_VOTE");

const voterCookie = await login("观测者", "访客队", voterEmail);
result = await request("/api/ballot", {
  cookie: voterCookie,
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ addGameId: game.id, operationId: "vote-before-withdraw" })
});
assert.equal(result.response.status, 200);
assert.deepEqual(result.body.ballot.gameIds, [game.id]);

result = await request(`/api/participant/games/${game.id}/withdraw`, { cookie: ownerCookie, method: "POST" });
assert.equal(result.response.status, 200);
result = await request("/api/ballot", { cookie: voterCookie });
assert.deepEqual(result.body.ballot.gameIds, []);

result = await request(`/api/participant/games/${game.id}/submit`, { cookie: ownerCookie, method: "POST" });
assert.equal(result.response.status, 200);
game = result.body.game;
assert.equal(game.lateSubmission, false);

const now = Date.now();
result = await request("/api/admin/settings", {
  admin: true,
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    eventTitle: "溯造 MiniGame 游戏开发大赛",
    theme: "宇宙",
    slogan: "溯求本源，造物不止",
    eventSeed: "integration-test",
    submissionEndAt: new Date(now - 2000).toISOString(),
    startAt: new Date(now - 60000).toISOString(),
    endAt: new Date(now + 60000).toISOString()
  })
});
assert.equal(result.response.status, 200);

const lateFileForm = workForm(game);
lateFileForm.set("gameFile", new Blob([Buffer.from("game-v2")], { type: "application/zip" }), "game-v2.zip");
result = await request(`/api/participant/games/${game.id}`, {
  cookie: ownerCookie,
  method: "PUT",
  body: lateFileForm
});
assert.equal(result.response.status, 409);
assert.equal(result.body.error, "LATE_DOWNLOAD_CONFIRM_REQUIRED");

const confirmedLateFileForm = workForm(game, { confirmLateDownload: "true" });
confirmedLateFileForm.set("gameFile", new Blob([Buffer.from("game-v2")], { type: "application/zip" }), "game-v2.zip");
result = await request(`/api/participant/games/${game.id}`, {
  cookie: ownerCookie,
  method: "PUT",
  body: confirmedLateFileForm
});
assert.equal(result.response.status, 200);
game = result.body.game;
assert.equal(game.lateSubmission, true);
assert.equal(game.creators.find((creator) => creator.id === member.creatorId)?.contribution, contribution);

result = await request(`/api/participant/games/${game.id}/members/${member.id}`, { cookie: ownerCookie, method: "DELETE" });
assert.equal(result.response.status, 200);
result = await request(`/api/participant/games/${game.id}`, { cookie: memberCookie, method: "PUT", body: workForm(game) });
assert.equal(result.response.status, 403);

result = await request("/api/participant/games", {
  cookie: memberCookie,
  method: "POST",
  body: (() => { const form = new FormData(); form.set("title", "潮汐余波"); return form; })()
});
assert.equal(result.response.status, 201);
let secondGame = result.body.game;
result = await request("/api/session", { cookie: memberCookie });
assert.ok(result.body.selfBlockedGameIds.includes(game.id));

result = await request("/api/admin/dashboard", { admin: true });
const stored = result.body.games.find((item) => item.id === game.id);
assert.match(stored.assetMeta.cover.sha256, /^[a-f0-9]{64}$/);
assert.match(stored.assetMeta.video.sha256, /^[a-f0-9]{64}$/);
assert.equal(stored.assetMeta.gameFile.originalName, "game-v2.zip");
assert.match(stored.downloadHistory.at(-1).before, /^\/uploads\/game-/);
assert.match(stored.downloadHistory.at(-1).after, /^\/uploads\/game-/);

result = await request(`/api/admin/audit?gameId=${encodeURIComponent(game.id)}&limit=500`, { admin: true });
assert.ok(result.body.audit.some((item) => item.action === "game_marked_late"));
assert.ok(result.body.audit.some((item) => item.action === "team_member_removed"));

const secondGameForm = workForm(secondGame, {
  title: "潮汐余波",
  team: "潮汐小组",
  description: "一款关于潮汐锁定与信号回声的短篇游戏。",
  coverUrl: "https://example.com/tide-cover.png",
  videoExternalUrl: "https://www.bilibili.com/video/BV1xx411c7mD"
});
secondGameForm.set("gameFile", new Blob([Buffer.from("tide-game")], { type: "application/x-7z-compressed" }), "tide.7z");
result = await request(`/api/participant/games/${secondGame.id}`, {
  cookie: memberCookie,
  method: "PUT",
  body: secondGameForm
});
assert.equal(result.response.status, 200);
secondGame = result.body.game;
result = await request(`/api/participant/games/${secondGame.id}/submit`, { cookie: memberCookie, method: "POST" });
assert.equal(result.response.status, 200);
secondGame = result.body.game;

for (const [id, operationId] of [[game.id, "final-vote-one"], [secondGame.id, "final-vote-two"]]) {
  result = await request("/api/ballot", {
    cookie: voterCookie,
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ addGameId: id, operationId })
  });
  assert.equal(result.response.status, 200);
}

result = await request(`/api/participant/games/${secondGame.id}/members`, {
  cookie: memberCookie,
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "星潮", email: voterEmail, role: "测试" })
});
assert.equal(result.response.status, 201);
assert.equal(result.body.voteInvalidated, true);
secondGame = result.body.game;
let invitedVoterMember = secondGame.teamMembers.find((item) => item.email === voterEmail && item.active);
assert.ok(invitedVoterMember);

result = await request("/api/ballot", { cookie: voterCookie });
assert.deepEqual(result.body.ballot.gameIds, [game.id]);
result = await request("/api/admin/dashboard", { admin: true });
let synchronizedBallot = result.body.ballots.find((item) => item.emailSearch === voterEmail);
assert.equal(synchronizedBallot.name, "星潮");
assert.equal(synchronizedBallot.team, "潮汐小组");

result = await request("/api/session", { cookie: voterCookie });
assert.equal(result.body.identity.name, "星潮");
assert.equal(result.body.identity.team, "潮汐小组");
assert.ok(result.body.selfBlockedGameIds.includes(secondGame.id));

result = await request("/api/ballot", {
  cookie: voterCookie,
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ addGameId: secondGame.id, operationId: "blocked-after-invite" })
});
assert.equal(result.response.status, 409);
assert.equal(result.body.error, "SELF_VOTE");

result = await request(`/api/admin/audit?gameId=${encodeURIComponent(secondGame.id)}&limit=500`, { admin: true });
assert.ok(result.body.audit.some((item) => item.action === "ballot_invalidated_by_team_membership"));
assert.ok(result.body.audit.some((item) => item.action === "participant_identity_synchronized_by_team_membership"));

const synchronizedProfile = new FormData();
synchronizedProfile.set("name", "星潮改");
synchronizedProfile.set("role", "测试");
synchronizedProfile.set("contribution", "维护测试流程");
result = await request(`/api/participant/games/${secondGame.id}/members/${invitedVoterMember.id}`, {
  cookie: voterCookie,
  method: "PUT",
  body: synchronizedProfile
});
assert.equal(result.response.status, 200);
secondGame = result.body.game;

result = await request("/api/session", { cookie: voterCookie });
assert.equal(result.body.identity.name, "星潮改");
assert.equal(result.body.identity.team, "潮汐小组");
result = await request("/api/ballot", { cookie: voterCookie });
assert.deepEqual(result.body.ballot.gameIds, [game.id]);
result = await request("/api/admin/dashboard", { admin: true });
synchronizedBallot = result.body.ballots.find((item) => item.emailSearch === voterEmail);
assert.equal(synchronizedBallot.name, "星潮改");

const renamedTeamForm = workForm(secondGame, { team: "潮汐新组" });
result = await request(`/api/participant/games/${secondGame.id}`, {
  cookie: memberCookie,
  method: "PUT",
  body: renamedTeamForm
});
assert.equal(result.response.status, 200);
secondGame = result.body.game;
result = await request("/api/session", { cookie: voterCookie });
assert.equal(result.body.identity.name, "星潮改");
assert.equal(result.body.identity.team, "潮汐新组");
result = await request("/api/ballot", { cookie: voterCookie });
assert.deepEqual(result.body.ballot.gameIds, [game.id]);
result = await request("/api/admin/dashboard", { admin: true });
synchronizedBallot = result.body.ballots.find((item) => item.emailSearch === voterEmail);
assert.equal(synchronizedBallot.team, "潮汐新组");

const invitedLoginEmail = "invited-login-flow@example.com";
result = await request(`/api/participant/games/${secondGame.id}/members`, {
  cookie: memberCookie,
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "岚序", email: invitedLoginEmail, role: "声音" })
});
assert.equal(result.response.status, 201);
secondGame = result.body.game;

result = await request("/api/verification/request", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: invitedLoginEmail })
});
assert.equal(result.response.status, 200);
assert.equal(result.body.invitedIdentityDetected, true);
assert.equal(Object.hasOwn(result.body, "name"), false);
assert.equal(Object.hasOwn(result.body, "team"), false);
const invitedCode = result.body.devCode;

result = await request("/api/auth/verify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: invitedLoginEmail, code: invitedCode })
});
assert.equal(result.response.status, 200);
assert.deepEqual(result.body.identity, { name: "岚序", team: "潮汐新组", email: invitedLoginEmail });

const closingVoterCookie = await login("远光", "观测访客", "closing-voter-flow@example.com");
result = await request("/api/ballot", {
  cookie: closingVoterCookie,
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ addGameId: secondGame.id, operationId: "closing-vote-two" })
});
assert.equal(result.response.status, 200);

result = await request("/api/admin/dashboard", { admin: true });
result = await request("/api/admin/settings", {
  admin: true,
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...result.body.settings, endAt: new Date(Date.now() - 1000).toISOString() })
});
assert.equal(result.response.status, 200);
result = await request("/api/admin/results/publish", { admin: true, method: "POST" });
assert.equal(result.response.status, 200);
result = await request("/api/admin/dashboard", { admin: true });
assert.equal(result.body.votingState, "published");

console.log("participant flow integration passed");
