const ADMIN_PASSWORD_KEY = "suyo.minigame.admin.password.v3";

const adminState = {
  password: localStorage.getItem(ADMIN_PASSWORD_KEY) || "",
  dashboard: null,
  fullAudit: null,
  editingId: "",
  creators: [],
  activeView: "overview",
  gameQuery: "",
  gameStatus: "",
  voterQuery: "",
  ballotStatus: "",
  commentAdmin: null,
  commentQuery: "",
  commentStatus: "",
  commentTab: "stream",
  auditAction: "",
  auditDate: "",
  auditPage: 1,
  auditPageSize: 20
};

const ADMIN_VIEWS = {
  overview: ["赛事总览", "当前活动运行状态与待处理事项"],
  gamesAdmin: ["参展作品", "作品资料、成员归属与内部文档"],
  ballotsAdmin: ["投票复核", "检查异常身份并作废违规选票"],
  commentsAdmin: ["社区管理", "管理讨论内容、标签、开关与禁言"],
  settingsAdmin: ["活动设置", "管理赛事信息与三个关键时间"],
  resultsAdmin: ["宇宙点亮", "裁定、复核并公开最终结果"],
  auditAdmin: ["审计记录", "查询不可变的运营与参赛操作" ]
};

const AUDIT_LABELS = {
  ballot_updated: "用户修改选票", ballot_invalidated_by_team_membership: "队伍关系使选票失效",
  participant_identity_updated: "用户更新投票身份", participant_identity_synchronized_by_team_membership: "队伍关系同步投票身份",
  session_verified: "用户完成邮箱验证", voter_removed: "管理员作废违规票",
  results_adjudicated: "管理员完成同票裁定", results_published: "管理员点亮宇宙", results_withdrawn: "管理员撤回公开结果",
  planet_regenerated: "管理员重新生成天体", game_created: "创建作品", game_updated: "修改作品", game_submitted: "提交参展",
  game_withdrawn: "撤回作品", game_owner_bound: "绑定负责人", game_member_added: "添加队友", game_member_removed: "移除队友",
  creator_profile_updated: "修改成员资料", game_late_marker_cleared: "撤销补交标记", game_marked_late: "自动标记补交",
  settings_updated: "修改赛事设置", comment_hidden: "隐藏评论", comment_restored: "恢复评论", comment_image_removed: "删除评论图片",
  comment_admin_hide: "隐藏评论", comment_admin_restore: "恢复评论", "comment_admin_remove-image": "删除评论图片", "comment_admin_remove-custom-tag": "移除评论标签",
  comment_user_muted: "禁言评论者", comment_user_unmuted: "解除禁言", comment_tag_created: "新增评论标签", comment_tag_updated: "修改评论标签",
  game_comments_readonly_updated: "修改作品讨论状态", global_comments_paused_updated: "修改全站评论状态", comment_created: "发表评论", comment_reply_created: "发表回复",
  comment_deleted_by_author: "作者删除评论", comment_profile_updated: "修改评论身份资料"
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
  activateAdminView(location.hash.slice(1) || adminState.activeView, { updateHash: false });
}

function activateAdminView(view, { updateHash = true } = {}) {
  if (!ADMIN_VIEWS[view]) view = "overview";
  adminState.activeView = view;
  $$('[data-admin-view-panel]').forEach((panel) => { panel.hidden = panel.id !== view; });
  $$('[data-admin-view]').forEach((link) => {
    const active = link.dataset.adminView === view;
    link.toggleAttribute("aria-current", active);
  });
  const [title, hint] = ADMIN_VIEWS[view];
  $("#adminViewTitle").textContent = title;
  $("#adminViewHint").textContent = hint;
  if (updateHash && location.hash !== `#${view}`) history.pushState(null, "", `#${view}`);
  $("#adminSidebar").classList.remove("open");
  $("#adminSidebarScrim").classList.remove("visible");
  $("#adminMenuToggle").setAttribute("aria-expanded", "false");
  $(".admin-main")?.scrollTo({ top: 0, behavior: "instant" });
}

function setDrawer(layer, open) {
  if (!layer) return;
  if (open) {
    layer.hidden = false;
    requestAnimationFrame(() => layer.classList.add("visible"));
  } else {
    layer.classList.remove("visible");
    setTimeout(() => { layer.hidden = true; }, 180);
  }
  document.body.classList.toggle("admin-overlay-open", open || $$(".admin-drawer-layer.visible").length > 0);
}

function openInspector(title, content) {
  $("#adminInspectorTitle").textContent = title;
  $("#adminInspectorContent").innerHTML = content;
  setDrawer($("#adminInspectorLayer"), true);
}

function closeInspector() {
  setDrawer($("#adminInspectorLayer"), false);
}

function requestAdminAction({
  title, description = "", consequence = "", confirmLabel = "确认", danger = false,
  reasonRequired = false, reason = "", valueLabel = "", value = "", valueRequired = false,
  expectedValue = "", inputType = "text"
}) {
  const dialog = $("#adminActionDialog");
  $("#adminActionTitle").textContent = title;
  $("#adminActionDescription").textContent = description;
  $("#adminActionConsequence").textContent = consequence;
  $("#adminActionConsequence").hidden = !consequence;
  $("#adminActionValueField").hidden = !valueLabel;
  $("#adminActionValueLabel").textContent = valueLabel;
  $("#adminActionValue").type = inputType;
  $("#adminActionValue").value = value;
  $("#adminActionReasonField").hidden = !reasonRequired;
  $("#adminActionReason").value = reason;
  $("#adminActionConfirm").textContent = confirmLabel;
  $("#adminActionConfirm").classList.toggle("button-danger", danger);
  message($("#adminActionMessage"), "");
  dialog.showModal();
  requestAnimationFrame(() => (valueLabel ? $("#adminActionValue") : reasonRequired ? $("#adminActionReason") : $("#adminActionConfirm")).focus());
  return new Promise((resolve) => {
    const finish = (result) => {
      $("#adminActionForm").onsubmit = null;
      $("#adminActionCancel").onclick = null;
      dialog.oncancel = null;
      if (dialog.open) dialog.close();
      resolve(result);
    };
    $("#adminActionForm").onsubmit = (event) => {
      event.preventDefault();
      const enteredValue = $("#adminActionValue").value.trim();
      const enteredReason = $("#adminActionReason").value.trim();
      if (valueRequired && !enteredValue) return message($("#adminActionMessage"), `请填写${valueLabel}。`, true);
      if (expectedValue && enteredValue !== expectedValue) return message($("#adminActionMessage"), `请输入“${expectedValue}”完成确认。`, true);
      if (reasonRequired && !enteredReason) return message($("#adminActionMessage"), "请填写操作原因。", true);
      finish({ confirmed: true, value: enteredValue, reason: enteredReason });
    };
    $("#adminActionCancel").onclick = () => finish({ confirmed: false });
    dialog.oncancel = (event) => { event.preventDefault(); finish({ confirmed: false }); };
  });
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
  const games = adminState.dashboard.games.filter((game) => !game.isOfficial).slice().sort((a, b) => b.voteCount - a.voteCount || a.title.localeCompare(b.title, "zh-Hans-CN"));
  $("#adminRanking").innerHTML = `
    <div class="ranking-head"><strong>当前票数</strong><span>仅后台可见</span></div>
    <div class="ranking-rows">
      ${games.length ? games.slice(0, 8).map((game, index) => `
        <div class="ranking-row">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <strong>${escapeHTML(game.title)}</strong>
          <small>${escapeHTML(game.team)}</small>
          <b>${game.voteCount} 票</b>
        </div>
      `).join("") : `<div class="admin-empty">暂无作品</div>`}
    </div>`;
}

function ballotNeedsReview(ballot) {
  if (ballot.risk?.level && ballot.risk.level !== "normal") return true;
  const voter = normalizedName(ballot.name);
  return ballot.gameIds.some((id) => (gameById(id)?.creators || []).some((creator) => normalizedName(creator.name) === voter));
}

function renderActionQueue() {
  const games = adminState.dashboard.games;
  const items = [
    { count: games.filter((game) => game.status === "draft").length, label: "草稿待提交", view: "gamesAdmin", filter: "draft" },
    { count: games.filter((game) => game.lateSubmission).length, label: "补交作品待复核", view: "gamesAdmin", filter: "late" },
    { count: games.filter((game) => game.status !== "abandoned" && !game.ownerEmail).length, label: "作品待绑定负责人", view: "gamesAdmin", filter: "ownerless" },
    { count: adminState.dashboard.ballots.filter(ballotNeedsReview).length, label: "选票建议人工复核", view: "ballotsAdmin", filter: "review" }
  ].filter((item) => item.count > 0);
  $("#adminActionQueue").innerHTML = items.length ? items.map((item) => `<button type="button" data-queue-view="${item.view}" data-queue-filter="${item.filter}"><strong>${item.count}</strong><span>${item.label}</span><em>进入处理</em></button>`).join("") : `<div class="admin-empty"><strong>当前没有待处理异常</strong><span>活动运行状态正常。</span></div>`;
  $$('[data-queue-view]').forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.queueView === "gamesAdmin") {
      adminState.gameStatus = button.dataset.queueFilter;
      $("#gameStatusFilter").value = adminState.gameStatus;
      renderGames();
    } else {
      adminState.ballotStatus = button.dataset.queueFilter;
      $("#ballotStatusFilter").value = adminState.ballotStatus;
      renderBallots();
    }
    activateAdminView(button.dataset.queueView);
  }));
}

function renderGames() {
  const list = $("#adminGameList");
  const needle = adminState.gameQuery.trim().toLowerCase();
  const games = adminState.dashboard.games.filter((game) => {
    const matchesSearch = !needle || [game.title, game.team, game.ownerEmail].join(" ").toLowerCase().includes(needle);
    const matchesStatus = !adminState.gameStatus
      || (adminState.gameStatus === "published" && (game.status === "submitted" || game.published))
      || (adminState.gameStatus === "draft" && game.status === "draft")
      || (adminState.gameStatus === "withdrawn" && game.status === "withdrawn")
      || (adminState.gameStatus === "late" && game.lateSubmission)
      || (adminState.gameStatus === "ownerless" && game.status !== "abandoned" && !game.ownerEmail);
    return matchesSearch && matchesStatus;
  });
  if (!games.length) {
    list.innerHTML = `<div class="admin-empty"><strong>${adminState.dashboard.games.length ? "没有匹配的作品" : "尚未录入作品"}</strong><span>${adminState.dashboard.games.length ? "调整搜索或状态筛选。" : "点击“新建作品”录入第一款参展游戏。"}</span></div>`;
    return;
  }
  list.innerHTML = games.map((game) => `
    <article class="admin-game-item admin-data-row ${game.published ? "" : "draft"} ${game.lateSubmission ? "late" : ""} ${game.isOfficial ? "official" : ""} ${game.status === "abandoned" ? "abandoned" : ""}">
      <img src="${escapeHTML(game.coverUrl || "/assets/pass-texture.png")}" alt="" />
      <div class="admin-row-main">
        <strong>${escapeHTML(game.title || "未命名草稿")}</strong>
        <span>${escapeHTML(game.team)}</span>
        <small>${escapeHTML(game.ownerEmail || "未绑定负责人")}</small>
      </div>
      <div class="admin-row-status"><span>${gameStatusLabel(game)}</span>${game.lateSubmission ? `<em>补交</em>` : ""}${game.isOfficial ? `<em>官方</em>` : ""}<b>${game.isOfficial ? "不计票" : `${game.voteCount} 票`}</b></div>
      <div class="admin-row-actions"><button class="button button-outline" data-edit-game="${escapeHTML(game.id)}" type="button" ${game.status === "abandoned" ? "disabled" : ""}>编辑</button>
        <details class="admin-more-menu"><summary>更多</summary><div>
          <button data-export-game="${escapeHTML(game.id)}" type="button">导出归档</button>
          ${game.status !== "abandoned" ? `<button data-bind-owner="${escapeHTML(game.id)}" type="button">绑定负责人</button>` : ""}
          ${(game.developmentDocuments || []).map((document) => `<button type="button" data-admin-document="${escapeHTML(game.id)}:${escapeHTML(document.id)}">下载：${escapeHTML(document.originalName)}</button>`).join("")}
          ${game.lateSubmission ? `<button class="danger-action" data-clear-late="${escapeHTML(game.id)}" type="button">复核补交标记</button>` : ""}
          ${game.status === "draft" && !game.firstSubmittedAt && !game.submittedAt ? `<button class="danger-action" data-discard-draft="${escapeHTML(game.id)}" type="button">作废并释放归属</button>` : ""}
        </div></details>
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
    const suspected = ballotNeedsReview(ballot);
    const matchesRisk = !adminState.ballotStatus
      || (adminState.ballotStatus === "review" && suspected)
      || (adminState.ballotStatus === "high" && ballot.risk?.level === "high")
      || (adminState.ballotStatus === "normal" && !suspected);
    return (!needle || text.includes(needle)) && matchesRisk;
  });
  if (!ballots.length) {
    list.innerHTML = needle
      ? `<div class="admin-empty"><strong>没有匹配的投票者</strong><span>尝试搜索姓名、队伍、邮箱或作品名称。</span></div>`
      : `<div class="admin-empty"><strong>还没有有效选票</strong><span>用户提交选票后会出现在这里。</span></div>`;
    return;
  }
  const canReview = adminState.dashboard.votingState !== "published";
  list.innerHTML = ballots.map((ballot) => {
    const suspected = ballotNeedsReview(ballot);
    const reasons = ballot.risk?.reasons || [];
    const firstReason = reasons[0]?.label || (suspected ? "姓名匹配作者" : "");
    return `
    <article class="ballot-row admin-data-row ${suspected ? "suspected-self-vote" : ""} ${ballot.risk?.level === "high" ? "high-risk" : ""}">
      <div class="admin-row-main"><strong>${escapeHTML(ballot.name)}</strong><span>${escapeHTML(ballot.team)}</span><small>${escapeHTML(ballot.email)}</small></div>
      <p>${ballot.games.map(escapeHTML).join(" / ")}</p>
      <span class="admin-risk-state">${suspected ? `<b>${ballot.risk?.level === "high" ? "高风险" : "建议复核"}</b><small>${escapeHTML(firstReason)}${reasons.length > 1 ? ` 等 ${reasons.length} 项` : ""}</small>` : `<span>暂无异常</span>`}</span>
      <time>${formatDate(ballot.updatedAt)}</time>
      <div class="admin-row-actions"><button class="button button-outline" data-inspect-ballot="${escapeHTML(ballot.id)}" type="button">查看详情</button>${canReview ? `<button class="text-action danger-action" data-delete-voter="${escapeHTML(ballot.id)}" type="button">作废选票</button>` : ""}</div>
    </article>
  `; }).join("");
  $$('[data-delete-voter]', list).forEach((button) => button.addEventListener("click", () => deleteVoter(button.dataset.deleteVoter)));
  $$('[data-inspect-ballot]', list).forEach((button) => button.addEventListener("click", () => inspectBallot(button.dataset.inspectBallot)));
}

function inspectBallot(id) {
  const ballot = adminState.dashboard.ballots.find((item) => item.id === id);
  if (!ballot) return;
  const audit = ballot.audit || [];
  const eligibility = ballot.eligibility || {};
  const reasons = ballot.risk?.reasons || [];
  const sourceLabels = { developer: "开发者豁免", downloads: "下载试玩", legacy: "历史选票保留" };
  const riskMarkup = `<div class="admin-inspector-log"><h3>风险信号 ${reasons.length}</h3>${reasons.length ? `<ol>${reasons.map((reason) => `<li><strong>${escapeHTML(reason.label)}</strong><span>${escapeHTML(reason.detail)}</span></li>`).join("")}</ol>` : `<div class="admin-empty">没有命中风险信号</div>`}</div>`;
  const downloadMarkup = `<div class="admin-inspector-log"><h3>资格记录 ${eligibility.downloads?.length || 0}</h3><p>${escapeHTML(sourceLabels[eligibility.source] || "尚未获得资格")}，浏览返回 ${eligibility.activityCount || 0} 次</p>${eligibility.downloads?.length ? `<ol>${eligibility.downloads.map((item) => `<li><time>${formatDate(item.firstDownloadedAt)}</time><span>${escapeHTML(item.title)}${item.count > 1 ? `，触发 ${item.count} 次` : ""}${item.source ? `，来源 ${escapeHTML(item.source)}` : ""}</span></li>`).join("")}</ol>` : `<div class="admin-empty">没有计入资格的下载</div>`}</div>`;
  openInspector(`选票：${ballot.name}`, `<dl class="admin-inspector-facts"><div><dt>邮箱</dt><dd>${escapeHTML(ballot.email)}</dd></div><div><dt>队伍</dt><dd>${escapeHTML(ballot.team)}</dd></div><div><dt>当前选择</dt><dd>${ballot.games.map(escapeHTML).join(" / ") || "空选票"}</dd></div><div><dt>更新时间</dt><dd>${formatDate(ballot.updatedAt)}</dd></div></dl>${riskMarkup}${downloadMarkup}<div class="admin-inspector-log"><h3>选票变化 ${audit.length}</h3>${audit.length ? `<ol>${audit.map((item) => { const before = (item.before || []).map((gameId) => gameById(gameId)?.title || gameId).join(" / ") || "空选票"; const after = (item.after || []).map((gameId) => gameById(gameId)?.title || gameId).join(" / ") || "空选票"; return `<li><time>${formatDate(item.createdAt)}</time><span>${escapeHTML(before)} → ${escapeHTML(after)}</span></li>`; }).join("")}</ol>` : `<div class="admin-empty">暂无选票变化记录</div>`}</div>`);
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
  $("#settingsSummary").innerHTML = `<dl class="settings-summary-grid"><div><dt>活动名称</dt><dd>${escapeHTML(settings.eventTitle)}</dd></div><div><dt>Game Jam 主题</dt><dd>${escapeHTML(settings.theme)}</dd></div><div class="field-wide"><dt>活动标语</dt><dd>${escapeHTML(settings.slogan)}</dd></div><div><dt>参展提交截止</dt><dd>${formatDate(settings.submissionEndAt)}</dd></div><div><dt>投票开始</dt><dd>${formatDate(settings.startAt)}</dd></div><div><dt>投票结束</dt><dd>${formatDate(settings.endAt)}</dd></div><div class="field-wide"><dt>星图种子</dt><dd>${escapeHTML(settings.eventSeed || "未设置")}</dd></div></dl><div class="settings-notice"><strong>控制规则</strong><span>参展截止只判断补交，投票截止只锁定选票，宇宙点亮仍由管理员手动触发。</span></div>`;
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
      <ul class="release-checklist"><li><span>01</span>玩家之声边界无未裁定同票</li><li><span>02</span>违规选票已完成人工复核</li><li><span>03</span>现场流程已经准备完成</li></ul>
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
  let audit = adminState.fullAudit || adminState.dashboard.recentAudit || [];
  if (adminState.auditAction) audit = audit.filter((item) => item.action === adminState.auditAction);
  if (adminState.auditDate) audit = audit.filter((item) => String(item.createdAt || "").slice(0, 10) === adminState.auditDate);
  if (!audit.length) {
    list.innerHTML = `<div class="admin-empty">暂无审计记录</div>`;
    $("#auditPagination").hidden = true;
    return;
  }
  const pages = Math.max(1, Math.ceil(audit.length / adminState.auditPageSize));
  adminState.auditPage = Math.min(adminState.auditPage, pages);
  const start = (adminState.auditPage - 1) * adminState.auditPageSize;
  const visible = audit.slice(start, start + adminState.auditPageSize);
  list.innerHTML = visible.map((item, index) => `
    <article class="audit-row admin-data-row">
      <time>${formatDate(item.createdAt)}</time>
      <strong>${escapeHTML(AUDIT_LABELS[item.action] || item.action)}</strong>
      <span>${escapeHTML(item.actorEmail || item.reason || item.actorType || "system")}</span>
      <button class="button button-outline" type="button" data-inspect-audit="${start + index}">查看详情</button>
    </article>`).join("");
  $("#auditPagination").hidden = pages <= 1;
  $("#auditPageLabel").textContent = `第 ${adminState.auditPage} / ${pages} 页，共 ${audit.length} 条`;
  $("#auditPrevPage").disabled = adminState.auditPage <= 1;
  $("#auditNextPage").disabled = adminState.auditPage >= pages;
  $$('[data-inspect-audit]', list).forEach((button) => button.addEventListener("click", () => {
    const item = audit[Number(button.dataset.inspectAudit)];
    openInspector(AUDIT_LABELS[item.action] || item.action, `<dl class="admin-inspector-facts"><div><dt>发生时间</dt><dd>${formatDate(item.createdAt)}</dd></div><div><dt>操作者</dt><dd>${escapeHTML(item.actorEmail || item.actorType || "system")}</dd></div><div><dt>原因</dt><dd>${escapeHTML(item.reason || "未提供")}</dd></div></dl><h3>完整记录</h3><pre>${escapeHTML(JSON.stringify(item, null, 2))}</pre>`);
  }));
}

function renderCommentAdmin() {
  const data = adminState.commentAdmin;
  if (!data) return;
  const paused = Boolean(data.settings.commentsPaused);
  $("#toggleGlobalComments").textContent = paused ? "恢复全站评论" : "暂停全站评论";
  $("#toggleGlobalComments").classList.toggle("danger-action", !paused);
  $$('[data-comment-admin-tab]').forEach((button) => button.setAttribute("aria-current", button.dataset.commentAdminTab === adminState.commentTab ? "page" : "false"));
  $$('[data-comment-admin-pane]').forEach((pane) => { pane.hidden = pane.dataset.commentAdminPane !== adminState.commentTab; });
  $("#commentGameSettings").innerHTML = data.settings.games.map((game) => `<div class="comment-game-setting"><span><strong>${escapeHTML(game.title || "未命名作品")}</strong><small>${game.commentsReadOnly ? "只读" : "开放交流"}</small></span><button class="text-action ${game.commentsReadOnly ? "" : "danger-action"}" data-comment-game-setting="${escapeHTML(game.id)}" data-readonly="${game.commentsReadOnly}">${game.commentsReadOnly ? "恢复交流" : "设为只读"}</button></div>`).join("") || `<div class="admin-empty">暂无作品</div>`;
  $("#commentTagList").innerHTML = data.tags.slice().sort((a, b) => a.order - b.order).map((tag) => `<div class="comment-tag-admin ${tag.enabled ? "" : "disabled"}"><span><strong>${escapeHTML(tag.label)}</strong><small>${escapeHTML(tag.group)}</small></span><button class="text-action" data-comment-tag-toggle="${escapeHTML(tag.id)}" data-enabled="${tag.enabled}">${tag.enabled ? "停用" : "恢复"}</button></div>`).join("");
  const mutes = Object.entries(data.mutes || {});
  $("#commentMuteList").innerHTML = mutes.length ? mutes.map(([email, mute]) => `<div class="comment-game-setting"><span><strong>${escapeHTML(email)}</strong><small>${mute?.permanent ? "永久禁言" : mute?.until ? `至 ${formatDate(mute.until)}` : "禁言中"}</small></span><button class="text-action" data-unmute-comment-author="${escapeHTML(email)}">解除禁言</button></div>`).join("") : `<div class="admin-empty"><strong>当前没有禁言账户</strong><span>被禁言用户仍可浏览、投票和点赞。</span></div>`;
  const needle = adminState.commentQuery.trim().toLowerCase();
  const comments = data.comments.filter((comment) => {
    const matchesSearch = !needle || [comment.gameTitle, comment.author?.name, comment.authorEmail, comment.body].join(" ").toLowerCase().includes(needle);
    const matchesStatus = !adminState.commentStatus || (adminState.commentStatus === "visible" && comment.status === "active") || comment.status === adminState.commentStatus;
    return matchesSearch && matchesStatus;
  });
  $("#commentAdminList").innerHTML = comments.map((comment) => `<article class="comment-admin-item ${comment.status}">
    <header><div><strong>${escapeHTML(comment.author?.name || "观测者")}</strong>${comment.author?.developer ? `<em>开发者</em>` : ""}<span>${escapeHTML(comment.authorEmail || "")}</span></div><time>${formatDate(comment.createdAt)}</time></header>
    <p class="comment-admin-game">${escapeHTML(comment.gameTitle)} / ${comment.replyToId ? `回复 @${escapeHTML(comment.replyToName || "观测者")}` : "一级评论"}</p>
    <div class="comment-admin-body">${escapeHTML(comment.body || (comment.images?.length ? "仅图片" : "无公开文字"))}</div>
    ${comment.tags?.length ? `<div class="comment-admin-tags">${comment.tags.map((tag) => `<span>${escapeHTML(tag.label)}${tag.custom ? "（自定义）" : ""}${tag.custom ? `<button type="button" data-remove-comment-tag="${escapeHTML(comment.id)}:${escapeHTML(tag.id)}">移除</button>` : ""}</span>`).join("")}</div>` : ""}
    ${comment.images?.length ? `<div class="comment-admin-images">${comment.images.map((image) => `<figure><img src="${escapeHTML(image.thumbnailUrl || image.url)}" alt="" /><button type="button" data-remove-comment-image="${escapeHTML(comment.id)}:${escapeHTML(image.id)}">删除违规图片</button></figure>`).join("")}</div>` : ""}
    <div class="comment-admin-actions">
      <button class="text-action ${comment.status === "active" ? "danger-action" : ""}" data-moderate-comment="${escapeHTML(comment.id)}" data-action="${comment.status === "hidden" ? "restore" : "hide"}">${comment.status === "hidden" ? "恢复显示" : "隐藏信号"}</button>
      <button class="text-action danger-action" data-mute-comment-author="${escapeHTML(comment.authorEmail || "")}">禁言邮箱</button>
      ${data.mutes?.[comment.authorEmail] ? `<button class="text-action" data-unmute-comment-author="${escapeHTML(comment.authorEmail)}">解除禁言</button>` : ""}
    </div>
  </article>`).join("") || `<div class="admin-empty"><strong>没有匹配的回声</strong><span>新评论会在这里立即出现。</span></div>`;

  $$('[data-comment-game-setting]').forEach((button) => button.addEventListener("click", () => updateGameCommentSetting(button.dataset.commentGameSetting, button.dataset.readonly !== "true")));
  $$('[data-comment-tag-toggle]').forEach((button) => button.addEventListener("click", () => updateCommentTag(button.dataset.commentTagToggle, button.dataset.enabled !== "true")));
  $$('[data-moderate-comment]').forEach((button) => button.addEventListener("click", () => moderateComment(button.dataset.moderateComment, button.dataset.action)));
  $$('[data-remove-comment-image]').forEach((button) => button.addEventListener("click", () => { const [id, imageId] = button.dataset.removeCommentImage.split(":"); moderateComment(id, "remove-image", { imageId }); }));
  $$('[data-remove-comment-tag]').forEach((button) => button.addEventListener("click", () => { const [id, tagId] = button.dataset.removeCommentTag.split(":"); moderateComment(id, "remove-custom-tag", { tagId }); }));
  $$('[data-mute-comment-author]').forEach((button) => button.addEventListener("click", () => muteCommentAuthor(button.dataset.muteCommentAuthor)));
  $$('[data-unmute-comment-author]').forEach((button) => button.addEventListener("click", () => unmuteCommentAuthor(button.dataset.unmuteCommentAuthor)));
}

async function reloadCommentAdmin() {
  adminState.commentAdmin = await adminFetch("/api/admin/comments");
  renderCommentAdmin();
}

async function toggleGlobalComments() {
  const paused = Boolean(adminState.commentAdmin?.settings.commentsPaused);
  const choice = await requestAdminAction({ title: paused ? "恢复全站评论" : "暂停全站评论", description: paused ? "验证用户将重新能够发表评论和回复。" : "所有作品讨论将立即变为只读，现有内容仍可浏览和点赞。", consequence: "该操作不会影响投票和作品编辑。", confirmLabel: paused ? "恢复评论" : "确认暂停", danger: !paused, reasonRequired: true });
  if (!choice.confirmed) return;
  await adminFetch("/api/admin/comments/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused: !paused, reason: choice.reason }) });
  await reloadCommentAdmin();
  showToast(paused ? "全站评论已恢复" : "全站评论已暂停");
}

async function updateGameCommentSetting(gameId, readOnly) {
  const game = gameById(gameId);
  const choice = await requestAdminAction({ title: readOnly ? "将作品讨论设为只读" : "恢复作品交流", description: `对象：${game?.title || "未命名作品"}`, consequence: readOnly ? "现有评论保留，但不能继续评论或回复。" : "验证用户可以继续参与讨论。", confirmLabel: readOnly ? "设为只读" : "恢复交流", danger: readOnly, reasonRequired: true });
  if (!choice.confirmed) return;
  await adminFetch(`/api/admin/games/${encodeURIComponent(gameId)}/comments/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ readOnly, reason: choice.reason }) });
  await reloadCommentAdmin();
}

async function createCommentTag(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await adminFetch("/api/admin/comments/tags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    event.currentTarget.reset();
    await reloadCommentAdmin();
  } catch (error) { showToast(error.message); }
}

async function updateCommentTag(id, enabled) {
  try {
    await adminFetch(`/api/admin/comments/tags/${encodeURIComponent(id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
    await reloadCommentAdmin();
  } catch (error) { showToast(error.message); }
}

async function moderateComment(id, action, extra = {}) {
  const actionNames = { hide: "隐藏信号", restore: "恢复显示", "remove-image": "删除违规图片", "remove-custom-tag": "移除自定义标签" };
  const choice = await requestAdminAction({ title: actionNames[action] || "管理评论", description: "该操作将立即影响公开讨论区。", consequence: "原内容和操作原因会永久保留在后台审计中。", confirmLabel: actionNames[action] || "确认执行", danger: action !== "restore", reasonRequired: true });
  if (!choice.confirmed) return;
  try {
    await adminFetch(`/api/admin/comments/${encodeURIComponent(id)}/moderate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, reason: choice.reason, ...extra }) });
    await reloadCommentAdmin();
  } catch (error) { showToast(error.message); }
}

async function muteCommentAuthor(email) {
  const choice = await requestAdminAction({ title: "禁言评论账户", description: email, consequence: "仅禁止发表新内容，用户仍可浏览、投票、编辑作品和点赞。", confirmLabel: "确认禁言", danger: true, valueLabel: "禁言时长（1h、1d、7d 或 permanent）", value: "1d", valueRequired: true, reasonRequired: true });
  if (!choice.confirmed) return;
  if (!/^(1h|1d|7d|permanent)$/.test(choice.value)) return showToast("禁言时长只能填写 1h、1d、7d 或 permanent。");
  try {
    await adminFetch(`/api/admin/comment-mutes/${encodeURIComponent(email)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ duration: choice.value, reason: choice.reason }) });
    await reloadCommentAdmin();
  } catch (error) { showToast(error.message); }
}

async function unmuteCommentAuthor(email) {
  const choice = await requestAdminAction({ title: "解除禁言", description: email, consequence: "用户将立即恢复评论和回复权限。", confirmLabel: "解除禁言", reasonRequired: true });
  if (!choice.confirmed) return;
  try {
    await adminFetch(`/api/admin/comment-mutes/${encodeURIComponent(email)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: choice.reason }) });
    await reloadCommentAdmin();
  } catch (error) { showToast(error.message); }
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
  $("#navGamesBadge").textContent = dashboard.stats.games;
  $("#navBallotsBadge").textContent = dashboard.stats.voters;
  $("#navCommentsBadge").textContent = adminState.commentAdmin?.comments?.length || 0;
  renderActionQueue();
  renderRanking();
  renderGames();
  renderBallots();
  renderResultControl();
  renderAudit();
  renderCommentAdmin();
  fillSettings();
  $("#auditGameFilter").innerHTML = `<option value="">全部作品</option>${dashboard.games.map((game) => `<option value="${escapeHTML(game.id)}">${escapeHTML(game.title || "未命名草稿")}</option>`).join("")}`;
  const auditActions = [...new Set((adminState.fullAudit || []).map((item) => item.action))].sort();
  $("#auditActionFilter").innerHTML = `<option value="">全部操作</option>${auditActions.map((action) => `<option value="${escapeHTML(action)}">${escapeHTML(AUDIT_LABELS[action] || action)}</option>`).join("")}`;
  $("#auditActionFilter").value = adminState.auditAction;
  activateAdminView(location.hash.slice(1) || adminState.activeView, { updateHash: false });
}

async function loadDashboard() {
  const [dashboard, auditResult, comments] = await Promise.all([
    adminFetch("/api/admin/dashboard"),
    adminFetch("/api/admin/audit?limit=500"),
    adminFetch("/api/admin/comments")
  ]);
  adminState.dashboard = dashboard;
  adminState.fullAudit = auditResult.audit;
  adminState.commentAdmin = comments;
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
  form.elements.isOfficial.checked = false;
  adminState.editingId = "";
  adminState.creators = [];
  renderCreatorRows();
  $("#gameId").value = "";
  $("#editorTitle").textContent = "新建作品";
  $("#editorHint").textContent = "保存后立即写入服务器";
  $("#saveGame").textContent = "保存作品";
  $("#planetCoordinate").textContent = "保存作品后生成";
  $("#planetSeed").textContent = "保存作品后生成";
  $("#regeneratePlanet").disabled = true;
  message($("#gameMessage"), "");
}

function openNewGameEditor() {
  resetGameForm();
  setDrawer($("#gameEditorLayer"), true);
}

function closeGameEditor() {
  setDrawer($("#gameEditorLayer"), false);
  setTimeout(resetGameForm, 190);
}

function openSettingsEditor() {
  fillSettings();
  setDrawer($("#settingsEditorLayer"), true);
}

function closeSettingsEditor() {
  setDrawer($("#settingsEditorLayer"), false);
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
  form.elements.isOfficial.checked = Boolean(game.isOfficial);
  $("#editorTitle").textContent = `编辑：${game.title}`;
  $("#editorHint").textContent = "未重新上传的素材保持不变；参赛权限与自投限制以邮箱为准";
  $("#saveGame").textContent = "更新作品";
  $("#planetCoordinate").textContent = game.coordinate ? `X ${Number(game.coordinate.x).toFixed(5)} / Y ${Number(game.coordinate.y).toFixed(5)} / Z ${Number(game.coordinate.z ?? (Number(game.coordinate.depth ?? 0.5) * 2 - 1)).toFixed(5)}` : "尚未生成";
  $("#planetSeed").textContent = game.planetSeed || "尚未生成";
  $("#regeneratePlanet").disabled = false;
  message($("#gameMessage"), "");
  setDrawer($("#gameEditorLayer"), true);
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
    closeGameEditor();
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
  if (!game) return;
  const choice = await requestAdminAction({ title: "绑定唯一负责人", description: `作品：${game.title || "未命名草稿"}`, consequence: "新邮箱将立即获得负责人权限，原负责人会立即失去权限。", confirmLabel: "确认绑定", danger: Boolean(game.ownerEmail), valueLabel: "负责人邮箱", value: game.ownerEmail || "", valueRequired: true, inputType: "email" });
  if (!choice.confirmed) return;
  const email = choice.value;
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
  const choice = await requestAdminAction({ title: "撤销补交标记", description: `作品：${game.title}`, consequence: "只撤销当前这次判断，之后若再次在截止后修改下载地址，系统仍会重新标记。", confirmLabel: "撤销标记", reasonRequired: true });
  if (!choice.confirmed) return;
  try {
    const result = await adminFetch(`/api/admin/games/${encodeURIComponent(id)}/late`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: choice.reason })
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
  const choice = await requestAdminAction({ title: "作废草稿并释放归属", description: `作品：${game.title || "未命名草稿"}`, consequence: "负责人和活跃队员的邮箱归属会立即释放，作品不能恢复，审计记录永久保留。", confirmLabel: "确认作废", danger: true, reasonRequired: true, valueLabel: "输入作品名称确认", expectedValue: game.title || "未命名草稿", valueRequired: true });
  if (!choice.confirmed) return;
  try {
    const result = await adminFetch(`/api/admin/games/${encodeURIComponent(id)}/discard-draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: choice.reason })
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
  if (!game) return;
  const choice = await requestAdminAction({ title: "重新生成天体", description: `作品：${game.title}`, consequence: "天体形态与坐标会改变，所有访问者将看到新的固定位置。", confirmLabel: "重新生成", danger: true });
  if (!choice.confirmed) return;
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
  const choice = await requestAdminAction({ title: "作废该用户的全部选票", description: `${ballot.name} / ${ballot.email}`, consequence: "有效票将失效，可能性核心会归还并释放槽位。操作会写入永久审计。", confirmLabel: "确认作废", danger: true, reasonRequired: true, reason: "违规投票，经人工复核作废" });
  if (!choice.confirmed) return;
  try {
    const result = await adminFetch(`/api/admin/voters/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: choice.reason })
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
    closeSettingsEditor();
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
  const choice = await requestAdminAction({ title: "点亮全站宇宙", description: "发布后，所有用户下次刷新或重新打开网站都会看到获奖结果。", consequence: "投票会立即停止。请确认同票裁定、违规票复核和现场流程均已完成。", confirmLabel: "点亮宇宙", danger: true, valueLabel: "输入“确认点亮”完成发布", expectedValue: "确认点亮", valueRequired: true });
  if (!choice.confirmed) return;
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
  const choice = await requestAdminAction({ title: "撤回已公开结果", description: "前台会在用户下次刷新后恢复锁票复核状态。", consequence: "旧裁定会清除，必须重新完成复核与点亮流程。", confirmLabel: "确认撤回", danger: true, reasonRequired: true, reason: "现场复核发现结果需要更正", valueLabel: "输入“确认撤回”继续", expectedValue: "确认撤回", valueRequired: true });
  if (!choice.confirmed) return;
  const button = $("#withdrawResults");
  button.disabled = true;
  button.textContent = "正在撤回";
  try {
    const result = await adminFetch("/api/admin/results/withdraw", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: choice.reason })
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
    adminState.auditAction = $("#auditActionFilter").value;
    adminState.auditDate = $("#auditDateFilter").value;
    adminState.auditPage = 1;
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
  $("#resetGameForm").addEventListener("click", openNewGameEditor);
  $("#cancelEdit").addEventListener("click", closeGameEditor);
  $("#closeGameEditor").addEventListener("click", closeGameEditor);
  $("#closeGameEditorBackdrop").addEventListener("click", closeGameEditor);
  $("#editSettings").addEventListener("click", openSettingsEditor);
  $("#closeSettingsEditor").addEventListener("click", closeSettingsEditor);
  $("#closeSettingsBackdrop").addEventListener("click", closeSettingsEditor);
  $("#cancelSettingsEdit").addEventListener("click", closeSettingsEditor);
  $("#closeAdminInspector").addEventListener("click", closeInspector);
  $("#closeAdminInspectorBackdrop").addEventListener("click", closeInspector);
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
  $("#ballotStatusFilter").addEventListener("change", (event) => { adminState.ballotStatus = event.target.value; renderBallots(); });
  $("#gameSearch").addEventListener("input", (event) => { adminState.gameQuery = event.target.value; renderGames(); });
  $("#gameStatusFilter").addEventListener("change", (event) => { adminState.gameStatus = event.target.value; renderGames(); });
  $("#regeneratePlanet").addEventListener("click", regeneratePlanet);
  $("#toggleGlobalComments").addEventListener("click", () => toggleGlobalComments().catch((error) => showToast(error.message)));
  $("#refreshComments").addEventListener("click", () => reloadCommentAdmin().catch((error) => showToast(error.message)));
  $("#commentTagForm").addEventListener("submit", createCommentTag);
  $("#commentAdminSearch").addEventListener("input", (event) => { adminState.commentQuery = event.target.value; renderCommentAdmin(); });
  $("#commentStatusFilter").addEventListener("change", (event) => { adminState.commentStatus = event.target.value; renderCommentAdmin(); });
  $$('[data-comment-admin-tab]').forEach((button) => button.addEventListener("click", () => { adminState.commentTab = button.dataset.commentAdminTab; renderCommentAdmin(); }));
  $$('[data-admin-view]').forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); activateAdminView(link.dataset.adminView); }));
  $("#adminMenuToggle").addEventListener("click", () => {
    const open = !$("#adminSidebar").classList.contains("open");
    $("#adminSidebar").classList.toggle("open", open);
    $("#adminSidebarScrim").classList.toggle("visible", open);
    $("#adminMenuToggle").setAttribute("aria-expanded", String(open));
  });
  $("#adminSidebarScrim").addEventListener("click", () => activateAdminView(adminState.activeView, { updateHash: false }));
  $("#auditPrevPage").addEventListener("click", () => { adminState.auditPage = Math.max(1, adminState.auditPage - 1); renderAudit(); });
  $("#auditNextPage").addEventListener("click", () => { adminState.auditPage += 1; renderAudit(); });
  window.addEventListener("hashchange", () => activateAdminView(location.hash.slice(1), { updateHash: false }));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || $("#adminActionDialog").open) return;
    if ($("#adminInspectorLayer").classList.contains("visible")) closeInspector();
    else if ($("#gameEditorLayer").classList.contains("visible")) closeGameEditor();
    else if ($("#settingsEditorLayer").classList.contains("visible")) closeSettingsEditor();
    else if ($("#adminSidebar").classList.contains("open")) activateAdminView(adminState.activeView, { updateHash: false });
  });
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
