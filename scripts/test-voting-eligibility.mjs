import assert from "node:assert/strict";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3112";
const adminPassword = process.env.TEST_ADMIN_PASSWORD || "test-admin";

function cookieHeader(jar) {
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function absorbCookies(response, jar) {
  const values = response.headers.getSetCookie?.() || [response.headers.get("set-cookie")].filter(Boolean);
  for (const value of values.flatMap((item) => item.split(/,(?=\s*[^;,]+=)/))) {
    const pair = value.trim().split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

async function request(path, { jar = new Map(), admin = false, json = true, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (jar.size) headers.set("cookie", cookieHeader(jar));
  if (admin) headers.set("x-admin-password", adminPassword);
  const response = await fetch(`${base}${path}`, { ...options, headers, redirect: "manual" });
  absorbCookies(response, jar);
  const body = json ? await response.json().catch(() => ({})) : null;
  return { response, body, jar };
}

async function login(jar, name, email) {
  const identity = { name, team: "公共玩家", email };
  let result = await request("/api/verification/request", {
    jar,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(identity)
  });
  assert.equal(result.response.status, 200);
  result = await request("/api/auth/verify", {
    jar,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...identity, code: result.body.devCode })
  });
  assert.equal(result.response.status, 200);
  return result.body;
}

function gameForm(title, { official = false } = {}) {
  const form = new FormData();
  form.set("title", title);
  form.set("team", "测试展区");
  form.set("shortDescription", "投票资格集成测试作品");
  form.set("description", "验证下载去重、等待门槛、官方作品排除与风险信号。");
  form.set("published", "on");
  if (official) form.set("isOfficial", "on");
  form.set("gameFile", new Blob([`test package for ${title}`], { type: "application/zip" }), `${title}.zip`);
  return form;
}

async function createGame(title, options) {
  const result = await request("/api/admin/games", { admin: true, method: "POST", body: gameForm(title, options) });
  assert.equal(result.response.status, 201);
  return result.body.game;
}

async function download(jar, gameId) {
  const result = await request(`/api/games/${encodeURIComponent(gameId)}/download`, { jar, json: false });
  assert.ok([200, 302].includes(result.response.status));
}

async function eligibility(jar) {
  const result = await request("/api/vote-eligibility", { jar });
  assert.equal(result.response.status, 200);
  return result.body.eligibility;
}

async function vote(jar, gameId, operationId) {
  return request("/api/ballot", {
    jar,
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ addGameId: gameId, operationId, version: 0 })
  });
}

const games = [];
for (let index = 1; index <= 4; index += 1) games.push(await createGame(`资格测试作品 ${index}`));
const official = await createGame("官方测试作品", { official: true });

const developerGame = await createGame("开发者资格测试作品");
const developerJar = new Map();
await request(`/api/admin/games/${encodeURIComponent(developerGame.id)}/owner`, {
  admin: true,
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "submitted-developer@example.com" })
});
await login(developerJar, "已提交开发者", "submitted-developer@example.com");
let developerStatus = await eligibility(developerJar);
assert.equal(developerStatus.source, "developer");
let developerVote = await vote(developerJar, games[3].id, "developer-direct-vote");
assert.equal(developerVote.response.status, 200, "已提交作品开发者无需下载即可投票");

await request(`/api/admin/games/${encodeURIComponent(developerGame.id)}`, {
  admin: true,
  method: "PUT",
  body: gameForm(developerGame.title, { official: true })
});
developerStatus = await eligibility(developerJar);
assert.equal(developerStatus.eligible, true, "开发者资格获得后应保留");

await download(new Map(), games[0].id);

const sharedDevice = new Map();
await login(sharedDevice, "公共玩家一", "eligibility-one@example.com");
assert.equal((await eligibility(sharedDevice)).qualifyingDownloadCount, 0, "匿名下载不能补记到登录账号");
await download(sharedDevice, official.id);
assert.equal((await eligibility(sharedDevice)).qualifyingDownloadCount, 0, "官方作品不计入资格");
await download(sharedDevice, games[0].id);
await download(sharedDevice, games[0].id);
await download(sharedDevice, games[1].id);
await download(sharedDevice, games[2].id);
let status = await eligibility(sharedDevice);
assert.equal(status.qualifyingDownloadCount, 3, "同一作品重复下载只能计一款");
assert.equal(status.eligible, false, "等待时间未满前不能投票");
let result = await vote(sharedDevice, games[3].id, "eligibility-too-early");
assert.equal(result.response.status, 403);
assert.equal(result.body.error, "VOTING_ELIGIBILITY_REQUIRED");

await new Promise((resolve) => setTimeout(resolve, 1200));
status = await eligibility(sharedDevice);
assert.equal(status.eligible, true);
result = await vote(sharedDevice, games[3].id, "eligibility-first-vote");
assert.equal(result.response.status, 200);

for (const [index, email] of ["eligibility-two@example.com", "eligibility-three@example.com"].entries()) {
  await login(sharedDevice, `公共玩家${index + 2}`, email);
  await download(sharedDevice, games[0].id);
  await download(sharedDevice, games[1].id);
  await download(sharedDevice, games[2].id);
}
await new Promise((resolve) => setTimeout(resolve, 1200));
for (const [index, email] of ["eligibility-two@example.com", "eligibility-three@example.com"].entries()) {
  await login(sharedDevice, `公共玩家${index + 2}`, email);
  result = await vote(sharedDevice, games[3].id, `device-switch-vote-${index}`);
  assert.equal(result.response.status, 200);
}

result = await request("/api/admin/dashboard", { admin: true });
assert.equal(result.response.status, 200);
const firstBallot = result.body.ballots.find((ballot) => ballot.emailSearch === "eligibility-one@example.com");
assert.ok(firstBallot.risk.reasons.some((reason) => reason.code === "RAPID_MINIMUM_DOWNLOADS"));
assert.ok(firstBallot.risk.reasons.some((reason) => reason.code === "VOTED_UNDOWNLOADED_GAME"));
const switchedBallot = result.body.ballots.find((ballot) => ballot.emailSearch === "eligibility-three@example.com");
assert.equal(switchedBallot.risk.level, "high");
assert.ok(switchedBallot.risk.reasons.some((reason) => reason.code === "DEVICE_ACCOUNT_SWITCH"));

result = await request(`/api/admin/games/${encodeURIComponent(games[0].id)}`, {
  admin: true,
  method: "PUT",
  body: gameForm(games[0].title, { official: true })
});
assert.equal(result.response.status, 200);
await login(sharedDevice, "公共玩家一", "eligibility-one@example.com");
assert.equal((await eligibility(sharedDevice)).eligible, true, "获得的资格不能因作品状态变化而撤回");

const beforeNewEvent = await request("/api/admin/dashboard", { admin: true });
const settings = beforeNewEvent.body.settings;
result = await request("/api/admin/settings", {
  admin: true,
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    eventTitle: settings.eventTitle,
    theme: settings.theme,
    slogan: settings.slogan,
    eventSeed: `${settings.eventSeed}-next`,
    submissionEndAt: settings.submissionEndAt,
    startAt: settings.startAt,
    endAt: settings.endAt
  })
});
assert.equal(result.response.status, 200);
status = await eligibility(sharedDevice);
assert.equal(status.eligible, false, "新活动必须重新计算投票资格");
assert.equal(status.qualifyingDownloadCount, 0);
result = await request("/api/ballot", { jar: sharedDevice });
assert.deepEqual(result.body.ballot.gameIds, [], "旧活动选票不得进入新活动");

console.log("voting eligibility and risk integration passed");
