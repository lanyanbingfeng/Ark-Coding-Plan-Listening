'use strict';

/**
 * renderer.js —— 状态机 + 双计划分组面板 + Canvas 粒子进度条
 *
 * 状态：
 *   BOOT / LOADING / MINI / HOVER / NO_CLI / NO_AUTH / ERROR / EMPTY
 *   其中 MINI / HOVER 为两种展示姿态，其余为数据状态。
 *   data-state = 展开时 'HOVER'，否则为当前数据状态；
 *   data-status 始终记录真实数据状态，便于 QA 断言。
 *
 * 铁律：任何异常都不让窗口闪空 —— 主进程在异常快照里回带上一次有效 plans，
 *       这里只要快照里有 plans 就继续渲染。
 *
 * 进度口径：面板与圆环展示的都是**剩余容量**（倒计时口径，数字随消耗下降），
 *           已用值只留在快照里备用。
 */

// parse.js 与本文件共享同一份纯函数实现（同为普通 script，CSP 允许 'self'）
const P = window.QuotaParse;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const RING_CIRCUMFERENCE = 2 * Math.PI * 17; // r = 17（见 style.css 的 .mini-ring）

const MAX_PARTICLES_PER_ROW = 5; // 每行微粒数上限（保持稀疏，不求多）
const MAX_DPR = 2; // devicePixelRatio 钳制上限
const EASE_DURATION = 600; // 数值缓动时长（ms）
const COLLAPSE_DELAY = 220; // 指针离开后收回延迟（ms）

/**
 * 指针贴近图标后延迟多久才展开面板（ms）。
 *
 * 为什么要延迟：图标只有 40px，如果「一靠近就展开」，用户根本来不及点它 ——
 * 面板会在 mousedown 之前就把图标顶掉，「单击切换订阅」这个手势就永远做不出来。
 * 给一小段窗口期：期内按下 → 判定为点击/拖拽；期内没按 → 展开面板。
 */
const EXPAND_DELAY = 260;

const CLICK_MAX_DIST = 4; // 位移小于该值（px）算单击，否则算拖拽
const CLICK_MAX_MS = 700; // 按压时长上限（ms），超过则不算单击
const TOAST_SHOW_MS = 1800; // 渐入提示停留时长（ms）
const TAU = Math.PI * 2;

/** 圆环盯的周期维度：用户要求 logo 一直显示 5 小时。 */
const RING_PERIOD = '5h';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const appEl = document.getElementById('app');
const miniEl = document.getElementById('mini');
const hoverEl = document.getElementById('hover');
const ringProgressEl = miniEl.querySelector('.ring-progress');
const alertDotEl = miniEl.querySelector('.alert-dot');
const accountNameEl = document.getElementById('account-name');
const updatedAtEl = document.getElementById('updated-at');
const panelRowsEl = document.getElementById('panel-rows');
const canvas = document.getElementById('particles');
const ctx = canvas.getContext('2d');
const fallbackEl = document.getElementById('fallback');
const fallbackTextEl = document.getElementById('fallback-text');
const fallbackCmdEl = document.getElementById('fallback-cmd');
const fallbackBtnEl = document.getElementById('fallback-btn');
const toastEl = document.getElementById('toast');

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------

let baseStatus = 'BOOT'; // 当前数据状态
let expanded = false; // 是否处于 HOVER 展开态
let collapseTimer = null;
let expandTimer = null;
let toastTimer = null;
let lastSnapshot = null;
let ringProduct = null; // 圆环盯的计划 product（由主进程下发）
let lastPlanSig = null; // 面板结构签名：结构没变就不重建 DOM（避免粒子/动画被重置）
let fallbackVisible = false;
let receivedAnySnapshot = false; // 是否已经收到过至少一份快照（用于启动重试）

/** 每行的 DOM 引用与动画状态，键为 `${product}:${periodKey}`。 */
const rowRefs = {};
const rowState = {};
let trackGeom = {}; // 缓存的轨道几何（CSS px，相对 canvas）
let canvasCssW = 0;
let canvasCssH = 0;
let rafId = null;
let lastFrameTs = 0;

/** 指针按压手势状态（用于区分单击与拖拽）。 */
let pressState = null;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function easeOutCubic(t) {
  const p = 1 - clamp(t, 0, 1);
  return 1 - p * p * p;
}

function rand(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

function formatClock(ms) {
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 头部展示的账号名。 */
function accountLabel(snap) {
  const a = snap && snap.account;
  if (a && a.userName) return a.userName;
  if (a && a.accountId) return `账号 ${a.accountId}`;
  return '火山方舟';
}

// ---------------------------------------------------------------------------
// 状态应用
// ---------------------------------------------------------------------------

/** 依据 baseStatus 与 expanded 刷新 #app 的 data-state / data-status。 */
function refreshDataState() {
  // 收起时的展示态：数据正常 → MINI；其余状态沿用数据状态本身
  const collapsedState = baseStatus === 'OK' ? 'MINI' : baseStatus;
  appEl.dataset.state = expanded ? 'HOVER' : collapsedState;
  appEl.dataset.status = baseStatus; // 始终记录真实数据状态，便于 QA 断言
  appEl.classList.toggle('loading', baseStatus === 'LOADING');
  syncParticleLoop();
}

/**
 * 应用一份归一化快照。
 * @param {object} snap 主进程推来的快照（含 plans[] 与 ringProduct）
 */
function applySnapshot(snap) {
  if (!snap || typeof snap !== 'object') return;
  lastSnapshot = snap;
  receivedAnySnapshot = true;
  if (snap.ringProduct !== undefined) ringProduct = snap.ringProduct;

  const allPlans = Array.isArray(snap.plans) ? snap.plans : [];
  const plans = P.selectVisiblePlans(allPlans);
  const usableCount = allPlans.filter((p) => p && p.state === 'ok').length;

  // baseStatus 映射：带陈旧数据的 ERROR 依旧走 ERROR 态（保留数据渲染）
  baseStatus = snap.status || 'ERROR';
  if (baseStatus === 'OK' && usableCount === 0) baseStatus = 'EMPTY';

  // ---- 头部 ----
  accountNameEl.textContent = accountLabel(snap);
  updatedAtEl.textContent = snap.updatedAt ? formatClock(snap.updatedAt) : '—';

  // ---- 计划分组 ----
  syncPlanDom(plans);
  updateRows(plans);

  // ---- MINI 圆环（固定盯 5 小时那条的剩余） ----
  updateRing(plans);

  // ---- 异常小点 ----
  alertDotEl.hidden = baseStatus !== 'ERROR';

  // ---- 兜底浮层 ----
  renderFallback(snap, plans);

  refreshDataState();
}

/**
 * 同步面板 DOM 结构。
 *
 * 只有「结构签名」变化时才重建 —— 否则每 30 秒一次的数据刷新会把所有行元素
 * 换成新的，粒子和缓动动画就会不断从头开始，看起来像在闪。
 *
 * @param {Array} plans
 */
function syncPlanDom(plans) {
  const sig = plans
    .map((p) => `${p.product}|${p.state}|${(p.periods || []).map((x) => x.key).join(',')}`)
    .join(';');
  if (sig === lastPlanSig) return;
  lastPlanSig = sig;

  // 移除旧分组（canvas 保留）
  Array.from(panelRowsEl.querySelectorAll('.plan')).forEach((el) => el.remove());
  clearRowMaps();

  for (const plan of plans) {
    panelRowsEl.appendChild(buildPlanEl(plan));
  }

  resizeCanvas();
  reportPanelStructure();
}

/**
 * 把订阅结构（有数据 / 无数据的计划数）报给主进程，供其自适应窗口高度：
 * 只有 Coding Plan 有数据时面板收得紧凑，不再在底部留一大块空白（用户截图反馈）。
 * 只在结构签名变化（本函数被调用）时上报，极低频。
 */
function reportPanelStructure() {
  let okCount = 0;
  for (const el of panelRowsEl.querySelectorAll('.plan')) {
    if (el.dataset.state === 'ok') okCount++;
  }
  const total = panelRowsEl.querySelectorAll('.plan').length;
  window.monitor.setPanelStructure({ okCount, otherCount: total - okCount });
}

/** 清空行引用 / 动画状态 / 几何缓存（DOM 重建时调用）。 */
function clearRowMaps() {
  for (const id in rowRefs) delete rowRefs[id];
  for (const id in rowState) delete rowState[id];
  trackGeom = {};
}

/**
 * 构建一个计划分组元素。
 * @param {object} plan
 * @returns {HTMLElement}
 */
function buildPlanEl(plan) {
  const el = document.createElement('div');
  el.className = 'plan';
  el.dataset.product = plan.product;
  el.dataset.state = plan.state;

  // ---- 分组标题行：名称 + 形态徽标 ----
  const head = document.createElement('div');
  head.className = 'plan-head';

  const name = document.createElement('span');
  name.className = 'plan-name';
  name.textContent = plan.name;
  head.appendChild(name);

  if (plan.editionLabel) {
    const badge = document.createElement('span');
    badge.className = 'plan-badge';
    badge.textContent = plan.editionLabel;
    head.appendChild(badge);
  }

  el.appendChild(head);

  // ---- 未订阅 / 查询失败的占位（保持高度稳定，不让面板跳动） ----
  if (plan.state !== 'ok') {
    const empty = document.createElement('div');
    empty.className = 'plan-empty';
    if (plan.state === 'unsubscribed') empty.textContent = `未订阅 ${plan.name}`;
    else if (plan.state === 'no-seat') empty.textContent = '未绑定席位（企业版）';
    else if (plan.state === 'nodata') empty.textContent = '暂无用量数据';
    else empty.textContent = `查询失败${plan.error ? `：${plan.error}` : ''}`;
    el.appendChild(empty);
    return el;
  }

  // ---- 三条周期进度条 ----
  const rowsWrap = document.createElement('div');
  rowsWrap.className = 'plan-rows';
  for (const period of plan.periods) {
    rowsWrap.appendChild(buildRowEl(plan, period));
  }
  el.appendChild(rowsWrap);
  return el;
}

/**
 * 构建单条周期行。
 *
 * 布局是**两行**：上行「轨道 + 百分比」（百分比紧贴轨道右端），下行「重置时刻」。
 * 早先是「轨道 + 右侧 92px 固定宽的 meta 双行」，那个固定宽度会留出一大块空白，
 * 肉眼看上去数字离进度条很远；而重置时刻被挤在 9px 的小字里，几乎看不见。
 *
 * @param {object} plan
 * @param {object} period
 * @returns {HTMLElement}
 */
function buildRowEl(plan, period) {
  const id = `${plan.product}:${period.key}`;

  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.key = period.key;

  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = period.label;

  const body = document.createElement('div');
  body.className = 'row-body';

  const line = document.createElement('div');
  line.className = 'row-line';

  const track = document.createElement('div');
  track.className = 'row-track';
  const fill = document.createElement('i');
  fill.className = 'row-fill';
  track.appendChild(fill);

  const pct = document.createElement('span');
  pct.className = 'row-pct';
  pct.textContent = '—';

  line.appendChild(track);
  line.appendChild(pct);

  const reset = document.createElement('span');
  reset.className = 'row-reset';
  reset.textContent = '—';

  body.appendChild(line);
  body.appendChild(reset);

  row.appendChild(label);
  row.appendChild(body);

  rowRefs[id] = { root: row, pct, reset, track, fill };
  rowState[id] = { display: 0, target: 0, from: 0, start: 0, active: false, particles: [] };

  return row;
}

/**
 * 把快照里的数值刷到已建好的行上（剩余百分比 / 进度条长度 / 重置时刻 / 分级配色）。
 * @param {Array} plans
 */
function updateRows(plans) {
  for (const plan of plans) {
    if (plan.state !== 'ok') continue;
    for (const period of plan.periods || []) {
      const id = `${plan.product}:${period.key}`;
      const ref = rowRefs[id];
      const st = rowState[id];
      if (!ref || !st) continue;

      const remaining = clamp(Number(period.remaining) || 0, 0, 100);
      const level = period.level || P.classifyLevel(remaining);

      // 直接给数字，不加「剩」字 —— 口径由面板整体语义承担，一个字反而占地方
      ref.pct.textContent = `${remaining.toFixed(1)}%`;
      ref.reset.textContent = period.resetAt > 0 ? `${period.resetText} 重置` : '暂无重置时间';
      ref.reset.title = period.resetText || '';
      ref.fill.style.width = `${remaining}%`; // DOM 宽度立即落到目标值（QA 可直接断言）
      ref.root.classList.remove('lv-normal', 'lv-warn', 'lv-danger');
      ref.root.classList.add(`lv-${level}`);

      setTarget(id, remaining);
    }
  }
}

/**
 * 更新 MINI 圆环：固定盯「圆环目标计划的 5 小时」的剩余容量。
 * @param {Array} plans
 */
function updateRing(plans) {
  const cands = P.selectRingCandidates(plans).filter((p) => P.pickPeriod(p, RING_PERIOD));
  const target = cands.find((p) => p.product === ringProduct) || cands[0] || null;
  const period = target ? P.pickPeriod(target, RING_PERIOD) : null;
  const remaining = period ? clamp(Number(period.remaining) || 0, 0, 100) : 0;
  const level = period ? period.level || P.classifyLevel(remaining) : 'normal';

  miniEl.dataset.percent = String(remaining);
  miniEl.dataset.plan = target ? target.product : '';
  miniEl.classList.remove('lv-normal', 'lv-warn', 'lv-danger');
  miniEl.classList.add(`lv-${level}`);
  ringProgressEl.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - remaining / 100));
  miniEl.title = target
    ? `${target.name} · 5 小时剩余 ${remaining.toFixed(1)}%`
    : '火山方舟额度（无可用订阅）';
}

/** 设置某行的缓动目标。 */
function setTarget(id, target) {
  const st = rowState[id];
  if (!st || st.target === target) return;
  st.from = st.display;
  st.target = target;
  st.start = performance.now();
  st.active = true;
}

/**
 * 渲染兜底浮层。
 * NO_CLI → 安装命令（可复制）
 * NO_AUTH → 「一键登录」按钮
 * EMPTY → 提示未订阅 / 可能登录态失效 + 「重新登录」按钮（避免死胡同）
 * ERROR → 有陈旧数据则保持进度条 + 小点；无数据才用浮层显示错误摘要
 */
function renderFallback(snap, plans) {
  const hasData = plans.length > 0;
  let show = false;
  fallbackCmdEl.hidden = true;
  fallbackBtnEl.hidden = true;
  fallbackTextEl.textContent = '';

  if (baseStatus === 'NO_CLI') {
    show = true;
    fallbackTextEl.textContent = '未检测到 Ark CLI，请先安装：';
    fallbackCmdEl.hidden = false;
    fallbackCmdEl.textContent = 'npm i -g @volcengine/ark-cli';
  } else if (baseStatus === 'NO_AUTH') {
    show = true;
    fallbackTextEl.textContent = '未登录或登录态已过期（SSO 约 47 小时失效）';
    fallbackBtnEl.hidden = false;
    fallbackBtnEl.textContent = '一键登录';
  } else if (baseStatus === 'EMPTY') {
    // 覆盖一个 parse 层无法区分的场景：CLI 退出码 0、auth_method 是陈旧非 'none' 值、但无任何可用订阅。
    // 用户可能已订阅但登录态失效 → 必须给一个可点的登录入口，否则是死胡同。
    show = true;
    fallbackTextEl.textContent = '未检测到已订阅套餐；若已订阅，可能是登录态失效';
    fallbackBtnEl.hidden = false;
    fallbackBtnEl.textContent = '重新登录';
  } else if (baseStatus === 'ERROR' && !hasData) {
    show = true;
    fallbackTextEl.textContent = `查询失败：${snap.error || '未知错误'}`;
  }

  fallbackVisible = show;
  fallbackEl.hidden = !show;
}

// ---------------------------------------------------------------------------
// 渐入提示
// ---------------------------------------------------------------------------

/**
 * 显示一条渐入提示，停留一段时间后淡出。
 * @param {string} text
 */
function showToast(text) {
  if (!text) return;
  toastEl.textContent = text;
  toastEl.hidden = false;
  void toastEl.offsetWidth; // 强制回流，保证透明度过渡能真正触发
  toastEl.classList.add('show');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = null;
    toastEl.classList.remove('show');
    setTimeout(() => {
      if (!toastEl.classList.contains('show')) toastEl.hidden = true;
    }, 320);
  }, TOAST_SHOW_MS);
}

// ---------------------------------------------------------------------------
// 交互：展开 / 收回
// ---------------------------------------------------------------------------

/**
 * 把面板的真实布局尺寸报给主进程，供展开态的命中判定使用。
 *
 * 为什么不直接让主进程用窗口尺寸：Windows 会给无边框透明窗口加一圈不可见的
 * 调整边框（本机 187.5% 缩放实测：请求 360×316，win.getBounds() 却是 365×321，
 * 且多出来的部分全在右、下）。拿外框判定，鼠标往右下移出面板时要多走 5px
 * 才算「已离开」—— 表现就是面板收不起来。用 #hover 的 offset* 实测值判定，
 * 判定边界永远等于肉眼看到的边界（offset* 不受 transform 过渡影响，随时可测）。
 */
function reportPanelRect() {
  window.monitor.setPanelRect({
    left: hoverEl.offsetLeft,
    top: hoverEl.offsetTop,
    width: hoverEl.offsetWidth,
    height: hoverEl.offsetHeight
  });
}

function expand() {
  if (expanded) return;
  expanded = true;
  // 先切姿态再测量；resizeCanvas 内部用布局尺寸(offset*)，不受 scale 过渡影响。
  refreshDataState();
  resizeCanvas();
  reportPanelRect(); // 展开态的命中区以面板实测矩形为准（见函数注释）
  // 双 rAF 兜底：等一帧完成样式重算后，再校正一次几何
  requestAnimationFrame(() => requestAnimationFrame(() => {
    resizeCanvas();
    reportPanelRect();
  }));
  window.monitor.setExpanded(true); // 告知主进程：此后整个窗口都算命中区
  window.monitor.refreshNow(); // 展开瞬间补一次刷新，保证看到最新值
}

function collapse() {
  if (!expanded) return;
  expanded = false;
  refreshDataState();
  window.monitor.setExpanded(false); // 回到 MINI：命中区收缩回窗口正中那块图标
}

function scheduleCollapse() {
  if (collapseTimer) clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    collapseTimer = null;
    collapse();
  }, COLLAPSE_DELAY);
}

function cancelCollapse() {
  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
}

/** 启动「悬停展开」计时（只有贴近图标时才启动，给点击留出窗口期）。 */
function scheduleExpand() {
  if (expanded || expandTimer) return;
  expandTimer = setTimeout(() => {
    expandTimer = null;
    expand();
  }, EXPAND_DELAY);
}

function cancelExpand() {
  if (expandTimer) {
    clearTimeout(expandTimer);
    expandTimer = null;
  }
}

// 主进程以约 40Hz 轮询系统光标位置做几何命中判定，仅在状态翻转时推送。
window.monitor.onPointerOver((hit) => {
  if (hit.near) scheduleExpand();
  else cancelExpand();

  if (hit.interactive) cancelCollapse();
  else scheduleCollapse();
});

// 主进程推来的瞬态提示（切换订阅等）
window.monitor.onToast(showToast);

/** 提示气泡紧贴图标出现时用的间距（与图标 40px 的尺寸配合）。 */
const TOAST_GAP_BELOW = 46;
const TOAST_GAP_ABOVE = 34;

/**
 * 应用主进程下发的「图标在窗口内的偏移」。
 *
 * 图标**不是**钉在窗口正中的：主进程为了让「图标能贴屏幕边缘」与「面板不超出屏幕」
 * 同时成立，会动态决定图标贴在窗口的哪一角（见 main.js 的 computeLayout）。
 * 这里负责把它落到 CSS 上，并让提示气泡朝「面板展开的那一侧」出现 ——
 * 否则图标贴在窗口下沿时，气泡会飘到窗口外面去。
 *
 * @param {{x:number, y:number}} offset
 */
function applyMiniOffset(offset) {
  const x = Number(offset && offset.x) || 0;
  const y = Number(offset && offset.y) || 0;
  appEl.style.setProperty('--mini-x', `${x}px`);
  appEl.style.setProperty('--mini-y', `${y}px`);

  const winH = document.body.clientHeight || 294;
  const below = y < winH / 2;
  appEl.style.setProperty(
    '--toast-top',
    below ? `${y + TOAST_GAP_BELOW}px` : `${y - TOAST_GAP_ABOVE}px`
  );
}

window.monitor.onMiniOffset(applyMiniOffset);

// ---------------------------------------------------------------------------
// 交互：小图标上的「单击切换 / 拖拽移动」
// ---------------------------------------------------------------------------

/**
 * 手势判定放在渲染层的原因：小图标上同时压着三种手势 —— 悬停展开 / 单击切换订阅 /
 * 拖拽移动。悬停由主进程的光标轮询判定，而「单击」与「拖拽」必须靠真实鼠标事件
 * 才能区分（看位移与时长），所以这里收 mousedown / mouseup，把「移动窗口」这件事
 * 委托给主进程跟随光标完成。面板拖动走同一套机制，只是告诉主进程换一种钳制规则。
 */
miniEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  cancelExpand(); // 用户已经按下：不再展开面板，把图标让给这次手势
  pressState = {
    mode: 'icon',
    startX: e.screenX,
    startY: e.screenY,
    startTs: Date.now(),
    moved: false
  };
  window.monitor.dragStart('icon');
  e.preventDefault();
});

// 展开面板同样可以按住拖动（面板内可点击的元素要排除掉）
hoverEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('.fallback-btn, .fallback-cmd')) return;
  pressState = {
    mode: 'panel',
    startX: e.screenX,
    startY: e.screenY,
    startTs: Date.now(),
    moved: false
  };
  window.monitor.dragStart('panel');
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!pressState) return;
  if (
    Math.abs(e.screenX - pressState.startX) > CLICK_MAX_DIST ||
    Math.abs(e.screenY - pressState.startY) > CLICK_MAX_DIST
  ) {
    pressState.moved = true;
  }
});

window.addEventListener('mouseup', () => {
  if (!pressState) return;
  const st = pressState;
  pressState = null;
  window.monitor.dragEnd();

  // 只有「单击小图标」才是切换订阅：位移够小 + 时长够短。
  // 拖面板松手、拖图标松手都不做动作。
  if (st.mode === 'icon' && !st.moved && Date.now() - st.startTs < CLICK_MAX_MS) {
    window.monitor.switchRing();
  }
});

// 兜底浮层交互
fallbackCmdEl.addEventListener('click', () => {
  window.monitor.copyText(fallbackCmdEl.textContent);
  fallbackCmdEl.textContent = '已复制 ✓';
  setTimeout(() => {
    fallbackCmdEl.textContent = 'npm i -g @volcengine/ark-cli';
  }, 1200);
});

// 「一键登录 / 重新登录」按钮：按当前状态分派。
// 目前只有 NO_AUTH 与 EMPTY 会显示该按钮，二者都应唤起 SSO 登录。
fallbackBtnEl.addEventListener('click', () => {
  if (baseStatus === 'NO_AUTH' || baseStatus === 'EMPTY') {
    window.monitor.openLogin(); // → 主进程执行 `arkcli auth login volc-sso`
  }
});

// ---------------------------------------------------------------------------
// Canvas 布局缓存
// ---------------------------------------------------------------------------

function resizeCanvas() {
  // 用「布局尺寸」(clientWidth/offset*) 而非「视觉尺寸」(getBoundingClientRect)：
  // 后者受 #hover 的 transform: scale(1.03 → 1) 过渡影响，会在过渡中间帧取到缩放值，
  // 导致 canvas 背板与轨道几何被放大、粒子层像素错位。
  const cw = canvas.clientWidth || canvas.getBoundingClientRect().width;
  const ch = canvas.clientHeight || canvas.getBoundingClientRect().height;
  if (!cw || !ch) return;

  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  canvasCssW = cw;
  canvasCssH = ch;
  canvas.width = Math.max(1, Math.round(cw * dpr));
  canvas.height = Math.max(1, Math.round(ch * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // 几何真值来源 = .row-track 元素本身（布局坐标，相对同一 offsetParent: .panel-rows）
  const baseX = canvas.offsetLeft;
  const baseY = canvas.offsetTop;
  trackGeom = {};
  for (const id in rowRefs) {
    const t = rowRefs[id].track;
    trackGeom[id] = {
      x: t.offsetLeft - baseX,
      y: t.offsetTop - baseY,
      w: t.offsetWidth,
      h: t.offsetHeight
    };
  }
}

window.addEventListener('resize', resizeCanvas);

// #hover 的 scale 过渡结束后重测一次，作为防御性校正
hoverEl.addEventListener('transitionend', (e) => {
  if (e.propertyName === 'transform') resizeCanvas();
});

// ---------------------------------------------------------------------------
// 粒子系统
// ---------------------------------------------------------------------------

/**
 * 每行微粒数量：随填充段宽度增长，但保持稀疏。
 * @param {number} fillW 填充段宽度
 * @returns {number}
 */
function particleCountFor(fillW) {
  if (fillW < 6) return 0;
  return Math.max(2, Math.min(MAX_PARTICLES_PER_ROW, Math.round(fillW / 26)));
}

/**
 * 创建一粒在填充段内向右漂移的白色微粒。
 *
 * 关键设计：粒子不做「到期销毁 + 随机重生」，而是飘出右端后从左侧重新进入，
 * 两端用位置相关的淡入淡出衔接，得到连续流动而不是位置瞬移。
 *
 * @param {object} geom 轨道几何 {x,y,w,h}
 * @param {number} fillW 填充段宽度
 * @param {boolean} atLeft 是否从填充段左端进入
 * @returns {object}
 */
function spawnParticle(geom, fillW, atLeft) {
  const yc = geom.y + geom.h / 2;
  const span = Math.max(1, fillW - 2);
  return {
    x: geom.x + 1 + (atLeft ? Math.random() * Math.min(3, span) : Math.random() * span),
    y0: yc + rand(-geom.h * 0.32, geom.h * 0.32), // 各自的基准高度，避免排成一条线
    speed: rand(0.016, 0.048), // px/ms → 约 16~48 px/s
    wobble: rand(0, TAU),
    size: rand(0.7, 1.5),
    alpha: rand(0.45, 1)
  };
}

/** 推进并绘制单行的白色漂移微粒。 */
function drawRowParticles(id, dt) {
  const st = rowState[id];
  const geom = trackGeom[id];
  if (!st || !geom) return;

  const pct = clamp(st.display, 0, 100);
  const fillW = (geom.w * pct) / 100;
  const want = particleCountFor(fillW);

  while (st.particles.length > want) st.particles.pop();
  while (st.particles.length < want) st.particles.push(spawnParticle(geom, fillW, false));
  if (want === 0) return;

  const head = geom.x + fillW;

  for (let i = 0; i < st.particles.length; i++) {
    const p = st.particles[i];

    p.x += p.speed * dt; // dt 归一化 → 不同刷新率下速度一致
    p.wobble += dt * 0.004;

    // 飘出填充段右端 → 从左侧重新进入，形成连续流动
    if (p.x >= head) {
      st.particles[i] = spawnParticle(geom, fillW, true);
      continue;
    }

    // 两端淡入淡出：左端淡入、接近前沿时淡出，避免出现/消失突兀
    const t = (p.x - geom.x) / Math.max(1, fillW);
    const fade = Math.min(1, t / 0.14) * Math.min(1, (1 - t) / 0.16);

    ctx.globalAlpha = clamp(p.alpha * fade, 0, 1);
    ctx.fillStyle = 'rgba(255, 255, 255, 1)';
    ctx.beginPath();
    ctx.arc(p.x, p.y0 + Math.sin(p.wobble) * 0.6, p.size, 0, TAU);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

function shouldRunLoop() {
  return expanded && !fallbackVisible;
}

function syncParticleLoop() {
  const run = shouldRunLoop();
  if (run && rafId === null) {
    lastFrameTs = 0;
    rafId = requestAnimationFrame(frame);
  } else if (!run && rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
    ctx.clearRect(0, 0, canvasCssW, canvasCssH);
  }
}

function frame(ts) {
  rafId = requestAnimationFrame(frame);
  const dt = lastFrameTs ? Math.min(48, ts - lastFrameTs) : 16;
  lastFrameTs = ts;

  // 数值缓动（easeOutCubic，约 600ms）
  for (const id in rowState) {
    const st = rowState[id];
    if (!st.active) continue;
    const t = easeOutCubic((ts - st.start) / EASE_DURATION);
    st.display = st.from + (st.target - st.from) * t;
    if (ts - st.start >= EASE_DURATION) {
      st.display = st.target;
      st.active = false;
    }
  }

  ctx.clearRect(0, 0, canvasCssW, canvasCssH);
  ctx.globalCompositeOperation = 'lighter'; // 发光叠加（禁止 shadowBlur）

  for (const id in rowState) drawRowParticles(id, dt);

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function init() {
  resizeCanvas();
  appEl.dataset.state = 'BOOT';
  appEl.dataset.status = 'BOOT';

  /**
   * 下一帧再切 LOADING —— 但**必须先确认还没收到数据**。
   *
   * 踩过的坑：主进程若在 init 内同步完成回灌（渲染层刚 refreshNow，主进程手里
   * 就有现成快照时会发生），applySnapshot 会把状态正确地设成 OK / EMPTY / NO_AUTH，
   * 随后这个 rAF 回调才执行，又把它强写回 LOADING —— 界面于是永远停在"加载中"，
   * 而且没有任何报错。数据回得越快越容易踩（mock 的 empty / noauth 反复复现）。
   */
  requestAnimationFrame(() => {
    if (receivedAnySnapshot) return; // 数据已到，别用 LOADING 覆盖它
    baseStatus = 'LOADING';
    refreshDataState();
  });

  window.monitor.onUpdate(applySnapshot);
  window.monitor.refreshNow(); // 首次主动拉取，避免错过主进程启动瞬间的推送

  // 图标偏移走「推送 + 主动拉取」双通道。
  // 单靠推送不够：那条消息若早于本文件的 listener 注册就永久丢了，渲染层会退回
  // CSS 默认的窗口正中，而主进程的命中判定用的是真实偏移 —— 两边错位，
  // 症状就是**鼠标移到图标上完全打不开面板**（本地实测踩过）。
  window.monitor
    .getMiniOffset()
    .then(applyMiniOffset)
    .catch(() => {
      /* 拉不到就沿用默认值，不影响其它功能 */
    });

  /**
   * 启动重试：主进程的首轮查询与渲染层的 listener 注册是并发的，单次请求可能正好
   * 落在「主进程已经推完、渲染层还没订阅」的窗口里 —— 那条推送直接丢掉，
   * 界面就停在 LOADING。与其在两端猜时序，不如让渲染层在拿到第一份快照之前
   * 每隔 800ms 主动再要一次，最多 6 次。真机上首轮通常 1 次就成，重试几乎不触发。
   */
  let retries = 0;
  const retryTimer = setInterval(() => {
    if (receivedAnySnapshot || retries >= 6) {
      clearInterval(retryTimer);
      return;
    }
    retries += 1;
    window.monitor.refreshNow();
  }, 800);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
