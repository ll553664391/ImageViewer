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
const historyModal = $("historyModal");
const historyList = $("historyList");
const historyCount = $("historyCount");
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
function renderImage(preserveView = false, onReady) {
  const img = currentImage();
  if (!img) {
    if (onReady) onReady();
    return;
  }
  pushHistory(img);

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
    if (onReady) onReady();
  };
  probe.onerror = () => {
    if (token !== state.loadToken) return;
    showToast("无法加载图片：" + img.name, true);
    if (onReady) onReady(); // 加载失败也要放行，避免窗口一直不显示
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
async function loadPath(path, onReady) {
  try {
    const result = await invoke("load_images", { path });
    state.images = result.images;
    state.folder = result.folder;
    state.single = result.single;
    if (state.images.length === 0) {
      showToast("文件夹中没有图片", true);
      if (onReady) onReady();
      return;
    }
    state.index = result.initialIndex;
    renderImage(false, onReady);
  } catch (e) {
    showToast(String(e), true);
    if (onReady) onReady(); // 出错也要放行，避免窗口一直不显示
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

/* ---------------- 剪贴板与文件操作 ---------------- */
async function writeClipboard(text) {
  // 优先使用原生命令，绕开 WebView 的剪贴板权限限制
  try {
    await invoke("write_clipboard", { text });
    return true;
  } catch (e) {
    console.warn("[clipboard] 原生写入失败，尝试浏览器 API:", e);
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

async function copyFileName() {
  const img = currentImage();
  if (!img) return showToast("当前没有图片", true);
  const ok = await writeClipboard(img.name);
  showToast(ok ? "已复制文件名" : "复制失败", !ok);
}

async function copyFullPath() {
  const img = currentImage();
  if (!img) return showToast("当前没有图片", true);
  const ok = await writeClipboard(img.path);
  showToast(ok ? "已复制绝对地址" : "复制失败", !ok);
}

const COPY_FOLDER_KEY = "quickview-copy-folder";

function getLastCopyFolder() {
  try {
    return localStorage.getItem(COPY_FOLDER_KEY) || "";
  } catch (_) {
    return "";
  }
}

function setLastCopyFolder(folder) {
  try {
    localStorage.setItem(COPY_FOLDER_KEY, folder);
  } catch (_) {}
}

/// 上次成功复制到的文件夹优先；若已失效则由后端返回空，这里回退到当前图片所在文件夹
async function resolveCopyDefaultFolder() {
  const last = getLastCopyFolder();
  try {
    const resolved = await invoke("get_copy_default_folder", { lastFolder: last });
    if (resolved) return resolved;
  } catch (e) {
    console.warn("[copy] 解析默认文件夹失败:", e);
  }
  return state.folder || undefined;
}

async function copyToFolder() {
  const img = currentImage();
  if (!img) return showToast("当前没有图片", true);
  const defaultFolder = await resolveCopyDefaultFolder();
  let target;
  try {
    target = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: defaultFolder,
      title: "选择要复制到的文件夹",
    });
  } catch (e) {
    showToast("选择文件夹失败：" + String(e), true);
    return;
  }
  if (!target) return;
  try {
    const dest = await invoke("copy_image_to_folder", {
      source: img.path,
      destFolder: target,
    });
    setLastCopyFolder(target); // 仅复制成功才记住，供下次作为默认目录
    showToast("已复制到：" + dest);
  } catch (e) {
    showToast("复制失败：" + String(e), true);
  }
}

/* ---------------- 历史记录 ---------------- */
const HISTORY_KEY = "quickview-history";
const HISTORY_MAX = 20;

function getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    // 兼容旧版按图片记录的格式：每个文件夹只保留时间最新的一条，并按时间倒序
    const best = new Map();
    for (const item of list) {
      const folder = item.folder || "";
      const prev = best.get(folder);
      if (!prev || (item.time || 0) > (prev.time || 0)) best.set(folder, item);
    }
    const normalized = Array.from(best.values()).sort(
      (a, b) => (b.time || 0) - (a.time || 0)
    );
    return normalized.slice(0, HISTORY_MAX);
  } catch (_) {
    return [];
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch (_) {}
  updateHistoryBadge();
  if (!historyModal.classList.contains("hidden")) renderHistoryList();
}

function updateHistoryBadge() {
  const n = getHistory().length;
  historyCount.textContent = n > 0 ? String(n) : "";
}

/// 一个文件夹只保留一条记录，内容为该文件夹最近浏览的图片；同文件夹再次浏览会更新并置顶
function pushHistory(img) {
  if (!img || !img.path) return;
  const folder = state.folder || "";
  let list = getHistory().filter((h) => h.folder !== folder);
  list.unshift({
    path: img.path,
    name: img.name,
    folder: folder,
    time: Date.now(),
  });
  if (list.length > HISTORY_MAX) list = list.slice(0, HISTORY_MAX);
  saveHistory(list);
}

function formatHistoryTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return "今天 " + hm;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

function folderDisplayName(folder) {
  if (!folder) return "未知文件夹";
  const parts = folder.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || folder;
}

function renderHistoryList() {
  const list = getHistory();
  if (list.length === 0) {
    historyList.innerHTML = '<div class="history-empty">暂无浏览记录</div>';
    return;
  }
  historyList.replaceChildren();
  list.forEach((item, i) => {
    const btn = document.createElement("button");
    btn.className = "history-item";
    btn.type = "button";

    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = String(i + 1);

    const meta = document.createElement("span");
    meta.className = "meta";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = folderDisplayName(item.folder);
    const folder = document.createElement("span");
    folder.className = "folder";
    const lastName = item.name || item.path.split(/[\\/]/).pop() || "";
    folder.textContent = `最近查看：${lastName} · ${item.folder || ""}`;
    meta.append(name, folder);

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatHistoryTime(item.time || Date.now());

    btn.append(idx, meta, time);
    btn.addEventListener("click", () => {
      closeHistory();
      loadPath(item.path);
    });
    historyList.appendChild(btn);
  });
}

function openHistory() {
  hideContextMenu();
  renderHistoryList();
  historyModal.classList.remove("hidden");
}

function closeHistory() {
  historyModal.classList.add("hidden");
}

function clearHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch (_) {}
  updateHistoryBadge();
  renderHistoryList();
  showToast("历史记录已清空");
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
$("btnEmptyHistory").addEventListener("click", openHistory);
$("btnEmptySettings").addEventListener("click", openSettings);
$("btnCloseSettings").addEventListener("click", () => settingsModal.classList.add("hidden"));
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) settingsModal.classList.add("hidden");
});
$("btnCloseHistory").addEventListener("click", closeHistory);
$("btnClearHistory").addEventListener("click", clearHistory);
historyModal.addEventListener("click", (e) => {
  if (e.target === historyModal) closeHistory();
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
  // 设置 / 历史弹窗打开时禁用自定义右键
  if (
    !settingsModal.classList.contains("hidden") ||
    !historyModal.classList.contains("hidden")
  )
    return;
  e.preventDefault();
  // 无图片时禁用文件相关操作
  const hasImage = state.index >= 0;
  contextMenu
    .querySelectorAll('[data-action="copyName"], [data-action="copyPath"], [data-action="copyTo"]')
    .forEach((btn) => btn.classList.toggle("disabled", !hasImage));
  updateHistoryBadge();
  // 先显示再测量，hidden(display:none) 时 offsetWidth/Height 为 0 会导致越界
  contextMenu.classList.remove("hidden");
  const x = Math.min(e.clientX, window.innerWidth - contextMenu.offsetWidth - 8);
  const y = Math.min(e.clientY, window.innerHeight - contextMenu.offsetHeight - 8);
  contextMenu.style.left = Math.max(4, x) + "px";
  contextMenu.style.top = Math.max(4, y) + "px";
});

contextMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || btn.classList.contains("disabled")) return;
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
    case "copyName":
      copyFileName();
      break;
    case "copyPath":
      copyFullPath();
      break;
    case "copyTo":
      copyToFolder();
      break;
    case "history":
      openHistory();
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
        else if (!historyModal.classList.contains("hidden")) closeHistory();
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

/* ---------------- 启动前恢复用户设置 ---------------- */
applyTheme(getStoredTheme()); // 默认暗色，恢复用户上次选择
$("chkShowFullPath").checked = getShowFullPath();
updateHistoryBadge();

/* ---------------- 启动 ----------------
 * 窗口在配置里初始隐藏（visible:false），避免先闪出白屏 / 主页。
 * 等首帧内容准备好后再显示窗口：
 *  - 带图片/文件夹路径启动（文件关联、右键菜单）→ 直接显示图片
 *  - 单独打开软件 → 显示主页
 */
const win = getCurrentWindow();
let windowShown = false;
function showMainWindow() {
  if (windowShown) return;
  windowShown = true;
  win.show()
    .then(() => {
      // 窗口首次显示后布局尺寸才最终确定，重新适配一次，避免隐藏期间算出的缩放不准
      requestAnimationFrame(() => {
        if (state.index >= 0 && state.scale === 1) fitToWindow();
      });
    })
    .catch((e) => console.error("[启动] 显示窗口失败:", e));
}

async function bootstrap() {
  // 兜底：即使后续任何环节异常，也保证窗口最终会显示，不会卡在隐藏状态
  const fallback = setTimeout(showMainWindow, 3000);
  try {
    const target = await invoke("take_launch_target");
    if (target) {
      // 等图片真正解码并渲染完成后再显示窗口，做到“打开即是图片”
      await loadPath(target.path, showMainWindow);
    } else {
      updateTitle(); // 无启动参数：显示主页（空状态默认可见）
      showMainWindow();
    }
  } catch (e) {
    console.error("启动失败:", e);
    showMainWindow();
  } finally {
    clearTimeout(fallback);
  }
}
bootstrap();
