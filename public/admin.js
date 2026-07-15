const ADMIN_PASSWORD_KEY = "suyo.minigame.admin.password.v3";

const adminState = {
  password: localStorage.getItem(ADMIN_PASSWORD_KEY) || "",
  dashboard: null,
  fullAudit: null,
  editingId: "",
  creators: [],
  voterQuery: ""
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

async function adminFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("x-admin-password", adminState.password);
  const response = await fetch(url, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    const body = contentType.includes("application/json") ? await response.json().catch(() => ({})) : {};
    const error = new Error(body.message || "请求失败，请稍后再试。");
    error.status = response.status;
    error.code = body.error || "REQUEST_FAILED";
    throw error;
  }
  return contentType.includes("application/json") ? response.json() : response;
}

function message(element, text, error = false) {
  element.textContent = text;
  element.className = `form-message${error ? " error" : text ? " success" : ""}`;
}

function showToast(text) {
  const toast = $("#adminToast");
  toast.textContent = text;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add("visible"));
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => { toast.hidden = true; }, 180);
  }, 2800);
}

function showLogin(error = "") {
  $("#adminLogin").hidden = false;
  $("#adminApp").hidden = true;
  $("#adminPasswordInput").value = adminState.password;
  message($("#adminLoginMessage"), error, Boolean(error));
}

function showApp() {
  $("#adminLogin").hidden = true;
  $("#adminApp").hidden = false;
}

function stateLabel(value) {
  return ({
    upcoming: "投票尚未开始",
    open: "投票进行中",
    locked: "已锁票，等待点亮",
    published: "宇宙已经点亮"
  })[value] || "状态未知";
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function toLocalInput(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 19);
}

function gameById(id) {
  return adminState.dashboard.games.find((game) => game.id === id);
}

function normalizedName(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
}

function renderRanking() {
  const games = adminState.dashboard.games.slice().sort((a, b) => b.voteCount - a.voteCount || a.title.localeCompare(b.title, "zh-Hans-CN"));
  $("#adminRanking").innerHTML = `
    <div class="ranking-head"><strong>当前票数</strong><span>投票期间仅后台可见</span></div>
    <div class="ranking-rows">
      ${games.length ? games.map((game, index) => `
        <div class="ranking-row">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <strong>${escapeHTML(game.title)}</strong>
          <small>${escapeHTML(game.team)}</small>
          <b>${game.voteCount} 票</b>
        </div>
      `).join("") : `<div class="admin-empty">暂无作品</div>`}
    </div>`;
}

function renderGames() {
  const list = $("#adminGameList");
  const games = adminState.dashboard.games;
  if (!games.length) {
    list.innerHTML = `<div class="admin-empty"><strong>尚未录入作品</strong><span>使用左侧表单创建第一款参展游戏。</span></div>`;
    return;
  }
  list.innerHTML = games.map((game) => `
    <article class="admin-game-item ${game.published ? "" : "draft"} ${game.lateSubmission ? "late" : ""} ${game.status === "abandoned" ? "abandoned" : ""}">
      <img src="${escapeHTML(game.coverUrl || "/assets/pass-texture.png")}" alt="" />
      <div>
        <strong>${escapeHTML(game.title || "未命名草稿")}</strong>
        <span>${escapeHTML(game.team)}</span>
        <small>${gameStatusLabel(game)}${game.lateSubmission ? " / 补交" : ""}${game.featured ? " / 本期主推" : ""} / ${game.voteCount} 票</small>
        ${game.status === "abandoned"
          ? `<label class="owner-binding"><span>作品归属</span><em>已释放（审计保留）</em></label>`
          : `<label class="owner-binding"><span>唯一负责人邮箱</span><input type="email" data-owner-email="${escapeHTML(game.id)}" value="${escapeHTML(game.ownerEmail || "")}" placeholder="name@example.com" /></label>`}
        <div class="admin-private-documents">
          <span>内部开发文档 · ${(game.developmentDocuments || []).length} 份</span>
          ${(game.developmentDocuments || []).map((document) => `<button type="button" data-admin-document="${escapeHTML(game.id)}:${escapeHTML(document.id)}" title="仅后台与本队可见">${escapeHTML(document.originalName)}</button>`).join("") || `<em>尚无内部文件</em>`}
        </div>
      </div>
      <div class="admin-row-actions">
        <button class="text-action" data-export-game="${escapeHTML(game.id)}" type="button">导出归档</button>
        ${game.status !== "abandoned" ? `<button class="text-action" data-edit-game="${escapeHTML(game.id)}" type="button">编辑</button>
        <button class="text-action" data-bind-owner="${escapeHTML(game.id)}" type="button">绑定负责人</button>` : ""}
        ${game.lateSubmission ? `<button class="text-action danger-action" data-clear-late="${escapeHTML(game.id)}" type="button">复核补交标记</button>` : ""}
        ${game.status === "draft" && !game.firstSubmittedAt && !game.submittedAt ? `<button class="text-action danger-action" data-discard-draft="${escapeHTML(game.id)}" type="button">作废并释放归属</button>` : ""}
      </div>
    </article>
  `).join("");
  $$('[data-edit-game]', list).forEach((button) => button.addEventListener("click", () => editGame(button.dataset.editGame)));
  $$('[data-bind-owner]', list).forEach((button) => button.addEventListener("click", () => bindOwner(button.dataset.bindOwner)));
  $$('[data-clear-late]', list).forEach((button) => button.addEventListener("click", () => clearLateMarker(button.dataset.clearLate)));
  $$('[data-discard-draft]', list).forEach((button) => button.addEventListener("click", () => discardDraft(button.dataset.discardDraft)));
  $$('[data-export-game]', list).forEach((button) => button.addEventListener("click", () => exportGameArchive(button.dataset.exportGame, button)));
  $$('[data-admin-document]', list).forEach((button) => button.addEventListener("click", () => {
    const [gameId, documentId] = button.dataset.adminDocument.split(":");
    downloadAdminDocument(gameId, documentId, button);
  }));
}

function gameStatusLabel(game) {
  if (game.status === "abandoned") return "已作废 / 归属已释放";
  if (game.status === "withdrawn") return "已撤回";
  if (game.status === "submitted" || game.published) return "公开展示";
  return "草稿";
}

function renderBallots() {
  const list = $("#ballotList");
  const needle = adminState.voterQuery.trim().toLowerCase();
  const ballots = adminState.dashboard.ballots.filter((ballot) => {
    const text = [ballot.name, ballot.team, ballot.email, ballot.emailSearch, ...ballot.games].join(" ").toLowerCase();
    return !needle || text.includes(needle);
  });
  if (!ballots.length) {
    list.innerHTML = needle
      ? `<div class="admin-empty"><strong>没有匹配的投票者</strong><span>尝试搜索姓名、队伍、邮箱或作品名称。</span></div>`
      : `<div class="admin-empty"><strong>还没有有效选票</strong><span>用户提交选票后会出现在这里。</span></div>`;
    return;
  }
  const canReview = adminState.dashboard.votingState !== "published";
  list.innerHTML = ballots.map((ballot) => {
    const voter = normalizedName(ballot.name);
    const suspected = ballot.gameIds.some((id) => (gameById(id)?.creators || []).some((creator) => normalizedName(creator.name) === voter));
    const audit = ballot.audit || [];
    return `
    <article class="ballot-row ${suspected ? "suspected-self-vote" : ""}">
      <div><strong>${escapeHTML(ballot.name)}</strong><span>${escapeHTML(ballot.team)}</span></div>
      <span>${escapeHTML(ballot.email)}</span>
      <p>${ballot.games.map(escapeHTML).join(" / ")}${suspected ? `<span class="review-flag">名称匹配作者，建议人工复核</span>` : ""}</p>
      <time>${formatDate(ballot.updatedAt)}</time>
      ${canReview ? `<button class="text-action danger-action" data-delete-voter="${escapeHTML(ballot.id)}" type="button">删除违规票</button>` : ""}
      <details class="ballot-audit">
        <summary>操作记录 ${audit.length}</summary>
        ${audit.length ? `<ol>${audit.map((item) => {
          const before = (item.before || []).map((id) => gameById(id)?.title || id).join(" / ") || "空选票";
          const after = (item.after || []).map((id) => gameById(id)?.title || id).join(" / ") || "空选票";
          return `<li><time>${formatDate(item.createdAt)}</time><span>${escapeHTML(before)} → ${escapeHTML(after)}</span></li>`;
        }).join("")}</ol>` : `<p>暂无选票变更记录。</p>`}
      </details>
    </article>
  `; }).join("");
  $$('[data-delete-voter]', list).forEach((button) => button.addEventListener("click", () => deleteVoter(button.dataset.deleteVoter)));
}

function fillSettings() {
  const settings = adminState.dashboard.settings;
  const form = $("#settingsForm");
  form.elements.eventTitle.value = settings.eventTitle || "";
  form.elements.theme.value = settings.theme || "";
  form.elements.slogan.value = settings.slogan || "";
  form.elements.submissionEndAt.value = toLocalInput(settings.submissionEndAt);
  form.elements.startAt.value = toLocalInput(settings.startAt);
  form.elements.endAt.value = toLocalInput(settings.endAt);
  form.elements.eventSeed.value = settings.eventSeed || "";
}

function renderResultControl() {
  const root = $("#resultControl");
  const { votingState: status, resultPreview: preview, settings } = adminState.dashboard;
  const published = status === "published";
  const winners = new Set(published ? settings.winnerGameIds || [] : preview.winnerIds || []);
  const constellation = new Set(published ? settings.constellationGameIds || [] : preview.constellationIds || []);
  const ranked = preview.ranked || [];
  const cutoff = ranked.filter((game) => game.voteCount > 0)[1]?.voteCount;
  const adjudicationCandidates = ranked.filter((game) => game.voteCount > 0 && game.voteCount >= cutoff);
  let controls = "";

  if (published) {
    controls = `<div class="ignition-state published"><strong>宇宙已点亮</strong><span>${formatDate(settings.publishedAt)} 发布。结果会在用户下次刷新或重新打开时出现。</span></div>
      <div class="withdraw-results"><p>只有在确认结果需要更正时才能撤回。撤回会恢复锁票复核状态，清除旧裁定，并写入审计记录。</p><button class="text-action danger-action" id="withdrawResults" type="button">进入结果撤回流程</button></div>`;
  } else if (preview.positiveCount < 2) {
    controls = `<div class="ignition-state"><strong>有效作品不足</strong><span>至少需要两款作品获得有效票才能发布玩家之声。</span></div>`;
  } else if (preview.unresolved) {
    controls = `
      <form class="adjudication-form" id="adjudicationForm">
        <div><strong>玩家之声边界存在同票</strong><span>请从边界候选中选出最终两款同等级获奖作品。高于边界的作品必须保留。</span></div>
        <div class="candidate-list">
          ${adjudicationCandidates.map((game) => `<label><input type="checkbox" name="winnerIds" value="${escapeHTML(game.id)}" /> <span><strong>${escapeHTML(game.title)}</strong><small>${escapeHTML(game.team)} / ${game.voteCount} 票</small></span></label>`).join("")}
        </div>
        <label class="admin-field"><span>裁定说明</span><textarea name="note" rows="3" maxlength="500" required placeholder="记录现场流程与选择依据"></textarea></label>
        <button class="button button-outline" type="submit">保存裁定</button>
        <p class="form-message" id="adjudicationMessage" role="status"></p>
      </form>`;
  } else {
    controls = `
      <div class="ignition-state ready"><strong>点亮条件已满足</strong><span>两项玩家之声与最终星座已经锁定。手动点亮后会立即停止投票，且不能直接删除选票。</span></div>
      <button class="button button-solid ignition-button" id="publishResults" type="button">确认并点亮全站宇宙</button>`;
  }

  root.innerHTML = `
    <div class="result-preview-list">
      ${ranked.length ? ranked.map((game, index) => `
        <article class="result-preview-row ${winners.has(game.id) ? "winner" : ""}">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <img src="${escapeHTML(game.coverUrl || "/assets/pass-texture.png")}" alt="" />
          <div><strong>${escapeHTML(game.title)}</strong><small>${escapeHTML(game.team)}</small></div>
          <b>${game.voteCount} 票</b>
          <em>${winners.has(game.id) ? "玩家之声" : constellation.has(game.id) ? "星座席位" : ""}</em>
        </article>
      `).join("") : `<div class="admin-empty">暂无排名数据</div>`}
    </div>
    <div class="result-actions-panel">${controls}</div>`;

  $("#adjudicationForm")?.addEventListener("submit", saveAdjudication);
  $("#publishResults")?.addEventListener("click", publishResults);
  $("#withdrawResults")?.addEventListener("click", withdrawResults);
}

function renderAudit() {
  const list = $("#auditList");
  const audit = adminState.fullAudit || adminState.dashboard.recentAudit || [];
  if (!audit.length) {
    list.innerHTML = `<div class="admin-empty">暂无审计记录</div>`;
    return;
  }
  const labels = {
    ballot_updated: "用户修改选票",
    session_verified: "用户完成邮箱验证",
    voter_removed: "管理员删除违规票",
    results_adjudicated: "管理员完成同票裁定",
    results_published: "管理员点亮宇宙",
    results_withdrawn: "管理员撤回公开结果",
    planet_regenerated: "管理员重新生成天体",
    game_created: "创建作品",
    game_updated: "修改作品",
    game_submitted: "提交参展",
    game_withdrawn: "撤回作品",
    game_owner_bound: "绑定负责人",
    game_member_added: "添加队友",
    game_member_removed: "移除队友",
    creator_profile_updated: "修改成员资料",
    game_late_marker_cleared: "撤销补交标记",
    game_marked_late: "自动标记补交",
    settings_updated: "修改赛事设置"
  };
  list.innerHTML = audit.map((item) => `
    <article class="audit-row">
      <time>${formatDate(item.createdAt)}</time>
      <strong>${escapeHTML(labels[item.action] || item.action)}</strong>
      <span>${escapeHTML(item.actorEmail || item.reason || item.actorType || "system")}</span>
      <details><summary>查看完整记录</summary><pre>${escapeHTML(JSON.stringify(item, null, 2))}</pre></details>
    </article>`).join("");
}

function renderDashboard() {
  const dashboard = adminState.dashboard;
  $("#adminEventTitle").textContent = dashboard.settings.eventTitle;
  $("#adminVotingState").textContent = stateLabel(dashboard.votingState);
  $("#adminVotingState").dataset.state = dashboard.votingState;
  $("#gamesStat").textContent = dashboard.stats.games;
  $("#publishedStat").textContent = dashboard.stats.publishedGames;
  $("#votersStat").textContent = dashboard.stats.voters;
  $("#votesStat").textContent = dashboard.stats.votes;
  renderRanking();
  renderGames();
  renderBallots();
  renderResultControl();
  renderAudit();
  fillSettings();
  $("#auditGameFilter").innerHTML = `<option value="">全部作品</option>${dashboard.games.map((game) => `<option value="${escapeHTML(game.id)}">${escapeHTML(game.title || "未命名草稿")}</option>`).join("")}`;
}

async function loadDashboard() {
  const [dashboard, auditResult] = await Promise.all([
    adminFetch("/api/admin/dashboard"),
    adminFetch("/api/admin/audit?limit=500")
  ]);
  adminState.dashboard = dashboard;
  adminState.fullAudit = auditResult.audit;
  renderDashboard();
}

async function login(password) {
  adminState.password = password;
  await adminFetch("/api/admin/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password })
  });
  localStorage.setItem(ADMIN_PASSWORD_KEY, password);
  showApp();
  await loadDashboard();
}

function newCreator() {
  return { id: `creator-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`, name: "", role: "", avatarUrl: "" };
}

function renderCreatorRows() {
  const root = $("#creatorRows");
  if (!adminState.creators.length) {
    root.innerHTML = `<div class="creator-empty">尚未添加成员。成员将在作品详情中成为环绕行星的卫星。</div>`;
    return;
  }
  root.innerHTML = adminState.creators.map((creator, index) => `
    <article class="creator-row" data-creator-index="${index}">
      <div class="creator-avatar-preview">${creator.avatarUrl ? `<img src="${escapeHTML(creator.avatarUrl)}" alt="" />` : `<span>${String(index + 1).padStart(2, "0")}</span>`}</div>
      <label class="admin-field"><span>成员名称</span><input data-creator-name maxlength="40" value="${escapeHTML(creator.name)}" required /></label>
      <label class="admin-field"><span>负责角色</span><input data-creator-role maxlength="40" value="${escapeHTML(creator.role)}" placeholder="程序 / 美术 / 策划" /></label>
      <label class="admin-field creator-file"><span>成员头像</span><input name="avatar-${index}" type="file" accept="image/*" /></label>
      <div class="creator-row-actions" aria-label="调整成员顺序">
        <button class="text-action" data-move-creator="${index}" data-direction="-1" type="button" ${index === 0 ? "disabled" : ""}>上移</button>
        <button class="text-action" data-move-creator="${index}" data-direction="1" type="button" ${index === adminState.creators.length - 1 ? "disabled" : ""}>下移</button>
        <button class="text-action danger-action" data-remove-creator="${index}" type="button">移除</button>
      </div>
    </article>
  `).join("");
  $$('[data-move-creator]', root).forEach((button) => button.addEventListener("click", () => {
    syncCreatorInputs();
    const from = Number(button.dataset.moveCreator);
    const to = from + Number(button.dataset.direction);
    if (to < 0 || to >= adminState.creators.length) return;
    const [creator] = adminState.creators.splice(from, 1);
    adminState.creators.splice(to, 0, creator);
    renderCreatorRows();
  }));
  $$('[data-remove-creator]', root).forEach((button) => button.addEventListener("click", () => {
    syncCreatorInputs();
    adminState.creators.splice(Number(button.dataset.removeCreator), 1);
    renderCreatorRows();
  }));
}

function syncCreatorInputs() {
  $$('[data-creator-index]', $("#creatorRows")).forEach((row) => {
    const creator = adminState.creators[Number(row.dataset.creatorIndex)];
    if (!creator) return;
    creator.name = $("[data-creator-name]", row).value.trim();
    creator.role = $("[data-creator-role]", row).value.trim();
  });
}

function resetGameForm() {
  const form = $("#gameForm");
  form.reset();
  form.elements.order.value = "100";
  form.elements.published.checked = true;
  adminState.editingId = "";
  adminState.creators = [];
  renderCreatorRows();
  $("#gameId").value = "";
  $("#editorTitle").textContent = "新建作品";
  $("#editorHint").textContent = "保存后立即写入服务器";
  $("#saveGame").textContent = "保存作品";
  $("#cancelEdit").hidden = true;
  $("#planetCoordinate").textContent = "保存作品后生成";
  $("#planetSeed").textContent = "保存作品后生成";
  $("#regeneratePlanet").disabled = true;
  message($("#gameMessage"), "");
}

function editGame(id) {
  const game = gameById(id);
  if (!game) return;
  const form = $("#gameForm");
  adminState.editingId = id;
  adminState.creators = (game.creators || []).map((creator) => ({ ...creator }));
  renderCreatorRows();
  $("#gameId").value = id;
  form.elements.title.value = game.title || "";
  form.elements.team.value = game.team || "";
  form.elements.shortDescription.value = game.shortDescription || "";
  form.elements.description.value = game.description || "";
  form.elements.creationNote.value = game.creationNote || "";
  form.elements.tags.value = (game.tags || []).join("，");
  form.elements.order.value = game.order ?? 100;
  form.elements.gameFile.value = "";
  form.elements.coverUrl.value = /^https?:/.test(game.coverUrl || "") ? game.coverUrl : "";
  form.elements.videoExternalUrl.value = game.videoExternalUrl || "";
  form.elements.published.checked = Boolean(game.published);
  form.elements.featured.checked = Boolean(game.featured);
  $("#editorTitle").textContent = `编辑：${game.title}`;
  $("#editorHint").textContent = "未重新上传的素材保持不变；参赛权限与自投限制以邮箱为准";
  $("#saveGame").textContent = "更新作品";
  $("#cancelEdit").hidden = false;
  $("#planetCoordinate").textContent = game.coordinate ? `X ${Number(game.coordinate.x).toFixed(5)} / Y ${Number(game.coordinate.y).toFixed(5)} / Z ${Number(game.coordinate.z ?? (Number(game.coordinate.depth ?? 0.5) * 2 - 1)).toFixed(5)}` : "尚未生成";
  $("#planetSeed").textContent = game.planetSeed || "尚未生成";
  $("#regeneratePlanet").disabled = false;
  message($("#gameMessage"), "");
  form.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

async function saveGame(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("#saveGame");
  const id = adminState.editingId;
  syncCreatorInputs();
  $("#creatorsJson").value = JSON.stringify(adminState.creators.map(({ id, name, role, avatarUrl }) => ({ id, name, role, avatarUrl })));
  const data = new FormData(form);
  button.disabled = true;
  button.textContent = form.elements.gameFile.files.length ? "正在上传作品文件" : form.elements.video.files.length ? "正在上传视频" : "正在保存";
  message($("#gameMessage"), "请保持页面开启，素材正在写入服务器。");
  try {
    const result = await adminFetch(id ? `/api/admin/games/${encodeURIComponent(id)}` : "/api/admin/games", {
      method: id ? "PUT" : "POST",
      body: data
    });
    showToast(result.message);
    resetGameForm();
    await loadDashboard();
  } catch (error) {
    message($("#gameMessage"), error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = adminState.editingId ? "更新作品" : "保存作品";
  }
}

async function bindOwner(id) {
  const game = gameById(id);
  const input = $(`[data-owner-email="${CSS.escape(id)}"]`);
  const email = input?.value.trim();
  if (!game || !email) return showToast("请填写负责人邮箱。");
  if (!window.confirm(`将 ${email} 绑定为《${game.title || "未命名草稿"}》的唯一负责人？原负责人会立即失去权限。`)) return;
  try {
    const result = await adminFetch(`/api/admin/games/${encodeURIComponent(id)}/owner`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email })
    });
    showToast(result.message);
    await loadDashboard();
  } catch (error) {
    showToast(error.message);
  }
}

async function clearLateMarker(id) {
  const game = gameById(id);
  if (!game) return;
  const reason = window.prompt(`复核《${game.title}》的补交审计后，填写撤销标记的原因：`);
  if (!reason?.trim()) return;
  try {
    const result = await adminFetch(`/api/admin/games/${encodeURIComponent(id)}/late`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: reason.trim() })
    });
    showToast(result.message);
    await loadDashboard();
  } catch (error) {
    showToast(error.message);
  }
}

async function discardDraft(id) {
  const game = gameById(id);
  if (!game) return;
  const reason = window.prompt(`作废《${game.title || "未命名草稿"}》会立即释放负责人和所有活跃队员的邮箱归属，且不能恢复。请填写作废原因：`);
  if (!reason?.trim()) return;
  try {
    const result = await adminFetch(`/api/admin/games/${encodeURIComponent(id)}/discard-draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: reason.trim() })
    });
    showToast(result.message);
    await loadDashboard();
  } catch (error) {
    showToast(error.message);
  }
}

async function regeneratePlanet() {
  const id = adminState.editingId;
  const game = gameById(id);
  if (!game || !window.confirm(`重新生成《${game.title}》的天体形态与坐标吗？所有访问者都会看到新的固定位置。`)) return;
  const button = $("#regeneratePlanet");
  button.disabled = true;
  button.textContent = "正在重新生成";
  try {
    const result = await adminFetch(`/api/admin/games/${encodeURIComponent(id)}/regenerate-planet`, { method: "POST" });
    showToast(result.message);
    await loadDashboard();
    editGame(id);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.textContent = "重新生成天体";
    button.disabled = !adminState.editingId;
  }
}

async function deleteVoter(id) {
  const ballot = adminState.dashboard.ballots.find((item) => item.id === id);
  if (!ballot) return;
  const reason = window.prompt(`删除 ${ballot.name} 的全部选票。请填写复核原因：`, "违规投票，经人工复核删除");
  if (!reason?.trim()) return;
  try {
    const result = await adminFetch(`/api/admin/voters/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: reason.trim() })
    });
    showToast(result.message);
    await loadDashboard();
  } catch (error) {
    showToast(error.message);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = "正在保存";
  message($("#settingsMessage"), "");
  try {
    const result = await adminFetch("/api/admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...data,
        submissionEndAt: new Date(data.submissionEndAt).toISOString(),
        startAt: new Date(data.startAt).toISOString(),
        endAt: new Date(data.endAt).toISOString()
      })
    });
    message($("#settingsMessage"), result.message);
    await loadDashboard();
  } catch (error) {
    message($("#settingsMessage"), error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "保存活动设置";
  }
}

async function saveAdjudication(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const winnerIds = $$('input[name="winnerIds"]:checked', form).map((input) => input.value);
  const note = form.elements.note.value.trim();
  const status = $("#adjudicationMessage");
  if (winnerIds.length !== 2) return message(status, "请选择恰好两款玩家之声获奖作品。", true);
  try {
    const result = await adminFetch("/api/admin/results/adjudicate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ winnerIds, note })
    });
    showToast(result.message);
    await loadDashboard();
  } catch (error) {
    message(status, error.message, true);
  }
}

async function publishResults() {
  if (!window.confirm("确认点亮全站宇宙吗？发布后用户下次打开网站将看到获奖结果。")) return;
  const button = $("#publishResults");
  button.disabled = true;
  button.textContent = "正在点亮";
  try {
    const result = await adminFetch("/api/admin/results/publish", { method: "POST" });
    showToast(result.message);
    await loadDashboard();
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
    button.textContent = "确认并点亮全站宇宙";
  }
}

async function withdrawResults() {
  const reason = window.prompt("请填写撤回公开结果的更正原因。该原因会写入审计记录：", "现场复核发现结果需要更正");
  if (!reason?.trim()) return;
  if (!window.confirm("确认撤回已经公开的玩家之声结果吗？前台会在下次刷新后恢复锁票状态。")) return;
  const button = $("#withdrawResults");
  button.disabled = true;
  button.textContent = "正在撤回";
  try {
    const result = await adminFetch("/api/admin/results/withdraw", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: reason.trim() })
    });
    showToast(result.message);
    await loadDashboard();
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
    button.textContent = "进入结果撤回流程";
  }
}

async function exportCsv({ button, endpoint, filename, idleLabel }) {
  button.disabled = true;
  button.textContent = "正在导出";
  try {
    const response = await adminFetch(endpoint);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = idleLabel;
  }
}

async function startArchiveExport({ scope, gameId = "", button, idleLabel }) {
  button.disabled = true;
  button.textContent = "正在生成归档";
  try {
    const ticket = await adminFetch("/api/admin/export/archive-ticket", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope, gameId })
    });
    const anchor = document.createElement("a");
    anchor.href = ticket.downloadUrl;
    anchor.download = "";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    showToast(scope === "all" ? "全部作品归档已开始下载" : "作品归档已开始下载");
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = idleLabel; }
}

function exportGameArchive(gameId, button) {
  return startArchiveExport({ scope: "game", gameId, button, idleLabel: "导出归档" });
}

function exportAllGames() {
  return startArchiveExport({ scope: "all", button: $("#exportAllGames"), idleLabel: "导出全部作品" });
}

async function downloadAdminDocument(gameId, documentId, button) {
  const game = gameById(gameId);
  const document = (game?.developmentDocuments || []).find((item) => item.id === documentId);
  const idleLabel = button.textContent;
  button.disabled = true;
  button.textContent = "读取中";
  try {
    const response = await adminFetch(`/api/admin/games/${encodeURIComponent(gameId)}/development-documents/${encodeURIComponent(documentId)}/download`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = document?.originalName || "开发文档";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = idleLabel; }
}

function exportVotes() {
  return exportCsv({ button: $("#exportVotes"), endpoint: "/api/admin/export/votes.csv", filename: "suyo-minigame-votes.csv", idleLabel: "导出选票" });
}

function exportAudit() {
  return exportCsv({ button: $("#exportAudit"), endpoint: "/api/admin/export/audit.csv", filename: "suyo-minigame-audit.csv", idleLabel: "导出审计" });
}

async function filterAudit(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const query = new URLSearchParams({ limit: "500" });
  for (const name of ["gameId", "email"]) {
    const value = String(data.get(name) || "").trim();
    if (value) query.set(name, value);
  }
  try {
    const result = await adminFetch(`/api/admin/audit?${query}`);
    adminState.fullAudit = result.audit;
    renderAudit();
  } catch (error) {
    showToast(error.message);
  }
}

function init() {
  $("#adminLoginForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const password = $("#adminPasswordInput").value.trim();
    if (!password) return message($("#adminLoginMessage"), "请输入后台密码。", true);
    message($("#adminLoginMessage"), "正在验证");
    login(password).catch((error) => {
      localStorage.removeItem(ADMIN_PASSWORD_KEY);
      adminState.password = "";
      showLogin(error.message);
    });
  });
  $("#adminLogout").addEventListener("click", () => {
    localStorage.removeItem(ADMIN_PASSWORD_KEY);
    adminState.password = "";
    showLogin();
  });
  $("#gameForm").addEventListener("submit", saveGame);
  $("#resetGameForm").addEventListener("click", resetGameForm);
  $("#cancelEdit").addEventListener("click", resetGameForm);
  $("#addCreator").addEventListener("click", () => {
    if (adminState.creators.length >= 12) return showToast("每款作品最多添加 12 位成员。");
    syncCreatorInputs();
    adminState.creators.push(newCreator());
    renderCreatorRows();
  });
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#auditFilterForm").addEventListener("submit", filterAudit);
  $("#exportVotes").addEventListener("click", exportVotes);
  $("#exportAudit").addEventListener("click", exportAudit);
  $("#exportAllGames").addEventListener("click", exportAllGames);
  $("#voterSearch").addEventListener("input", (event) => {
    adminState.voterQuery = event.target.value;
    renderBallots();
  });
  $("#regeneratePlanet").addEventListener("click", regeneratePlanet);
  renderCreatorRows();

  if (adminState.password) {
    login(adminState.password).catch((error) => {
      localStorage.removeItem(ADMIN_PASSWORD_KEY);
      adminState.password = "";
      showLogin(error.message);
    });
  } else {
    showLogin();
  }
}

init();
