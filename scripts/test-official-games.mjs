import assert from "node:assert/strict";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3108";
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
  const verified = await request("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, team, email, code: sent.body.devCode })
  });
  assert.equal(verified.response.status, 200);
  return verified.cookie;
}

function gameForm({ title, isOfficial = false }) {
  const form = new FormData();
  form.set("title", title);
  form.set("team", "溯游工作室");
  form.set("shortDescription", "用于验证作品资格的测试作品。");
  form.set("description", "用于验证官方作品规则的测试内容。");
  form.set("published", "on");
  if (isOfficial) form.set("isOfficial", "on");
  form.set("gameFile", new Blob([`official rules package: ${title}`], { type: "application/zip" }), `${title}.zip`);
  return form;
}

let result = await request("/api/admin/games", {
  admin: true,
  method: "POST",
  body: gameForm({ title: "官方展示作品", isOfficial: true })
});
assert.equal(result.response.status, 201);
const officialGame = result.body.game;
assert.equal(officialGame.isOfficial, true);

const voterCookie = await login("规则验证者", "测试小组", "official-rule-voter@example.com");
result = await request("/api/ballot", {
  cookie: voterCookie,
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ addGameId: officialGame.id, operationId: "official-game-vote" })
});
assert.equal(result.response.status, 400);
assert.equal(result.body.error, "INVALID_GAME");

const participantCookie = await login("参赛者", "测试小组", "official-rule-participant@example.com");
const draftForm = new FormData();
draftForm.set("title", "不能自设官方资格");
result = await request("/api/participant/games", { cookie: participantCookie, method: "POST", body: draftForm });
assert.equal(result.response.status, 201);
const participantGame = result.body.game;
const participantUpdate = new FormData();
participantUpdate.set("revision", participantGame.revision);
participantUpdate.set("title", participantGame.title);
participantUpdate.set("team", "测试小组");
participantUpdate.set("shortDescription", "参赛者不能绕过资格规则。");
participantUpdate.set("description", "参赛者不能把自己的作品设为官方作品。");
participantUpdate.set("isOfficial", "on");
result = await request(`/api/participant/games/${encodeURIComponent(participantGame.id)}`, { cookie: participantCookie, method: "PUT", body: participantUpdate });
assert.equal(result.response.status, 200);
assert.equal(result.body.game.isOfficial, false);

result = await request("/api/site");
assert.equal(result.response.status, 200);
assert.equal(result.body.games.find((game) => game.id === officialGame.id)?.isOfficial, true);
assert.ok(!result.body.results.some((game) => game.id === officialGame.id));

result = await request("/api/admin/games", {
  admin: true,
  method: "POST",
  body: gameForm({ title: "参赛测试作品" })
});
assert.equal(result.response.status, 201);
const contestGame = result.body.game;

result = await request(`/api/games/${encodeURIComponent(contestGame.id)}/download`, { cookie: voterCookie });
assert.equal(result.response.status, 200);

result = await request("/api/ballot", {
  cookie: voterCookie,
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ addGameId: contestGame.id, operationId: "contest-game-vote" })
});
assert.equal(result.response.status, 200);
assert.deepEqual(result.body.ballot.gameIds, [contestGame.id]);

result = await request(`/api/admin/games/${encodeURIComponent(contestGame.id)}`, {
  admin: true,
  method: "PUT",
  body: gameForm({ title: contestGame.title, isOfficial: true })
});
assert.equal(result.response.status, 200);
assert.equal(result.body.game.isOfficial, true);

result = await request("/api/ballot", { cookie: voterCookie });
assert.equal(result.response.status, 200);
assert.deepEqual(result.body.ballot.gameIds, []);

result = await request("/api/admin/dashboard", { admin: true });
assert.equal(result.response.status, 200);
assert.ok(!result.body.resultPreview.ranked.some((game) => game.id === contestGame.id));
assert.ok(result.body.recentAudit.some((entry) => entry.action === "ballot_invalidated_by_official_game" && entry.gameId === contestGame.id));

console.log("official game rules integration passed");
