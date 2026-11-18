import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const stage = $("stage");
const photo = $("photo");
const empty = $("empty");
const minimap = $("minimap");
const miniImg = $("miniImg");
const miniViewport = $("miniViewport");
const toastEl = $("toast");
const settingsModal = $("settingsModal");
const contextMenu = $("contextMenu");
const progressBar = $("progressBar");
const progressFill = $("progressFill");
const APP_TITLE = "快看看图";

/* ---------------- 状态 ---------------- */
const state = {
  images: [],
  index: -1,
  folder: "",
  single: false,
  scale: 1, // 相对适应窗口的倍率：1 = fit
  offsetX: 0, // 视图平移（屏幕像素）
  offsetY: 0,
  fitScale: 1, // 适应窗口时的实际缩放比
  natW: 0,
  natH: 0,
  panning: false,
  panStartX: 0,
  panStartY: 0,
  panBaseX: 0,
  panBaseY: 0,
  toastTimer: null,
  preloads: [],
  loadToken: 0,
};

const MIN_SCALE = 0.05; // 相对倍率下限
const MAX_SCALE = 40; // 相对倍率上限
// 图片贴合舞台边缘的留白（0 = 尽可能占满可用区域）
const PADDING = 0;

/* ---------------- 工具 ---------------- */
function showToast(message, warn = false) {
  clearTimeout(state.toastTimer);
  toastEl.textContent = message;
  toastEl.classList.toggle("warn", warn);
  toastEl.classList.add("show");
  state.toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1400);
}

function currentImage() {
  return state.images[state.index] || null;
}

/// 把文件名 / 计数 / 缩放显示到窗口标题栏
async function updateTitle() {
  const img = currentImage();
  let title = APP_TITLE;
  if (img) {
    const counter = `${state.index + 1}/${state.images.length}`;
    const zoom = Math.round(state.scale * 100) + "%";
    const label = getShowFullPath() ? img.path : img.name;
    title = `${label}  ·  ${counter}  ·  ${zoom}  -  ${APP_TITLE}`;
  }
  try {
    await getCurrentWindow().setTitle(title);
  } catch (_) {}
}

/* ---------------- 图片渲染 ---------------- */
function renderImage(preserveView = false) {
  const img = currentImage();
  if (!img) return;

  updateCounter();

  const url = convertFileSrc(img.path);
  const token = ++state.loadToken;
  const probe = new Image();
  probe.onload = () => {
    if (token !== state.loadToken) return; // 防止快速翻页时的竞态
    state.natW = probe.naturalWidth;
    state.natH = probe.naturalHeight;
    photo.src = url;
    empty.classList.add("hidden");
    if (!preserveView) {
      fitToWindow();
    } else {
      applyTransform();
    }
    preloadNeighbors();
  };
  probe.onerror = () => {
    if (token !== state.loadToken) return;
    showToast("无法加载图片：" + img.name, true);
  };
  probe.src = url;
}

function updateCounter() {
  updateTitle();
  updateProgress();
}

/// 底部进度条：与标题栏的 当前序号/总数 对应
function updateProgress() {
  if (state.images.length === 0 || state.index < 0) {
    progressBar.classList.add("hidden");
    return;
  }
  progressBar.classList.remove("hidden");
  const ratio = (state.index + 1) / state.images.length;
  progressFill.style.width = (ratio * 100) + "%";
}

function fitToWindow() {
  if (!state.natW || !state.natH) return;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  // 取宽高中更小的缩放比，保证不裁切、不变形，且尽可能占满可视区域
  state.fitScale = Math.min((w - PADDING) / state.natW, (h - PADDING) / state.natH);
  if (!isFinite(state.fitScale) || state.fitScale <= 0) state.fitScale = 1;
  state.scale = 1;
  state.offsetX = 0;
  state.offsetY = 0;
  applyTransform();
}

function applyTransform() {
  if (!state.natW || !state.natH) return;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const actual = state.fitScale * state.scale;
  const dispW = state.natW * actual;
  const dispH = state.natH * actual;
  const tx = (w - dispW) / 2 + state.offsetX;
  const ty = (h - dispH) / 2 + state.offsetY;

  photo.style.transformOrigin = "0 0";
  photo.style.transform = `translate(${tx}px, ${ty}px) scale(${actual})`;
  // 用固定尺寸代替原始尺寸，transform 后即为显示尺寸
  photo.style.width = state.natW + "px";
  photo.style.height = state.natH + "px";

  updateTitle();

  const zoomed = state.scale > 1.02;
  minimap.classList.toggle("hidden", !zoomed);
  stage.classList.toggle("pannable", zoomed);
  if (zoomed) updateMinimap(tx, ty, dispW, dispH, actual);
}

/* ---------------- 缩略图总览 ---------------- */
function updateMinimap(tx, ty, dispW, dispH, actual) {
  const boxW = 176;
  const boxH = 120;
  const ratio = state.natW / state.natH;
  let imgW, imgH;
  if (ratio > boxW / boxH) {
    imgW = boxW;
    imgH = boxW / ratio;
  } else {
    imgH = boxH;
    imgW = boxH * ratio;
  }
  const offL = (boxW - imgW) / 2;
  const offT = (boxH - imgH) / 2;

  miniImg.style.width = imgW + "px";
  miniImg.style.height = imgH + "px";
  if (miniImg.src !== photo.src) miniImg.src = photo.src;

  // 可见区域在图片坐标中的位置
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const visX = -tx / actual;
  const visY = -ty / actual;
  const visW = w / actual;
  const visH = h / actual;

  let vx = offL + (visX / state.natW) * imgW;
  let vy = offT + (visY / state.natH) * imgH;
  let vw = (visW / state.natW) * imgW;
  let vh = (visH / state.natH) * imgH;

  // 限制在图片显示区域
  const minX = offL;
  const minY = offT;
  const maxX = offL + imgW;
  const maxY = offT + imgH;
  if (vw > imgW) vw = imgW;
  if (vh > imgH) vh = imgH;
  vx = Math.max(minX, Math.min(vx, maxX - vw));
  vy = Math.max(minY, Math.min(vy, maxY - vh));

  miniViewport.style.left = vx + "px";
  miniViewport.style.top = vy + "px";
  miniViewport.style.width = vw + "px";
  miniViewport.style.height = vh + "px";
}

/* ---------------- 缩放：以鼠标位置为中心 ---------------- */
function zoomAt(clientX, clientY, factor) {
  if (state.index < 0 || !state.natW) return;
  const rect = stage.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;

  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const oldActual = state.fitScale * state.scale;
  const tx = (w - state.natW * oldActual) / 2 + state.offsetX;
  const ty = (h - state.natH * oldActual) / 2 + state.offsetY;

  // 鼠标指向的图片原始坐标
  const px = (mx - tx) / oldActual;
  const py = (my - ty) / oldActual;

  let newScale = state.scale * factor;
  newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
  const newActual = state.fitScale * newScale;

  // 让该图片点仍位于鼠标处
  const newTx = mx - px * newActual;
  const newTy = my - py * newActual;

  state.scale = newScale;
  state.offsetX = newTx - (w - state.natW * newActual) / 2;
  state.offsetY = newTy - (h - state.natH * newActual) / 2;
  applyTransform();
}

function zoomCenter(factor) {
  const rect = stage.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}

/* ---------------- 翻页 ---------------- */
function goto(next) {
  if (state.images.length === 0) return;
  const target = state.index + (next ? 1 : -1);
  if (target < 0) {
    showToast("已经是第一张了", true);
    return;
  }
  if (target >= state.images.length) {
    showToast("已经是最后一张了", true);
    return;
  }
  state.index = target;
  renderImage();
}

function preloadNeighbors() {
  state.preloads = [];
  for (const i of [state.index - 1, state.index + 1]) {
    if (i < 0 || i >= state.images.length) continue;
    const im = new Image();
    im.src = convertFileSrc(state.images[i].path);
    state.preloads.push(im);
  }
}

/* ---------------- 加载路径 ---------------- */
async function loadPath(path) {
  try {
    const result = await invoke("load_images", { path });
    state.images = result.images;
    state.folder = result.folder;
    state.single = result.single;
    if (state.images.length === 0) {
      showToast("文件夹中没有图片", true);
      return;
    }
    state.index = result.initialIndex;
    renderImage();
  } catch (e) {
    showToast(String(e), true);
  }
}

async function pickImage() {
  const selected = await openDialog({
    multiple: false,
    filters: [
      {
        name: "图片",
        extensions: [
          "jpg", "jpeg", "jpe", "jfif", "png", "gif", "bmp", "webp",
          "tif", "tiff", "ico", "avif", "svg",
        ],
      },
    ],
  });
  if (selected) await loadPath(selected);
}

async function pickFolder() {
  const selected = await openDialog({ directory: true, multiple: false });
  if (selected) await loadPath(selected);
}

/* ---------------- 设置弹窗 ---------------- */
async function refreshIntegrationStatus() {
  try {
    const s = await invoke("get_integration_status");
    $("defaultStatus").textContent = s.defaultRegistered ? "已注册" : "未注册";
    $("chkContextMenu").checked = s.contextMenu;
    $("exePath").textContent = s.exePath;
  } catch (e) {
    console.error(e);
  }
}

async function setDefaultViewer() {
  try {
    await invoke("register_default_viewer");
    showToast("已注册，请在系统设置中确认");
    await invoke("open_default_apps_settings");
    await refreshIntegrationStatus();
  } catch (e) {
    showToast("注册失败：" + String(e), true);
  }
}

async function toggleContextMenu(enabled) {
  try {
    await invoke("set_folder_context_menu", { enabled });
    showToast(enabled ? "右键菜单已启用" : "右键菜单已移除");
    await refreshIntegrationStatus();
  } catch (e) {
    showToast("设置失败：" + String(e), true);
  }
}

/* ---------------- 显示绝对路径开关 ---------------- */
function getShowFullPath() {
  try {
    return localStorage.getItem("quickview-show-fullpath") === "1";
  } catch (_) {
    return false;
  }
}

function setShowFullPath(enabled) {
  try {
    localStorage.setItem("quickview-show-fullpath", enabled ? "1" : "0");
  } catch (_) {}
  updateTitle(); // 立即刷新标题栏
}

/* ---------------- 主题 ---------------- */
function getStoredTheme() {
  try {
    return localStorage.getItem("quickview-theme") || "dark";
  } catch (_) {
    return "dark";
  }
}

function applyTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem("quickview-theme", t);
  } catch (_) {}
  document.querySelectorAll(".theme-option").forEach((el) => {
    el.classList.toggle("active", el.dataset.theme === t);
  });
  // 同步窗口（系统标题栏）主题：暗色主题 -> 深色标题栏，浅色主题 -> 浅色标题栏
  invoke("set_window_theme", { theme: t }).catch((err) =>
    console.error("[theme] set_window_theme failed:", err)
  );
}

/* ---------------- 设置弹窗 ---------------- */
function openSettings() {
  hideContextMenu();
  settingsModal.classList.remove("hidden");
  refreshIntegrationStatus();
  applyTheme(getStoredTheme());
  $("chkShowFullPath").checked = getShowFullPath();
}

$("btnEmptyImage").addEventListener("click", pickImage);
$("btnEmptySettings").addEventListener("click", openSettings);
$("btnCloseSettings").addEventListener("click", () => settingsModal.classList.add("hidden"));
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) settingsModal.classList.add("hidden");
});
$("btnSetDefault").addEventListener("click", setDefaultViewer);
$("chkContextMenu").addEventListener("change", (e) => toggleContextMenu(e.target.checked));
$("chkShowFullPath").addEventListener("change", (e) => setShowFullPath(e.target.checked));
document.querySelectorAll(".theme-option").forEach((el) => {
  el.addEventListener("click", () => applyTheme(el.dataset.theme));
});

/* ---------------- 右键菜单 ---------------- */
function hideContextMenu() {
  contextMenu.classList.add("hidden");
}

window.addEventListener("contextmenu", (e) => {
  // 设置弹窗打开时禁用自定义右键
  if (!settingsModal.classList.contains("hidden")) return;
  e.preventDefault();
  const x = Math.min(e.clientX, window.innerWidth - contextMenu.offsetWidth - 8);
  const y = Math.min(e.clientY, window.innerHeight - contextMenu.offsetHeight - 8);
  contextMenu.style.left = Math.max(4, x) + "px";
  contextMenu.style.top = Math.max(4, y) + "px";
  contextMenu.classList.remove("hidden");
});

contextMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  hideContextMenu();
  switch (btn.dataset.action) {
    case "settings":
      openSettings();
      break;
    case "open":
      pickImage();
      break;
    case "fit":
      fitToWindow();
      break;
    case "fullscreen":
      toggleFullscreen();
      break;
  }
});

// 点击空白处 / 滚动 / 缩放时关闭右键菜单
window.addEventListener("mousedown", (e) => {
  if (!contextMenu.contains(e.target) && e.button !== 2) hideContextMenu();
});
window.addEventListener("wheel", hideContextMenu, { passive: true });

async function toggleFullscreen() {
  const win = getCurrentWindow();
  await win.setFullscreen(!(await win.isFullscreen()));
}

// 滚轮缩放
stage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAt(e.clientX, e.clientY, factor);
  },
  { passive: false }
);

// 拖动平移
stage.addEventListener("pointerdown", (e) => {
  if (state.scale <= 1.02 || e.button !== 0) return;
  state.panning = true;
  state.panStartX = e.clientX;
  state.panStartY = e.clientY;
  state.panBaseX = state.offsetX;
  state.panBaseY = state.offsetY;
  stage.classList.add("panning");
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener("pointermove", (e) => {
  if (!state.panning) return;
  state.offsetX = state.panBaseX + (e.clientX - state.panStartX);
  state.offsetY = state.panBaseY + (e.clientY - state.panStartY);
  applyTransform();
});
function endPan(e) {
  if (!state.panning) return;
  state.panning = false;
  stage.classList.remove("panning");
  try {
    stage.releasePointerCapture(e.pointerId);
  } catch (_) {}
}
stage.addEventListener("pointerup", endPan);
stage.addEventListener("pointercancel", endPan);

// 键盘翻页与快捷键
window.addEventListener("keydown", async (e) => {
  if (e.target.tagName === "INPUT") return;

  switch (e.code) {
    case "ArrowUp":
    case "ArrowLeft":
    case "KeyA":
      e.preventDefault();
      goto(false);
      break;
    case "ArrowDown":
    case "ArrowRight":
    case "KeyD":
      e.preventDefault();
      goto(true);
      break;
    case "Equal":
    case "NumpadAdd":
      e.preventDefault();
      zoomCenter(1.25);
      break;
    case "Minus":
    case "NumpadSubtract":
      e.preventDefault();
      zoomCenter(1 / 1.25);
      break;
    case "Digit0":
      e.preventDefault();
      fitToWindow();
      break;
    case "KeyS":
      // S 键打开设置（首页按钮之外的快捷入口）
      e.preventDefault();
      openSettings();
      break;
    case "Comma":
      if (e.ctrlKey) {
        e.preventDefault();
        openSettings();
      }
      break;
    case "KeyO":
      if (e.ctrlKey) {
        e.preventDefault();
        pickImage();
      }
      break;
    case "KeyF":
      if (e.ctrlKey) {
        e.preventDefault();
        pickFolder();
      }
      break;
    case "F11":
      e.preventDefault();
      await toggleFullscreen();
      break;
    case "Escape":
      {
        hideContextMenu();
        const win = getCurrentWindow();
        if (await win.isFullscreen()) await win.setFullscreen(false);
        else if (!settingsModal.classList.contains("hidden")) settingsModal.classList.add("hidden");
      }
      break;
  }
});

// 窗口尺寸变化：保持相对视图
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.index < 0) return;
    if (state.scale === 1) fitToWindow();
    else applyTransform();
  }, 80);
});

// 拖入文件 / 文件夹
getCurrentWindow().onDragDropEvent((event) => {
  if (event.payload.type === "drop" && event.payload.paths?.length) {
    loadPath(event.payload.paths[0]);
  }
});

/* ---------------- 启动 ---------------- */
applyTheme(getStoredTheme()); // 默认暗色，恢复用户上次选择
$("chkShowFullPath").checked = getShowFullPath();

async function bootstrap() {
  try {
    const target = await invoke("take_launch_target");
    if (target) await loadPath(target.path);
    else updateTitle(); // 空状态显示纯应用名
  } catch (e) {
    console.error("启动失败:", e);
  }
}
bootstrap();
