'use strict';

/**
 * main.js —— Electron 主进程
 *
 * 职责：
 *   1. 创建固定尺寸的透明置顶无边框窗口（MINI 小图标 ⇄ 悬停展开面板）
 *   2. 默认让鼠标事件穿透（forward:true），渲染层命中时通过 IPC 切换为可交互
 *   3. 定时轮询 `arkcli usage plan --all --format json`（防重入 + 15s 超时 kill）
 *   4. 通过 IPC 把归一化快照推给渲染进程
 *   5. 系统托盘：右键看进度 + 切换圆环盯的订阅 + 显示/隐藏挂件
 *   6. 自实现窗口拖拽（不再依赖 -webkit-app-region）
 *   7. 支持 `--mock[=场景名]` 演示模式（不调用真实 CLI）
 */

const { app, BrowserWindow, ipcMain, clipboard, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// 解析层与 mock 层均为纯函数 / 纯数据，单独成文件以便 QA 直接 require 做单测。
const {
  normalizeSnapshot,
  buildFailureSnapshot,
  selectVisiblePlans,
  selectRingCandidates,
  pickPeriod
} = require('./src/parse');
const { getMockScenario } = require('./src/mock');
// 图标 / 面板的屏幕边界解算是纯函数，单独成模块以便 node 单测直接钉住（见 tests/parse.test.js）
const { computeLayout: solveLayout, workAreaNear: solveAreaNear } = require('./src/layout');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 单个 arkcli 进程的超时上限（毫秒）—— 超时后 kill 并置为 ERROR。 */
const CLI_TIMEOUT_MS = 15000;

/** 默认轮询间隔（毫秒）。 */
const DEFAULT_INTERVAL_MS = 30000;

/** 轮询间隔下限保护（避免配置写出 0 导致疯狂轮询）。 */
const MIN_INTERVAL_MS = 5000;

/**
 * 窗口宽度固定 = 展开面板的宽度。绝不用 setBounds/setSize 动态改尺寸 ——
 * 透明窗口 resize 会撕裂闪屏。
 *
 * ⚠️ 不要拿 win.getBounds() 当「面板的边界」用：
 * Windows 会给这个无边框透明窗口外挂一圈**不可见**的调整边框，本机 187.5% 缩放下
 * 实测请求 360×316、getBounds() 却回 365×321，而且多出来的部分全压在右边和下边
 * （左上角坐标完全一致）。命中判定因此**不能**用 getBounds()，必须用渲染层实测
 * 上报的面板矩形（见 panelRect）。
 */
const WINDOW_WIDTH = 180;

/**
 * 窗口高度的**默认值**（首次启动 / 配置缺失时用）。
 * 实际高度按「有数据的计划数」自适应（见 computePanelHeight / panel-structure）：
 * 只有一个订阅有数据时面板收得紧凑，两个都有数据时才撑到全高。
 * CSS 侧高度全部写 100% 跟随窗口，因此改这里不会造成布局错位。
 */
const WINDOW_HEIGHT = 294;

/**
 * 面板结构高度常量 —— 与 style.css 里的值一一对应，改 CSS 必须同步改这里：
 *   .panel-rows top=38 bottom=10 gap=7
 *   .plan-head height=15
 *   .row max-height=33、.plan-rows gap=4（每个有数据的计划固定 3 行）
 *   .plan-empty（标题 + 一行占位文字）≈ 36
 */
const PANEL_TOP_PAD = 38;
const PANEL_BOTTOM_PAD = 10;
const GROUP_GAP = 7;
const PLAN_HEAD_H = 15;
const ROW_H = 33;
const ROW_GAP = 4;
const ROWS_PER_PLAN = 3;
const EMPTY_PLAN_H = 36;

/** 自适应高度的钳制范围（EMPTY 兜底态也要够 fallback 浮层立足）。 */
const MIN_WINDOW_H = 170;
const MAX_WINDOW_H = 420;

/** 相邻两次目标高度差 ≤ 该值就不动窗口（防抖：避免 1~2px 的往返抖动）。 */
const PANEL_H_TOLERANCE = 4;

/** MINI 态图标边长（须与 style.css 中 #mini 的尺寸保持一致）。 */
const MINI_SIZE = 40;

/**
 * 图标在窗口内的偏移兜底值 = 窗口正中。
 * 真实值由 computeLayout() 算出后写进 miniOffset，见那里的长注释。
 */
const MINI_OFFSET_CENTER = {
  x: (WINDOW_WIDTH - MINI_SIZE) / 2,
  y: (WINDOW_HEIGHT - MINI_SIZE) / 2
};

/**
 * 命中判定的外扩容差（px），拆两档：
 *   - 交互区（interactive）：决定窗口是否可接收鼠标事件（含点击、拖拽）
 *   - 展开区（near）：决定是否启动「悬停展开面板」的计时
 *
 * 为什么要两档：40px 的小图标如果只用一个判定区，指针一靠近就展开面板，
 * 用户根本来不及「点击图标切换订阅」。让展开区更贴近图标本体，点击才有窗口期。
 */
const HIT_ENTER_PAD = 8;
const HIT_LEAVE_PAD = 14;
const NEAR_PAD = 4;

/** 光标轮询间隔（ms）。约 40Hz，手感跟手，开销可忽略。 */
const HOVER_POLL_MS = 24;

/** 窗口移动后冻结穿透切换的时间窗（ms）：覆盖一次完整拖拽，避免拖拽被中途打断。 */
const MOVE_GUARD_MS = 320;

/**
 * 拖拽看门狗（ms）：拖拽中光标连续静止超过该时长，即认定用户已松手。
 * 兜底场景：mouseup 在窗口外丢失时，若不收尾窗口会一直粘着光标跑。
 */
const DRAG_IDLE_MS = 1400;

/** 圆环默认盯的周期维度。用户要求 logo 一直显示「5 小时」。 */
const RING_PERIOD = '5h';

/** 托盘菜单里文本进度条的格子数。 */
const BAR_CELLS = 8;

// ---------------------------------------------------------------------------
// mock 参数解析
// ---------------------------------------------------------------------------

/**
 * 从启动参数解析 mock 配置。
 * 支持 `--mock`（默认场景 normal）与 `--mock=<场景名>`。
 * @param {string[]} argv
 * @returns {{ mock: boolean, scenario: string|null }}
 */
function parseMockArgv(argv) {
  const hit = argv.find((a) => a === '--mock' || a.startsWith('--mock='));
  if (!hit) return { mock: false, scenario: null };
  if (hit === '--mock') return { mock: true, scenario: 'normal' };
  return { mock: true, scenario: hit.slice('--mock='.length) || 'normal' };
}

const { mock: MOCK_MODE, scenario: MOCK_SCENARIO } = parseMockArgv(process.argv);

// ---------------------------------------------------------------------------
// 运行态
// ---------------------------------------------------------------------------

let win = null;
let tray = null;
let pollTimer = null;
let inFlight = false; // 防重入标志：上一轮未结束则不发新请求
let pendingPoll = false; // 上一轮期间被挡下的刷新请求，本轮结束后补跑
let lastGood = null; // 上一次成功快照，异常时用于保留旧数据
let lastSnapshot = null; // 最近一次推送的快照（不含 ringProduct），用于渲染层错过推送时回灌
let intervalMs = DEFAULT_INTERVAL_MS;

let miniPlan = null; // 圆环当前盯的计划 product（null = 自动取剩余最少的那条）
let showWidget = true; // 桌面挂件是否可见（托盘常驻）
let quitting = false;

/**
 * 当前生效的窗口高度（面板高度自适应订阅状态，见 panel-structure IPC）。
 * 启动时优先用上次保存的 panelH，避免「先按 294 创建、首轮快照后又缩一次」的闪动。
 */
let windowH = WINDOW_HEIGHT;
let pendingPanelH = null; // 展开 / 拖拽中算出的目标高度，收起后再应用（避免动画中 resize）

/**
 * 「渲染层已加载完但还没拿到过首份快照」的标志。
 *
 * 为什么需要它（本地实测到的时序竞争）：主进程的启动轮询与渲染层的 listener 注册
 * 是并发的，谁先谁后不确定。若首轮轮询先完成，那次 `webContents.send` 会直接丢掉
 * （页面尚未加载完时发不到渲染进程），界面就永远停在 LOADING。
 * 查询越快越容易踩 —— mock 的 noauth / error 这类「瞬间回包」场景几乎每次都中。
 */
let replayOnReady = false;

// ---------------------------------------------------------------------------
// 悬停命中判定（主进程光标轮询）
// ---------------------------------------------------------------------------

/**
 * 为什么命中判定放在主进程，而不是渲染层监听 mousemove？
 *
 * 拖拽与悬停判定的区域高度重叠，而窗口本身是鼠标穿透的 —— 只有主进程直接读
 * 系统光标位置做几何判定，才不依赖任何鼠标事件，免疫拖拽吞事件，也不会漏掉快速划过。
 */
let hoverWatchTimer = null;
let uiExpanded = false; // 渲染层上报的当前姿态：true=展开面板，false=MINI logo
let lastInteractive = null; // 上一次下发给窗口的穿透状态（null=尚未下发过）
let lastNear = null; // 上一次下发的「贴近图标」状态（避免 40Hz 重复推送）
let hoverEntered = false; // 迟滞环的当前状态
let moveGuardUntil = 0; // 拖拽保护截止时间戳：窗口刚移动过时不切换穿透

/**
 * 展开态的面板矩形（由渲染层实测上报，CSS px、相对视口）。
 *
 * 为什么不能直接用 win.getBounds() —— 这是实测定位到的病灶：
 *
 * 本机屏幕缩放 187.5%，请求 360×316 的窗口，getBounds() 返回的却是 **365×321**，
 * 而 CSS 视口只有 364×320、真正的面板（#hover）更是只有 360×316。也就是说
 * Windows 给这个无边框透明窗口加了一圈约 5 DIP 的**不可见调整边框**，
 * 且多出来的部分**全部压在右边和下边**（左上角坐标与请求值一致）。
 *
 * 于是「窗口矩形」比「肉眼看到的面板」右多 5px、下多 5px，而展开态的判定
 * 原本就是拿整个窗口矩形算的 —— 结果：
 *   鼠标往左 / 往上离开面板 → 判定边界与面板边界重合 → 立刻收起 ✅
 *   鼠标往右 / 往下离开面板 → 面板已经出去了、判定还认为「在里面」，要多走 5px ❌
 *
 * 用户能感知到的现象正是「只有往左、往上才收得起来，往右、往下都不行」，
 * 而且**与挂件摆在屏幕哪个位置无关**（因为边框是恒定的）。
 *
 * 解法：让渲染层把 #hover 的实测矩形报上来，判定边界永远等于视觉边界。
 * 这样换任何 DPI 缩放、换任何 Windows 版本都成立。
 */
let panelRect = null;

/**
 * 小图标在窗口内的偏移（窗口坐标，单位 px）。默认窗口正中，拖拽后由 computeLayout 重算。
 *
 * 这个自由度是「图标能贴屏幕边」与「面板不超出屏幕」同时成立的关键，
 * 详见 computeLayout 的注释。
 */
let miniOffset = { x: MINI_OFFSET_CENTER.x, y: MINI_OFFSET_CENTER.y };

/**
 * 自实现拖拽的运行时状态。
 *   mode='icon'  → 拖小图标：图标钉在光标下，窗口位置由「图标位置 − 在窗偏移」反推
 *   mode='panel' → 拖展开面板：窗口钉在光标下，图标在窗口内的偏移保持不变
 * 两者各自按屏幕边界钳制，互不干扰。
 */
let dragState = null;

/**
 * 光标落在哪个判定区。
 * @returns {{interactive:boolean, near:boolean}}
 */
function cursorHitTest() {
  const pt = screen.getCursorScreenPoint();
  // 原点用**内容区**而不是窗口外框：面板矩形是渲染层按视口坐标报上来的，
  // 而视口左上角 = 内容区左上角。两者同坐标系，判定才不会整体平移。
  // （实测这台上两者相同，但内容区才是语义正确的那个。）
  const cb = win.getContentBounds();
  const b = cb.width > 0 && cb.height > 0 ? cb : win.getBounds();
  const x = pt.x - b.x;
  const y = pt.y - b.y;

  // 展开态：命中区就是**面板本身**（渲染层实测矩形），不是窗口外框。
  // 拿不到上报值时退回窗口矩形 —— 只是首帧兜底，正常展开后立刻就有值。
  if (uiExpanded) {
    const r = panelRect || { left: 0, top: 0, width: b.width, height: b.height };
    const inside =
      x >= r.left && y >= r.top && x < r.left + r.width && y < r.top + r.height;
    return { interactive: inside, near: inside };
  }

  // MINI 态：判定区跟着图标走 —— 图标不再钉在窗口正中，可能贴在窗口任意一角
  const inX = miniOffset.x;
  const inY = miniOffset.y;
  const pad = hoverEntered ? HIT_LEAVE_PAD : HIT_ENTER_PAD;
  // near 区也带一点迟滞：指针已经进到图标附近后把判定放大几像素，
  // 免得停在边界上反复翻转，导致展开计时反复「启动 → 取消」。
  const nearPad = hoverEntered ? NEAR_PAD + 6 : NEAR_PAD;

  const within = (p) =>
    x >= inX - p && x <= inX + MINI_SIZE + p && y >= inY - p && y <= inY + MINI_SIZE + p;

  return { interactive: within(pad), near: within(nearPad) };
}

/** 启动光标轮询：只在命中状态发生变化时才与窗口通信，避免每帧 IPC。 */
function startHoverWatch() {
  if (hoverWatchTimer) clearInterval(hoverWatchTimer);
  hoverWatchTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;

    // 拖拽中：窗口跟随光标移动，不做穿透切换
    if (dragState) {
      followCursorDuringDrag();
      return;
    }

    // 窗口刚移动过 → 大概率正在拖拽。此时若因窗口坐标抖动判定「光标已离开命中区」
    // 而打开穿透，系统会立刻中断窗口拖拽 —— 表现为「拖一下就断」。故拖拽期间冻结穿透状态。
    if (Date.now() < moveGuardUntil) return;

    const hit = cursorHitTest();
    hoverEntered = hit.interactive;

    // 只在状态翻转时推送 + 切穿透，避免 40Hz 的无效 IPC
    if (hit.interactive === lastInteractive && hit.near === lastNear) return;

    if (hit.interactive !== lastInteractive) {
      lastInteractive = hit.interactive;
      win.setIgnoreMouseEvents(!hit.interactive, { forward: true });
    }
    lastNear = hit.near;

    if (win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('pointer-over', { interactive: hit.interactive, near: hit.near });
    }
  }, HOVER_POLL_MS);
}

/** 停止光标轮询。 */
function stopHoverWatch() {
  if (hoverWatchTimer) {
    clearInterval(hoverWatchTimer);
    hoverWatchTimer = null;
  }
}

/**
 * 窗口发生移动时调用（用户正在拖拽窗口 / 程序 setPosition）。
 *
 * 拖拽期间必须让窗口保持可交互：否则轮询一旦判定「光标已离开命中区」就会打开穿透，
 * 系统会立即中断这次拖拽 —— 表现为拖到一半突然断开。
 */
function noteWindowMoved() {
  moveGuardUntil = Date.now() + MOVE_GUARD_MS;
  if (win && !win.isDestroyed() && lastInteractive !== true) {
    lastInteractive = true;
    win.setIgnoreMouseEvents(false);
  }
}

// ---------------------------------------------------------------------------
// 图标位置 / 展开方向 / 屏幕边界
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 把「期望的图标屏幕位置」解算成「图标在窗口内的偏移 + 窗口位置」。
 *
 * 解算逻辑本身在 src/layout.js（纯函数、可单测），这里只负责把 electron 的
 * 显示器工作区喂进去。要理解为什么要这么解，看 layout.js 里 computeLayout 的注释。
 *
 * @param {number} ix
 * @param {number} iy
 * @returns {{icon:{x:number,y:number}, offset:{x:number,y:number}, win:{x:number,y:number}}}
 */
function computeLayout(ix, iy) {
  return solveLayout({
    iconX: ix,
    iconY: iy,
    areas: screen.getAllDisplays().map((d) => d.workArea),
    winW: WINDOW_WIDTH,
    winH: windowH,
    miniSize: MINI_SIZE
  });
}

/**
 * 按订阅结构算出面板需要的窗口高度。
 *
 * 为什么由主进程按公式算、而不是渲染层量 DOM：窗口缩小时 flex 行会被压缩，
 * 量到的是「压缩后」的高度 —— 之后订阅变多时永远算不出「需要变大」。
 * 公式基于行高上限（ROW_H），与实际布局一致，且结构变化只由快照驱动、极低频。
 *
 * @param {number} okCount 有数据（state === 'ok'）的计划数
 * @param {number} otherCount 未订阅 / 无数据 / 失败的计划数
 * @returns {number} 窗口高度（px）
 */
function computePanelHeight(okCount, otherCount) {
  const okPlanH = PLAN_HEAD_H + ROWS_PER_PLAN * ROW_H + (ROWS_PER_PLAN - 1) * ROW_GAP;
  const groups = okCount * okPlanH + otherCount * EMPTY_PLAN_H;
  const gaps = Math.max(0, okCount + otherCount - 1) * GROUP_GAP;
  return PANEL_TOP_PAD + groups + gaps + PANEL_BOTTOM_PAD;
}

/**
 * 把窗口高度调到目标值（仅订阅结构变化时调用，极低频）。
 *
 * 位置不动、只改高度；改完按「图标屏幕位置不变」重解算窗口落位与在窗偏移 ——
 * 这样 MINI 小图标纹丝不动，只有面板的底边伸缩。
 * @param {number} h
 */
function applyWindowHeight(h) {
  if (!win || win.isDestroyed()) return;
  windowH = h;
  const b = win.getBounds();
  win.setBounds({ x: b.x, y: b.y, width: WINDOW_WIDTH, height: h });
  applyLayoutFromIconPos();
  writeConfig({ panelH: h }); // 下次启动直接按这个高度创建，避免启动后再缩一次的闪动
}

/**
 * 取包含 (x, y) 的显示器工作区；落在多屏之间的空隙时取最近的那块。
 * @param {number} x
 * @param {number} y
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function workAreaNear(x, y) {
  return solveAreaNear(screen.getAllDisplays().map((d) => d.workArea), x, y);
}

/** 把图标在窗口内的偏移同步给渲染层（它负责 CSS 定位与提示气泡位置）。 */
function pushMiniOffset() {
  if (win && !win.isDestroyed() && win.webContents) {
    win.webContents.send('mini-offset', { x: miniOffset.x, y: miniOffset.y });
  }
}

/**
 * 以「图标当前所在的屏幕位置」为准，重算展开方向并落位。
 * 拖拽结束、显示器变化、启动时都走这里。
 */
function applyLayoutFromIconPos() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const layout = computeLayout(b.x + miniOffset.x, b.y + miniOffset.y);
  miniOffset = layout.offset;
  win.setPosition(layout.win.x, layout.win.y);
  pushMiniOffset();
  scheduleSaveWindowState();
}

/**
 * 显示器被拔掉 / 分辨率变化：图标和面板都可能落到已不存在的区域。
 * 重新钳制一次（把图标拉回可见区、面板收回屏内）。
 */
function handleDisplayChange() {
  if (!win || win.isDestroyed()) return;
  applyLayoutFromIconPos();
}

// ---------------------------------------------------------------------------
// 自实现拖拽
// ---------------------------------------------------------------------------

/**
 * 为什么不用 `-webkit-app-region: drag`：
 *
 * 系统拖拽区会把该区域的鼠标事件全部吞掉（连 CSS :hover 都失效），
 * 于是「单击图标切换订阅」这个动作永远收不到 click；而且系统拖动完全不受我们控制，
 * 没法按屏幕边界做钳制。所以拖拽全部自己实现：渲染层判定手势与位移，
 * 主进程用「已有」的 40Hz 光标轮询跟随移动窗口 —— 钳制规则也就完全在我们手里。
 *
 * 单击、拖拽、悬停三种手势因此能在同一块区域内干净共存。
 *
 * @param {'icon'|'panel'} mode icon=拖小图标（图标钉在光标下）；panel=拖展开面板（面板钉在光标下）
 */
function startDrag(mode) {
  if (!win || win.isDestroyed()) return;
  const pt = screen.getCursorScreenPoint();
  const b = win.getBounds();
  dragState = {
    mode: mode === 'panel' ? 'panel' : 'icon',
    grabX: pt.x - b.x, // 光标在窗口内的位置
    grabY: pt.y - b.y,
    // 拖拽期间冻结图标偏移，避免「窗口跟着光标走」和「图标在窗口内挪位」互相追尾
    offset: { x: miniOffset.x, y: miniOffset.y },
    lastX: pt.x,
    lastY: pt.y,
    lastMoveAt: Date.now()
  };
  // 拖拽期间窗口必须可交互
  lastInteractive = true;
  win.setIgnoreMouseEvents(false);
}

function endDrag() {
  if (!dragState) return;
  const mode = dragState.mode;
  dragState = null;

  if (mode === 'icon') {
    // 图标拖完了：按它最终落在屏幕的哪个位置，重算展开方向与在窗偏移。
    // 这一步让图标在窗口内"挪位"、窗口反向平移，图标视觉位置保持不变 ——
    // 于是既贴住了屏幕边缘，面板又不会伸到屏幕外。
    applyLayoutFromIconPos();
  } else {
    // 面板拖完了：图标在窗口内的偏移不动（图标跟着面板走），只记住位置
    scheduleSaveWindowState();
  }

  // 强制下一拍重新计算穿透状态（mouseup 若丢在窗口外，不至于让窗口一直"吃"鼠标）
  lastInteractive = null;

  // 拖拽中挂起的高度调整，现在安全了
  if (pendingPanelH !== null && !uiExpanded) {
    const h = pendingPanelH;
    pendingPanelH = null;
    applyWindowHeight(h);
  }
}

/** 拖拽期间：把窗口搬到光标底下，并做「光标长时间静止 = 已松手」的看门狗。 */
function followCursorDuringDrag() {
  const pt = screen.getCursorScreenPoint();
  if (pt.x === dragState.lastX && pt.y === dragState.lastY) {
    if (Date.now() - dragState.lastMoveAt > DRAG_IDLE_MS) endDrag();
    return;
  }
  dragState.lastX = pt.x;
  dragState.lastY = pt.y;
  dragState.lastMoveAt = Date.now();

  moveGuardUntil = Date.now() + MOVE_GUARD_MS;

  if (dragState.mode === 'icon') {
    // 图标钉在光标下：先算图标该在屏幕哪，再反推窗口位置。
    // 图标本身按屏幕边界钳死（拖到边缘就停住，但绝不越界）。
    const inIconX = dragState.grabX - dragState.offset.x; // 光标落在图标内的相对位置
    const inIconY = dragState.grabY - dragState.offset.y;
    const area = workAreaNear(pt.x, pt.y);
    const iconX = clamp(pt.x - inIconX, area.x, area.x + area.width - MINI_SIZE);
    const iconY = clamp(pt.y - inIconY, area.y, area.y + area.height - MINI_SIZE);
    win.setPosition(Math.round(iconX - dragState.offset.x), Math.round(iconY - dragState.offset.y));
    return;
  }

  // 面板钉在光标下：只要求窗口本身完整留在工作区内
  const area = workAreaNear(pt.x, pt.y);
  const wx = clamp(pt.x - dragState.grabX, area.x, area.x + area.width - WINDOW_WIDTH);
  const wy = clamp(pt.y - dragState.grabY, area.y, area.y + area.height - windowH);
  win.setPosition(Math.round(wx), Math.round(wy));
}

// ---------------------------------------------------------------------------
// 配置（${userData}/config.json）
// ---------------------------------------------------------------------------

/** 配置文件路径。 */
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

/**
 * 读取用户配置。文件不存在 / 解析失败 / 不是对象 → 返回空对象。
 * @returns {object}
 */
function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  } catch (_) {
    return {};
  }
}

/**
 * 合并写入配置（读-改-写，保留其它字段）。
 * 写失败静默忽略 —— 配置写不进去不应影响软件运行。
 * @param {object} patch
 */
function writeConfig(patch) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(Object.assign(readConfig(), patch), null, 2), 'utf8');
  } catch (_) {
    /* 写不了就算了，不影响运行 */
  }
}

/**
 * 读取轮询间隔（毫秒）。非法 / 缺失 → 回落默认值并写一份默认配置。
 * @returns {number}
 */
function loadIntervalMs() {
  const v = Number(readConfig().intervalMs);
  if (Number.isFinite(v) && v >= MIN_INTERVAL_MS) return v;
  writeConfig({ intervalMs: DEFAULT_INTERVAL_MS });
  return DEFAULT_INTERVAL_MS;
}

/**
 * 读取上次保存的**图标屏幕位置**。
 *
 * 为什么存图标位置而不是窗口位置：窗口位置只是「图标位置 − 图标在窗偏移」的推导结果，
 * 而那个偏移会随展开方向变化。存图标位置才是稳定锚点，换个展开方向也不会漂。
 *
 * 兼容旧配置：老版本存的是 winPos（那时图标钉在窗口正中），换算一下即可。
 *
 * @returns {{x:number,y:number}|null}
 */
function loadIconPos() {
  const cfg = readConfig();

  const p = cfg.iconPos;
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }

  const w = cfg.winPos;
  if (w && Number.isFinite(w.x) && Number.isFinite(w.y)) {
    return {
      x: Math.round(w.x + MINI_OFFSET_CENTER.x),
      y: Math.round(w.y + MINI_OFFSET_CENTER.y)
    };
  }

  return null;
}

/** 保存图标位置的节流定时器（拖拽会高频触发）。 */
let savePosTimer = null;

/** 立即把图标当前位置写进配置。 */
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  writeConfig({
    iconPos: { x: Math.round(b.x + miniOffset.x), y: Math.round(b.y + miniOffset.y) }
  });
}

/** 节流保存图标位置：停止移动 400ms 后才写盘，避免拖拽过程中反复写文件。 */
function scheduleSaveWindowState() {
  if (savePosTimer) clearTimeout(savePosTimer);
  savePosTimer = setTimeout(() => {
    savePosTimer = null;
    saveWindowState();
  }, 400);
}

/** 读取圆环盯的计划（配置里存的 product 字符串）。 */
function loadMiniPlan() {
  const v = readConfig().miniPlan;
  return typeof v === 'string' && v ? v : null;
}

/** 读取挂件可见性（默认可见）。 */
function loadShowWidget() {
  const v = readConfig().showWidget;
  return v === undefined ? true : v !== false;
}

/**
 * 读取上次保存的面板高度。
 * 结构没变时直接按它创建窗口，避免「先按默认高度创建、首轮快照后又缩一次」的闪动。
 * @returns {number}
 */
function loadPanelH() {
  const v = Number(readConfig().panelH);
  if (Number.isFinite(v) && v >= MIN_WINDOW_H && v <= MAX_WINDOW_H) return Math.round(v);
  return WINDOW_HEIGHT;
}

// ---------------------------------------------------------------------------
// 子进程调用
// ---------------------------------------------------------------------------

/**
 * 从 stderr / stdout 中提取人类可读消息。
 * CLI 的 stderr 可能是 JSON（形如 {"error":{"message":"..."}}），解析失败则用原始字符串。
 * @param {string} text
 * @returns {string}
 */
function extractMessage(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const tryParse = (candidate) => {
    try {
      const j = JSON.parse(candidate);
      if (j && j.error && j.error.message) return String(j.error.message);
      if (j && typeof j.message === 'string') return j.message;
    } catch (_) {
      /* not json */
    }
    return null;
  };
  const direct = tryParse(s);
  if (direct) return direct;
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    const nested = tryParse(m[0]);
    if (nested) return nested;
  }
  return s;
}

/**
 * 执行 `arkcli usage plan --all --format json`。
 *
 * 为什么必须带 `--all`（真实踩坑）：不带 `--all` 时 CLI 只返回「探测到的」套餐桶，
 * 实测会把已订阅的 Agent Plan 整个漏掉，面板上就永远看不到 Agent Plan。
 * `--all` 会强制把 4 个桶（personal × 2 + team × 2）全列出来，没订阅的返回
 * subscribed:false —— 正好让 UI 能显示「未订阅 Agent Plan」。
 *
 * Windows 说明：全局 npm 安装的 CLI 在 Windows 上其实是 `arkcli.cmd`，
 * 直接 spawn('arkcli') 不加 shell 容易 ENOENT。因此这里用 `shell: true`，
 * 让 cmd.exe 来解析命令名，从而在 Windows/macOS/Linux 上都能调起来。
 *
 * @returns {Promise<{ok:boolean, raw?:object, kind?:string, message?:string}>}
 */
function runArkCli() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn('arkcli', ['usage', 'plan', '--all', '--format', 'json'], {
        shell: true, // ← Windows 下靠它解析到 arkcli.cmd
        windowsHide: true
      });
    } catch (err) {
      return finish({ ok: false, kind: 'NO_CLI', message: String((err && err.message) || err) });
    }

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* ignore */
      }
      finish({ ok: false, kind: 'ERROR', message: `命令执行超时（${CLI_TIMEOUT_MS / 1000}s），已终止` });
    }, CLI_TIMEOUT_MS);

    if (child.stdout) child.stdout.on('data', (d) => (stdout += d.toString()));
    if (child.stderr) child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => {
      clearTimeout(timer);
      const code = err && err.code;
      if (code === 'ENOENT') {
        return finish({ ok: false, kind: 'NO_CLI', message: '未找到 arkcli 命令' });
      }
      finish({ ok: false, kind: 'ERROR', message: String((err && err.message) || err) });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;

      const combined = `${stdout}\n${stderr}`;

      // NO_CLI：命令不存在
      if (/not recognized|command not found|is not recognized|no such file/i.test(combined)) {
        return finish({
          ok: false,
          kind: 'NO_CLI',
          message: extractMessage(stderr || stdout) || '未安装 arkcli'
        });
      }

      // 非 0 退出码
      if (code !== 0) {
        const message = extractMessage(stderr || stdout) || `命令退出码 ${code}`;
        const kind = /login|auth|sso|credential|unauthor|expired|未登录|登录|鉴权/i.test(message)
          ? 'NO_AUTH'
          : 'ERROR';
        return finish({ ok: false, kind, message });
      }

      // 正常退出 → 解析 JSON
      try {
        const raw = JSON.parse(String(stdout).trim());
        finish({ ok: true, raw });
      } catch (e) {
        finish({ ok: false, kind: 'ERROR', message: `JSON 解析失败：${e.message}` });
      }
    });
  });
}

/**
 * mock 模式下取一次假数据结果（不触碰真实 CLI）。
 * @returns {Promise<{ok:boolean, raw?:object, kind?:string, message?:string}>}
 */
async function runMock() {
  const scenario = getMockScenario(MOCK_SCENARIO);
  if (scenario.type === 'fail') {
    return { ok: false, kind: scenario.status, message: scenario.message };
  }
  return { ok: true, raw: scenario.data };
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

/**
 * 构造托盘位图：优先挂 1x + 2x 两个 representation（高 DPI 屏自动选清晰的那张）。
 * @returns {Electron.NativeImage}
 */
function createTrayImage() {
  const dir = path.join(__dirname, 'assets');
  const p16 = path.join(dir, 'tray-16.png');
  const p32 = path.join(dir, 'tray-32.png');

  const img = nativeImage.createEmpty();
  try {
    if (fs.existsSync(p16)) img.addRepresentation({ scaleFactor: 1, buffer: fs.readFileSync(p16) });
    if (fs.existsSync(p32)) img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(p32) });
  } catch (_) {
    /* 回退到下面 */
  }
  if (img && !img.isEmpty()) return img;

  for (const p of [p16, p32]) {
    try {
      const one = nativeImage.createFromPath(p);
      if (one && !one.isEmpty()) return one;
    } catch (_) {
      /* 继续下一个 */
    }
  }
  return nativeImage.createEmpty();
}

/** 生成一格文本进度条：`████░░░░`。 */
function progressBar(remaining) {
  const p = Math.max(0, Math.min(100, Number(remaining) || 0));
  const filled = Math.round((p / 100) * BAR_CELLS);
  return '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled);
}

/** 计划在菜单/提示里的短名：`Coding Plan`。 */
function planShortName(plan) {
  if (!plan) return '';
  return plan.editionLabel && plan.edition === 'team' ? `${plan.name} 团队版` : plan.name;
}

/**
 * 把一个计划渲染成若干菜单项（标题 + 三条周期）。
 * 进度条直接放在 label 里（不依赖 sublabel）—— sublabel 在部分 Windows 版本上
 * 不渲染，若只放进 sublabel 会出现「菜单里看不到进度」的情况。
 * @param {object} plan
 * @returns {Array<object>}
 */
function planMenuItems(plan) {
  const items = [
    {
      label: `${plan.name} · ${plan.editionLabel}${plan.tier ? ` · ${plan.tier}` : ''}`,
      enabled: false
    }
  ];

  if (plan.state !== 'ok') {
    items.push({ label: `    ${plan.stateLabel}`, enabled: false });
    return items;
  }

  for (const p of plan.periods) {
    items.push({
      label: `    ${p.label}   ${progressBar(p.remaining)}   ${p.remaining.toFixed(1)}%`,
      sublabel: `${p.resetText} 重置`,
      enabled: false
    });
  }
  return items;
}

/** 组装托盘右键菜单（每次弹出时实时构建，保证数据是新的）。 */
function buildTrayMenu() {
  const snap = lastSnapshot;
  const template = [];

  // ---- 标题行：更新时刻 / 异常摘要 ----
  const clock = new Date().toTimeString().slice(0, 8);
  if (snap && snap.status === 'OK') {
    template.push({ label: `火山方舟额度 · 更新 ${clock}`, enabled: false });
  } else if (snap && snap.error) {
    template.push({ label: `火山方舟额度 · ${snap.error}`, enabled: false });
  } else {
    template.push({ label: '火山方舟额度 · 正在查询…', enabled: false });
  }

  // ---- 各个计划的进度 ----
  const plans = snap && Array.isArray(snap.plans) ? selectVisiblePlans(snap.plans) : [];
  for (const plan of plans) {
    template.push({ type: 'separator' });
    template.push(...planMenuItems(plan));
  }

  // ---- 切换圆环盯的订阅 ----
  const candidates = snap ? selectRingCandidates(snap.plans) : [];
  if (candidates.length > 1) {
    const cur = currentRingPlan();
    template.push({ type: 'separator' });
    template.push({
      label: `圆环显示：${planShortName(cur)} · 5 小时（点击切换）`,
      click: () => switchRingPlan('tray')
    });
  }

  // ---- 设置 / 操作 ----
  template.push({ type: 'separator' });
  template.push({
    label: '显示桌面挂件',
    type: 'checkbox',
    checked: showWidget,
    click: (item) => setWidgetVisible(item.checked)
  });
  template.push({ label: '立即刷新', click: () => pollOnce('tray') });
  template.push({ type: 'separator' });
  template.push({
    label: '退出',
    click: () => {
      quitting = true;
      app.quit();
    }
  });

  return Menu.buildFromTemplate(template);
}

/** 创建托盘图标并绑定交互。 */
function createTray() {
  if (tray) return;
  tray = new Tray(createTrayImage());
  tray.setToolTip('火山方舟额度监测');

  // 左键单击 → 切换圆环盯的订阅（与点击桌面图标等价），并给出渐入提示
  tray.on('click', () => switchRingPlan('tray'));

  // 右键 → 实时构建菜单再弹出。不用 setContextMenu 是因为菜单内容依赖最新快照，
  // 每次弹出现建可以省掉「数据一变就重建菜单」的同步问题。
  tray.on('right-click', () => {
    try {
      tray.popUpContextMenu(buildTrayMenu());
    } catch (_) {
      /* ignore */
    }
  });
}

/** 刷新托盘提示文案（剩余量一眼可见，不用展开菜单）。 */
function updateTrayTooltip() {
  if (!tray) return;
  const cur = currentRingPlan();
  const p = cur ? pickPeriod(cur, RING_PERIOD) : null;
  if (!cur || !p) {
    tray.setToolTip('火山方舟额度监测');
    return;
  }
  tray.setToolTip(`火山方舟 · ${planShortName(cur)} · 5 小时剩余 ${p.remaining.toFixed(1)}%`);
}

/** 显示 / 隐藏桌面挂件（托盘图标始终常驻）。 */
function setWidgetVisible(visible) {
  showWidget = !!visible;
  writeConfig({ showWidget });
  if (!win || win.isDestroyed()) return;
  if (showWidget) {
    win.show();
    lastInteractive = null;
    hoverEntered = false;
    startHoverWatch();
  } else {
    stopHoverWatch();
    win.hide();
  }
}

// ---------------------------------------------------------------------------
// 圆环目标（盯哪个订阅的 5 小时）
// ---------------------------------------------------------------------------

/** 当前快照里「可以盯」的候选计划（state === 'ok' 且带 5h 周期）。 */
function ringCandidates() {
  const snap = lastSnapshot;
  if (!snap || !Array.isArray(snap.plans)) return [];
  return selectRingCandidates(snap.plans).filter((p) => pickPeriod(p, RING_PERIOD));
}

/**
 * 当前圆环盯的计划对象。
 *
 * 取不到「历史配置」时（首次启动 / 配置被清）：默认盯**最紧张**的那条 ——
 * 也就是 5 小时剩余最少的计划。原实现简单地取候选列表第一条，实测会落到
 * Agent Plan（一条都没用过，永远满环 100%），圆环就完全失去了指示意义。
 */
function currentRingPlan() {
  const cands = ringCandidates();
  if (cands.length === 0) return null;

  const configured = cands.find((p) => p.product === miniPlan);
  if (configured) return configured;

  return cands.slice().sort((a, b) => {
    const pa = pickPeriod(a, RING_PERIOD);
    const pb = pickPeriod(b, RING_PERIOD);
    const ra = pa && Number.isFinite(pa.remaining) ? pa.remaining : 101;
    const rb = pb && Number.isFinite(pb.remaining) ? pb.remaining : 101;
    return ra - rb;
  })[0];
}

/**
 * 切换圆环盯的订阅（在已订阅的计划之间轮换），并弹一条渐入提示。
 * @param {string} origin 触发来源，仅用于日志
 */
function switchRingPlan(origin) {
  const cands = ringCandidates();
  if (cands.length === 0) {
    sendToast('暂时没有可显示的订阅');
    return;
  }
  if (cands.length === 1) {
    sendToast(`当前只订阅了 ${planShortName(cands[0])}`);
    return;
  }

  const cur = currentRingPlan();
  const idx = Math.max(0, cands.indexOf(cur));
  const next = cands[(idx + 1) % cands.length];

  miniPlan = next.product;
  writeConfig({ miniPlan });

  // 重推最近一次快照，让渲染层拿到新的 ringProduct 并重画圆环
  sendSnapshot(lastSnapshot);
  updateTrayTooltip();
  sendToast(`已切换到 ${planShortName(next)} · 5 小时`);

  if (MOCK_MODE) {
    // eslint-disable-next-line no-console
    console.log(`[mock:${MOCK_SCENARIO}] ring-plan → ${miniPlan} (${origin})`);
  }
}

// ---------------------------------------------------------------------------
// 轮询调度
// ---------------------------------------------------------------------------

/**
 * 把快照推给渲染进程（顺带注入当前圆环目标）。
 *
 * 注意下发的是**解析后的** ringProduct 而不是原始配置值 `miniPlan` ——
 * 后者首次启动时是 null，渲染层只能自己猜一个（老实现猜的是候选列表第一条，
 * 实测会落到一条都没用过的 Agent Plan，圆环永远满环）。
 * 这里统一下发最终决议，让两端对「圆环盯谁」只有一个答案。
 *
 * @param {object} snapshot
 */
function sendSnapshot(snapshot) {
  if (!snapshot) return;
  lastSnapshot = snapshot; // currentRingPlan() 依赖它，必须先赋值
  const cur = currentRingPlan();
  const ringProduct = cur ? cur.product : null;
  if (win && !win.isDestroyed() && win.webContents) {
    win.webContents.send('quota-update', Object.assign({}, snapshot, { ringProduct }));
  }
}

/** 给渲染层推一条渐入提示（切换订阅、异常等瞬态反馈）。 */
function sendToast(text) {
  if (!text) return;
  if (win && !win.isDestroyed() && win.webContents) {
    win.webContents.send('toast', String(text));
  }
}

/**
 * 执行一次查询并推送结果。
 *
 * 防重入：上一轮未结束时不并发发起，但**记一个待办**，本轮结束后补跑一次 ——
 * 直接丢弃会让「手动刷新」在启动瞬间失效（老实现就是直接 return）。
 *
 * @param {string} origin 触发来源，仅用于日志
 */
async function pollOnce(origin) {
  if (inFlight) {
    pendingPoll = true;
    return;
  }
  inFlight = true;
  try {
    const res = MOCK_MODE ? await runMock() : await runArkCli();

    let snapshot;
    if (res.ok) {
      snapshot = normalizeSnapshot(res.raw, lastGood);
    } else {
      // 异常 / 空结果：保留上一次有效快照一起推给渲染层，避免 UI 闪空
      snapshot = buildFailureSnapshot(res.kind, res.message, lastGood);
    }

    if (snapshot && snapshot.status === 'OK') {
      lastGood = snapshot;
    }

    sendSnapshot(snapshot);
    updateTrayTooltip();

    // 渲染层若在本轮期间才加载完（错过了上面的推送），这里补发一次
    if (replayOnReady) {
      replayOnReady = false;
      sendSnapshot(lastSnapshot);
    }

    if (MOCK_MODE) {
      const n = snapshot.plans ? snapshot.plans.length : 0;
      const usable = snapshot.plans ? snapshot.plans.filter((p) => p.state === 'ok').length : 0;
      // eslint-disable-next-line no-console
      console.log(
        `[mock:${MOCK_SCENARIO}] (${origin}) → status=${snapshot.status}, plans=${n}, usable=${usable}`
      );
    }
  } catch (err) {
    // 任何未预期异常都不能让轮询链断掉
    sendSnapshot(buildFailureSnapshot('ERROR', String((err && err.message) || err), lastGood));
  } finally {
    inFlight = false;
    if (pendingPoll) {
      pendingPoll = false;
      setTimeout(() => pollOnce('queued'), 0);
    }
  }
}

/**
 * 用 setTimeout 链式调度，避免 setInterval 在轮询耗时长于间隔时产生进程堆积。
 */
function scheduleNext() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await pollOnce('interval');
    scheduleNext();
  }, intervalMs);
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createWindow() {
  // 默认落在主显示器右侧偏上（挂件常见位置）；有历史记录则按图标上次的屏幕位置还原。
  // computeLayout 会顺带把「图标在窗口内的偏移」和「窗口位置」一起解出来。
  const primaryArea = screen.getPrimaryDisplay().workArea;
  const savedIcon = loadIconPos();
  const layout = computeLayout(
    savedIcon ? savedIcon.x : primaryArea.x + primaryArea.width - MINI_SIZE - 40,
    savedIcon ? savedIcon.y : primaryArea.y + 60
  );
  miniOffset = layout.offset;

  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: windowH, // 面板高度自适应订阅状态（见 panel-structure），CSS 侧用 100% 跟随
    x: layout.win.x,
    y: layout.win.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 默认鼠标穿透，但 forward:true 让渲染进程仍能收到鼠标事件，
  // 从而在指针进入图标区时完成点击 / 拖拽手势。
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // 页面每次加载完成（首次 / 重载）后，确保渲染层一定拿到数据：
  // 有现成快照就直接补发；还没有就标记待办，等本轮轮询结束后补发。
  // 同样要把「图标在窗口内的偏移」补一次 —— 它决定图标画在哪、命中判定算在哪，
  // 两边一旦不一致，鼠标移过去就完全打不开面板（这正是踩过的坑）。
  win.webContents.on('did-finish-load', () => {
    if (lastSnapshot) sendSnapshot(lastSnapshot);
    else replayOnReady = true;
    pushMiniOffset();
  });

  win.once('ready-to-show', () => {
    if (showWidget) {
      win.show();
      lastInteractive = null;
      hoverEntered = false;
      startHoverWatch();
    }
    // 把图标在窗口内的偏移告诉渲染层（它负责 CSS 定位与提示气泡位置）
    pushMiniOffset();
  });

  // 窗口移动期间冻结穿透切换，避免拖到一半被中断（详见 noteWindowMoved）
  win.on('will-move', noteWindowMoved);
  win.on('move', noteWindowMoved);
  win.on('moved', noteWindowMoved);

  // 移动结束后记住新位置，下次启动直接还原
  win.on('moved', scheduleSaveWindowState);

  win.on('closed', () => {
    stopHoverWatch();
    if (savePosTimer) {
      clearTimeout(savePosTimer);
      savePosTimer = null;
    }
    win = null;
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

// 渲染层上报自身姿态（MINI / HOVER）。命中判定由主进程的光标轮询统一负责，
// 渲染层不直接控制窗口穿透 —— 单一数据源，避免两边状态打架。
ipcMain.on('ui-expanded', (_e, expanded) => {
  uiExpanded = !!expanded;
  // 姿态刚切换的一瞬间，立刻按新姿态重判一次，避免等下一个轮询周期
  if (win && !win.isDestroyed() && hoverWatchTimer) {
    const hit = cursorHitTest();
    hoverEntered = hit.interactive;
    if (hit.interactive !== lastInteractive) {
      lastInteractive = hit.interactive;
      win.setIgnoreMouseEvents(!hit.interactive, { forward: true });
    }
  }
  // 收起后应用挂起中的高度调整（展开时不 resize，避免动画中间帧被撕裂）
  if (!uiExpanded && pendingPanelH !== null) {
    const h = pendingPanelH;
    pendingPanelH = null;
    applyWindowHeight(h);
  }
});

/**
 * 渲染层上报订阅结构（有数据 / 无数据的计划数）。
 * 主进程据此算出面板需要的窗口高度 —— 只有一个订阅有数据时收得紧凑，
 * 底部不再留一大块空白（用户截图反馈的问题）。
 * 展开 / 拖拽中先挂起，收起后再应用（见 ui-expanded handler）。
 */
ipcMain.on('panel-structure', (_e, s) => {
  const okCount = Math.max(0, Math.min(8, Math.round(Number(s && s.okCount)) || 0));
  const otherCount = Math.max(0, Math.min(8, Math.round(Number(s && s.otherCount)) || 0));
  const desired = clamp(computePanelHeight(okCount, otherCount), MIN_WINDOW_H, MAX_WINDOW_H);
  if (!win || win.isDestroyed()) return;
  if (Math.abs(desired - windowH) <= PANEL_H_TOLERANCE) return;
  if (uiExpanded || dragState) {
    pendingPanelH = desired;
    return;
  }
  applyWindowHeight(desired);
});

/**
 * 渲染层上报「面板的真实矩形」（#hover 的 offset* 布局尺寸，CSS px、相对视口）。
 * 展开态的命中判定以它为准 —— 原因见 panelRect 声明处的长注释：
 * win.getBounds() 会被 Windows 的不可见调整边框撑大，且多出来的全在右、下，
 * 拿它判定就会出现「往左上能收起、往右下收不起」的方向性 bug。
 */
ipcMain.on('panel-rect', (_e, rect) => {
  if (
    rect &&
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  ) {
    panelRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  } else {
    panelRect = null; // 无效值 → 展开态退回窗口矩形兜底
  }
});

ipcMain.on('refresh-now', () => {
  // 渲染层可能错过启动瞬间的推送（其订阅晚于首轮完成），这里先把最近一次快照回灌一次；
  // 若首轮还没出结果，就标记待办，等它结束后补发。
  if (lastSnapshot) sendSnapshot(lastSnapshot);
  else replayOnReady = true;
  pollOnce('manual');
});

ipcMain.on('copy-text', (_e, text) => {
  try {
    clipboard.writeText(String(text || ''));
  } catch (_) {
    /* ignore */
  }
});

ipcMain.on('open-login', () => {
  // 唤起浏览器 SSO 登录；detached 让 CLI 独立于本应用生命周期
  try {
    const child = spawn('arkcli', ['auth', 'login', 'volc-sso'], {
      shell: true,
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch (_) {
    /* ignore */
  }
});

// 桌面图标：单击切换圆环盯的订阅（与托盘左键一致）
ipcMain.on('switch-ring', () => switchRingPlan('widget'));

// 自实现拖拽：模式由渲染层决定（icon=拖小图标 / panel=拖展开面板），两者的屏幕钳制规则不同
ipcMain.on('drag-start', (_e, mode) => startDrag(mode));
ipcMain.on('drag-end', () => endDrag());

/**
 * 渲染层主动拉取「图标在窗口内的偏移」。
 *
 * 为什么不能只靠推送：`pushMiniOffset` 是单次事件，若它发生在渲染层注册 listener
 * 之前，那条消息就永久丢了 —— 渲染层继续用 CSS 默认值（窗口正中）画图标，
 * 而主进程按真实偏移做命中判定，两边错位，鼠标移到图标上也打不开面板。
 * 推送 + 主动拉取双通道，这类「只发生一次的状态」才靠得住。
 */
ipcMain.handle('mini-offset:get', () => ({ x: miniOffset.x, y: miniOffset.y }));

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

// 单实例锁：托盘常驻的应用被启动两次会出现两个托盘图标，体验很糟。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    intervalMs = loadIntervalMs();
    miniPlan = loadMiniPlan();
    showWidget = loadShowWidget();
    windowH = loadPanelH();

    createWindow();
    createTray();

    // 显示器变化（拔掉外接屏 / 改分辨率 / 缩放）后重新钳制，避免图标或面板跑到看不见的地方
    screen.on('display-removed', handleDisplayChange);
    screen.on('display-metrics-changed', handleDisplayChange);

    // 启动后立即执行一次，不等第一个 interval 到点
    pollOnce('startup');
    scheduleNext();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        pollOnce('activate');
        scheduleNext();
      }
    });
  });
}

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  // 有托盘常驻的软件不能因为窗口全关就退出；挂件用 hide 而非 close，
  // 真正退出只走托盘菜单的「退出」。
  if (quitting) app.quit();
});
