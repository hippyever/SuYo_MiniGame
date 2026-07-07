const profileKey = "suzao.minigame.profile";
const deviceKey = "suzao.minigame.deviceId";
const recentKey = "suzao.minigame.recent";

const nameInput = document.querySelector("#nameInput");
const teamInput = document.querySelector("#teamInput");
const deviceText = document.querySelector("#deviceText");
const checkinButton = document.querySelector("#checkinButton");
const buttonLabel = document.querySelector("#buttonLabel");
const buttonHint = document.querySelector("#buttonHint");
const statusCard = document.querySelector("#statusCard");
const clockText = document.querySelector("#clockText");
const recentList = document.querySelector("#recentList");
const clearLocalButton = document.querySelector("#clearLocalButton");

let deviceId = "";
let fingerprint = "";

function loadProfile() {
  try {
    const profile = JSON.parse(localStorage.getItem(profileKey) || "{}");
    nameInput.value = profile.name || "";
    teamInput.value = profile.team || "";
  } catch {
    nameInput.value = "";
    teamInput.value = "";
  }
}

function saveProfile() {
  const profile = {
    name: nameInput.value.trim(),
    team: teamInput.value.trim()
  };
  localStorage.setItem(profileKey, JSON.stringify(profile));
}

function generateDeviceId() {
  const existing = localStorage.getItem(deviceKey);
  if (existing) return existing;
  const webCrypto = window.crypto || window.msCrypto;
  const value = webCrypto?.randomUUID
    ? `sz-${webCrypto.randomUUID()}`
    : `sz-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(deviceKey, value);
  return value;
}

async function sha256(input) {
  const webCrypto = window.crypto || window.msCrypto;
  if (!webCrypto?.subtle) return "";
  const bytes = new TextEncoder().encode(input);
  const digest = await webCrypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildFingerprint() {
  const data = [
    navigator.userAgent,
    navigator.language,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen.width,
    screen.height,
    screen.colorDepth,
    navigator.hardwareConcurrency || "",
    navigator.deviceMemory || "",
    navigator.platform || ""
  ].join("|");
  return sha256(data);
}

function setStatus(type, title, message) {
  statusCard.className = `status-card ${type || ""}`.trim();
  statusCard.querySelector(".status-title").textContent = title;
  statusCard.querySelector(".status-text").textContent = message;
}

function setButton(isBusy, label = "立即打卡", hint = "记录位置与时间") {
  checkinButton.disabled = isBusy;
  buttonLabel.textContent = label;
  buttonHint.textContent = hint;
}

function updateClock() {
  const now = new Date();
  clockText.textContent = now.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("当前浏览器不支持定位。"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy
        });
      },
      (error) => {
        const messages = {
          1: "定位权限被拒绝，请允许浏览器访问位置信息。",
          2: "暂时无法获得定位，请稍后重试。",
          3: "定位超时，请到开阔位置后重试。"
        };
        reject(new Error(messages[error.code] || "定位失败，请重试。"));
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      }
    );
  });
}

function readRecent() {
  try {
    return JSON.parse(localStorage.getItem(recentKey) || "[]");
  } catch {
    return [];
  }
}

function writeRecent(items) {
  localStorage.setItem(recentKey, JSON.stringify(items.slice(0, 8)));
}

function addRecent(checkin) {
  const items = readRecent();
  items.unshift(checkin);
  writeRecent(items);
  renderRecent();
}

function renderRecent() {
  const items = readRecent();
  if (!items.length) {
    recentList.innerHTML = '<p class="empty">本机还没有打卡记录。</p>';
    return;
  }
  recentList.innerHTML = items
    .map((item) => {
      const accuracy = item.location?.accuracy ? `约 ${Math.round(item.location.accuracy)}m` : "已记录";
      return `
        <div class="recent-item">
          <div>
            <strong>${escapeHtml(item.localDate)} ${escapeHtml(item.localTime)}</strong>
            <span>${escapeHtml(item.team)} / ${escapeHtml(item.name)}</span>
          </div>
          <span>${escapeHtml(accuracy)}</span>
        </div>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function deviceMeta() {
  return {
    language: navigator.language,
    platform: navigator.platform,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: `${screen.width}x${screen.height}`,
    pixelRatio: window.devicePixelRatio || 1
  };
}

async function submitCheckin() {
  const name = nameInput.value.trim();
  const team = teamInput.value.trim();
  if (!name || !team) {
    setStatus("error", "信息不完整", "请先填写姓名和队伍。");
    return;
  }

  saveProfile();
  setButton(true, "正在定位", "等待浏览器授权");
  setStatus("", "正在定位", "请允许浏览器访问位置信息。");

  try {
    const location = await getLocation();
    setButton(true, "正在上传", `定位精度约 ${Math.round(location.accuracy)}m`);
    setStatus("", "正在上传", "位置已获取，正在写入后台日志。");

    const response = await fetch("/api/checkins", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name,
        team,
        deviceId,
        fingerprint,
        clientTime: new Date().toISOString(),
        location,
        deviceMeta: deviceMeta()
      })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.message || "打卡失败，请重试。");
    }
    addRecent(result.checkin);
    setStatus("success", "打卡成功", `${result.checkin.localDate} ${result.checkin.localTime} 已记录，设备尾号 ${result.checkin.deviceTail}。`);
  } catch (error) {
    setStatus("error", "打卡失败", error.message || "请稍后再试。");
  } finally {
    setButton(false);
  }
}

function init() {
  loadProfile();
  deviceId = generateDeviceId();
  deviceText.textContent = `设备尾号 ${deviceId.slice(-8)}`;
  buildFingerprint().then((value) => {
    fingerprint = value;
  });
  updateClock();
  setInterval(updateClock, 1000);
  renderRecent();

  nameInput.addEventListener("input", saveProfile);
  teamInput.addEventListener("input", saveProfile);
  checkinButton.addEventListener("click", submitCheckin);
  clearLocalButton.addEventListener("click", () => {
    localStorage.removeItem(profileKey);
    localStorage.removeItem(recentKey);
    loadProfile();
    renderRecent();
    setStatus("", "本机缓存已清空", "设备码仍保留，用于防作弊绑定。");
  });
}

init();
