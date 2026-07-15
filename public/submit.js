const state = {
  session: null,
  workspace: null,
  game: null,
  dirty: false,
  pendingInvitedIdentity: false,
  confirmResolve: null,
  profileTarget: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function formatDate(value) {
  if (!value) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}

function setMessage(element, text = "", error = false) {
  element.textContent = text;
  element.dataset.error = error ? "true" : "false";
}

function toast(text) {
  const node = $("#toast");
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 3200);
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { accept: "application/json", ...(options.headers || {}) } });
  const result = await response.json().catch(() => ({ ok: false, message: "服务器返回了无法识别的响应。" }));
  if (!response.ok || result.ok === false) {
    const error = new Error(result.message || "请求失败。");
    Object.assign(error, result, { status: response.status });
    throw error;
  }
  return result;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${Math.ceil(bytes / 1024)}KB`;
}

function uploadApi(url, { method, body, onProgress }) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, url);
    request.setRequestHeader("accept", "application/json");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    });
    request.addEventListener("load", () => {
      let result;
      try { result = JSON.parse(request.responseText); }
      catch { result = { ok: false, message: "服务器返回了无法识别的响应。" }; }
      if (request.status >= 200 && request.status < 300 && result.ok !== false) return resolve(result);
      const error = new Error(result.message || "请求失败。");
      Object.assign(error, result, { status: request.status });
      reject(error);
    });
    request.addEventListener("error", () => reject(new Error("网络连接中断。请保留页面并重新上传。")));
    request.addEventListener("abort", () => reject(new Error("上传已取消。")));
    request.send(body);
  });
}

function showOnly(id) {
  for (const selector of ["authPanel", "workspaceLoading", "draftOrigin", "participantWorkspace"]) $(`#${selector}`).hidden = selector !== id;
}

function statusText(game) {
  if (game.status === "submitted") return game.lateSubmission ? "已提交 / 补交" : "已提交";
  if (game.status === "withdrawn") return "已撤回";
  return "草稿";
}

function roleText(game) {
  return game.role === "owner" ? "唯一负责人" : "队伍编辑成员";
}

function creatorById(id) {
  return (state.game?.creators || []).find((creator) => creator.id === id) || null;
}

function fillGameForm() {
  const game = state.game;
  const form = $("#gameForm");
  form.elements.revision.value = game.revision || 1;
  for (const name of ["title", "team", "shortDescription", "description", "creationNote", "tags", "videoExternalUrl"]) {
    const value = name === "tags" ? (game.tags || []).join("，") : game[name] || "";
    form.elements[name].value = value;
  }
  form.elements.coverUrl.value = String(game.coverUrl || "").startsWith("http") ? game.coverUrl : "";
  form.elements.gameFile.value = "";
  $("#coverCurrent").textContent = game.coverUrl ? `当前封面：${String(game.coverUrl).startsWith("/uploads/") ? "已上传文件" : "外部地址"}` : "尚未上传";
  $("#videoCurrent").textContent = game.uploadedVideoUrl ? "当前优先使用已上传视频" : game.videoExternalUrl ? "当前使用公开视频链接" : "单个文件不超过 200MB";
  $("#gameFileCurrent").textContent = game.gameFileMeta
    ? `当前文件：${game.gameFileMeta.originalName || "已上传作品包"}，${formatBytes(game.gameFileMeta.size)}`
    : game.downloadUrl
      ? "当前作品仍使用旧版外部地址。选择压缩包并保存后将替换为上传文件。"
      : "支持 ZIP、7Z、RAR，单个文件不超过 2GB。";
  $("#updatedAtLabel").textContent = `最后保存：${formatDate(game.updatedAt)}`;
  state.dirty = false;
  updateDirtyState();
}

function renderHeader() {
  const game = state.game;
  $("#workspaceTitle").textContent = game.title || "未命名作品";
  $("#workspaceTeam").textContent = game.team || "队伍名称尚未填写";
  $("#statusLabel").textContent = statusText(game);
  $("#roleLabel").textContent = roleText(game);
  const missingCount = (game.missingFields || []).length;
  $("#requirementSummary").textContent = game.status === "submitted"
    ? "当前版本已公开，可继续更新作品资料"
    : missingCount
      ? `尚未公开，提交前还差 ${missingCount} 项`
      : "资料已齐全，可以提交参展";
  $("#deadlineLabel").textContent = `提交截止：${formatDate(game.submissionEndAt)}`;
  $(".workspace-state").dataset.late = game.lateSubmission ? "true" : "false";
  $(".critical-field").dataset.late = game.afterSubmissionDeadline ? "true" : "false";
  $("#gameFileCurrent").dataset.late = game.afterSubmissionDeadline ? "true" : "false";
}

function memberStatus(member) {
  return member.firstLoginAt ? `已于 ${formatDate(member.firstLoginAt)} 验证登录` : "待首次邮箱验证";
}

function avatarMarkup(creator) {
  if (creator?.avatarUrl) return `<img src="${escapeHTML(creator.avatarUrl)}" alt="${escapeHTML(creator.name)}的头像" />`;
  return escapeHTML((creator?.name || "?").slice(0, 1));
}

function renderTeam() {
  const game = state.game;
  const roster = $("#teamRoster");
  const owner = creatorById(game.ownerCreatorId) || game.creators?.[0] || { name: state.workspace.identity.name, role: "负责人", contribution: "" };
  const ownerCanEdit = game.role === "owner";
  const rows = [{ id: "owner", email: game.ownerEmail, creator: owner, meta: "负责人邮箱已锁定", canEdit: ownerCanEdit, canRemove: false }];
  for (const member of (game.teamMembers || []).filter((item) => item.active)) {
    rows.push({ id: member.id, email: member.email, creator: creatorById(member.creatorId) || { id: member.creatorId, name: "未命名队友", role: "" }, meta: memberStatus(member), canEdit: ownerCanEdit || game.editableCreatorId === member.creatorId, canRemove: ownerCanEdit });
  }
  roster.innerHTML = rows.map((row) => `<article class="team-row">
    <div class="team-avatar">${avatarMarkup(row.creator)}</div>
    <div class="team-member-copy"><strong>${escapeHTML(row.creator.name || "未命名")}</strong><span>${escapeHTML(row.creator.role || (row.id === "owner" ? "负责人" : "职能未填写"))}</span><p class="team-member-contribution${row.creator.contribution ? "" : " is-empty"}">${escapeHTML(row.creator.contribution || "工作简述未填写")}</p></div>
    <code>${escapeHTML(row.email || "负责人邮箱待后台绑定")}<br>${escapeHTML(row.meta)}</code>
    <div class="team-row-actions">${row.canEdit ? `<button type="button" data-edit-member="${escapeHTML(row.id)}">修改资料</button>` : ""}${row.canRemove ? `<button class="danger-text" type="button" data-remove-member="${escapeHTML(row.id)}">移除权限</button>` : ""}</div>
  </article>`).join("");
  $$('[data-edit-member]', roster).forEach((button) => button.addEventListener("click", () => openProfile(button.dataset.editMember)));
  $$('[data-remove-member]', roster).forEach((button) => button.addEventListener("click", () => removeMember(button.dataset.removeMember)));
  $("#memberInviteForm").hidden = game.role !== "owner";
}

function renderSubmission() {
  const game = state.game;
  const requirements = [
    ["游戏名称", Boolean(game.title)], ["游戏简介", Boolean(game.description)], ["游戏封面", Boolean(game.coverUrl)],
    ["演示视频", Boolean(game.uploadedVideoUrl || game.videoExternalUrl)], ["作品文件", Boolean(game.downloadUrl)],
    ["队伍名称", Boolean(game.team)], ["制作人员", Boolean((game.creators || []).length)]
  ];
  $("#submissionChecks").innerHTML = requirements.map(([label, ready]) => `<div class="submission-check" data-ready="${ready}"><strong>${escapeHTML(label)}</strong><span>${ready ? "已完成" : "待补充"}</span></div>`).join("");
  const owner = game.role === "owner";
  $("#submitGame").hidden = !owner || game.status === "submitted";
  $("#withdrawGame").hidden = !owner || game.status !== "submitted";
  $("#submissionDescription").textContent = !owner
    ? "你可以编辑作品内容，以及自己的姓名、职能、头像与工作简述；提交与撤回由负责人完成。"
    : game.status === "submitted"
      ? "作品已经公开。撤回会让所有相关可能性核心自动归还，旧选票不会在重新提交后恢复。"
      : game.status === "withdrawn"
        ? "作品处于撤回状态。重新提交后会作为新的公开版本，旧选票不会恢复。"
        : "提交后作品立即进入公开星图。截止时间之后提交会显示补交标记。";
}

function renderWorkspace() {
  showOnly("participantWorkspace");
  renderHeader();
  fillGameForm();
  renderTeam();
  renderSubmission();
}

function updateDirtyState() {
  $("#saveState").textContent = state.dirty ? "存在未保存修改" : "所有修改已保存";
}

async function loadSession() {
  const result = await api("/api/session");
  state.session = result;
  if (!result.authenticated) {
    $("#accountLabel").textContent = "尚未登录";
    $("#logoutButton").hidden = true;
    showOnly("authPanel");
    return false;
  }
  $("#accountLabel").textContent = `${result.identity.name} / ${result.identity.team}`;
  $("#logoutButton").hidden = false;
  return true;
}

async function loadWorkspace() {
  showOnly("workspaceLoading");
  try {
    const result = await api("/api/participant/workspace");
    state.workspace = result;
    state.game = result.game;
    if (!result.game) showOnly("draftOrigin");
    else renderWorkspace();
  } catch (error) {
    if (error.status === 401) return loadSession();
    showOnly("draftOrigin");
    setMessage($("#createMessage"), error.message, true);
  }
}

async function sendCode() {
  const form = $("#authForm");
  const button = $("#sendCode");
  const body = { name: form.elements.name.value, team: form.elements.team.value, email: form.elements.email.value };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(body.email || "").trim())) {
    setMessage($("#authMessage"), "请先填写有效邮箱。", true);
    return;
  }
  button.disabled = true;
  setMessage($("#authMessage"), "正在发送验证码...");
  try {
    const result = await api("/api/verification/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setSubmissionInvitedIdentity(result.invitedIdentityDetected);
    setMessage($("#authMessage"), result.devCode ? `${result.message} 本地验证码：${result.devCode}` : result.message);
    $("#authMessage").dataset.identitySignal = String(Boolean(result.invitedIdentityDetected));
  } catch (error) {
    setMessage($("#authMessage"), error.message, true);
  } finally {
    button.disabled = false;
  }
}

function setSubmissionInvitedIdentity(active) {
  state.pendingInvitedIdentity = Boolean(active);
  const form = $("#authForm");
  form.dataset.invited = String(state.pendingInvitedIdentity);
  for (const input of [form.elements.name, form.elements.team]) {
    input.readOnly = state.pendingInvitedIdentity;
    if (state.pendingInvitedIdentity) {
      input.value = "";
      input.placeholder = "验证后同步";
    } else {
      input.removeAttribute("placeholder");
    }
  }
  $("#authMessage").dataset.identitySignal = String(state.pendingInvitedIdentity);
}

async function verifyLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("#verifyLogin");
  button.disabled = true;
  setMessage($("#authMessage"), "正在验证身份...");
  try {
    const result = await api("/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    state.session = result;
    setSubmissionInvitedIdentity(false);
    await loadSession();
    await loadWorkspace();
  } catch (error) {
    setMessage($("#authMessage"), error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function createDraft(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  setMessage($("#createMessage"), "正在建立作品坐标...");
  try {
    const result = await api("/api/participant/games", { method: "POST", body: new FormData(event.currentTarget) });
    state.game = result.game;
    toast(result.message);
    renderWorkspace();
  } catch (error) {
    setMessage($("#createMessage"), error.message, true);
  } finally {
    button.disabled = false;
  }
}

function confirmAction({ eyebrow = "操作确认", title, description, accept = "确认", danger = true }) {
  const dialog = $("#confirmDialog");
  $("#confirmEyebrow").textContent = eyebrow;
  $("#confirmTitle").textContent = title;
  $("#confirmDescription").textContent = description;
  $("#acceptConfirm").textContent = accept;
  $("#acceptConfirm").className = `signal-button ${danger ? "danger" : "primary"}`;
  dialog.showModal();
  return new Promise((resolve) => { state.confirmResolve = resolve; });
}

function closeConfirm(value) {
  $("#confirmDialog").close();
  state.confirmResolve?.(value);
  state.confirmResolve = null;
}

async function saveGameDetails(event, { quiet = false } = {}) {
  event?.preventDefault?.();
  const form = $("#gameForm");
  const button = $("#saveGame");
  const video = form.elements.video.files[0];
  if (video && video.size > 200 * 1024 * 1024) {
    setMessage($("#gameMessage"), "演示视频不能超过 200MB。", true);
    return false;
  }
  const gameFile = form.elements.gameFile.files[0];
  const maxGameFileBytes = Number(state.workspace?.settings?.maxGameFileBytes || 2 * 1024 ** 3);
  if (gameFile && gameFile.size > maxGameFileBytes) {
    setMessage($("#gameMessage"), `作品文件不能超过 ${formatBytes(maxGameFileBytes)}。`, true);
    return false;
  }
  if (gameFile && !/\.(zip|7z|rar)$/i.test(gameFile.name)) {
    setMessage($("#gameMessage"), "作品文件仅支持 ZIP、7Z 或 RAR 压缩包。", true);
    return false;
  }
  const data = new FormData(form);
  if (!form.elements.cover.files[0] && !form.elements.coverUrl.value && state.game.coverUrl) data.set("coverUrl", state.game.coverUrl);
  const downloadChanged = Boolean(gameFile);
  if (downloadChanged && state.game.afterSubmissionDeadline && state.game.firstSubmittedAt) {
    const accepted = await confirmAction({ eyebrow: "补交判定", title: "确认替换作品文件？", description: "提交截止时间已过。保存后作品会永久显示补交标记，即使再次上传旧版本也不会自动消除。", accept: "确认替换文件" });
    if (!accepted) return false;
    data.set("confirmLateDownload", "true");
  }
  button.disabled = true;
  const progress = $("#gameFileProgress");
  const progressLabel = $("#gameFileProgressLabel");
  if (gameFile) {
    progress.hidden = false;
    progressLabel.hidden = false;
    progress.value = 0;
    progressLabel.textContent = "正在准备上传...";
  }
  if (!quiet) setMessage($("#gameMessage"), gameFile ? "正在上传作品文件，请保持页面开启。" : "正在写入作品档案...");
  try {
    const result = await uploadApi(`/api/participant/games/${encodeURIComponent(state.game.id)}`, {
      method: "PUT",
      body: data,
      onProgress: (loaded, total) => {
        if (!gameFile) return;
        const percent = Math.min(99, Math.round((loaded / total) * 100));
        progress.value = percent;
        progressLabel.textContent = `已上传 ${percent}%（${formatBytes(loaded)} / ${formatBytes(total)}）`;
      }
    });
    if (gameFile) {
      progress.value = 100;
      progressLabel.textContent = "上传完成，作品档案已保存。";
    }
    state.game = result.game;
    renderHeader();
    fillGameForm();
    renderTeam();
    renderSubmission();
    if (!quiet) toast(state.game.status === "submitted" ? result.message : "已保存为草稿，作品尚未公开。" );
    return true;
  } catch (error) {
    if (error.game) state.game = error.game;
    setMessage($("#gameMessage"), error.message, true);
    if (gameFile) progressLabel.textContent = `上传失败：${error.message}`;
    return false;
  } finally {
    button.disabled = false;
  }
}

async function addMember(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  button.disabled = true;
  setMessage($("#memberMessage"), "正在写入队友权限...");
  try {
    const result = await api(`/api/participant/games/${encodeURIComponent(state.game.id)}/members`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    state.game = result.game;
    form.reset();
    renderHeader(); renderTeam(); renderSubmission();
    toast(result.message);
    setMessage($("#memberMessage"), "");
  } catch (error) {
    setMessage($("#memberMessage"), error.message, true);
  } finally { button.disabled = false; }
}

function openProfile(memberId) {
  const game = state.game;
  const member = memberId === "owner" ? null : (game.teamMembers || []).find((item) => item.id === memberId);
  const creator = memberId === "owner" ? creatorById(game.ownerCreatorId) || game.creators?.[0] : creatorById(member?.creatorId);
  state.profileTarget = memberId;
  const form = $("#profileForm");
  form.elements.memberId.value = memberId;
  form.elements.name.value = creator?.name || "";
  form.elements.role.value = creator?.role || "";
  form.elements.contribution.value = creator?.contribution || "";
  form.elements.profileAvatar.value = "";
  setMessage($("#profileMessage"), "");
  $("#profileDialog").showModal();
}

async function saveProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api(`/api/participant/games/${encodeURIComponent(state.game.id)}/members/${encodeURIComponent(state.profileTarget)}`, { method: "PUT", body: new FormData(form) });
    state.game = result.game;
    $("#profileDialog").close();
    renderHeader(); renderTeam(); renderSubmission();
    toast(result.message);
  } catch (error) {
    setMessage($("#profileMessage"), error.message, true);
  } finally { button.disabled = false; }
}

async function removeMember(memberId) {
  const creator = creatorById((state.game.teamMembers || []).find((member) => member.id === memberId)?.creatorId);
  const accepted = await confirmAction({ title: `移除 ${creator?.name || "这位队友"} 的编辑权限？`, description: "权限会立即失效。该邮箱仍永久禁止给本作品投票，成员变化会写入审计记录。", accept: "确认移除" });
  if (!accepted) return;
  try {
    const result = await api(`/api/participant/games/${encodeURIComponent(state.game.id)}/members/${encodeURIComponent(memberId)}`, { method: "DELETE" });
    state.game = result.game;
    renderHeader(); renderTeam(); renderSubmission();
    toast(result.message);
  } catch (error) { toast(error.message); }
}

async function submitGame() {
  if (state.dirty) {
    const saved = await saveGameDetails(null, { quiet: true });
    if (!saved) return;
  }
  if ((state.game.missingFields || []).length) {
    setMessage($("#submissionMessage"), `提交前请补充：${state.game.missingFields.join("、")}。`, true);
    return;
  }
  const accepted = await confirmAction({ eyebrow: "提交参展", title: "让作品进入共享宇宙？", description: state.game.afterSubmissionDeadline ? "当前已超过提交截止时间。作品会立即公开并显示补交标记。" : "提交后作品会立即公开，所有探索者都可以浏览并投票。", accept: "确认提交", danger: false });
  if (!accepted) return;
  try {
    const result = await api(`/api/participant/games/${encodeURIComponent(state.game.id)}/submit`, { method: "POST" });
    state.game = result.game;
    renderHeader(); fillGameForm(); renderTeam(); renderSubmission();
    toast(result.message);
  } catch (error) { setMessage($("#submissionMessage"), error.message, true); }
}

async function withdrawGame() {
  const accepted = await confirmAction({ eyebrow: "撤回作品", title: "确认离开共享宇宙？", description: "作品会立即从星图中隐藏，所有相关可能性核心自动归还并释放投票槽位。旧选票只保留在审计中，重新提交也不会恢复。", accept: "确认撤回" });
  if (!accepted) return;
  try {
    const result = await api(`/api/participant/games/${encodeURIComponent(state.game.id)}/withdraw`, { method: "POST" });
    state.game = result.game;
    renderHeader(); fillGameForm(); renderTeam(); renderSubmission();
    toast(result.message);
  } catch (error) { setMessage($("#submissionMessage"), error.message, true); }
}

async function logout() {
  await api("/api/session", { method: "DELETE" });
  state.session = null; state.workspace = null; state.game = null;
  await loadSession();
}

function bindEvents() {
  $("#sendCode").addEventListener("click", sendCode);
  $("#authForm").elements.email.addEventListener("input", () => {
    if (state.pendingInvitedIdentity) setSubmissionInvitedIdentity(false);
  });
  $("#authForm").addEventListener("submit", verifyLogin);
  $("#createDraftForm").addEventListener("submit", createDraft);
  $("#gameForm").addEventListener("submit", saveGameDetails);
  $("#gameForm").addEventListener("input", () => { state.dirty = true; updateDirtyState(); });
  $("#memberInviteForm").addEventListener("submit", addMember);
  $("#profileForm").addEventListener("submit", saveProfile);
  $("#submitGame").addEventListener("click", submitGame);
  $("#withdrawGame").addEventListener("click", withdrawGame);
  $("#logoutButton").addEventListener("click", logout);
  $("#cancelConfirm").addEventListener("click", () => closeConfirm(false));
  $("#acceptConfirm").addEventListener("click", () => closeConfirm(true));
  $$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.closeDialog}`).close()));
  window.addEventListener("beforeunload", (event) => { if (state.dirty) event.preventDefault(); });
}

async function init() {
  bindEvents();
  try {
    if (await loadSession()) await loadWorkspace();
  } catch (error) {
    showOnly("authPanel");
    setMessage($("#authMessage"), error.message, true);
  }
}

init();
