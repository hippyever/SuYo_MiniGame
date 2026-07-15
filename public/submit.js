const state = {
  session: null,
  workspace: null,
  game: null,
  dirty: false,
  pendingInvitedIdentity: false,
  confirmResolve: null,
  profileTarget: null,
  replacementDocumentId: "",
  pendingReplacement: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function renderMarkdown(value) {
  return window.SuyoMarkdown?.render(value) || `<p>${escapeHTML(value)}</p>`;
}

function resetMarkdownPreviews(root = document) {
  $$('[data-markdown-preview]', root).forEach((preview) => { preview.hidden = true; preview.innerHTML = ""; });
  $$('[data-markdown-preview-toggle]', root).forEach((button) => { button.textContent = "预览格式"; button.setAttribute("aria-expanded", "false"); });
}

function toggleMarkdownPreview(button) {
  const field = button.closest(".markdown-field");
  const preview = $('[data-markdown-preview]', field);
  const textarea = $("textarea", field);
  if (!preview || !textarea) return;
  const willShow = preview.hidden;
  preview.hidden = !willShow;
  button.textContent = willShow ? "收起预览" : "预览格式";
  button.setAttribute("aria-expanded", String(willShow));
  if (willShow) preview.innerHTML = renderMarkdown(textarea.value || "暂无内容");
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

function resumableUploadKey(file, kind) {
  return `suyo-resumable-upload:${kind}:${encodeURIComponent(`${file.name}:${file.size}:${file.lastModified}:${file.type}`)}`;
}

function clearResumableUpload(file, kind) {
  if (file) localStorage.removeItem(resumableUploadKey(file, kind));
}

async function resumableUpload(file, { kind, onProgress, onState } = {}) {
  if (!file) throw new Error("没有选择需要上传的文件。" );
  const key = resumableUploadKey(file, kind);
  let resumeId = localStorage.getItem(key) || "";
  let initiated;
  try {
    initiated = await api("/api/participant/uploads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, originalName: file.name, size: file.size, mimeType: file.type || "application/octet-stream", resumeId })
    });
  } catch (error) {
    if (resumeId && error.status === 404) {
      localStorage.removeItem(key);
      resumeId = "";
      initiated = await api("/api/participant/uploads", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, originalName: file.name, size: file.size, mimeType: file.type || "application/octet-stream" })
      });
    } else throw error;
  }
  let upload = initiated.upload;
  localStorage.setItem(key, upload.id);
  onProgress?.(upload.uploadedBytes, upload.size);
  if (upload.uploadedBytes > 0) onState?.(`检测到已上传 ${Math.round(upload.uploadedBytes / upload.size * 100)}%，正在续传...`);
  while (upload.uploadedBytes < upload.size) {
    const offset = upload.uploadedBytes;
    const blob = file.slice(offset, Math.min(file.size, offset + upload.chunkBytes));
    let response;
    try {
      response = await fetch(`/api/participant/uploads/${encodeURIComponent(upload.id)}/chunk`, {
        method: "PUT",
        headers: {
          accept: "application/json",
          "content-type": "application/octet-stream",
          "x-upload-offset": String(offset)
        },
        body: blob
      });
    } catch {
      const error = new Error(`网络中断，已保留 ${Math.round(offset / file.size * 100)}% 的进度。点击保存并保留当前文件，即可继续上传。`);
      error.resumePercent = Math.round(offset / file.size * 100);
      throw error;
    }
    const result = await response.json().catch(() => ({ ok: false, message: "服务器返回了无法识别的上传响应。" }));
    if (!response.ok || result.ok === false) {
      if (result.upload && Number.isFinite(result.upload.uploadedBytes) && result.upload.uploadedBytes !== offset) {
        upload = result.upload;
        onProgress?.(upload.uploadedBytes, upload.size);
        continue;
      }
      const error = new Error(result.message || "上传分片失败。请点击保存重试。");
      error.status = response.status;
      throw error;
    }
    upload = result.upload;
    onProgress?.(upload.uploadedBytes, upload.size);
  }
  const completed = await api(`/api/participant/uploads/${encodeURIComponent(upload.id)}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  onProgress?.(completed.upload.uploadedBytes, completed.upload.size);
  return completed.upload;
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
  form.elements.video.value = "";
  $("#coverCurrent").textContent = game.coverUrl ? `当前封面：${String(game.coverUrl).startsWith("/uploads/") ? "已上传文件" : "外部地址"}` : "尚未上传";
  $("#videoCurrent").textContent = game.uploadedVideoUrl ? "当前优先使用已上传视频" : game.videoExternalUrl ? "当前使用公开视频链接" : "单个文件不超过 200MB";
  $("#gameFileCurrent").textContent = game.gameFileMeta
    ? `当前文件：${game.gameFileMeta.originalName || "已上传作品包"}，${formatBytes(game.gameFileMeta.size)}`
    : game.downloadUrl
      ? "当前作品仍使用旧版外部地址。选择压缩包并保存后将替换为上传文件。"
      : "支持 ZIP、7Z、RAR，单个文件不超过 2GB。";
  $("#updatedAtLabel").textContent = `最后保存：${formatDate(game.updatedAt)}`;
  resetMarkdownPreviews(form);
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
    <div class="team-member-copy"><strong>${escapeHTML(row.creator.name || "未命名")}</strong><span>${escapeHTML(row.creator.role || (row.id === "owner" ? "负责人" : "职能未填写"))}</span><div class="team-member-contribution markdown-content markdown-compact${row.creator.contribution ? "" : " is-empty"}">${renderMarkdown(row.creator.contribution || "工作简述未填写")}</div></div>
    <code>${escapeHTML(row.email || "负责人邮箱待后台绑定")}<br>${escapeHTML(row.meta)}</code>
    <div class="team-row-actions">${row.canEdit ? `<button type="button" data-edit-member="${escapeHTML(row.id)}">修改资料</button>` : ""}${row.canRemove ? `<button class="danger-text" type="button" data-remove-member="${escapeHTML(row.id)}">移除权限</button>` : ""}</div>
  </article>`).join("");
  $$('[data-edit-member]', roster).forEach((button) => button.addEventListener("click", () => openProfile(button.dataset.editMember)));
  $$('[data-remove-member]', roster).forEach((button) => button.addEventListener("click", () => removeMember(button.dataset.removeMember)));
  $("#memberInviteForm").hidden = game.role !== "owner";
}

function validateDevelopmentDocuments(files) {
  const allowed = /\.(doc|docx|xls|xlsx|ppt|pptx|pdf|txt|md|zip|7z|rar)$/i;
  const maxBytes = Number(state.workspace?.settings?.maxDevelopmentDocumentBytes || 200 * 1024 ** 2);
  for (const file of files) {
    if (!allowed.test(file.name)) return `“${file.name}”的格式不受支持。`;
    if (file.size > maxBytes) return `“${file.name}”超过 ${formatBytes(maxBytes)}。`;
  }
  return "";
}

function renderDevelopmentDocuments() {
  const list = $("#developmentDocumentList");
  const documents = state.game?.developmentDocuments || [];
  if (!documents.length) {
    list.innerHTML = `<div class="document-empty"><strong>资料舱尚未写入文件</strong><span>策划案、排期、源文件说明与复盘材料都可以留在这里。</span></div>`;
    return;
  }
  list.innerHTML = documents.map((document, index) => `<article class="development-document-row">
    <span class="document-index">${String(index + 1).padStart(2, "0")}</span>
    <div><strong>${escapeHTML(document.originalName)}</strong><span>${formatBytes(document.size)} · ${escapeHTML(formatDate(document.updatedAt || document.uploadedAt))}</span><code>SHA-256 ${escapeHTML(String(document.sha256 || "").slice(0, 16))}…</code></div>
    <div class="document-actions"><a href="/api/participant/games/${encodeURIComponent(state.game.id)}/development-documents/${encodeURIComponent(document.id)}/download">下载</a><button type="button" data-replace-document="${escapeHTML(document.id)}">${state.pendingReplacement?.documentId === document.id ? "继续上传" : "替换"}</button><button class="danger-text" type="button" data-remove-document="${escapeHTML(document.id)}">移除</button></div>
  </article>`).join("");
  $$('[data-replace-document]', list).forEach((button) => button.addEventListener("click", () => {
    if (state.pendingReplacement?.documentId === button.dataset.replaceDocument) {
      replaceDevelopmentDocumentFile(state.pendingReplacement.file, state.pendingReplacement.documentId, { skipConfirmation: true });
      return;
    }
    state.replacementDocumentId = button.dataset.replaceDocument;
    const picker = $("#replacementDocumentFile");
    picker.value = "";
    picker.click();
  }));
  $$('[data-remove-document]', list).forEach((button) => button.addEventListener("click", () => removeDevelopmentDocument(button.dataset.removeDocument)));
}

async function uploadDevelopmentDocuments() {
  const picker = $("#developmentDocumentFiles");
  const files = [...picker.files];
  if (!files.length) return setMessage($("#developmentDocumentMessage"), "请先选择需要上传的文件。", true);
  const validation = validateDevelopmentDocuments(files);
  if (validation) return setMessage($("#developmentDocumentMessage"), validation, true);
  const button = $("#uploadDevelopmentDocuments");
  const progress = $("#developmentDocumentProgress");
  button.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  setMessage($("#developmentDocumentMessage"), `正在上传 ${files.length} 份内部文件。传输中断后可点击此按钮续传。`);
  try {
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let completedBytes = 0;
    const uploadIds = [];
    for (const file of files) {
      const upload = await resumableUpload(file, {
        kind: "developmentDocument",
        onState: (text) => setMessage($("#developmentDocumentMessage"), text),
        onProgress: (loaded) => { progress.value = Math.min(99, Math.round(((completedBytes + loaded) / totalBytes) * 100)); }
      });
      completedBytes += file.size;
      uploadIds.push(upload.id);
    }
    const result = await api(`/api/participant/games/${encodeURIComponent(state.game.id)}/development-documents/attach`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uploadIds })
    });
    progress.value = 100;
    files.forEach((file) => clearResumableUpload(file, "developmentDocument"));
    picker.value = "";
    state.game = result.game;
    renderHeader(); renderDevelopmentDocuments();
    setMessage($("#developmentDocumentMessage"), result.message);
    toast(result.message);
  } catch (error) {
    setMessage($("#developmentDocumentMessage"), error.message, true);
  } finally { button.disabled = false; }
}

async function replaceDevelopmentDocumentFile(file, documentId, { skipConfirmation = false } = {}) {
  if (!file || !documentId) return;
  const validation = validateDevelopmentDocuments([file]);
  if (validation) return setMessage($("#developmentDocumentMessage"), validation, true);
  const current = (state.game.developmentDocuments || []).find((document) => document.id === documentId);
  if (!skipConfirmation) {
    const accepted = await confirmAction({ eyebrow: "内部资料替换", title: `替换“${current?.originalName || "这份文档"}”？`, description: "新文件保存后，旧文件实体会立即清除；旧文件名、大小、哈希值和操作人仍保留在审计记录中。", accept: "确认替换" });
    if (!accepted) return;
  }
  const progress = $("#developmentDocumentProgress");
  progress.hidden = false; progress.value = 0;
  setMessage($("#developmentDocumentMessage"), "正在替换内部文件（支持断点续传）...");
  try {
    const upload = await resumableUpload(file, {
      kind: "developmentDocument",
      onState: (text) => setMessage($("#developmentDocumentMessage"), text),
      onProgress: (loaded, total) => { progress.value = Math.min(99, Math.round((loaded / total) * 100)); }
    });
    const result = await api(`/api/participant/games/${encodeURIComponent(state.game.id)}/development-documents/${encodeURIComponent(documentId)}/attach`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uploadId: upload.id })
    });
    progress.value = 100;
    clearResumableUpload(file, "developmentDocument");
    state.pendingReplacement = null;
    state.replacementDocumentId = "";
    state.game = result.game;
    renderHeader(); renderDevelopmentDocuments();
    setMessage($("#developmentDocumentMessage"), result.message);
    toast(result.message);
  } catch (error) {
    state.pendingReplacement = { file, documentId };
    renderDevelopmentDocuments();
    setMessage($("#developmentDocumentMessage"), `${error.message} 可点击“继续上传”续传。`, true);
  }
}

async function replaceDevelopmentDocument(event) {
  const picker = event.currentTarget;
  const file = picker.files[0];
  const documentId = state.replacementDocumentId;
  picker.value = "";
  await replaceDevelopmentDocumentFile(file, documentId);
}

async function removeDevelopmentDocument(documentId) {
  const document = (state.game.developmentDocuments || []).find((item) => item.id === documentId);
  const accepted = await confirmAction({ eyebrow: "内部资料移除", title: `移除“${document?.originalName || "这份文档"}”？`, description: "文件实体会被清除，文件元数据和操作记录仍会永久保留在审计中。", accept: "确认移除" });
  if (!accepted) return;
  try {
    const result = await api(`/api/participant/games/${encodeURIComponent(state.game.id)}/development-documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
    state.game = result.game;
    renderHeader(); renderDevelopmentDocuments();
    setMessage($("#developmentDocumentMessage"), result.message);
    toast(result.message);
  } catch (error) { setMessage($("#developmentDocumentMessage"), error.message, true); }
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
  $("#abandonDraftGame").hidden = !owner || game.status !== "draft" || Boolean(game.firstSubmittedAt || game.submittedAt);
  $("#submissionDescription").textContent = !owner
    ? "你可以编辑作品内容，以及自己的姓名、职能、头像与工作简述；提交与撤回由负责人完成。"
    : game.status === "submitted"
      ? "作品已经公开。撤回会让所有相关可能性核心自动归还，旧选票不会在重新提交后恢复。"
      : game.status === "withdrawn"
        ? "作品处于撤回状态。重新提交后会作为新的公开版本，旧选票不会恢复。"
      : "提交后作品立即进入公开星图。截止时间之后提交会显示补交标记。未提交的草稿可选择放弃，并立即解除全队邮箱归属。";
}

function renderWorkspace() {
  showOnly("participantWorkspace");
  renderHeader();
  fillGameForm();
  renderTeam();
  renderDevelopmentDocuments();
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
  if (gameFile || video) {
    progress.hidden = false;
    progressLabel.hidden = false;
    progress.value = 0;
    progressLabel.textContent = "正在准备可恢复上传...";
  }
  if (!quiet) setMessage($("#gameMessage"), gameFile || video ? "正在准备可恢复上传。传输中断后可点击保存继续。" : "正在写入作品档案...");
  try {
    if (video) {
      progressLabel.textContent = "正在上传演示视频（支持断点续传）...";
      const upload = await resumableUpload(video, {
        kind: "video",
        onState: (text) => { progressLabel.textContent = text; },
        onProgress: (loaded, total) => {
          const percent = Math.min(99, Math.round((loaded / total) * 100));
          progress.value = percent;
          progressLabel.textContent = `演示视频 ${percent}%（${formatBytes(loaded)} / ${formatBytes(total)}）`;
        }
      });
      data.delete("video");
      data.set("resumableVideoId", upload.id);
    }
    if (gameFile) {
      progress.value = 0;
      progressLabel.textContent = "正在上传作品文件（支持断点续传）...";
      const upload = await resumableUpload(gameFile, {
        kind: "game",
        onState: (text) => { progressLabel.textContent = text; },
        onProgress: (loaded, total) => {
          const percent = Math.min(99, Math.round((loaded / total) * 100));
          progress.value = percent;
          progressLabel.textContent = `作品文件 ${percent}%（${formatBytes(loaded)} / ${formatBytes(total)}）`;
        }
      });
      data.delete("gameFile");
      data.set("resumableGameFileId", upload.id);
    }
    if (gameFile || video) progressLabel.textContent = "文件已完整传输，正在写入作品档案...";
    const result = await uploadApi(`/api/participant/games/${encodeURIComponent(state.game.id)}`, {
      method: "PUT",
      body: data
    });
    if (gameFile || video) {
      progress.value = 100;
      progressLabel.textContent = "上传完成，作品档案已保存。";
    }
    state.game = result.game;
    clearResumableUpload(video, "video");
    clearResumableUpload(gameFile, "game");
    renderHeader();
    fillGameForm();
    renderTeam();
    renderSubmission();
    if (!quiet) toast(state.game.status === "submitted" ? result.message : "已保存为草稿，作品尚未公开。" );
    return true;
  } catch (error) {
    if (error.game) state.game = error.game;
    setMessage($("#gameMessage"), error.message, true);
    if (gameFile || video) progressLabel.textContent = `上传暂停：${error.message}`;
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
  resetMarkdownPreviews(form);
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

async function abandonDraftGame() {
  const accepted = await confirmAction({
    eyebrow: "放弃草稿",
    title: "确认作废这份未提交草稿？",
    description: "此操作不能恢复。草稿与审计记录会由管理员保留，但你和所有活跃队员会立即解除作品归属，可以创建或加入其他作品。未保存的本地修改不会写入草稿。",
    accept: "作废并释放归属"
  });
  if (!accepted) return;
  try {
    const result = await api(`/api/participant/games/${encodeURIComponent(state.game.id)}/abandon`, { method: "POST" });
    state.game = null;
    state.dirty = false;
    await loadWorkspace();
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
  $("#uploadDevelopmentDocuments").addEventListener("click", uploadDevelopmentDocuments);
  $("#replacementDocumentFile").addEventListener("change", replaceDevelopmentDocument);
  $("#profileForm").addEventListener("submit", saveProfile);
  $$('[data-markdown-preview-toggle]').forEach((button) => button.addEventListener("click", () => toggleMarkdownPreview(button)));
  $("#submitGame").addEventListener("click", submitGame);
  $("#withdrawGame").addEventListener("click", withdrawGame);
  $("#abandonDraftGame").addEventListener("click", abandonDraftGame);
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
