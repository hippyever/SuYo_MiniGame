const PROFILE_KEY = "suyo.minigame.profile.v3";
const LOCAL_PREFIX = "suyo.minigame.exploration.v4";

const SPACE = Object.freeze({
  near: 12,
  workRadiusMin: 880,
  workRadiusMax: 1260,
  observationDistance: 205,
  sourceDistance: 270,
  identityDistance: 390,
  mediaDistance: 540,
  spectrumDistance: 720,
  overviewDistance: 3600,
  overviewTrigger: 960,
  guidanceDistance: 1580,
  fieldOfView: 68 * Math.PI / 180
});

const PERSONAL_ORBIT = Object.freeze({
  radiusX: 0.38,
  radiusY: 0.38,
  entryAngle: 0,
  duration: 36000,
  arrivalBoost: 0.22,
  arrivalDecay: 12000
});

const state = {
  site: null,
  games: [],
  gameById: new Map(),
  session: { authenticated: false, identity: null },
  ballot: { gameIds: [], version: 0, updatedAt: null },
  visited: new Set(),
  resolved: new Set(),
  routeIds: [],
  routeIndex: 0,
  routeActive: false,
  routePaused: false,
  routeNavigating: false,
  routeArrived: false,
  routeTimer: null,
  targetId: "",
  selectedTargetId: "",
  targetProximity: { level: "remote", signal: 0 },
  detectorSnapshots: new Map(),
  detectorLabels: new Map(),
  offscreenSummary: "",
  detailId: "",
  detailReturnCamera: null,
  detailOriginFocus: null,
  detailReturnId: "",
  detailReturnOriginFocus: null,
  landing: false,
  landingTimer: null,
  navigationHintTimer: null,
  creatorOrbitFrame: null,
  creatorOrbitStartedAt: 0,
  pendingVoteId: "",
  pendingBallotOpen: false,
  pendingReplacementId: "",
  pendingBallotRetry: null,
  lastBallotChange: null,
  ritualGameId: "",
  ritualPhase: "idle",
  ritualHoldStartedAt: 0,
  ritualHoldFrame: null,
  ritualHintTimer: null,
  ritualOrbitFrame: null,
  ritualOperationId: "",
  ritualSelectedCoreId: "",
  ritualHapticStep: 0,
  ritualMuted: false,
  ritualAudioContext: null,
  ritualOscillator: null,
  ritualGain: null,
  ritualSuccessTimer: null,
  ritualReturnContext: null,
  ritualFlightAnimation: null,
  ritualArrival: null,
  ritualResizeFrame: null,
  deepLinkId: new URLSearchParams(location.search).get("game") || "",
  launched: false,
  lowMode: false,
  lowModeManual: false,
  performanceTier: "standard",
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  palette: null,
  canvas: null,
  ctx: null,
  width: 0,
  height: 0,
  dpr: 1,
  camera: { x: 0, y: 0, z: 0, yaw: 0.08, pitch: -0.04, mode: "free" },
  cameraDestination: { x: 0, y: 0, z: 0, yaw: 0.08, pitch: -0.04, mode: "free" },
  cameraVelocity: { x: 0, y: 0, z: 0 },
  overviewIntent: 0,
  navigationActive: false,
  navigationTargetId: "",
  userControllingUntil: 0,
  dollyInputs: new Map(),
  lastFrameAt: 0,
  pointers: new Map(),
  dragDistance: 0,
  pinch: null,
  images: new Map(),
  planetPalettes: new Map(),
  stars: [],
  dust: [],
  frame: 0,
  countdownTimer: null,
  resultRevealStart: 0,
  resultRevealProgress: 0,
  resultEntered: false,
  resultReturnTarget: ""
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

function lerpAngle(from, to, amount) {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * amount;
}

function vectorLength(vector) {
  return Math.hypot(vector.x || 0, vector.y || 0, vector.z || 0);
}

function normalizeVector(vector) {
  const length = Math.max(0.00001, vectorLength(vector));
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function cameraBasis(camera = state.camera) {
  const cosinePitch = Math.cos(camera.pitch);
  const forward = normalizeVector({
    x: Math.sin(camera.yaw) * cosinePitch,
    y: Math.sin(camera.pitch),
    z: Math.cos(camera.yaw) * cosinePitch
  });
  const right = normalizeVector(cross({ x: 0, y: 1, z: 0 }, forward));
  const up = normalizeVector(cross(forward, right));
  return { forward, right, up };
}

function directionAngles(direction) {
  const normalized = normalizeVector(direction);
  return {
    yaw: Math.atan2(normalized.x, normalized.z),
    pitch: Math.asin(clamp(normalized.y, -1, 1))
  };
}

function distance3D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function addScaled(origin, direction, amount) {
  return {
    x: origin.x + direction.x * amount,
    y: origin.y + direction.y * amount,
    z: origin.z + direction.z * amount
  };
}

function wrappedOffset(value, span) {
  return ((value + span / 2) % span + span) % span - span / 2;
}

function normalizeName(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
}

function hashNumber(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let value = hashNumber(seed) || 1;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || "请求失败，请稍后再试。");
    error.code = body.error;
    error.status = response.status;
    error.retryAfter = body.retryAfter;
    error.body = body;
    throw error;
  }
  return body;
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间待定";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date).replace("/", ".");
}

function votingCopy() {
  const status = state.site?.votingState;
  if (status === "open") return { label: "投票进行中", timeLabel: "投票截止", disabled: false };
  if (status === "upcoming") return { label: "投票尚未开始", timeLabel: "投票开始", disabled: true };
  if (status === "published") return { label: "玩家之声已发布", timeLabel: "结果发布", disabled: true };
  return { label: "投票已结束，结果复核中", timeLabel: "投票结束", disabled: true };
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add("visible"));
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => { toast.hidden = true; }, 190);
  }, 2800);
}

function setMessage(element, message, error = false) {
  element.textContent = message;
  element.className = `form-message${error ? " error" : message ? " success" : ""}`;
}

function openDialog(dialog) {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog) {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function localKey() {
  const settings = state.site?.settings;
  return `${LOCAL_PREFIX}:${settings?.eventTitle || "event"}:${settings?.startAt || "time"}`;
}

function readLocalState() {
  try {
    return JSON.parse(localStorage.getItem(localKey())) || {};
  } catch {
    return {};
  }
}

function writeLocalState() {
  if (!state.site) return;
  try {
    localStorage.setItem(localKey(), JSON.stringify({
      visitedGameIds: [...state.visited],
      resolvedGameIds: [...state.resolved],
      routeGameIds: state.routeIds,
      routeIndex: state.routeIndex,
      camera: state.camera,
      performanceMode: state.lowModeManual ? state.performanceTier : "auto"
    }));
  } catch {}
}

function readProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveProfile(identity) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(identity));
  } catch {}
}

function automaticPerformanceTier() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (state.reducedMotion || Boolean(connection?.saveData)) return "low";
  if (Number(navigator.deviceMemory || 8) <= 4 || Number(navigator.hardwareConcurrency || 8) <= 4) return "low";
  if (Number(navigator.deviceMemory || 8) <= 8 || Number(navigator.hardwareConcurrency || 8) <= 8) return "standard";
  return "full";
}

function applyPerformanceMode() {
  state.lowMode = state.performanceTier === "low";
  document.body.classList.toggle("low-performance", state.performanceTier === "low");
  document.body.classList.toggle("standard-performance", state.performanceTier === "standard");
  $("#performanceButton").dataset.mode = state.performanceTier;
  $("#performanceButton").setAttribute("aria-label", `当前${performanceLabel(state.performanceTier)}，点击切换表现等级`);
  $("#performanceButton").textContent = `画质：${performanceLabel(state.performanceTier)}`;
  resizeCanvas();
}

function performanceLabel(tier) {
  return ({ full: "完整", standard: "标准", low: "简化" })[tier] || "标准";
}

function initializeLocalState() {
  const saved = readLocalState();
  const validIds = new Set(state.games.map((game) => game.id));
  state.visited = new Set((saved.visitedGameIds || []).filter((id) => validIds.has(id)));
  state.resolved = new Set((saved.resolvedGameIds || saved.visitedGameIds || []).filter((id) => validIds.has(id)));

  const previousRoute = (saved.routeGameIds || []).filter((id) => validIds.has(id));
  const routeSet = new Set(previousRoute);
  const missing = state.games.map((game) => game.id).filter((id) => !routeSet.has(id));
  shuffle(missing);
  state.routeIds = [...previousRoute];
  missing.forEach((id) => {
    const minimum = Math.min(Number(saved.routeIndex || 0), state.routeIds.length);
    const insertion = minimum + Math.floor(Math.random() * (state.routeIds.length - minimum + 1));
    state.routeIds.splice(insertion, 0, id);
  });
  state.routeIndex = clamp(Number(saved.routeIndex || 0), 0, state.routeIds.length);

  if (saved.camera && [saved.camera.x, saved.camera.y, saved.camera.z, saved.camera.yaw, saved.camera.pitch].every(Number.isFinite)) {
    state.camera = {
      x: Number(saved.camera.x),
      y: Number(saved.camera.y),
      z: Number(saved.camera.z),
      yaw: Number(saved.camera.yaw),
      pitch: clamp(Number(saved.camera.pitch), -1.38, 1.38),
      mode: saved.camera.mode === "overview" ? "overview" : "free"
    };
    state.cameraDestination = { ...state.camera };
  } else {
    resetToCore(false);
  }

  const explicitTier = ["full", "standard", "low"].includes(saved.performanceMode) ? saved.performanceMode : "";
  state.lowModeManual = Boolean(explicitTier);
  state.performanceTier = state.ctx ? explicitTier || automaticPerformanceTier() : "low";
  createStars();
  applyPerformanceMode();
  updateExplorationUI();
}

function shuffle(items) {
  const values = items;
  if (globalThis.crypto?.getRandomValues) {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const random = new Uint32Array(1);
      globalThis.crypto.getRandomValues(random);
      const selected = random[0] % (index + 1);
      [values[index], values[selected]] = [values[selected], values[index]];
    }
  } else {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const selected = Math.floor(Math.random() * (index + 1));
      [values[index], values[selected]] = [values[selected], values[index]];
    }
  }
  return values;
}

function loadPalette() {
  const styles = getComputedStyle(document.documentElement);
  state.palette = {
    space: styles.getPropertyValue("--space").trim(),
    spaceSoft: styles.getPropertyValue("--space-soft").trim(),
    ink: styles.getPropertyValue("--ink").trim(),
    muted: styles.getPropertyValue("--muted").trim(),
    line: styles.getPropertyValue("--line").trim(),
    signal: styles.getPropertyValue("--signal").trim()
  };
}

function setupCanvas() {
  state.canvas = $("#spaceCanvas");
  state.ctx = state.canvas.getContext("2d", { alpha: false });
  if (!state.ctx) {
    state.performanceTier = "low";
    state.lowMode = true;
    document.body.classList.add("canvas-fallback", "low-performance");
    state.canvas.hidden = true;
    return;
  }
  loadPalette();
  new ResizeObserver(resizeCanvas).observe($("#observerShell"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => loadPalette());
  bindCanvasControls();
  createStars();
  requestAnimationFrame(renderFrame);
}

function resizeCanvas() {
  if (!state.canvas || !state.ctx) return;
  const rect = state.canvas.getBoundingClientRect();
  state.width = Math.max(1, rect.width);
  state.height = Math.max(1, rect.height);
  const dprCap = state.performanceTier === "full" ? 2 : state.performanceTier === "standard" ? 1.5 : 1;
  state.dpr = Math.min(devicePixelRatio || 1, dprCap);
  state.canvas.width = Math.round(state.width * state.dpr);
  state.canvas.height = Math.round(state.height * state.dpr);
  if (state.cameraDestination.mode === "overview") {
    state.cameraDestination.z = -overviewDistanceForViewport();
    if (state.reducedMotion) state.camera.z = state.cameraDestination.z;
  }
}

function createStars() {
  const seed = `${state.site?.settings?.eventSeed || "suyo"}:deep-space`;
  const random = seededRandom(seed);
  const count = state.performanceTier === "full" ? 620 : state.performanceTier === "standard" ? 380 : 190;
  state.stars = Array.from({ length: count }, (_, index) => ({
    direction: (() => {
      const y = random() * 2 - 1;
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      const angle = random() * Math.PI * 2;
      return { x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius };
    })(),
    size: index % 29 === 0 ? 1.8 : 0.42 + random() * 0.9,
    alpha: 0.24 + random() * 0.58,
    phase: random() * Math.PI * 2
  }));

  const dustCount = state.performanceTier === "full" ? 320 : state.performanceTier === "standard" ? 190 : 80;
  state.dust = Array.from({ length: dustCount }, (_, index) => {
    const layer = index % 3;
    const span = 920 + layer * 720;
    return {
      x: (random() - 0.5) * span,
      y: (random() - 0.5) * span,
      z: (random() - 0.5) * span,
      span,
      layer,
      size: 0.55 + random() * (layer === 0 ? 1.2 : 0.7),
      alpha: 0.12 + random() * 0.34
    };
  });
}

function worldPoint(game) {
  const coordinate = game.coordinate || {};
  const x = clamp(Number(coordinate.x || 0), -1, 1);
  const y = clamp(Number(coordinate.y || 0), -1, 1);
  const rawZ = Number.isFinite(Number(coordinate.z)) ? Number(coordinate.z) : Number(coordinate.depth ?? 0.5) * 2 - 1;
  const normalizedZ = clamp((rawZ + 1) / 2, 0, 1);
  const seed = hashNumber(`${state.site?.settings?.eventSeed || "event"}:${game.id}:volume`);
  const azimuth = x * Math.PI * 0.96 + ((seed % 101) - 50) * 0.0018;
  const elevation = y * 0.92 + (((seed >>> 7) % 71) - 35) * 0.0015;
  const radius = SPACE.workRadiusMin + normalizedZ * (SPACE.workRadiusMax - SPACE.workRadiusMin);
  const horizontal = Math.cos(elevation);
  return {
    x: Math.sin(azimuth) * horizontal * radius,
    y: Math.sin(elevation) * radius,
    z: Math.cos(azimuth) * horizontal * radius
  };
}

function worldToScreen(point, camera = state.camera) {
  const basis = cameraBasis(camera);
  const delta = { x: point.x - camera.x, y: point.y - camera.y, z: point.z - camera.z };
  const localX = dot(delta, basis.right);
  const localY = dot(delta, basis.up);
  const depth = dot(delta, basis.forward);
  const focal = Math.max(260, state.height * 0.5 / Math.tan(SPACE.fieldOfView / 2));
  const safeDepth = Math.max(SPACE.near, depth);
  return {
    x: state.width / 2 + localX * focal / safeDepth,
    y: state.height / 2 - localY * focal / safeDepth,
    depth,
    distance: vectorLength(delta),
    localX,
    localY,
    focal,
    visible: depth > SPACE.near
  };
}

function resetToCore(animate = true) {
  const seed = hashNumber(`${state.site?.settings?.eventSeed || "event"}:initial-camera`);
  const yaw = (seed / 4294967296) * Math.PI * 2 - Math.PI;
  const next = { x: 0, y: 0, z: 0, yaw, pitch: -0.035, mode: "free" };
  state.cameraDestination = next;
  if (!animate || state.reducedMotion) state.camera = { ...next };
  state.overviewIntent = 0;
  state.navigationActive = false;
  state.navigationTargetId = "";
  clearSelectedTarget();
}

function overviewDistanceForViewport() {
  const aspect = Math.max(0.42, state.width / Math.max(1, state.height));
  const verticalHalf = SPACE.fieldOfView / 2;
  const horizontalHalf = Math.atan(Math.tan(verticalHalf) * aspect);
  const limitingHalf = Math.max(0.2, Math.min(verticalHalf, horizontalHalf));
  return Math.max(SPACE.overviewDistance, SPACE.workRadiusMax / Math.sin(limitingHalf) * 1.12);
}

function resetView(animate = true) {
  const next = { x: 0, y: 0, z: -overviewDistanceForViewport(), yaw: 0, pitch: 0, mode: "overview" };
  state.cameraDestination = next;
  if (!animate || state.reducedMotion) state.camera = { ...next };
  state.overviewIntent = 1;
  state.navigationActive = false;
  state.navigationTargetId = "";
  clearSelectedTarget();
  updateMapMode();
}

function clampCamera({ includeCurrent = true } = {}) {
  const normalizeCamera = (camera) => {
    camera.pitch = clamp(camera.pitch, -1.38, 1.38);
    if (!Number.isFinite(camera.yaw)) camera.yaw = 0;
    ["x", "y", "z"].forEach((axis) => {
      if (!Number.isFinite(camera[axis])) camera[axis] = 0;
    });
  };
  if (includeCurrent) normalizeCamera(state.camera);
  normalizeCamera(state.cameraDestination);
}

function claimCameraControl() {
  state.userControllingUntil = performance.now() + 700;
  state.navigationActive = false;
  state.navigationTargetId = "";
  if (state.routeActive && state.routeNavigating) {
    state.routeNavigating = false;
    state.routePaused = true;
    $("#routePause").textContent = "继续";
    $("#routeProgress").textContent = "已由你接管航向";
    updateExplorationUI();
  }
}

function nearestCaptureTarget(direction = cameraBasis().forward) {
  let result = null;
  for (const game of state.games) {
    const point = worldPoint(game);
    const delta = { x: point.x - state.camera.x, y: point.y - state.camera.y, z: point.z - state.camera.z };
    const distance = vectorLength(delta);
    const alignment = dot(normalizeVector(delta), direction);
    if (alignment < 0.935) continue;
    const score = distance * (1 + (1 - alignment) * 5);
    if (!result || score < result.score) result = { game, point, distance, alignment, score };
  }
  return result;
}

function dollyCamera(amount, { user = true, persist = true } = {}) {
  dismissNavigationHint();
  if (user) claimCameraControl();
  if (state.camera.mode === "overview" || state.cameraDestination.mode === "overview") {
    if (amount <= 0) return;
    state.camera.mode = "free";
    state.cameraDestination.mode = "free";
    state.overviewIntent = 0;
    updateMapMode();
  }
  let base = state.cameraDestination;
  const selectedGame = state.gameById.get(state.selectedTargetId);
  const selectedPoint = selectedGame ? worldPoint(selectedGame) : null;
  const basis = cameraBasis(base);
  if (amount < 0) {
    state.overviewIntent = clamp(state.overviewIntent + Math.abs(amount) / SPACE.overviewTrigger, 0, 1);
    if (state.overviewIntent >= 1) {
      resetView(true);
      writeLocalState();
      return;
    }
  } else {
    state.overviewIntent = Math.max(0, state.overviewIntent - amount / 420);
  }

  let travel = clamp(amount, -280, 280);
  let travelDirection = basis.forward;
  if (selectedPoint && travel > 0) {
    const delta = {
      x: selectedPoint.x - base.x,
      y: selectedPoint.y - base.y,
      z: selectedPoint.z - base.z
    };
    const targetDistance = vectorLength(delta);
    travelDirection = normalizeVector(delta);
    travel = Math.min(travel, Math.max(0, targetDistance - SPACE.observationDistance));
    base = { ...base, ...directionAngles(delta) };
  }
  const distanceFromCore = vectorLength(state.camera);
  if (!selectedPoint && distanceFromCore > SPACE.guidanceDistance && travel > 0 && !state.navigationActive) {
    const centerDirection = normalizeVector({ x: -state.camera.x, y: -state.camera.y, z: -state.camera.z });
    const blend = clamp((distanceFromCore - SPACE.guidanceDistance) / 5200, 0.018, 0.075);
    travelDirection = normalizeVector({
      x: basis.forward.x * (1 - blend) + centerDirection.x * blend,
      y: basis.forward.y * (1 - blend) + centerDirection.y * blend,
      z: basis.forward.z * (1 - blend) + centerDirection.z * blend
    });
  }
  const capture = !selectedPoint && travel > 0 ? nearestCaptureTarget(travelDirection) : null;
  if (capture && capture.distance < SPACE.sourceDistance + travel + 80) {
    travel = Math.max(0, capture.distance - SPACE.observationDistance);
    setTarget(capture.game.id);
  }
  const next = addScaled(base, travelDirection, travel);
  state.cameraDestination = { ...base, ...next, mode: "free" };
  clampCamera();
  if (persist) writeLocalState();
}

function startContinuousDolly(source, direction) {
  if (!state.launched || state.detailId || !direction) return;
  dismissNavigationHint();
  if (!state.dollyInputs.size) claimCameraControl();
  state.dollyInputs.set(source, Math.sign(direction));
}

function stopContinuousDolly(source) {
  if (!state.dollyInputs.delete(source)) return;
  if (!state.dollyInputs.size) writeLocalState();
}

function stopAllContinuousDolly() {
  if (!state.dollyInputs.size) return;
  state.dollyInputs.clear();
  writeLocalState();
}

function updateContinuousDolly(timestamp) {
  const previous = state.lastFrameAt || timestamp;
  const deltaSeconds = clamp((timestamp - previous) / 1000, 0, 0.05);
  state.lastFrameAt = timestamp;
  if (!state.dollyInputs.size || !state.launched || state.detailId || document.hidden) return;
  const direction = clamp([...state.dollyInputs.values()].reduce((sum, value) => sum + value, 0), -1, 1);
  if (direction) dollyCamera(direction * 420 * deltaSeconds, { user: false, persist: false });
}

function bindDollyButton(button, direction) {
  let holdTimer = null;
  let holding = false;
  const source = `button:${button.id}`;
  const finish = () => {
    if (holdTimer) window.clearTimeout(holdTimer);
    holdTimer = null;
    if (holding) stopContinuousDolly(source);
    else if (state.launched && !state.detailId) dollyCamera(direction * 125);
    holding = false;
    button.removeAttribute("data-holding");
  };
  button.addEventListener("pointerdown", (event) => {
    if (!state.launched || state.detailId || event.button !== 0) return;
    event.preventDefault();
    button.setPointerCapture?.(event.pointerId);
    holdTimer = window.setTimeout(() => {
      holdTimer = null;
      holding = true;
      button.dataset.holding = "true";
      startContinuousDolly(source, direction);
    }, 220);
  });
  button.addEventListener("pointerup", finish);
  button.addEventListener("pointercancel", () => {
    holding = true;
    finish();
  });
  button.addEventListener("lostpointercapture", () => {
    if (holding || holdTimer) finish();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    if (event.detail === 0 && state.launched && !state.detailId) dollyCamera(direction * 125);
  });
}

function strafeCamera(horizontal, vertical, { user = true } = {}) {
  dismissNavigationHint();
  if (user) claimCameraControl();
  if (state.cameraDestination.mode === "overview") state.cameraDestination.mode = "free";
  const { right, up } = cameraBasis();
  const base = state.cameraDestination;
  state.cameraDestination = {
    ...base,
    x: base.x + right.x * horizontal + up.x * vertical,
    y: base.y + right.y * horizontal + up.y * vertical,
    z: base.z + right.z * horizontal + up.z * vertical,
    mode: "free"
  };
  state.overviewIntent = 0;
  updateMapMode();
}

function rotateCamera(deltaYaw, deltaPitch, { user = true } = {}) {
  dismissNavigationHint();
  if (user) claimCameraControl();
  state.cameraDestination.yaw += deltaYaw;
  state.cameraDestination.pitch = clamp(state.cameraDestination.pitch + deltaPitch, -1.38, 1.38);
  if (state.cameraDestination.mode === "overview") state.cameraDestination.mode = "free";
  state.overviewIntent = 0;
  updateMapMode();
}

function zoomAt(_screenX, _screenY, factor) {
  dollyCamera((factor - 1) * 620);
}

function bindCanvasControls() {
  const canvas = state.canvas;
  canvas.addEventListener("wheel", (event) => {
    if (!state.launched || state.detailId) return;
    event.preventDefault();
    dollyCamera(clamp(-event.deltaY * 0.92, -240, 240));
  }, { passive: false });

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  canvas.addEventListener("pointerdown", (event) => {
    if (!state.launched || state.detailId) return;
    dismissNavigationHint();
    canvas.setPointerCapture(event.pointerId);
    state.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      time: performance.now(),
      button: event.button,
      pointerType: event.pointerType
    });
    state.dragDistance = 0;
    if (state.pointers.size === 2) state.pinch = null;
  });

  canvas.addEventListener("pointermove", (event) => {
    const pointer = state.pointers.get(event.pointerId);
    if (!pointer || !state.launched || state.detailId) return;
    const oldX = pointer.x;
    const oldY = pointer.y;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.time = performance.now();
    state.dragDistance += Math.hypot(pointer.x - oldX, pointer.y - oldY);

    if (state.pointers.size === 1) {
      const dx = pointer.x - oldX;
      const dy = pointer.y - oldY;
      const shouldStrafe = pointer.pointerType === "mouse" && pointer.button === 1;
      if (shouldStrafe) strafeCamera(-dx * 2.15, dy * 2.15);
      else rotateCamera(-dx * 0.0042, dy * 0.0038);
      return;
    }

    const points = [...state.pointers.values()];
    const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    const middle = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    if (state.pinch) {
      dollyCamera((distance - state.pinch.distance) * 2.35);
      strafeCamera(-(middle.x - state.pinch.middle.x) * 1.55, (middle.y - state.pinch.middle.y) * 1.55);
    }
    state.pinch = { distance, middle };
  });

  const release = (event) => {
    const pointer = state.pointers.get(event.pointerId);
    const wasTap = pointer && state.pointers.size === 1 && state.dragDistance < 8 && (pointer.pointerType !== "mouse" || pointer.button === 0);
    state.pointers.delete(event.pointerId);
    if (state.pointers.size < 2) state.pinch = null;
    if (wasTap) selectAt(event.clientX, event.clientY);
    writeLocalState();
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  canvas.addEventListener("keydown", (event) => {
    if (!state.launched || state.detailId) return;
    dismissNavigationHint();
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      if (event.shiftKey) {
        if (event.key === "ArrowLeft") strafeCamera(-90, 0);
        if (event.key === "ArrowRight") strafeCamera(90, 0);
        if (event.key === "ArrowUp") strafeCamera(0, 90);
        if (event.key === "ArrowDown") strafeCamera(0, -90);
      } else {
        if (event.key === "ArrowLeft") rotateCamera(-0.12, 0);
        if (event.key === "ArrowRight") rotateCamera(0.12, 0);
        if (event.key === "ArrowUp") rotateCamera(0, 0.1);
        if (event.key === "ArrowDown") rotateCamera(0, -0.1);
      }
      return;
    }
    if (["+", "=", "w", "W", "-", "_", "s", "S"].includes(event.key)) {
      event.preventDefault();
      const direction = ["+", "=", "w", "W"].includes(event.key) ? 1 : -1;
      const source = `key:${event.code}`;
      if (!state.dollyInputs.has(source)) {
        dollyCamera(direction * 70, { persist: false });
        startContinuousDolly(source, direction);
      }
      return;
    }
    if (["a", "A"].includes(event.key)) strafeCamera(-105, 0);
    if (["d", "D"].includes(event.key)) strafeCamera(105, 0);
    if (event.key === "0") resetView(true);
    if (event.key === "Enter" && state.targetId) approachOrOpenTarget();
    if (event.key === "Escape") clearSelectedTarget();
  });
  window.addEventListener("keyup", (event) => stopContinuousDolly(`key:${event.code}`));
  window.addEventListener("blur", stopAllContinuousDolly);
  document.addEventListener("visibilitychange", () => document.hidden && stopAllContinuousDolly());
}

function planetRadius(game, screen = worldToScreen(worldPoint(game))) {
  if (!screen.visible) return 0;
  return clamp(48 * screen.focal / Math.max(SPACE.near, screen.depth), 2.4, 126);
}

function selectAt(clientX, clientY) {
  dismissNavigationHint();
  const rect = state.canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  let nearest = null;
  for (const game of state.games) {
    const snapshot = proximitySnapshot(game);
    if (!snapshot.screen.visible) continue;
    const distance = Math.hypot(x - snapshot.screen.x, y - snapshot.screen.y);
    const hitRadius = Math.max(30, planetRadius(game, snapshot.screen) + 16);
    if (distance <= hitRadius && (!nearest || distance < nearest.distance)) nearest = { game, distance };
  }
  if (!nearest) {
    return;
  }
  if (nearest.game.id === state.selectedTargetId && proximitySnapshot(nearest.game).level === "source") {
    openDetail(nearest.game.id);
    return;
  }
  selectTarget(nearest.game.id);
}

function selectTarget(id) {
  const game = state.gameById.get(id);
  if (!game) return;
  state.selectedTargetId = id;
  state.navigationActive = false;
  state.navigationTargetId = "";
  state.overviewIntent = 0;
  setTarget(id);
  aimCameraAtTarget(game);
  updateMapMode();
  writeLocalState();
}

function clearSelectedTarget() {
  state.selectedTargetId = "";
  setTarget("");
}

function aimCameraAtTarget(game) {
  const point = worldPoint(game);
  const base = state.cameraDestination;
  const angles = directionAngles({
    x: point.x - base.x,
    y: point.y - base.y,
    z: point.z - base.z
  });
  state.cameraDestination = { ...base, ...angles };
  if (state.reducedMotion) state.camera = { ...state.camera, ...angles };
}

function navigateToGame(id) {
  const game = state.gameById.get(id);
  if (!game) return;
  if (state.selectedTargetId && state.selectedTargetId !== id) state.selectedTargetId = "";
  const point = worldPoint(game);
  const inward = normalizeVector(point);
  const destination = addScaled(point, inward, -SPACE.observationDistance);
  const angles = directionAngles({ x: point.x - destination.x, y: point.y - destination.y, z: point.z - destination.z });
  state.cameraDestination = { ...destination, ...angles, mode: "free" };
  state.navigationActive = true;
  state.navigationTargetId = id;
  state.overviewIntent = 0;
  if (state.reducedMotion) state.camera = { ...state.cameraDestination };
  clampCamera();
  updateMapMode();
}

function setTarget(id) {
  state.targetId = id;
  document.body.classList.toggle("target-active", Boolean(id));
  const game = state.gameById.get(id);
  state.targetProximity = game ? proximitySnapshot(game) : { level: "remote", signal: 0 };
  updateTargetConsole(state.targetProximity);
  updatePreviewVideo();
}

function proximitySnapshot(game) {
  const point = worldPoint(game);
  const screen = worldToScreen(point);
  const distance = distance3D(state.camera, point);
  let level = "remote";
  if (distance <= SPACE.sourceDistance) level = "source";
  else if (distance <= SPACE.identityDistance) level = "identity";
  else if (distance <= SPACE.mediaDistance) level = "media";
  else if (distance <= SPACE.spectrumDistance) level = "spectrum";
  const signal = 1 - clamp((distance - SPACE.observationDistance) / (SPACE.workRadiusMax - SPACE.observationDistance), 0, 1);
  return { signal, level, distance, screen, point };
}

function updateTargetConsole(snapshot = state.targetProximity) {
  const consoleElement = $("#targetConsole");
  const game = state.gameById.get(state.targetId);
  if (!game) {
    consoleElement.hidden = true;
    return;
  }
  const level = snapshot?.level || "remote";
  const copies = {
    remote: { label: "深空异常", signal: "异常光点", hint: "调整朝向并向信号深入", action: "导航至信号" },
    spectrum: { label: "光谱初判", signal: "类型已解析", hint: (game.tags || [])[0] || "作品色谱正在显现", action: "继续靠近" },
    media: { label: "玩法解析", signal: "媒体信号接入", hint: game.videoUrl ? "静音玩法片段正在显现" : "作品封面正在显现", action: "继续靠近" },
    identity: { label: "身份解析", signal: "作品名称已确认", hint: game.title, action: "进入观测壳层" },
    source: { label: "来源解析", signal: "作品行星已确认", hint: `${game.team} / ${(game.creators || []).map((creator) => creator.name).slice(0, 2).join("、") || "作者待补充"}`, action: "查看游戏" }
  };
  const copy = copies[level];
  consoleElement.hidden = false;
  consoleElement.dataset.proximity = level;
  $("#targetCoordinate").textContent = coordinateLabel(game);
  $("#targetSignal").textContent = copy.signal;
  $("#targetHint").textContent = copy.hint;
  $("#targetUnknown").textContent = ["identity", "source"].includes(level) || state.resolved.has(game.id) || state.site?.resultsVisible ? game.title : (level === "spectrum" ? (game.tags || [])[0] || "类型待解析" : "未知作品");
  $("#targetLateBadge").hidden = !game.lateSubmission || !["identity", "source"].includes(level);
  $("#proximityLabel").textContent = copy.label;
  $("#signalScale").dataset.level = level;
  $("#signalScale").style.setProperty("--signal-strength", String(snapshot?.signal || 0));
  $("#openTarget").textContent = copy.action;
}

function approachOrOpenTarget() {
  const game = state.gameById.get(state.targetId);
  if (!game) return;
  const snapshot = proximitySnapshot(game);
  if (snapshot.level === "source") openDetail(game.id);
  else navigateToGame(game.id);
}

function coordinateLabel(game) {
  const x = Number(game.coordinate?.x || 0).toFixed(3);
  const y = Number(game.coordinate?.y || 0).toFixed(3);
  const z = Number(game.coordinate?.z ?? (Number(game.coordinate?.depth ?? 0.5) * 2 - 1)).toFixed(3);
  return `X ${x} / Y ${y} / Z ${z}`;
}

function isDirectVideo(url) {
  return Boolean(url) && (/^\/uploads\//.test(url) || /\.(mp4|webm|mov)(\?|$)/i.test(url));
}

function videoEmbedUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value, location.href);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}?rel=0` : "";
    }
    if (host.endsWith("youtube.com")) {
      const id = url.searchParams.get("v") || url.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/)?.[1];
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}?rel=0` : "";
    }
    if (host.endsWith("bilibili.com")) {
      const bvid = url.pathname.match(/\/video\/(BV[\w]+)/i)?.[1];
      return bvid ? `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&high_quality=1&autoplay=0` : "";
    }
    if (host.endsWith("v.qq.com")) {
      const vid = url.searchParams.get("vid") || url.pathname.match(/\/([A-Za-z0-9]+)\.html$/)?.[1];
      return vid ? `https://v.qq.com/txp/iframe/player.html?vid=${encodeURIComponent(vid)}&auto=0` : "";
    }
  } catch {}
  return "";
}

function updatePreviewVideo() {
  const video = $("#planetPreview");
  const game = state.gameById.get(state.targetId);
  video.pause();
  if (!game || state.detailId || state.lowMode || !["media", "identity", "source"].includes(state.targetProximity.level) || !isDirectVideo(game.videoUrl)) {
    video.removeAttribute("src");
    video.load();
    return;
  }
  if (video.src !== new URL(game.videoUrl, location.href).href) {
    video.src = game.videoUrl;
    video.load();
  }
  video.play().catch(() => {});
}

function coverImage(game) {
  if (state.images.has(game.id)) return state.images.get(game.id);
  const image = new Image();
  image.decoding = "async";
  image.src = game.coverUrl || "/assets/pass-texture.png";
  image.addEventListener("load", () => sampleCoverPalette(game), { once: true });
  state.images.set(game.id, image);
  return image;
}

function rgbToHsl(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const delta = max - min;
  if (!delta) return { h: 0, s: 0, l: light * 100 };
  const saturation = delta / (1 - Math.abs(2 * light - 1));
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = Math.round(hue * 60);
  if (hue < 0) hue += 360;
  return { h: hue, s: saturation * 100, l: light * 100 };
}

function sampleCoverPalette(game) {
  if (!game?.coverUrl || state.planetPalettes.has(game.id)) return;
  const source = new Image();
  source.decoding = "async";
  source.crossOrigin = "anonymous";
  source.addEventListener("load", () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 12;
      canvas.height = 12;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(source, 0, 0, 12, 12);
      const pixels = context.getImageData(0, 0, 12, 12).data;
      let red = 0;
      let green = 0;
      let blue = 0;
      let weight = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const brightness = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 765;
        const sampleWeight = 0.35 + Math.abs(brightness - 0.5);
        red += pixels[index] * sampleWeight;
        green += pixels[index + 1] * sampleWeight;
        blue += pixels[index + 2] * sampleWeight;
        weight += sampleWeight;
      }
      state.planetPalettes.set(game.id, rgbToHsl(red / weight, green / weight, blue / weight));
    } catch {
      state.planetPalettes.set(game.id, null);
    }
  }, { once: true });
  source.src = game.coverUrl;
}

function createPlanetGradient(ctx, x, y, radius, game, reveal) {
  const seed = hashNumber(game.planetSeed || game.id);
  const sampled = state.planetPalettes.get(game.id);
  const hue = sampled?.h ?? seed % 360;
  const saturation = 4 + reveal * clamp(sampled?.s ?? 34, 18, 62);
  const light = clamp(sampled?.l ?? (matchMedia("(prefers-color-scheme: dark)").matches ? 42 : 48), 31, 57);
  const gradient = ctx.createRadialGradient(x - radius * 0.34, y - radius * 0.38, radius * 0.06, x, y, radius);
  gradient.addColorStop(0, `hsl(${hue} ${saturation}% ${light + 23}%)`);
  gradient.addColorStop(0.45, `hsl(${hue} ${saturation}% ${light}%)`);
  gradient.addColorStop(1, `hsl(${hue} ${Math.max(2, saturation - 8)}% ${Math.max(11, light - 26)}%)`);
  return gradient;
}

function drawImageCover(ctx, image, x, y, radius) {
  if (!image.complete || !image.naturalWidth) return false;
  const diameter = radius * 2;
  const sourceRatio = image.naturalWidth / image.naturalHeight;
  let sx = 0;
  let sy = 0;
  let sw = image.naturalWidth;
  let sh = image.naturalHeight;
  if (sourceRatio > 1) {
    sw = image.naturalHeight;
    sx = (image.naturalWidth - sw) / 2;
  } else {
    sh = image.naturalWidth;
    sy = (image.naturalHeight - sh) / 2;
  }
  ctx.drawImage(image, sx, sy, sw, sh, x - radius, y - radius, diameter, diameter);
  return true;
}

function revealAmount(snapshot, game) {
  const resolvedFloor = state.resolved.has(game.id) ? 0.42 : 0;
  const selectedSignal = game.id === state.targetId ? 0.08 : 0;
  return clamp(Math.max(resolvedFloor, snapshot.signal) + selectedSignal, 0.05, 1);
}

function drawBackground(ctx) {
  ctx.fillStyle = state.palette.space;
  ctx.fillRect(0, 0, state.width, state.height);
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;

  for (const star of state.stars) {
    const point = addScaled(state.camera, star.direction, 10000);
    const screen = worldToScreen(point);
    if (!screen.visible || screen.x < -4 || screen.y < -4 || screen.x > state.width + 4 || screen.y > state.height + 4) continue;
    const twinkle = state.reducedMotion || state.lowMode ? 0 : Math.sin(state.frame * 0.014 + star.phase) * 0.08;
    ctx.globalAlpha = clamp(star.alpha + twinkle + (dark ? 0.04 : -0.05), 0.12, 0.82);
    ctx.fillStyle = state.palette.ink;
    ctx.fillRect(screen.x, screen.y, star.size, star.size);
  }

  for (const particle of state.dust) {
    const depthScale = 1 + particle.layer * 0.72;
    const point = {
      x: state.camera.x + wrappedOffset(particle.x - state.camera.x / depthScale, particle.span),
      y: state.camera.y + wrappedOffset(particle.y - state.camera.y / depthScale, particle.span),
      z: state.camera.z + wrappedOffset(particle.z - state.camera.z / depthScale, particle.span)
    };
    const screen = worldToScreen(point);
    if (!screen.visible || screen.x < -5 || screen.y < -5 || screen.x > state.width + 5 || screen.y > state.height + 5) continue;
    const depthFade = clamp(1 - screen.depth / (particle.span * 0.72), 0.08, 1);
    ctx.globalAlpha = particle.alpha * depthFade;
    ctx.fillStyle = state.palette.ink;
    const size = particle.size * clamp(520 / Math.max(80, screen.depth), 0.45, 2.2);
    ctx.fillRect(screen.x, screen.y, size, size);
  }
  ctx.globalAlpha = 1;
}

function drawCoordinateGrid(ctx) {
  if (state.lowMode || state.camera.mode === "overview") return;
  const horizon = worldToScreen(addScaled(state.camera, cameraBasis().forward, 420));
  ctx.save();
  ctx.strokeStyle = state.palette.line;
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(horizon.x, horizon.y, Math.min(state.width, state.height) * 0.08, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawResultConnections(ctx) {
  if (!state.site?.resultsVisible || !state.site.constellationIds?.length) return;
  const points = state.site.constellationIds
    .map((id) => state.gameById.get(id))
    .filter(Boolean)
    .map((game) => ({ game, ...worldToScreen(worldPoint(game)) }))
    .filter((point) => point.visible)
    .sort((a, b) => Math.atan2(a.y - state.height / 2, a.x - state.width / 2) - Math.atan2(b.y - state.height / 2, b.x - state.width / 2));
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = state.palette.signal;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  const links = points.slice(1).map((point, index) => [points[index], point]);
  if (points.length > 2) links.push([points.at(-1), points[0]]);
  const total = Math.max(0.001, state.resultRevealProgress) * links.length;
  links.forEach(([from, to], index) => {
    const segment = clamp(total - index, 0, 1);
    if (!segment) return;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(lerp(from.x, to.x, segment), lerp(from.y, to.y, segment));
    ctx.stroke();
  });
  ctx.restore();
}

function drawPlanetSurface(ctx, game, screen, radius, reveal) {
  if (state.lowMode || radius < 18) return;
  const random = seededRandom(`${game.planetSeed || game.id}:surface`);
  ctx.save();
  ctx.globalAlpha = 0.08 + reveal * 0.13;
  ctx.strokeStyle = state.palette.ink;
  ctx.lineWidth = Math.max(0.5, radius * 0.012);
  const bands = 3 + Math.floor(random() * 4);
  for (let index = 0; index < bands; index += 1) {
    const vertical = (random() - 0.5) * radius * 1.6;
    ctx.beginPath();
    ctx.ellipse(screen.x, screen.y + vertical * 0.42, radius * 0.94, radius * (0.08 + random() * 0.12), (random() - 0.5) * 0.34, 0, Math.PI * 2);
    ctx.stroke();
  }
  const craters = 3 + Math.floor(random() * 5);
  for (let index = 0; index < craters; index += 1) {
    const angle = random() * Math.PI * 2;
    const distance = random() * radius * 0.62;
    const size = radius * (0.025 + random() * 0.1);
    ctx.beginPath();
    ctx.ellipse(screen.x + Math.cos(angle) * distance, screen.y + Math.sin(angle) * distance, size, size * (0.35 + random() * 0.45), random() * Math.PI, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function resultData(game) {
  return state.site?.results?.find((item) => item.id === game.id) || null;
}

function proximityRank(level) {
  return ({ remote: 0, spectrum: 1, media: 2, identity: 3, source: 4 })[level] || 0;
}

function drawDetectorLabel(ctx, game, snapshot, radius) {
  const resolved = state.resolved.has(game.id);
  const resultsVisible = state.site?.resultsVisible;
  const rank = proximityRank(snapshot.level);
  if (!resultsVisible && !resolved && rank < 1) return;
  if (state.camera.mode === "overview" && !resultsVisible && !resolved) return;

  let primary = "";
  let secondary = "";
  if (resultsVisible || resolved || rank >= 3) primary = game.title;
  else if (rank === 2) primary = "玩法信号";
  else primary = (game.tags || [])[0] || "类型解析中";
  if (rank >= 4 || resultsVisible) {
    const creators = (game.creators || []).map((creator) => creator.name).slice(0, 2).join("、");
    secondary = creators ? `${game.team} / ${creators}` : game.team;
  } else if (rank >= 2 && !resolved) {
    secondary = rank === 2 ? "封面与静音预览" : "身份解析中";
  } else if (resolved) {
    secondary = "已解析作品";
  }

  ctx.save();
  ctx.font = "600 11px Microsoft YaHei, sans-serif";
  const width = clamp(Math.max(ctx.measureText(primary).width, secondary ? ctx.measureText(secondary).width : 0) + 18, 82, 190);
  const height = secondary ? 38 : 24;
  let x = snapshot.screen.x + radius + 18;
  let y = snapshot.screen.y - height / 2;
  if (x + width > state.width - 12) x = snapshot.screen.x - radius - width - 18;
  x = clamp(x, 10, state.width - width - 10);
  y = clamp(y, 10, state.height - height - 10);
  state.labelRects ||= [];
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const collision = state.labelRects.some((rect) => x < rect.x + rect.width + 7 && x + width + 7 > rect.x && y < rect.y + rect.height + 5 && y + height + 5 > rect.y);
    if (!collision) break;
    y = clamp(y + height + 7, 10, state.height - height - 10);
  }
  const stillCollides = state.labelRects.some((rect) => x < rect.x + rect.width && x + width > rect.x && y < rect.y + rect.height && y + height > rect.y);
  if (stillCollides && rank < 4 && !resolved && !resultsVisible) {
    ctx.restore();
    return;
  }
  state.labelRects.push({ x, y, width, height });

  ctx.strokeStyle = game.id === state.targetId ? state.palette.signal : state.palette.line;
  ctx.globalAlpha = game.id === state.targetId ? 0.9 : 0.48;
  ctx.beginPath();
  ctx.moveTo(snapshot.screen.x + Math.sign(x - snapshot.screen.x) * (radius + 5), snapshot.screen.y);
  ctx.lineTo(x + (x > snapshot.screen.x ? 0 : width), y + height / 2);
  ctx.stroke();
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = state.palette.spaceSoft;
  ctx.fillRect(x, y, width, height);
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = state.palette.ink;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = "600 11px Microsoft YaHei, sans-serif";
  ctx.fillText(primary, x + 9, y + 6, width - 18);
  if (secondary) {
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = state.palette.muted;
    ctx.font = "9px Cascadia Mono, Microsoft YaHei, monospace";
    ctx.fillText(secondary, x + 9, y + 22, width - 18);
  }
  ctx.restore();
}

function drawPlanet(ctx, game) {
  const snapshot = state.detectorSnapshots.get(game.id) || proximitySnapshot(game);
  const screen = snapshot.screen;
  if (!screen.visible) return;
  const physicalRadius = planetRadius(game, screen);
  if (screen.x < -physicalRadius * 5 || screen.y < -physicalRadius * 5 || screen.x > state.width + physicalRadius * 5 || screen.y > state.height + physicalRadius * 5) return;
  const reveal = revealAmount(snapshot, game);
  const seed = hashNumber(game.planetSeed || game.id);
  const selected = game.id === state.targetId;
  const resolved = state.resolved.has(game.id);
  const voted = state.session.authenticated && state.ballot.gameIds.includes(game.id);
  const winner = state.site?.winnerIds?.includes(game.id);
  const constellation = state.site?.constellationIds?.includes(game.id);
  const planetBlend = clamp((SPACE.mediaDistance + 70 - snapshot.distance) / 245, 0, 1);
  const starRadius = 2.4 + snapshot.signal * 4.6 + (selected ? 1.5 : 0);
  const radius = lerp(starRadius, physicalRadius, planetBlend);
  const sampled = state.planetPalettes.get(game.id);
  const hue = sampled?.h ?? seed % 360;
  const colorStrength = resolved ? Math.max(0.58, reveal) : reveal;

  ctx.save();
  const haloRadius = Math.max(14, radius * (planetBlend > 0.2 ? 2.8 : 4.5));
  const halo = ctx.createRadialGradient(screen.x, screen.y, 0, screen.x, screen.y, haloRadius);
  halo.addColorStop(0, `hsla(${hue} ${18 + colorStrength * 48}% 82% / ${0.7 + snapshot.signal * 0.2})`);
  halo.addColorStop(0.18, `hsla(${hue} ${12 + colorStrength * 44}% 64% / ${0.28 + snapshot.signal * 0.2})`);
  halo.addColorStop(1, `hsla(${hue} 28% 48% / 0)`);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, haloRadius, 0, Math.PI * 2);
  ctx.fill();

  if (!state.lowMode && planetBlend > 0.34 && seed % 3 === 0) {
    ctx.strokeStyle = constellation ? state.palette.signal : state.palette.line;
    ctx.globalAlpha = (0.16 + reveal * 0.24) * planetBlend;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(screen.x, screen.y, radius * 1.55, radius * 0.34, ((seed % 60) - 30) * Math.PI / 180, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = createPlanetGradient(ctx, screen.x, screen.y, radius, game, reveal);
  ctx.globalAlpha = lerp(0.88, 0.98, planetBlend);
  ctx.fill();
  if (planetBlend > 0.05) {
    ctx.clip();
    drawPlanetSurface(ctx, game, screen, radius, reveal);
    if (proximityRank(snapshot.level) >= 2) {
      const image = coverImage(game);
      ctx.globalAlpha = clamp(planetBlend * 0.88, 0, 0.88);
      ctx.filter = `saturate(${0.18 + reveal * 0.82}) contrast(${0.92 + reveal * 0.14})`;
      drawImageCover(ctx, image, screen.x, screen.y, radius);
    }

    const preview = $("#planetPreview");
    if (selected && !state.lowMode && preview.readyState >= 2 && proximityRank(snapshot.level) >= 2) {
      ctx.globalAlpha = clamp(planetBlend * 0.76, 0, 0.78);
      ctx.filter = `saturate(${0.38 + reveal * 0.68}) contrast(1.08)`;
      const side = Math.min(preview.videoWidth || 1, preview.videoHeight || 1);
      const sx = Math.max(0, ((preview.videoWidth || side) - side) / 2);
      const sy = Math.max(0, ((preview.videoHeight || side) - side) / 2);
      try {
        ctx.drawImage(preview, sx, sy, side, side, screen.x - radius, screen.y - radius, radius * 2, radius * 2);
      } catch {}
    }
  }
  ctx.restore();

  ctx.save();
  if (state.site?.resultsVisible) {
    const maxVotes = Math.max(1, ...state.site.results.map((item) => Number(item.voteCount || 0)));
    const strength = Number(resultData(game)?.voteCount || 0) / maxVotes;
    const ignition = state.resultRevealProgress;
    ctx.globalAlpha = (0.08 + strength * 0.72) * ignition;
    ctx.strokeStyle = state.palette.signal;
    ctx.lineWidth = winner ? 2.5 : 1;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius + 7 + strength * 16, 0, Math.PI * 2);
    ctx.stroke();
    if (winner) {
      ctx.globalAlpha = 0.22 * ignition;
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius + 13, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.lineWidth = selected || winner ? 2 : 1;
  ctx.strokeStyle = selected || winner ? state.palette.signal : state.palette.line;
  ctx.globalAlpha = selected || winner ? 0.95 : 0.42 + planetBlend * 0.18;
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, radius + (selected ? 10 : 2), 0, Math.PI * 2);
  ctx.stroke();

  if (resolved && !state.site?.resultsVisible) {
    ctx.strokeStyle = state.palette.signal;
    ctx.globalAlpha = 0.62;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius + 6, -Math.PI * 0.2, Math.PI * 0.25);
    ctx.stroke();
  }

  if (voted && !state.site?.resultsVisible) {
    ctx.strokeStyle = state.palette.signal;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.92;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius + 10, Math.PI * 0.58, Math.PI * 1.12);
    ctx.stroke();
  }

  if (selected) {
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = state.palette.signal;
    ctx.beginPath();
    ctx.moveTo(screen.x + radius + 14, screen.y);
    ctx.lineTo(screen.x + radius + 54, screen.y);
    ctx.stroke();
  }

  ctx.restore();
  drawDetectorLabel(ctx, game, snapshot, radius);
}

function drawOffscreenSignals(ctx) {
  if (state.camera.mode === "overview" || !state.games.length) return;
  const basis = cameraBasis();
  const groups = new Map();
  for (const game of state.games) {
    const snapshot = state.detectorSnapshots.get(game.id);
    if (!snapshot) continue;
    const onScreen = snapshot.screen.visible && snapshot.screen.x >= 20 && snapshot.screen.x <= state.width - 20 && snapshot.screen.y >= 20 && snapshot.screen.y <= state.height - 20;
    if (onScreen) continue;
    const delta = normalizeVector({ x: snapshot.point.x - state.camera.x, y: snapshot.point.y - state.camera.y, z: snapshot.point.z - state.camera.z });
    const horizontal = dot(delta, basis.right);
    const vertical = dot(delta, basis.up);
    const forward = dot(delta, basis.forward);
    const angle = Math.atan2(-vertical, horizontal || (forward < 0 ? 0.0001 : 0));
    const sector = Math.round(angle / (Math.PI / 4));
    const group = groups.get(sector) || { angle, count: 0, resolved: 0, nearest: Infinity };
    group.count += 1;
    if (state.resolved.has(game.id)) group.resolved += 1;
    group.nearest = Math.min(group.nearest, snapshot.distance);
    groups.set(sector, group);
  }

  const descriptions = [];
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "9px Cascadia Mono, monospace";
  for (const group of groups.values()) {
    const insetX = Math.max(32, state.width * 0.46);
    const insetY = Math.max(28, state.height * 0.43);
    const scale = 1 / Math.max(Math.abs(Math.cos(group.angle)), Math.abs(Math.sin(group.angle)), 0.001);
    const x = state.width / 2 + Math.cos(group.angle) * insetX * scale;
    const y = state.height / 2 + Math.sin(group.angle) * insetY * scale;
    const clampedX = clamp(x, 24, state.width - 24);
    const clampedY = clamp(y, 24, state.height - 24);
    ctx.translate(clampedX, clampedY);
    ctx.rotate(group.angle);
    ctx.strokeStyle = state.palette.signal;
    ctx.globalAlpha = 0.34 + clamp(1 - group.nearest / 1800, 0, 0.32);
    ctx.beginPath();
    ctx.moveTo(-8, 0);
    ctx.lineTo(8, 0);
    ctx.stroke();
    ctx.rotate(-group.angle);
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = state.palette.muted;
    ctx.fillText(String(group.count), 0, group.angle > 0 ? -11 : 11);
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    const horizontalLabel = Math.cos(group.angle) > 0.35 ? "右侧" : Math.cos(group.angle) < -0.35 ? "左侧" : "";
    const verticalLabel = Math.sin(group.angle) > 0.35 ? "下方" : Math.sin(group.angle) < -0.35 ? "上方" : "";
    descriptions.push(`${verticalLabel}${horizontalLabel || "方向"}有 ${group.count} 个${group.resolved === group.count ? "已解析" : "未知"}信号`);
  }
  ctx.restore();
  const summary = descriptions.join("；");
  if (summary !== state.offscreenSummary) {
    state.offscreenSummary = summary;
    const element = $("#offscreenSummary");
    if (element) element.textContent = summary;
  }
}

function updateDetectorState() {
  let wroteResolved = false;
  for (const [id, snapshot] of state.detectorSnapshots) {
    if (proximityRank(snapshot.level) >= 3 && !state.resolved.has(id)) {
      state.resolved.add(id);
      wroteResolved = true;
    }
  }
  if (wroteResolved) {
    updateExplorationUI();
    renderAccessibleIndex();
    writeLocalState();
  }

  let targetId = state.selectedTargetId && state.gameById.has(state.selectedTargetId)
    ? state.selectedTargetId
    : state.navigationTargetId && state.gameById.has(state.navigationTargetId) ? state.navigationTargetId : "";
  if (!targetId) {
    let best = null;
    for (const [id, snapshot] of state.detectorSnapshots) {
      if (!snapshot.screen.visible || proximityRank(snapshot.level) < 2) continue;
      if (snapshot.screen.x < -80 || snapshot.screen.x > state.width + 80 || snapshot.screen.y < -80 || snapshot.screen.y > state.height + 80) continue;
      const center = Math.hypot(snapshot.screen.x - state.width / 2, snapshot.screen.y - state.height / 2);
      const score = center + snapshot.distance * 0.08 - proximityRank(snapshot.level) * 38;
      if (!best || score < best.score) best = { id, score };
    }
    targetId = best?.id || "";
  }
  if (targetId !== state.targetId) setTarget(targetId);
  else if (targetId) {
    const next = state.detectorSnapshots.get(targetId);
    const changed = next.level !== state.targetProximity.level;
    state.targetProximity = next;
    updateTargetConsole(next);
    if (changed) updatePreviewVideo();
  }

  const routeGame = state.gameById.get(state.routeIds[state.routeIndex]);
  if (routeGame) updateRouteArrival(routeGame, state.detectorSnapshots.get(routeGame.id));
}

function applyContentGravity() {
  if (state.cameraDestination.mode === "overview" || state.navigationActive || state.selectedTargetId) return;
  const distance = vectorLength(state.camera);
  if (distance < SPACE.guidanceDistance) return;
  const towardCenter = directionAngles({ x: -state.camera.x, y: -state.camera.y, z: -state.camera.z });
  const strength = clamp((distance - SPACE.guidanceDistance) / 2600, 0, 1) * 0.0035;
  state.cameraDestination.yaw = lerpAngle(state.cameraDestination.yaw, towardCenter.yaw, strength);
  state.cameraDestination.pitch = lerp(state.cameraDestination.pitch, towardCenter.pitch, strength);
}

function updateMapMode() {
  if (!state.site) return;
  const label = state.routeActive
    ? (state.routePaused ? "自动巡航已暂停" : "自动巡航中")
    : state.navigationActive
      ? "导航信标已锁定"
      : state.cameraDestination.mode === "overview" || state.camera.mode === "overview"
        ? "全景观测"
        : "自由航行";
  $("#mapMode").textContent = label;
}

function renderFrame(timestamp = performance.now()) {
  state.frame += 1;
  updateContinuousDolly(timestamp);
  if (state.ctx && state.width && state.height) {
    applyContentGravity();
    const amount = state.reducedMotion ? 1 : state.landing ? 0.14 : state.navigationActive ? 0.026 : 0.12;
    state.camera.x = lerp(state.camera.x, state.cameraDestination.x, amount);
    state.camera.y = lerp(state.camera.y, state.cameraDestination.y, amount);
    state.camera.z = lerp(state.camera.z, state.cameraDestination.z, amount);
    state.camera.yaw = lerpAngle(state.camera.yaw, state.cameraDestination.yaw, amount);
    state.camera.pitch = lerp(state.camera.pitch, state.cameraDestination.pitch, amount);
    if (distance3D(state.camera, state.cameraDestination) < 2.5) state.camera.mode = state.cameraDestination.mode;
    clampCamera({ includeCurrent: false });

    if (state.navigationActive && distance3D(state.camera, state.cameraDestination) < 12) {
      state.navigationActive = false;
      state.camera.mode = "free";
      state.cameraDestination.mode = "free";
      updateMapMode();
    }
    if (state.site?.resultsVisible && state.resultRevealStart) {
      state.resultRevealProgress = clamp((performance.now() - state.resultRevealStart) / (state.reducedMotion ? 1 : 2500), 0, 1);
    }

    state.detectorSnapshots = new Map(state.games.map((game) => [game.id, proximitySnapshot(game)]));
    state.labelRects = [];
    const ctx = state.ctx;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    drawBackground(ctx);
    drawCoordinateGrid(ctx);
    drawResultConnections(ctx);
    [...state.games]
      .sort((a, b) => (state.detectorSnapshots.get(b.id)?.screen.depth || 0) - (state.detectorSnapshots.get(a.id)?.screen.depth || 0))
      .forEach((game) => drawPlanet(ctx, game));
    drawOffscreenSignals(ctx);
    if (state.frame % 5 === 0) updateDetectorState();
  }
  requestAnimationFrame(renderFrame);
}

function updateRouteArrival(game, proximity) {
  if (!state.routeActive || !state.routeNavigating || game.id !== state.routeIds[state.routeIndex]) return;
  if (!proximity || proximity.level !== "source" || distance3D(state.camera, state.cameraDestination) > 18) return;
  state.routeNavigating = false;
  state.navigationActive = false;
  state.routeArrived = true;
  state.routePaused = true;
  $("#routeProgress").textContent = "已抵达未知行星，等待穿越";
  $("#routeLateBadge").hidden = !game.lateSubmission;
  $("#routePause").textContent = "查看游戏";
  updateExplorationUI();
}

function markVisited(id) {
  if (!id || state.visited.has(id)) return;
  state.visited.add(id);
  state.resolved.add(id);
  updateExplorationUI();
  writeLocalState();
}

function updateExplorationUI() {
  $("#visitedCount").textContent = state.visited.size;
  $("#gameCount").textContent = state.games.length;
  updateMapMode();
}

function creatorNodes(game) {
  const creators = game.creators || [];
  if (!creators.length) return `<p class="creator-caption">制作人员暂未填写</p>`;
  const nodes = creators.map((creator, index) => {
    const angle = (Math.PI * 2 * index / creators.length) - Math.PI / 2;
    const left = 50 + Math.cos(angle) * 41;
    const top = 50 + Math.sin(angle) * 39;
    const visual = creator.avatarUrl
      ? `<img src="${escapeHTML(creator.avatarUrl)}" alt="${escapeHTML(creator.name)}头像" />`
      : `<span aria-hidden="true">${escapeHTML(creator.name.slice(0, 1))}</span>`;
    return `<button class="creator-node" type="button" style="left:${left}%;top:${top}%" data-creator-index="${index}" aria-pressed="false" aria-label="${escapeHTML(creator.name)}，${escapeHTML(creator.role || "制作人员")}">${visual}</button>`;
  }).join("");
  return `<div class="creator-orbit-track">${nodes}</div>`;
}

function stopCreatorOrbit() {
  if (state.creatorOrbitFrame) cancelAnimationFrame(state.creatorOrbitFrame);
  state.creatorOrbitFrame = null;
  state.creatorOrbitStartedAt = 0;
}

function startCreatorOrbit() {
  stopCreatorOrbit();
  const orbit = $("#creatorOrbit");
  const nodes = $$('[data-creator-index]', orbit);
  if (!nodes.length) return;

  const positionNodes = (time) => {
    if (!state.detailId || !orbit.isConnected) return stopCreatorOrbit();
    const rect = orbit.getBoundingClientRect();
    const nodeSize = nodes[0].getBoundingClientRect().width || 58;
    const pathInset = nodeSize / 2 + 2;
    const radiusX = Math.max(0, rect.width / 2 - pathInset);
    const radiusY = Math.max(0, rect.height / 2 - pathInset);
    if (!state.creatorOrbitStartedAt) state.creatorOrbitStartedAt = time;
    const phase = state.reducedMotion ? 0 : ((time - state.creatorOrbitStartedAt) / 34000) * Math.PI * 2;

    nodes.forEach((node, index) => {
      const angle = phase + (Math.PI * 2 * index / nodes.length) - Math.PI / 2;
      const x = Math.cos(angle) * radiusX;
      const y = Math.sin(angle) * radiusY;
      node.style.left = "50%";
      node.style.top = "50%";
      node.style.transform = `translate(-50%, -50%) translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
    });

    if (!state.reducedMotion) state.creatorOrbitFrame = requestAnimationFrame(positionNodes);
  };

  state.creatorOrbitFrame = requestAnimationFrame(positionNodes);
}

function isSelfGame(game) {
  if (!state.session.authenticated) return false;
  return (state.session.selfBlockedGameIds || []).includes(game.id);
}

function updateDetailVoteButton() {
  const button = $("#detailVote");
  const game = state.gameById.get(state.detailId);
  if (!game) return;
  if (state.site.votingState !== "open") {
    button.disabled = true;
    button.textContent = state.site.votingState === "upcoming" ? "投票尚未开始" : "投票已结束";
    return;
  }
  if (state.ballot.gameIds.includes(game.id)) {
    button.disabled = false;
    button.textContent = "撤回这一票";
    return;
  }
  if (isSelfGame(game)) {
    button.disabled = true;
    button.textContent = "不能为自己的作品投票";
    return;
  }
  button.disabled = false;
  button.textContent = "投出一票";
}

function populateDetail(game) {
  $("#detailCoordinate").textContent = coordinateLabel(game);
  $("#detailTeam").textContent = game.team;
  $("#detailTitle").textContent = game.title;
  $("#detailShort").textContent = game.shortDescription || "";
  $("#detailDescription").textContent = game.description || game.shortDescription || "游戏简介暂未填写。";
  $("#detailCreationNote").textContent = game.creationNote || "创作手记暂未填写。";
  $("#detailLateBadge").hidden = !game.lateSubmission;
  $("#creationNoteSection").hidden = !game.creationNote;
  $("#detailTags").innerHTML = (game.tags || []).map((tag) => `<span>${escapeHTML(tag)}</span>`).join("");

  const cover = $("#detailCover");
  const video = $("#detailVideo");
  const embed = $("#detailVideoEmbed");
  const embedUrl = videoEmbedUrl(game.videoUrl);
  cover.src = game.coverUrl || "/assets/pass-texture.png";
  cover.alt = `${game.title}游戏封面`;
  video.pause();
  video.removeAttribute("src");
  video.hidden = true;
  embed.removeAttribute("src");
  embed.hidden = true;
  cover.hidden = false;
  if (isDirectVideo(game.videoUrl)) {
    video.src = game.videoUrl;
    video.muted = true;
    video.loop = true;
    video.hidden = false;
    cover.hidden = true;
  } else if (embedUrl) {
    embed.src = embedUrl;
    embed.hidden = false;
    cover.hidden = true;
  }
  const videoLink = $("#detailVideoLink");
  videoLink.hidden = !game.videoUrl || isDirectVideo(game.videoUrl) || Boolean(embedUrl);
  if (!videoLink.hidden) videoLink.href = game.videoUrl;
  const download = $("#detailDownload");
  download.hidden = !game.downloadUrl;
  if (game.downloadUrl) download.href = game.downloadUrl;

  const orbit = $("#creatorOrbit");
  orbit.innerHTML = creatorNodes(game);
  $("#creatorCaption").textContent = game.creators?.length ? "选择头像查看姓名与职责" : "制作人员暂未填写";
  $$('[data-creator-index]', orbit).forEach((button) => button.addEventListener("click", () => {
    $$('[data-creator-index]', orbit).forEach((item) => item.setAttribute("aria-pressed", "false"));
    button.setAttribute("aria-pressed", "true");
    const creator = game.creators[Number(button.dataset.creatorIndex)];
    $("#creatorCaption").textContent = creator.role ? `${creator.name} / ${creator.role}` : creator.name;
  }));
  updateDetailVoteButton();
}

function openDetail(id) {
  const game = state.gameById.get(id);
  if (!game || state.landing || state.detailId) return;
  state.detailId = id;
  state.detailReturnCamera = { ...state.camera };
  state.detailOriginFocus = document.activeElement;
  state.landing = true;
  updatePreviewVideo();
  markVisited(id);
  populateDetail(game);

  const landing = $("#landingTransition");
  $("#landingImage").src = game.coverUrl || "/assets/pass-texture.png";
  $("#landingStatus").textContent = "正在穿越行星表面";
  landing.hidden = false;
  landing.classList.remove("exiting");
  requestAnimationFrame(() => landing.classList.add("entering"));
  const point = worldPoint(game);
  const approach = normalizeVector({ x: point.x - state.camera.x, y: point.y - state.camera.y, z: point.z - state.camera.z });
  const destination = addScaled(point, approach, -72);
  const angles = directionAngles({ x: point.x - destination.x, y: point.y - destination.y, z: point.z - destination.z });
  state.cameraDestination = { ...destination, ...angles, mode: "free" };
  state.navigationActive = false;

  clearTimeout(state.landingTimer);
  state.landingTimer = setTimeout(() => {
    const detail = $("#planetDetail");
    detail.hidden = false;
    requestAnimationFrame(() => detail.classList.add("visible"));
    document.body.classList.add("detail-open");
    $("#detailVideo").play().catch(() => {});
    startCreatorOrbit();
    landing.classList.remove("entering");
    landing.hidden = true;
    state.landing = false;
    $("#closeDetail").focus();
  }, state.reducedMotion ? 0 : 880);
}

function closeDetail() {
  const detail = $("#planetDetail");
  if (detail.hidden || state.landing) return;
  closeReturnVoteConfirm({ restoreFocus: false, force: true });
  const closedId = state.detailId;
  const game = state.gameById.get(closedId);
  state.landing = true;
  stopCreatorOrbit();
  $("#detailVideo").pause();
  $("#detailVideoEmbed").removeAttribute("src");
  const landing = $("#landingTransition");
  $("#landingImage").src = game?.coverUrl || "/assets/pass-texture.png";
  $("#landingStatus").textContent = "正在返回观测轨道";
  landing.hidden = false;
  landing.classList.remove("entering");
  landing.classList.add("exiting");
  detail.classList.remove("visible");
  if (state.detailReturnCamera) state.cameraDestination = { ...state.detailReturnCamera };
  clampCamera({ includeCurrent: false });
  clearTimeout(state.landingTimer);
  setTimeout(() => {
    detail.hidden = true;
    document.body.classList.remove("detail-open");
  }, state.reducedMotion ? 0 : 180);
  state.landingTimer = setTimeout(() => {
    landing.classList.remove("exiting");
    landing.hidden = true;
    state.detailId = "";
    state.landing = false;
    updatePreviewVideo();
    state.detailReturnCamera = null;
    const focusTarget = state.detailOriginFocus?.isConnected ? state.detailOriginFocus : state.canvas;
    focusTarget?.focus?.();
    state.detailOriginFocus = null;
    writeLocalState();
    if (state.routeActive && state.routeArrived && closedId === state.routeIds[state.routeIndex]) {
      state.routePaused = false;
      state.routeArrived = false;
      state.routeIndex += 1;
      writeLocalState();
      clearTimeout(state.routeTimer);
      state.routeTimer = setTimeout(advanceRoute, state.reducedMotion ? 0 : 480);
    }
  }, state.reducedMotion ? 0 : 760);
}

async function shareCurrentGame() {
  const game = state.gameById.get(state.detailId);
  if (!game) return;
  const url = new URL(location.origin + location.pathname);
  url.searchParams.set("game", game.id);
  const data = { title: `${game.title} / 溯造 MiniGame`, text: `${game.team}制作的《${game.title}》`, url: url.toString() };
  try {
    if (navigator.share) await navigator.share(data);
    else {
      await navigator.clipboard.writeText(data.url);
      showToast("作品链接已复制。" );
    }
  } catch (error) {
    if (error.name !== "AbortError") showToast("暂时无法分享，请复制浏览器地址。" );
  }
}

function renderSearch(query = "") {
  const needle = query.trim().toLowerCase();
  const games = state.games.filter((game) => {
    const text = [game.title, game.team, ...(game.creators || []).map((creator) => creator.name)].join(" ").toLowerCase();
    return !needle || text.includes(needle);
  });
  $("#searchResults").innerHTML = games.length ? games.map((game) => `
    <button class="search-result" type="button" data-search-id="${escapeHTML(game.id)}">
      <img src="${escapeHTML(game.coverUrl || "/assets/pass-texture.png")}" alt="" />
      <div><strong>${escapeHTML(game.title)}${game.lateSubmission ? ` <small class="late-badge">补交</small>` : ""}</strong><span>${escapeHTML(game.team)}</span></div>
      <code>${escapeHTML(coordinateLabel(game))}</code>
    </button>
  `).join("") : `<p class="dialog-intro">没有找到匹配作品。</p>`;
  $$('[data-search-id]', $("#searchResults")).forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.searchId;
    closeDialog($("#searchDialog"));
    setTarget(id);
    navigateToGame(id, 1.25);
    state.canvas.focus();
  }));
}

function openSearch() {
  renderSearch($("#searchInput").value);
  openDialog($("#searchDialog"));
  requestAnimationFrame(() => $("#searchInput").focus());
}

function routePositionLabel() {
  const remaining = state.routeIds.filter((id, index) => index >= state.routeIndex && !state.visited.has(id)).length;
  return `${state.games.length - remaining}/${state.games.length} 已查看`;
}

function startRoute() {
  if (!state.games.length) return;
  state.routeActive = true;
  state.routePaused = false;
  state.routeArrived = false;
  state.routeNavigating = false;
  $("#routeConsole").hidden = false;
  $("#routePause").textContent = "暂停";
  advanceRoute();
  updateExplorationUI();
}

function stopRoute(message = "") {
  state.routeActive = false;
  state.routePaused = false;
  state.routeNavigating = false;
  state.routeArrived = false;
  state.navigationActive = false;
  state.navigationTargetId = "";
  clearTimeout(state.routeTimer);
  $("#routeConsole").hidden = true;
  updateExplorationUI();
  writeLocalState();
  if (message) showToast(message);
}

function advanceRoute() {
  if (!state.routeActive || state.routePaused || state.detailId) return;
  while (state.routeIndex < state.routeIds.length && state.visited.has(state.routeIds[state.routeIndex])) state.routeIndex += 1;
  if (state.routeIndex >= state.routeIds.length) {
    stopRoute("全部作品已经查看，可以检查你的投票。" );
    return;
  }
  const id = state.routeIds[state.routeIndex];
  state.routeNavigating = true;
  state.routeArrived = false;
  setTarget(id);
  navigateToGame(id, 1.58);
  $("#routeProgress").textContent = `${routePositionLabel()}，正在接近`;
  $("#routeLateBadge").hidden = !state.gameById.get(id)?.lateSubmission;
  $("#routePause").textContent = "暂停";
  writeLocalState();
}

function toggleRoutePause() {
  if (!state.routeActive) return;
  if (state.routeArrived) {
    openDetail(state.routeIds[state.routeIndex]);
    return;
  }
  state.routePaused = !state.routePaused;
  if (state.routePaused) {
    state.routeNavigating = false;
    state.navigationActive = false;
    state.navigationTargetId = "";
    state.cameraDestination = { ...state.camera };
  }
  $("#routePause").textContent = state.routePaused ? "继续" : "暂停";
  updateExplorationUI();
  if (!state.routePaused) advanceRoute();
}

function skipRouteTarget() {
  if (!state.routeActive || state.routeIndex >= state.routeIds.length) return;
  const [skipped] = state.routeIds.splice(state.routeIndex, 1);
  state.routeIds.push(skipped);
  state.routePaused = false;
  state.routeNavigating = false;
  state.routeArrived = false;
  state.navigationActive = false;
  state.navigationTargetId = "";
  setTarget("");
  writeLocalState();
  advanceRoute();
}

function profileValues() {
  return {
    name: $("#authName").value.trim(),
    team: $("#authTeam").value.trim(),
    email: $("#authEmail").value.trim().toLowerCase()
  };
}

function validateProfile() {
  const identity = profileValues();
  if (!identity.name || !identity.team || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(identity.email)) {
    setMessage($("#authMessage"), "请填写姓名、队伍和有效邮箱。", true);
    return null;
  }
  return identity;
}

function openAuth(pendingVoteId = "") {
  if (pendingVoteId) state.pendingVoteId = pendingVoteId;
  const profile = readProfile();
  $("#authName").value ||= profile.name || "";
  $("#authTeam").value ||= profile.team || "";
  $("#authEmail").value ||= profile.email || "";
  setMessage($("#authMessage"), "");
  openDialog($("#authDialog"));
}

function startCodeCountdown(seconds) {
  clearInterval(state.countdownTimer);
  const button = $("#sendCodeButton");
  let remaining = Math.max(1, seconds);
  button.disabled = true;
  button.textContent = `${remaining} 秒后重发`;
  state.countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(state.countdownTimer);
      button.disabled = false;
      button.textContent = "重新发送";
      return;
    }
    button.textContent = `${remaining} 秒后重发`;
  }, 1000);
}

async function sendCode() {
  const identity = validateProfile();
  if (!identity) return;
  const button = $("#sendCodeButton");
  button.disabled = true;
  button.textContent = "正在发送";
  setMessage($("#authMessage"), "");
  try {
    const result = await fetchJSON("/api/verification/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(identity)
    });
    if (result.devCode) {
      $("#authCode").value = result.devCode;
      setMessage($("#authMessage"), "本地调试验证码已自动填入。" );
    } else {
      setMessage($("#authMessage"), "验证码已发送，请检查邮箱。" );
    }
    startCodeCountdown(60);
    $("#authCode").focus();
  } catch (error) {
    button.disabled = false;
    button.textContent = "发送验证码";
    setMessage($("#authMessage"), error.message, true);
    if (error.retryAfter) startCodeCountdown(error.retryAfter);
  }
}

async function verifyAuth(event) {
  event.preventDefault();
  const identity = validateProfile();
  const code = $("#authCode").value.trim();
  if (!identity) return;
  if (!/^\d{6}$/.test(code)) return setMessage($("#authMessage"), "请输入 6 位数字验证码。", true);
  const button = $("#verifyButton");
  button.disabled = true;
  button.textContent = "正在验证";
  try {
    const result = await fetchJSON("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...identity, code })
    });
    state.session = { authenticated: true, identity: result.identity, selfBlockedGameIds: result.selfBlockedGameIds || [] };
    state.ballot = result.ballot || { gameIds: [], version: 0 };
    saveProfile(identity);
    closeDialog($("#authDialog"));
    $("#authCode").value = "";
    updateAccountUI();
    renderBallot();
    updateDetailVoteButton();
    showToast("登录成功，之后可以直接修改投票。" );
    const pending = state.pendingVoteId;
    const shouldOpenBallot = state.pendingBallotOpen;
    state.pendingVoteId = "";
    state.pendingBallotOpen = false;
    if (pending) await toggleVote(pending);
    else if (shouldOpenBallot) openBallot();
  } catch (error) {
    setMessage($("#authMessage"), error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "验证并登录";
  }
}

async function logout() {
  try {
    await fetchJSON("/api/session", { method: "DELETE" });
  } catch {}
  state.session = { authenticated: false, identity: null, selfBlockedGameIds: [] };
  state.ballot = { gameIds: [], version: 0, updatedAt: null };
  state.pendingReplacementId = "";
  state.pendingBallotRetry = null;
  closeVoteCeremony({ immediate: true });
  closeReturnVoteConfirm({ restoreFocus: false, force: true });
  closeDialog($("#ballotDialog"));
  updateAccountUI();
  updateDetailVoteButton();
  showToast("已退出登录。" );
}

function newOperationId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `vote-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function corePalette(game) {
  const sampled = state.planetPalettes.get(game?.id);
  const seed = hashNumber(game?.planetSeed || game?.id || "possibility");
  return {
    hue: Math.round(sampled?.h ?? seed % 360),
    hue2: Math.round((sampled?.h ?? seed % 360) + 28 + (seed % 36)) % 360
  };
}

function applyCorePalette(element, game) {
  if (!element || !game) return;
  const palette = corePalette(game);
  element.style.setProperty("--hue", palette.hue);
  element.style.setProperty("--hue-2", palette.hue2);
}

function setupCeremonyParticles() {
  const root = $("#ceremonyParticles");
  if (root.childElementCount) return;
  const count = state.performanceTier === "full" ? 72 : state.performanceTier === "standard" ? 48 : 24;
  root.innerHTML = Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * 360 + (hashNumber(`particle-${index}`) % 17);
    const radius = 20 + (hashNumber(`radius-${index}`) % 48);
    const delay = -(hashNumber(`delay-${index}`) % 920);
    return `<i style="--angle:${angle}deg;--radius:${radius}vmin;--delay:${delay}ms"></i>`;
  }).join("");
}

function ensureRitualAudio() {
  if (state.ritualMuted) return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!state.ritualAudioContext) state.ritualAudioContext = new AudioContextClass();
  if (state.ritualAudioContext.state === "suspended") state.ritualAudioContext.resume().catch(() => {});
  return state.ritualAudioContext;
}

function stopExtractionTone() {
  if (state.ritualOscillator) {
    try { state.ritualOscillator.stop(); } catch {}
    state.ritualOscillator.disconnect();
  }
  state.ritualGain?.disconnect();
  state.ritualOscillator = null;
  state.ritualGain = null;
}

function startExtractionTone() {
  const context = ensureRitualAudio();
  if (!context) return;
  stopExtractionTone();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(54, context.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(118, context.currentTime + 3);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.035, context.currentTime + 2.8);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  state.ritualOscillator = oscillator;
  state.ritualGain = gain;
}

function playRitualTone(frequency = 180, duration = 0.24, volume = 0.05) {
  const context = ensureRitualAudio();
  if (!context) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, context.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.45, context.currentTime + duration);
  gain.gain.setValueAtTime(volume, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + duration);
}

function ritualVibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

function setCeremonyStatus(title, status, eyebrow = "可能性核心提取") {
  $("#ceremonyTitle").textContent = title;
  $("#ceremonyStatus").textContent = status;
  $("#ceremonyEyebrow").textContent = eyebrow;
  $("#ceremonyLive").textContent = `${title}。${status}`;
}

function phaseHint(phase = state.ritualPhase) {
  return {
    ready: "持续按住提取区域三秒，松开会回退。",
    floating: "点击悬浮的可能性核心，将它送入你的轨道。",
    replacement: "三颗核心已经占满轨道。选择一颗旧核心完成交接。",
    submitting: "正在等待观测站锁定选票。",
    handoff: "新旧核心正在轨道边缘等待交接确认。",
    orbiting: "可能性核心正在沿引导航迹进入轨道。",
    personal: "靠近、悬停或选择核心，查看它对应的作品。"
  }[phase] || "";
}

function scheduleCeremonyHint() {
  clearTimeout(state.ritualHintTimer);
  const hint = $("#ceremonyHint");
  hint.hidden = true;
  const text = phaseHint();
  if (!text) return;
  state.ritualHintTimer = setTimeout(() => {
    if ($("#voteCeremony").hidden) return;
    hint.textContent = text;
    hint.hidden = false;
  }, 5000);
}

function setRitualPhase(phase, { title, status, eyebrow } = {}) {
  state.ritualPhase = phase;
  const ceremony = $("#voteCeremony");
  ceremony.dataset.phase = phase;
  if (title || status || eyebrow) setCeremonyStatus(title || $("#ceremonyTitle").textContent, status || $("#ceremonyStatus").textContent, eyebrow || $("#ceremonyEyebrow").textContent);
  $("#ceremonyHint").hidden = true;
  scheduleCeremonyHint();
}

function styleUserPlanet() {
  const identity = state.session.identity || { name: "观测者", team: "未知队伍" };
  const seed = hashNumber(`${normalizeName(identity.name)}:${normalizeName(identity.team)}:${state.site?.settings?.eventSeed || "cosmos"}`);
  const selectedGames = state.ballot.gameIds.map((id) => state.gameById.get(id)).filter(Boolean);
  const palettes = selectedGames.map(corePalette);
  const coreHue = palettes[0]?.hue ?? (seed + 56) % 360;
  const coreHue2 = palettes[1]?.hue ?? palettes[0]?.hue2 ?? (seed + 112) % 360;
  const ceremony = $("#voteCeremony");
  ceremony.style.setProperty("--user-hue", seed % 360);
  ceremony.style.setProperty("--core-hue", coreHue);
  ceremony.style.setProperty("--core-hue-2", coreHue2);
  ceremony.style.setProperty("--vitality", selectedGames.length / 3);
  $("#ceremonyIdentity").textContent = `${identity.name} / ${identity.team}`;
}

function stopPersonalOrbit() {
  if (state.ritualOrbitFrame) cancelAnimationFrame(state.ritualOrbitFrame);
  state.ritualOrbitFrame = null;
}

function personalOrbitGeometry() {
  const system = $("#personalSystem");
  const rect = system.getBoundingClientRect();
  const width = system.clientWidth || rect.width;
  const height = system.clientHeight || rect.height;
  const scaleX = rect.width / Math.max(1, width);
  const scaleY = rect.height / Math.max(1, height);
  const radiusX = width * PERSONAL_ORBIT.radiusX;
  const radiusY = height * PERSONAL_ORBIT.radiusY;
  return {
    system,
    rect,
    width,
    height,
    scaleX,
    scaleY,
    radiusX,
    radiusY,
    entryX: width / 2 + Math.cos(PERSONAL_ORBIT.entryAngle) * radiusX,
    entryY: height / 2 + Math.sin(PERSONAL_ORBIT.entryAngle) * radiusY
  };
}

function elementCenterInPersonalSystem(element, geometry = personalOrbitGeometry()) {
  const rect = element.getBoundingClientRect();
  return {
    x: (rect.left + rect.width / 2 - geometry.rect.left) / Math.max(0.001, geometry.scaleX),
    y: (rect.top + rect.height / 2 - geometry.rect.top) / Math.max(0.001, geometry.scaleY)
  };
}

function arrivalOrbitAngle(time, arrival) {
  const elapsed = Math.max(0, time - arrival.startedAt);
  const decay = arrival.decay || PERSONAL_ORBIT.arrivalDecay;
  const boost = arrival.boost ?? PERSONAL_ORBIT.arrivalBoost;
  const accumulatedBoost = boost * decay * (1 - Math.exp(-elapsed / decay));
  return PERSONAL_ORBIT.entryAngle + ((elapsed + accumulatedBoost) / PERSONAL_ORBIT.duration) * Math.PI * 2;
}

function startPersonalOrbit() {
  stopPersonalOrbit();
  const system = $("#personalSystem");
  const orbit = (time) => {
    if ($("#voteCeremony").hidden || !system.isConnected) return stopPersonalOrbit();
    const geometry = personalOrbitGeometry();
    const nodes = $$('[data-personal-core]', system);
    const phase = state.reducedMotion ? 0 : (time / PERSONAL_ORBIT.duration) * Math.PI * 2;
    nodes.forEach((node, index) => {
      let angle = phase + (Math.PI * 2 * index / Math.max(nodes.length, 3)) - Math.PI / 2;
      if (node.dataset.handoff === "true") angle = PERSONAL_ORBIT.entryAngle;
      if (!state.reducedMotion && state.ritualArrival?.id === node.dataset.personalCore) angle = arrivalOrbitAngle(time, state.ritualArrival);
      const x = Math.cos(angle) * geometry.radiusX;
      const y = Math.sin(angle) * geometry.radiusY;
      node.style.left = "50%";
      node.style.top = "50%";
      node.style.transform = `translate(-50%, -50%) translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
    });
    if (!state.reducedMotion) state.ritualOrbitFrame = requestAnimationFrame(orbit);
  };
  state.ritualOrbitFrame = requestAnimationFrame(orbit);
}

function inspectPersonalCore(id) {
  const game = state.gameById.get(id);
  if (!game || state.ritualPhase === "replacement") return;
  state.ritualSelectedCoreId = id;
  $$('[data-personal-core]', $("#personalSystem")).forEach((node) => node.setAttribute("aria-pressed", String(node.dataset.personalCore === id)));
  $("#inspectorTitle").textContent = game.title;
  $("#inspectorTeam").textContent = game.team;
  $("#prepareReturn").disabled = state.site.votingState !== "open";
  $("#prepareReturn").textContent = state.site.votingState === "open" ? "归还核心" : "投票已经锁定";
  $("#coreInspector").hidden = false;
  $("#returnConfirm").hidden = true;
  scheduleCeremonyHint();
}

function renderPersonalSystem({ floatingId = "", handoffId = "", arrivalId = "" } = {}) {
  styleUserPlanet();
  const selected = state.ballot.gameIds.map((id) => state.gameById.get(id)).filter(Boolean);
  const layer = $("#personalCoreLayer");
  layer.innerHTML = selected.map((game) => {
    const palette = corePalette(game);
    return `<button class="personal-core" type="button" style="--hue:${palette.hue};--hue-2:${palette.hue2}" data-personal-core="${escapeHTML(game.id)}" data-handoff="${game.id === handoffId}" data-arrival="${game.id === arrivalId}" aria-pressed="false" aria-label="${escapeHTML(game.title)}，${escapeHTML(game.team)}"></button>`;
  }).join("");
  $$('[data-personal-core]', layer).forEach((button) => {
    button.addEventListener("pointerenter", () => inspectPersonalCore(button.dataset.personalCore));
    button.addEventListener("focus", () => inspectPersonalCore(button.dataset.personalCore));
    button.addEventListener("click", () => {
      const id = button.dataset.personalCore;
      if (state.ritualPhase === "replacement") submitRitualOperation({ addGameId: state.ritualGameId, removeGameId: id, mode: "replace" });
      else inspectPersonalCore(id);
    });
  });
  const floating = $("#floatingCore");
  floating.hidden = !floatingId;
  if (floatingId) applyCorePalette(floating, state.gameById.get(floatingId));
  $("#orbitEntryTarget").hidden = !floatingId;
  if (!floatingId) {
    $("#coreFlightPath").style.opacity = "";
    $("#coreFlightPath").style.width = "0";
  } else {
    requestAnimationFrame(positionCoreFlightGuide);
  }
  $("#ceremonyCapacity").textContent = `${selected.length}/3 颗核心正在公转`;
  startPersonalOrbit();
}

function positionCoreFlightGuide() {
  const system = $("#personalSystem");
  const floating = $("#floatingCore");
  const body = $(".floating-core-body", floating);
  const path = $("#coreFlightPath");
  const target = $("#orbitEntryTarget");
  if (!system || floating.hidden || !body || !path || !target) return;
  const geometry = personalOrbitGeometry();
  const start = elementCenterInPersonalSystem(body, geometry);
  const startX = start.x;
  const startY = start.y;
  const endX = geometry.entryX;
  const endY = geometry.entryY;
  const distance = Math.hypot(endX - startX, endY - startY);
  const angle = Math.atan2(endY - startY, endX - startX) * 180 / Math.PI;
  path.style.left = `${startX}px`;
  path.style.top = `${startY}px`;
  path.style.width = `${distance}px`;
  path.style.setProperty("--flight-length", `${Math.max(0, distance - 7)}px`);
  path.style.transform = `rotate(${angle}deg)`;
  target.style.left = `${endX}px`;
  target.style.top = `${endY}px`;
  target.hidden = false;
}

function refreshCeremonyGeometry() {
  cancelAnimationFrame(state.ritualResizeFrame);
  state.ritualResizeFrame = requestAnimationFrame(() => {
    const ceremony = $("#voteCeremony");
    if (!ceremony || ceremony.hidden || state.ritualPhase === "orbiting") return;
    if (!$("#floatingCore").hidden) positionCoreFlightGuide();
    startPersonalOrbit();
  });
}

async function animateCoreIntoOrbit(gameId) {
  const floating = $("#floatingCore");
  const body = $(".floating-core-body", floating);
  const target = $("#orbitEntryTarget");
  if (!floating || floating.hidden || !body || !target) return;
  positionCoreFlightGuide();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const geometry = personalOrbitGeometry();
  const start = elementCenterInPersonalSystem(body, geometry);
  const dx = geometry.entryX - start.x;
  const dy = geometry.entryY - start.y;
  const lift = Math.min(112, Math.max(58, Math.abs(dx) * 0.16));
  const duration = state.reducedMotion ? 180 : 1380;
  floating.disabled = true;
  state.ritualFlightAnimation?.cancel?.();
  state.ritualFlightAnimation = floating.animate([
    { transform: "translate(-50%, -50%) scale(1)", opacity: 1, offset: 0 },
    { transform: `translate(calc(-50% + ${dx * .22}px), calc(-50% + ${dy * .22 - lift * .7}px)) scale(1.06)`, opacity: 1, offset: .28 },
    { transform: `translate(calc(-50% + ${dx * .68}px), calc(-50% + ${dy * .68 - lift}px)) scale(.9)`, opacity: 1, offset: .7 },
    { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.72)`, opacity: .96, offset: 1 }
  ], { duration, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" });
  try {
    await state.ritualFlightAnimation.finished;
  } catch {}
  floating.hidden = true;
  target.hidden = true;
  state.ritualFlightAnimation?.cancel?.();
  state.ritualFlightAnimation = null;
  floating.disabled = false;
  state.ritualArrival = {
    id: gameId,
    startedAt: performance.now(),
    boost: state.reducedMotion ? 0 : PERSONAL_ORBIT.arrivalBoost,
    decay: state.reducedMotion ? 1 : PERSONAL_ORBIT.arrivalDecay
  };
  ritualVibrate(74);
  playRitualTone(196, 0.58, 0.06);
}

function showVoteCeremony() {
  setupCeremonyParticles();
  const ceremony = $("#voteCeremony");
  ceremony.hidden = false;
  document.body.classList.add("ceremony-open");
  $("#coreInspector").hidden = true;
  $("#returnConfirm").hidden = true;
  $("#ceremonySuccessActions").hidden = true;
}

function openVoteCeremony(id) {
  const game = state.gameById.get(id);
  if (!game) return;
  state.ritualGameId = id;
  state.ritualReturnContext = {
    sourceGameId: id,
    detailId: state.detailId,
    camera: state.detailReturnCamera ? { ...state.detailReturnCamera } : { ...state.camera }
  };
  state.ritualSelectedCoreId = "";
  state.ritualOperationId = "";
  showVoteCeremony();
  const palette = corePalette(game);
  const ceremony = $("#voteCeremony");
  ceremony.style.setProperty("--core-hue", palette.hue);
  ceremony.style.setProperty("--core-hue-2", palette.hue2);
  $("#ceremonySource").style.backgroundImage = `url("${String(game.coverUrl || "/assets/pass-texture.png").replace(/"/g, "%22")}")`;
  $("#ceremonyCoordinate").textContent = coordinateLabel(game);
  $("#extractProgress").textContent = "0%";
  $("#extractProgressSemantic")?.setAttribute("aria-valuenow", "0");
  ceremony.style.setProperty("--extract", 0);
  renderPersonalSystem();
  setRitualPhase("ready", {
    title: `提取《${game.title}》`,
    status: `持续按住三秒，从 ${game.team} 的作品行星中提取可能性核心。`,
    eyebrow: "可能性核心提取"
  });
  setTimeout(() => $("#extractHold").focus(), 0);
}

function openPersonalSystem() {
  if (!state.session.authenticated) {
    state.pendingBallotOpen = true;
    return openAuth();
  }
  state.ritualGameId = "";
  state.ritualReturnContext = null;
  state.ritualSelectedCoreId = "";
  $("#ceremonySource").style.backgroundImage = "none";
  $("#ceremonyCoordinate").textContent = "PRIVATE OBSERVATORY";
  showVoteCeremony();
  renderPersonalSystem();
  setRitualPhase("personal", {
    title: "我的可能性星系",
    status: state.ballot.gameIds.length ? "靠近或选择核心，查看对应作品并管理当前选票。" : "你的轨道仍然安静。探索作品，并带回你相信的可能性。",
    eyebrow: "私人观测空间"
  });
  setTimeout(() => $("#closeCeremony").focus(), 0);
}

function finishClosingCeremony() {
  const ceremony = $("#voteCeremony");
  ceremony.hidden = true;
  ceremony.dataset.phase = "idle";
  ceremony.style.setProperty("--extract", 0);
  document.body.classList.remove("ceremony-open");
  state.ritualPhase = "idle";
  state.ritualGameId = "";
  state.ritualSelectedCoreId = "";
  state.ritualOperationId = "";
  $("#ceremonySuccessActions").hidden = true;
  clearTimeout(state.ritualHintTimer);
  clearTimeout(state.ritualSuccessTimer);
  cancelAnimationFrame(state.ritualHoldFrame);
  cancelAnimationFrame(state.ritualResizeFrame);
  state.ritualFlightAnimation?.cancel?.();
  state.ritualFlightAnimation = null;
  state.ritualArrival = null;
  $("#orbitEntryTarget").hidden = true;
  stopPersonalOrbit();
  stopExtractionTone();
  ritualVibrate(0);
}

function closeVoteCeremony({ immediate = false } = {}) {
  const ceremony = $("#voteCeremony");
  if (!ceremony || ceremony.hidden) return;
  if (!immediate && ["submitting", "handoff", "orbiting"].includes(state.ritualPhase)) {
    $("#ceremonyHint").textContent = "观测站正在锁定选票，请等待本次信号确认。";
    $("#ceremonyHint").hidden = false;
    return;
  }
  if (!immediate && ["floating", "replacement"].includes(state.ritualPhase)) {
    setRitualPhase("returning", { title: "核心正在返航", status: "尚未生效的可能性核心正在返回作品行星。", eyebrow: "取消提取" });
    setTimeout(finishClosingCeremony, state.reducedMotion ? 0 : 760);
    return;
  }
  finishClosingCeremony();
}

function continueExplorationFromCeremony() {
  const context = state.ritualReturnContext;
  finishClosingCeremony();
  if (state.detailId) {
    closeDetail();
    return;
  }
  if (context?.camera) {
    state.cameraDestination = { ...context.camera, mode: "free" };
    if (state.reducedMotion) state.camera = { ...state.cameraDestination };
  }
  if (context?.sourceGameId) setTarget(context.sourceGameId);
  state.canvas?.focus();
}

function returnToWorkFromCeremony() {
  const context = state.ritualReturnContext;
  finishClosingCeremony();
  if (state.detailId) {
    $("#detailVote")?.focus();
    return;
  }
  if (context?.sourceGameId) {
    setTarget(context.sourceGameId);
    navigateToGame(context.sourceGameId);
  }
  state.canvas?.focus();
}

function stayInPersonalSystem() {
  $("#ceremonySuccessActions").hidden = true;
  renderPersonalSystem();
  setRitualPhase("personal", {
    title: "我的可能性星系",
    status: "靠近或选择核心，查看对应作品并管理当前选票。",
    eyebrow: "私人观测空间"
  });
  $("#closeCeremony").focus();
}

function updateExtractionProgress(time) {
  if (state.ritualPhase !== "extracting") return;
  const progress = clamp((time - state.ritualHoldStartedAt) / 3000, 0, 1);
  $("#voteCeremony").style.setProperty("--extract", progress.toFixed(4));
  $("#extractProgress").textContent = `${Math.round(progress * 100)}%`;
  $("#extractProgressSemantic")?.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  const hapticStep = Math.min(4, Math.floor(progress * 4));
  if (hapticStep > state.ritualHapticStep) {
    state.ritualHapticStep = hapticStep;
    ritualVibrate(5 + hapticStep * 7);
  }
  if (progress >= 1) return completeExtraction();
  state.ritualHoldFrame = requestAnimationFrame(updateExtractionProgress);
}

function beginExtraction(event) {
  if (state.ritualPhase !== "ready") return;
  if (event?.type === "pointerdown" && event.button !== 0) return;
  event?.preventDefault?.();
  $("#ceremonyHint").hidden = true;
  state.ritualHoldStartedAt = performance.now();
  state.ritualHapticStep = 0;
  setRitualPhase("extracting", { title: "正在提取可能性", status: "保持稳定。松开会让提取进度回退。", eyebrow: "引力信号增强" });
  startExtractionTone();
  state.ritualHoldFrame = requestAnimationFrame(updateExtractionProgress);
}

function cancelExtraction() {
  if (state.ritualPhase !== "extracting") return;
  cancelAnimationFrame(state.ritualHoldFrame);
  stopExtractionTone();
  ritualVibrate(0);
  $("#voteCeremony").style.setProperty("--extract", 0);
  $("#extractProgress").textContent = "0%";
  $("#extractProgressSemantic")?.setAttribute("aria-valuenow", "0");
  setRitualPhase("ready", { title: `提取《${state.gameById.get(state.ritualGameId)?.title || "可能性核心"}》`, status: "提取已回退。持续按住三秒可以重新开始。", eyebrow: "信号已经恢复" });
}

function completeExtraction() {
  if (state.ritualPhase !== "extracting") return;
  cancelAnimationFrame(state.ritualHoldFrame);
  stopExtractionTone();
  ritualVibrate(46);
  playRitualTone(122, 0.42, 0.06);
  renderPersonalSystem({ floatingId: state.ritualGameId });
  setRitualPhase("floating", {
    title: "可能性核心已脱离",
    status: "这张票尚未生效。点击画面中标记为“待入轨核心”的天体，它会沿引导航迹进入右侧接入点。",
    eyebrow: "等待第二次确认"
  });
  setTimeout(() => $("#floatingCore").focus(), state.reducedMotion ? 0 : 900);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBallotOperation(payload, deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const remaining = deadline - Date.now();
    const timeout = setTimeout(() => controller.abort(), Math.min(4200, Math.max(300, remaining)));
    try {
      return await fetchJSON("/api/ballot", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      lastError = error;
      if (error.status && error.status < 500) throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (Date.now() < deadline) await sleep(Math.min(900, deadline - Date.now()));
  }
  const timeoutError = new Error(lastError?.message || "观测站在十五秒内没有回应。");
  timeoutError.code = "RITUAL_TIMEOUT";
  throw timeoutError;
}

async function syncBallot() {
  if (!state.session.authenticated) return;
  try {
    const result = await fetchJSON("/api/ballot");
    state.ballot = result.ballot;
    updateAccountUI();
    updateDetailVoteButton();
    if (!$("#voteCeremony").hidden && state.ritualPhase === "personal") renderPersonalSystem();
  } catch {}
}

async function submitRitualOperation({ addGameId = "", removeGameId = "", mode = "add" }) {
  if (["submitting", "handoff"].includes(state.ritualPhase)) return;
  const operationId = state.ritualOperationId || newOperationId();
  state.ritualOperationId = operationId;
  const isReplace = mode === "replace";
  const isReturn = mode === "return";
  if (isReplace) {
    renderPersonalSystem({ floatingId: addGameId, handoffId: removeGameId });
    setRitualPhase("handoff", { title: "核心正在交接", status: "新旧核心在轨道边缘等待观测站完成原子替换。", eyebrow: "选票交换中" });
  } else {
    setRitualPhase("submitting", {
      title: isReturn ? "正在解除轨道" : "正在锁定轨道",
      status: isReturn ? "旧核心会在撤回确认后返航。" : "可能性核心正在轨道外等待观测站确认。",
      eyebrow: isReturn ? "归还确认中" : "选票提交中"
    });
  }
  try {
    const result = await fetchBallotOperation({
      operationId,
      addGameId: addGameId || undefined,
      removeGameId: removeGameId || undefined,
      version: state.ballot.version
    }, Date.now() + 15000);
    const before = [...state.ballot.gameIds];
    state.ballot = result.ballot;
    state.lastBallotChange = { added: addGameId || null, removed: removeGameId || null, at: Date.now() };
    state.ritualOperationId = "";
    updateAccountUI();
    updateDetailVoteButton();
    if (isReturn) {
      ritualVibrate(72);
      playRitualTone(184, 0.62, 0.065);
      if (mode === "return" && $("#voteCeremony").hidden) runVoteRitual({ removed: removeGameId });
      if (!$("#voteCeremony").hidden) {
        renderPersonalSystem();
        setRitualPhase("personal", { title: "可能性核心已归还", status: "轨道已经释放。投票截止前仍可再次选择这款作品。", eyebrow: "归还完成" });
      }
      showToast("可能性核心已经归还，选票已撤回。" );
      return true;
    }
    setRitualPhase("orbiting", {
      title: isReplace ? "新核心正在完成交接" : "可能性核心正在入轨",
      status: isReplace ? "观测站已确认替换。新核心正沿引导航迹接管旧核心释放的轨道。" : "观测站已确认选票。核心正沿引导航迹飞向轨道接入点。",
      eyebrow: isReplace ? "轨道交接" : "入轨序列"
    });
    await animateCoreIntoOrbit(addGameId);
    renderPersonalSystem({ arrivalId: addGameId });
    setRitualPhase("success", { title: "可能性核心已入轨", status: "这一票已经生效。核心正在把作品的光谱注入你的行星。", eyebrow: `${state.ballot.gameIds.length}/3 轨道已占用` });
    $("#ceremonySuccessActions").hidden = true;
    clearTimeout(state.ritualSuccessTimer);
    state.ritualSuccessTimer = setTimeout(() => {
      $("#ceremonySuccessActions").hidden = false;
      $("#ceremonyContinue").focus();
    }, state.reducedMotion ? 400 : 4000);
    if (before.length !== state.ballot.gameIds.length || isReplace) showToast("选票已生效，可能性核心正在你的星系中公转。" );
    return true;
  } catch (error) {
    state.ritualOperationId = "";
    if (error.code === "LOGIN_REQUIRED") {
      const pendingGameId = state.ritualGameId;
      state.session = { authenticated: false, identity: null, selfBlockedGameIds: [] };
      finishClosingCeremony();
      openAuth(pendingGameId);
      return false;
    }
    if (["BALLOT_VERSION_CONFLICT", "BALLOT_TARGET_CHANGED", "VOTE_LIMIT"].includes(error.code) && error.body?.ballot) {
      state.ballot = error.body.ballot;
      updateAccountUI();
      updateDetailVoteButton();
      renderPersonalSystem();
      setRitualPhase("personal", { title: "轨道状态已经同步", status: "另一台设备修改了选票。请查看最新核心后重新操作。", eyebrow: "选票版本更新" });
      showToast(error.message);
      return false;
    }
    if (error.code === "RITUAL_TIMEOUT") {
      renderPersonalSystem({ floatingId: addGameId });
      setRitualPhase("returning", { title: "信号未能锁定", status: "十五秒内没有收到确认，核心正在返回作品行星。", eyebrow: "自动归还" });
      showToast("信号未能锁定，可能性核心已经返回。" );
      setTimeout(() => closeVoteCeremony({ immediate: true }), state.reducedMotion ? 250 : 900);
      setTimeout(syncBallot, 4500);
      return false;
    }
    renderPersonalSystem({ floatingId: addGameId });
    setRitualPhase(addGameId ? "floating" : "personal", { title: "轨道锁定失败", status: error.message, eyebrow: "操作没有生效" });
    showToast(error.message);
    return false;
  }
}

function activateFloatingCore() {
  if (state.ritualPhase !== "floating") return;
  if (state.ballot.gameIds.length >= 3) {
    renderPersonalSystem({ floatingId: state.ritualGameId });
    setRitualPhase("replacement", { title: "选择一颗旧核心", status: "新核心会与选中的旧核心在轨道边缘完成交接。", eyebrow: "三条轨道已经占满" });
    const first = $('[data-personal-core]', $("#personalSystem"));
    first?.focus();
    return;
  }
  submitRitualOperation({ addGameId: state.ritualGameId, mode: "add" });
}

function openReturnVoteConfirm(id) {
  const game = state.gameById.get(id);
  if (!game || !state.ballot.gameIds.includes(id)) return;
  const layer = $("#returnVoteConfirm");
  state.detailReturnId = id;
  state.detailReturnOriginFocus = document.activeElement;
  applyCorePalette($("#returnVoteCore"), game);
  $("#returnVoteGame").textContent = `《${game.title}》 / ${game.team}`;
  $("#returnVoteDescription").textContent = "确认后，这颗核心会返回作品行星，对应选票立即撤回。投票截止前仍可重新选择。";
  $("#returnVoteStatus").textContent = "";
  $("#confirmReturnVote").disabled = false;
  $("#confirmReturnVote").textContent = "确认归还核心";
  layer.dataset.busy = "false";
  layer.hidden = false;
  requestAnimationFrame(() => $("#cancelReturnVote").focus());
}

function closeReturnVoteConfirm({ restoreFocus = true, force = false } = {}) {
  const layer = $("#returnVoteConfirm");
  if (layer.hidden || (!force && layer.dataset.busy === "true")) return;
  layer.hidden = true;
  state.detailReturnId = "";
  if (restoreFocus) state.detailReturnOriginFocus?.focus?.();
  state.detailReturnOriginFocus = null;
}

async function confirmReturnVote() {
  const id = state.detailReturnId;
  if (!id) return;
  const layer = $("#returnVoteConfirm");
  const confirmButton = $("#confirmReturnVote");
  layer.dataset.busy = "true";
  confirmButton.disabled = true;
  confirmButton.textContent = "正在归还";
  $("#returnVoteStatus").textContent = "正在解除轨道锁定，请稍候。";
  const succeeded = await requestDirectReturn(id);
  layer.dataset.busy = "false";
  if (succeeded) {
    layer.hidden = true;
    state.detailReturnId = "";
    state.detailReturnOriginFocus = null;
    return;
  }
  confirmButton.disabled = false;
  confirmButton.textContent = "重新尝试归还";
  $("#returnVoteStatus").textContent = "归还没有完成，请检查网络后重试。";
  confirmButton.focus();
}

async function requestDirectReturn(id) {
  const game = state.gameById.get(id);
  if (!game) return false;
  const operationId = newOperationId();
  try {
    const result = await fetchBallotOperation({ operationId, removeGameId: id, version: state.ballot.version }, Date.now() + 15000);
    state.ballot = result.ballot;
    state.lastBallotChange = { added: null, removed: id, at: Date.now() };
    updateAccountUI();
    updateDetailVoteButton();
    runVoteRitual({ removed: id });
    showToast("可能性核心已经归还，选票已撤回。" );
    return true;
  } catch (error) {
    if (error.body?.ballot) state.ballot = error.body.ballot;
    updateAccountUI();
    updateDetailVoteButton();
    showToast(error.message);
    setTimeout(syncBallot, 4500);
    return false;
  }
}

async function updateBallot(gameIds) {
  const before = [...state.ballot.gameIds];
  try {
    const result = await fetchJSON("/api/ballot", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameIds, version: state.ballot.version })
    });
    state.ballot = result.ballot;
    const added = gameIds.find((id) => !before.includes(id));
    const removed = before.find((id) => !gameIds.includes(id));
    state.lastBallotChange = { added, removed, at: Date.now() };
    state.pendingReplacementId = "";
    state.pendingBallotRetry = null;
    $("#ballotConflict").hidden = true;
    updateAccountUI();
    renderBallot();
    updateDetailVoteButton();
    runVoteRitual({ added, removed });
    showToast(result.message);
    return true;
  } catch (error) {
    if (error.code === "LOGIN_REQUIRED") {
      state.session = { authenticated: false, identity: null, selfBlockedGameIds: [] };
      updateAccountUI();
      openAuth();
    }
    if (error.code === "BALLOT_VERSION_CONFLICT" && error.body?.ballot) {
      state.pendingBallotRetry = [...gameIds];
      state.ballot = error.body.ballot;
      updateAccountUI();
      renderBallot();
      $("#ballotConflict").hidden = false;
      openDialog($("#ballotDialog"));
    }
    showToast(error.message);
    return false;
  }
}

async function toggleVote(id) {
  const game = state.gameById.get(id);
  if (!game) return;
  if (state.site.votingState !== "open") return showToast(votingCopy().label);
  if (!state.session.authenticated) return openAuth(id);
  if (state.ballot.gameIds.includes(id)) return openReturnVoteConfirm(id);
  if (isSelfGame(game)) return showToast(`你参与了《${game.title}》的制作，不能为自己的作品投票。`);
  openVoteCeremony(id);
}

async function replaceVote(oldId) {
  const replacement = state.pendingReplacementId;
  if (!replacement || !state.ballot.gameIds.includes(oldId)) return;
  const next = state.ballot.gameIds.map((id) => id === oldId ? replacement : id);
  await updateBallot(next);
}

function runVoteRitual({ added, removed }) {
  const id = added || removed;
  const game = state.gameById.get(id);
  if (!game) return;
  const ritual = $("#voteRitual");
  const orb = $("i", ritual);
  const label = $("span", ritual);
  const ballotRect = $("#ballotButton").getBoundingClientRect();
  const gamePoint = worldToScreen(worldPoint(game));
  const start = added
    ? { x: gamePoint.x, y: gamePoint.y }
    : { x: ballotRect.left + ballotRect.width / 2, y: ballotRect.top + ballotRect.height / 2 };
  const end = added
    ? { x: ballotRect.left + ballotRect.width / 2, y: ballotRect.top + ballotRect.height / 2 }
    : { x: gamePoint.x, y: gamePoint.y };
  applyCorePalette(orb, game || { id: removed || added || "unknown" });
  label.textContent = added ? "选票进入个人星系" : "选票返回宇宙";
  ritual.hidden = false;
  ritual.style.left = `${start.x}px`;
  ritual.style.top = `${start.y}px`;
  const duration = state.reducedMotion ? 120 : 760;
  const animation = ritual.animate([
    { transform: "translate(-50%, -50%) scale(0.72)", opacity: 0 },
    { offset: 0.16, transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
    { transform: `translate(calc(-50% + ${end.x - start.x}px), calc(-50% + ${end.y - start.y}px)) scale(0.34)`, opacity: 0.25 }
  ], { duration, easing: "cubic-bezier(.16,1,.3,1)" });
  animation.finished.finally(() => {
    ritual.hidden = true;
    $("#ballotButton").classList.remove("vote-received");
    requestAnimationFrame(() => $("#ballotButton").classList.add("vote-received"));
  });
}

function renderBallot() {
  if (!state.session.authenticated) return;
  const selected = state.ballot.gameIds.map((id) => state.gameById.get(id)).filter(Boolean);
  const slots = Array.from({ length: 3 }, (_, index) => selected[index] || null);
  $("#ballotOrbits").innerHTML = slots.map((game, index) => game ? `
    <article class="ballot-slot ${state.lastBallotChange?.added === game.id ? "just-added" : ""}">
      <img src="${escapeHTML(game.coverUrl || "/assets/pass-texture.png")}" alt="" />
      <strong>${escapeHTML(game.title)}</strong>
      ${state.pendingReplacementId
        ? `<button class="replace-vote" type="button" data-replace-vote="${escapeHTML(game.id)}">替换为当前作品</button>`
        : `<button type="button" data-remove-vote="${escapeHTML(game.id)}">撤回</button>`}
    </article>
  ` : `
    <article class="ballot-slot empty">
      <span>空轨道</span>
      <strong>还可以选择作品</strong>
      <span>${index + 1}/3</span>
    </article>
  `).join("");
  $$('[data-remove-vote]', $("#ballotOrbits")).forEach((button) => button.addEventListener("click", () => toggleVote(button.dataset.removeVote)));
  $$('[data-replace-vote]', $("#ballotOrbits")).forEach((button) => button.addEventListener("click", () => replaceVote(button.dataset.replaceVote)));
  const identity = state.session.identity;
  $("#ballotIdentity").textContent = `${identity.name} / ${identity.team} / ${identity.email}`;
  const unexplored = Math.max(0, state.games.length - state.visited.size);
  $("#unexploredNote").textContent = unexplored
    ? `仍有 ${unexplored} 款作品尚未在这台设备上查看。你仍然可以保留或修改当前选票。`
    : "这台设备已经查看全部作品。投票截止前仍可随时修改。";
  if (!state.pendingReplacementId) setMessage($("#ballotMessage"), "");
}

function clearExploration() {
  if (!confirm("只清除这台设备上的探索记录与巡航顺序，云端选票不会改变。继续吗？")) return;
  state.visited.clear();
  state.resolved.clear();
  state.routeIds = shuffle(state.games.map((game) => game.id));
  state.routeIndex = 0;
  state.pendingReplacementId = "";
  stopRoute();
  setTarget("");
  resetView(true);
  updateExplorationUI();
  writeLocalState();
  renderBallot();
  showToast("本机探索记录已经清除，云端选票保持不变。");
}

function openBallot() {
  openPersonalSystem();
}

function closeBallotDialog() {
  state.pendingReplacementId = "";
  if (state.session.authenticated) renderBallot();
  closeDialog($("#ballotDialog"));
}

function updateAccountUI() {
  const authenticated = state.session.authenticated;
  $("#loginButton").textContent = authenticated ? state.session.identity.name : "登录";
  $("#ballotCount").textContent = `${state.ballot.gameIds.length}/3`;
}

function renderAccessibleIndex() {
  $("#accessibleGameList").innerHTML = state.games.map((game) => {
    const known = !state.ctx || state.resolved.has(game.id) || state.site?.resultsVisible;
    return `
    <button type="button" data-accessible-game="${escapeHTML(game.id)}" aria-label="${escapeHTML(known ? `${game.title}，${game.team}，坐标 ${coordinateLabel(game)}` : `未知作品，坐标 ${coordinateLabel(game)}`)}">
      <img src="${escapeHTML(game.coverUrl || "/assets/pass-texture.png")}" alt="" />
      <span><strong>${escapeHTML(known ? game.title : "未知作品")}${known && game.lateSubmission ? ` <em class="late-badge">补交</em>` : ""}</strong><small>${escapeHTML(known ? game.team : "尚未完成身份解析")}</small></span>
      <code>${escapeHTML(coordinateLabel(game))}</code>
    </button>
  `;
  }).join("");
  $$('[data-accessible-game]').forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.accessibleGame;
    if (!state.ctx) openDetail(id);
    else {
      setTarget(id);
      navigateToGame(id);
      state.canvas?.focus();
    }
  }));
}

function renderResults() {
  if (!state.site.resultsVisible) return;
  const winners = state.site.winnerIds.map((id) => state.gameById.get(id)).filter(Boolean);
  $("#winnerList").innerHTML = winners.map((game) => `
    <article class="winner-item">
      <img src="${escapeHTML(game.coverUrl || "/assets/pass-texture.png")}" alt="" />
      <div><strong>${escapeHTML(game.title)}</strong><span>${escapeHTML(game.team)}</span></div>
    </article>
  `).join("");
  $("#resultSummary").textContent = `${state.site.totalVoters || 0} 位玩家参与投票，${state.site.constellationIds.length} 款作品组成最终星座。`;
  $("#ignitionWinners").innerHTML = winners.map((game, index) => `
    <article style="--ignition-order:${index}">
      <span>同等级玩家之声奖</span>
      <strong>${escapeHTML(game.title)}</strong>
      <small>${escapeHTML(game.team)}</small>
    </article>
  `).join("");
}

function showResultIgnition() {
  const ignition = $("#resultIgnition");
  state.resultEntered = false;
  state.resultRevealStart = 0;
  state.resultRevealProgress = 0;
  ignition.hidden = false;
  ignition.classList.remove("leaving");
  requestAnimationFrame(() => ignition.classList.add("visible"));
  $("#enterResultUniverse").focus();
}

function enterResultUniverse() {
  const ignition = $("#resultIgnition");
  ignition.classList.add("leaving");
  state.resultEntered = true;
  state.resultRevealStart = performance.now();
  state.resultRevealProgress = state.reducedMotion ? 1 : 0;
  resetView(true);
  setTimeout(() => {
    ignition.hidden = true;
    ignition.classList.remove("visible", "leaving");
    $("#resultConsole").hidden = false;
    if (state.resultReturnTarget && state.gameById.has(state.resultReturnTarget)) {
      setTarget(state.resultReturnTarget);
      navigateToGame(state.resultReturnTarget, 1.28);
      state.resultReturnTarget = "";
    }
    state.canvas.focus();
  }, state.reducedMotion ? 0 : 820);
}

function createResultShareCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#171a17";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(232,235,227,.22)";
  ctx.strokeRect(34, 34, 1132, 562);
  ctx.fillStyle = "#a9aea3";
  ctx.font = "22px Cascadia Mono, monospace";
  ctx.fillText(state.site.settings.eventTitle, 76, 92);
  ctx.fillStyle = "#e8ebe3";
  ctx.font = "800 66px Bahnschrift, Arial Narrow, sans-serif";
  ctx.fillText("玩家之声", 72, 174);
  ctx.fillStyle = "#bdd55b";
  ctx.font = "700 26px Microsoft YaHei, sans-serif";
  ctx.fillText(state.site.settings.slogan, 76, 220);

  const constellation = state.site.constellationIds.map((id) => state.gameById.get(id)).filter(Boolean);
  const positions = constellation.map((game, index) => ({
    game,
    x: 690 + Math.cos(index / Math.max(1, constellation.length) * Math.PI * 2 - 0.7) * (180 + (index % 2) * 65),
    y: 320 + Math.sin(index / Math.max(1, constellation.length) * Math.PI * 2 - 0.7) * (150 + (index % 2) * 45)
  }));
  ctx.strokeStyle = "rgba(189,213,91,.55)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  positions.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  if (positions.length > 2) ctx.lineTo(positions[0].x, positions[0].y);
  ctx.stroke();
  positions.forEach((point) => {
    const winner = state.site.winnerIds.includes(point.game.id);
    ctx.fillStyle = winner ? "#bdd55b" : "#e8ebe3";
    ctx.beginPath();
    ctx.arc(point.x, point.y, winner ? 11 : 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `${winner ? 700 : 500} 18px Microsoft YaHei, sans-serif`;
    ctx.fillText(point.game.title, point.x + 17, point.y + 6);
  });

  const winners = state.site.winnerIds.map((id) => state.gameById.get(id)).filter(Boolean);
  winners.forEach((game, index) => {
    ctx.fillStyle = "#a9aea3";
    ctx.font = "18px Cascadia Mono, monospace";
    ctx.fillText("同等级玩家之声奖", 76, 312 + index * 112);
    ctx.fillStyle = "#e8ebe3";
    ctx.font = "750 34px Microsoft YaHei, sans-serif";
    ctx.fillText(game.title, 76, 354 + index * 112);
    ctx.fillStyle = "#a9aea3";
    ctx.font = "20px Microsoft YaHei, sans-serif";
    ctx.fillText(game.team, 76, 386 + index * 112);
  });
  return canvas;
}

async function shareResults() {
  const canvas = createResultShareCanvas();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return showToast("结果图片生成失败，请稍后再试。");
  const file = new File([blob], "suyo-minigame-player-voice.png", { type: "image/png" });
  try {
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title: "溯造 MiniGame 玩家之声", text: state.site.settings.slogan, files: [file] });
    } else {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      showToast("玩家之声结果图已经生成。");
    }
  } catch (error) {
    if (error.name !== "AbortError") showToast("暂时无法分享结果图片。");
  }
}

function updateHeader() {
  const settings = state.site.settings;
  const copy = votingCopy();
  $("#eventTitle").textContent = settings.eventTitle;
  $("#eventTheme").textContent = `主题：${settings.theme}`;
  $("#statusLabel").textContent = copy.label;
  $("#observerStatus").dataset.state = state.site.votingState;
  $("#deadlineLabel").textContent = state.site.votingState === "published" ? formatDate(state.site.publishedAt) : formatDate(state.site.votingState === "upcoming" ? settings.startAt : settings.endAt);

  $("#posterEvent").textContent = settings.eventTitle;
  $("#posterTheme").textContent = settings.theme;
  const sloganParts = String(settings.slogan || "溯求本源，造物不止").split(/[，,]/);
  $("#posterSlogan").innerHTML = sloganParts.length > 1
    ? `<span>${escapeHTML(sloganParts[0])}，</span><span>${escapeHTML(sloganParts.slice(1).join("，"))}</span>`
    : `<span>${escapeHTML(settings.slogan)}</span>`;
  $("#posterGameCount").textContent = String(state.games.length).padStart(2, "0");
  $("#posterTimeLabel").textContent = copy.timeLabel;
  $("#posterDeadline").textContent = state.site.votingState === "published" ? formatDate(state.site.publishedAt) : formatDate(state.site.votingState === "upcoming" ? settings.startAt : settings.endAt);
  $("#launchLabel").textContent = "开始观测";
  $("#launchButton").disabled = false;
  $("#mapLoading").hidden = true;
}

function showNavigationHint() {
  const hint = $("#navigationHint");
  hint.hidden = false;
  requestAnimationFrame(() => hint.classList.add("visible"));
  clearTimeout(state.navigationHintTimer);
  state.navigationHintTimer = setTimeout(dismissNavigationHint, state.reducedMotion ? 1800 : 6500);
}

function dismissNavigationHint() {
  const hint = $("#navigationHint");
  if (!hint || hint.hidden) return;
  clearTimeout(state.navigationHintTimer);
  hint.classList.remove("visible");
  setTimeout(() => { hint.hidden = true; }, state.reducedMotion ? 0 : 260);
}

function launchObservatory() {
  if (!state.site || state.launched) return;
  state.launched = true;
  $("#observerShell").setAttribute("aria-hidden", "false");
  const poster = $("#launchPoster");
  poster.classList.add("opening");
  setTimeout(() => {
    poster.hidden = true;
    poster.classList.remove("opening");
    state.canvas.focus();
    showNavigationHint();
    if (state.deepLinkId && state.gameById.has(state.deepLinkId)) {
      setTarget(state.deepLinkId);
      navigateToGame(state.deepLinkId, 1.25);
      if (state.site.resultsVisible) state.resultReturnTarget = state.deepLinkId;
      state.deepLinkId = "";
    }
    if (state.site.resultsVisible) showResultIgnition();
  }, state.reducedMotion ? 0 : 930);
}

function replayPoster() {
  state.launched = false;
  const poster = $("#launchPoster");
  poster.hidden = false;
  poster.classList.remove("opening");
  $("#observerShell").setAttribute("aria-hidden", "true");
  $("#launchButton").focus();
}

function bindUI() {
  $("#launchButton").addEventListener("click", launchObservatory);
  $("#replayPoster").addEventListener("click", replayPoster);
  $("#openTarget").addEventListener("click", approachOrOpenTarget);
  $("#closeDetail").addEventListener("click", closeDetail);
  $("#shareGame").addEventListener("click", shareCurrentGame);
  $("#detailVote").addEventListener("click", () => state.detailId && toggleVote(state.detailId));
  $("#searchButton").addEventListener("click", openSearch);
  $("#searchInput").addEventListener("input", (event) => renderSearch(event.target.value));
  $("#routeButton").addEventListener("click", startRoute);
  $("#routePause").addEventListener("click", toggleRoutePause);
  $("#routeSkip").addEventListener("click", skipRouteTarget);
  $("#routeExit").addEventListener("click", () => stopRoute("已退出自动浏览。"));
  $("#resetViewButton").addEventListener("click", () => resetView(true));
  bindDollyButton($("#zoomIn"), 1);
  bindDollyButton($("#zoomOut"), -1);
  $("#performanceButton").addEventListener("click", () => {
    const tiers = ["full", "standard", "low"];
    state.performanceTier = tiers[(tiers.indexOf(state.performanceTier) + 1) % tiers.length];
    state.lowModeManual = true;
    createStars();
    applyPerformanceMode();
    updatePreviewVideo();
    writeLocalState();
    showToast(`已切换为${performanceLabel(state.performanceTier)}画质。`);
  });
  $("#planetPreview").addEventListener("timeupdate", (event) => {
    if (event.currentTarget.currentTime >= 8) event.currentTarget.currentTime = 0;
  });
  $("#loginButton").addEventListener("click", () => state.session.authenticated ? openPersonalSystem() : openAuth());
  $("#ballotButton").addEventListener("click", openBallot);
  $("#cancelReturnVote").addEventListener("click", () => closeReturnVoteConfirm());
  $("#cancelReturnVoteBackdrop").addEventListener("click", () => closeReturnVoteConfirm());
  $("#confirmReturnVote").addEventListener("click", confirmReturnVote);
  $("#closeCeremony").addEventListener("click", () => closeVoteCeremony());
  $("#ceremonyContinue").addEventListener("click", continueExplorationFromCeremony);
  $("#ceremonyReturnWork").addEventListener("click", returnToWorkFromCeremony);
  $("#ceremonyStay").addEventListener("click", stayInPersonalSystem);
  $("#floatingCore").addEventListener("click", activateFloatingCore);
  $("#ceremonySound").addEventListener("click", () => {
    state.ritualMuted = !state.ritualMuted;
    $("#ceremonySound").setAttribute("aria-pressed", String(state.ritualMuted));
    $("#ceremonySound").textContent = `仪式声音：${state.ritualMuted ? "关" : "开"}`;
    if (state.ritualMuted) stopExtractionTone();
    else playRitualTone(156, 0.18, 0.035);
  });
  const extractHold = $("#extractHold");
  extractHold.addEventListener("pointerdown", (event) => {
    extractHold.setPointerCapture?.(event.pointerId);
    beginExtraction(event);
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) => extractHold.addEventListener(type, cancelExtraction));
  extractHold.addEventListener("contextmenu", (event) => event.preventDefault());
  extractHold.addEventListener("keydown", (event) => {
    if (![" ", "Enter"].includes(event.key) || event.repeat) return;
    beginExtraction(event);
  });
  extractHold.addEventListener("keyup", (event) => {
    if ([" ", "Enter"].includes(event.key)) cancelExtraction();
  });
  $("#prepareReturn").addEventListener("click", () => {
    if (!state.ritualSelectedCoreId || state.site.votingState !== "open") return;
    $("#returnConfirm").hidden = false;
    $("#coreInspector").hidden = true;
    $("#confirmReturn").focus();
  });
  $("#cancelReturn").addEventListener("click", () => {
    $("#returnConfirm").hidden = true;
    if (state.ritualSelectedCoreId) inspectPersonalCore(state.ritualSelectedCoreId);
  });
  $("#confirmReturn").addEventListener("click", () => {
    const id = state.ritualSelectedCoreId;
    if (!id) return;
    $("#returnConfirm").hidden = true;
    submitRitualOperation({ removeGameId: id, mode: "return" });
  });
  $("#inspectGame").addEventListener("click", () => {
    const id = state.ritualSelectedCoreId;
    if (!id) return;
    closeVoteCeremony({ immediate: true });
    const beginReturnFlight = () => {
      setTarget(id);
      navigateToGame(id);
      state.canvas?.focus();
    };
    if (state.detailId) {
      closeDetail();
      window.setTimeout(beginReturnFlight, state.prefersReducedMotion ? 30 : 720);
    } else {
      beginReturnFlight();
    }
  });
  $("#closeAuth").addEventListener("click", () => closeDialog($("#authDialog")));
  $("#authForm").addEventListener("submit", verifyAuth);
  $("#sendCodeButton").addEventListener("click", sendCode);
  $("#closeBallot").addEventListener("click", closeBallotDialog);
  $("#logoutButton").addEventListener("click", logout);
  $("#clearExploration").addEventListener("click", clearExploration);
  $("#acceptServerBallot").addEventListener("click", () => {
    state.pendingBallotRetry = null;
    $("#ballotConflict").hidden = true;
    showToast("已保留服务器上的最新选票。");
  });
  $("#retryBallotChange").addEventListener("click", async () => {
    const retry = state.pendingBallotRetry;
    if (!retry) return;
    $("#ballotConflict").hidden = true;
    await updateBallot(retry);
  });
  $("#ballotExplore").addEventListener("click", () => {
    closeDialog($("#ballotDialog"));
    startRoute();
  });
  $("#closeResults").addEventListener("click", () => { $("#resultConsole").hidden = true; });
  $("#shareResults").addEventListener("click", shareResults);
  $("#enterResultUniverse").addEventListener("click", enterResultUniverse);
  [$("#searchDialog"), $("#authDialog"), $("#ballotDialog")].forEach((dialog) => dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog === $("#ballotDialog") ? closeBallotDialog() : closeDialog(dialog);
  }));
  document.addEventListener("keydown", (event) => {
    const returnConfirm = $("#returnVoteConfirm");
    if (!returnConfirm.hidden) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeReturnVoteConfirm();
        return;
      }
      if (event.key === "Tab") {
        const focusable = $$('button:not([disabled])', returnConfirm).filter((element) => !element.hidden && element.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
      return;
    }
    const ceremony = $("#voteCeremony");
    if (event.key === "Escape" && !ceremony.hidden) {
      event.preventDefault();
      closeVoteCeremony();
      return;
    }
    if (event.key === "Tab" && !ceremony.hidden) {
      const focusable = $$('button:not([disabled])', ceremony).filter((element) => !element.hidden && element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    const detail = $("#planetDetail");
    if (event.key === "Escape" && state.detailId && !state.landing) closeDetail();
    if (event.key !== "Tab" || detail.hidden || !detail.classList.contains("visible")) return;
    const focusable = $$('button:not([disabled]), a[href], video[controls]', detail).filter((element) => !element.hidden);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelExtraction();
      stopPersonalOrbit();
    } else if (!$("#voteCeremony").hidden) {
      startPersonalOrbit();
      if (["personal", "success"].includes(state.ritualPhase)) syncBallot();
    }
  });
  window.addEventListener("online", syncBallot);
  window.visualViewport?.addEventListener("resize", refreshCeremonyGeometry, { passive: true });
  window.addEventListener("orientationchange", refreshCeremonyGeometry, { passive: true });
  if ("ResizeObserver" in window) {
    new ResizeObserver(refreshCeremonyGeometry).observe($("#personalSystem"));
  }
}

async function loadApplication() {
  try {
    const [site, session] = await Promise.all([
      fetchJSON("/api/site"),
      fetchJSON("/api/session")
    ]);
    state.site = site;
    state.games = site.games || [];
    state.gameById = new Map(state.games.map((game) => [game.id, game]));
    state.session = session.authenticated
      ? { authenticated: true, identity: session.identity, selfBlockedGameIds: session.selfBlockedGameIds || [] }
      : { authenticated: false, identity: null, selfBlockedGameIds: [] };
    state.ballot = session.ballot || { gameIds: [], version: 0, updatedAt: null };
    state.games.forEach(coverImage);
    initializeLocalState();
    updateHeader();
    updateAccountUI();
    renderAccessibleIndex();
    renderResults();
  } catch (error) {
    const loading = $("#mapLoading");
    loading.hidden = false;
    loading.innerHTML = `<strong>共享宇宙暂时无法建立</strong><p>${escapeHTML(error.message)}</p><button class="secondary-action" id="retryLoad" type="button">重新连接</button>`;
    $("#launchLabel").textContent = "连接失败";
    $("#retryLoad")?.addEventListener("click", () => location.reload());
  }
}

function init() {
  bindUI();
  setupCanvas();
  const profile = readProfile();
  $("#authName").value = profile.name || "";
  $("#authTeam").value = profile.team || "";
  $("#authEmail").value = profile.email || "";
  loadApplication();
}

init();
