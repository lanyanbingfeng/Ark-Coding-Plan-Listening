'use strict';

/**
 * parse.js —— 归一化 / 解析层（纯函数，零运行时依赖）
 *
 * 双环境可用（同一份逻辑，主进程与渲染层共享，避免两边算漂移）：
 *   - Electron 主进程：require('./parse')
 *   - 渲染进程（浏览器）：<script src="parse.js"></script> → window.QuotaParse
 *
 * 本文件不 require 任何东西（连 node 内置模块都不用），因此可以在纯 node 环境
 * 下 require 后喂 fixture 断言，无需启动 GUI。
 *
 * 数据源契约见 README 与官方 arkcli `usage plan --all --format json`。
 */

// ---------------------------------------------------------------------------
// 常量表
// ---------------------------------------------------------------------------

/** 周期维度归一后的展示文案。 */
const PERIOD_LABELS = {
  '5h': '5 小时',
  week: '周用量',
  month: '月用量'
};

/** 三条进度条的固定自上而下顺序。 */
const PERIOD_ORDER = ['5h', 'week', 'month'];

/** 时间戳秒 / 毫秒判定阈值：大于该值视为毫秒。 */
const MS_THRESHOLD = 9999999999;

/**
 * 计划元信息。
 *
 * 为什么要有这张表：CLI 的 `product` 是 `agent-plan` / `coding-plan` 这类机器标识，
 * 展示层需要「Agent Plan · 个人版」这种人类可读名称；且同一个 product 的
 * team / personal 两种形态要能在 UI 上区分。
 */
const PLAN_META = {
  'agent-plan': { name: 'Agent Plan', edition: 'personal', editionLabel: '个人版' },
  'coding-plan': { name: 'Coding Plan', edition: 'personal', editionLabel: '个人版' },
  'agent-plan-team': { name: 'Agent Plan', edition: 'team', editionLabel: '团队版' },
  'coding-plan-team': { name: 'Coding Plan', edition: 'team', editionLabel: '团队版' }
};

/** 计划的固定展示顺序：个人版在前，Agent 在 Coding 之前。 */
const PLAN_ORDER = ['agent-plan', 'coding-plan', 'agent-plan-team', 'coding-plan-team'];

/** 计划状态 → 展示文案。state === 'ok' 时不需要文案（直接渲染周期进度条）。 */
const STATE_LABELS = {
  ok: '',
  unsubscribed: '未订阅',
  'no-seat': '未绑定席位',
  error: '查询失败',
  nodata: '暂无用量数据'
};

/** 纯数字字符串（用于区分「数字字符串」与「RFC3339 字符串」）。 */
const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;

/**
 * 剩余容量分级阈值（按「展示值」= 剩余百分比判定）。
 *
 * 为什么按剩余而不是按已用：进度条展示的是剩余容量（倒计时口径，见 classifyLevel），
 * 颜色必须跟展示值语义一致 —— 剩余越少越告警。
 */
const REMAIN_WARN = 40; // 剩余 ≤ 40% → 亮紫
const REMAIN_DANGER = 15; // 剩余 ≤ 15% → 警示红紫

// ---------------------------------------------------------------------------
// 基础工具（纯函数）
// ---------------------------------------------------------------------------

/**
 * 判断时间戳是否为毫秒级。
 * 规则：ts > 9999999999 → 毫秒，否则秒。
 * @param {number} ts
 * @returns {boolean}
 */
function isMilliseconds(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > MS_THRESHOLD;
}

/**
 * 把「任意形态的时间值」归一为毫秒时间戳。
 *
 * 为什么需要它（真实踩坑）：早期实现只认数字时间戳，但 arkcli 的 `reset_at`
 * 实际是 **RFC3339 字符串**（如 "2026-09-17T18:55:54+08:00"）。
 * `Number("2026-09-17T18:55:54+08:00")` → NaN → 一路落到「暂无重置时间」，
 * 表现为「明明有重置时间却显示不出来」。这里把数字 / 数字字符串 / ISO 字符串
 * 三种形态统一收口。
 *
 * @param {number|string|null|undefined} value
 * @returns {number} 归一后的毫秒时间戳；无数据返回 -1（哨兵）
 */
function parseTimeValue(value) {
  if (value === null || value === undefined) return -1;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return -1; // -1 / 0 / NaN 均为无数据
    return Math.round(isMilliseconds(value) ? value : value * 1000);
  }

  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return -1;
    if (NUMERIC_RE.test(s)) return parseTimeValue(Number(s));
    // RFC3339 / ISO 8601（带时区偏移，如 2026-09-17T18:55:54+08:00）
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? -1 : ms;
  }

  return -1;
}

/** 兼容旧名（README / 旧调用点用 normalizeTimestamp）。 */
function normalizeTimestamp(ts) {
  return parseTimeValue(ts);
}

/**
 * 将 reset_at 格式化为「MM-DD HH:mm」（绝对时刻）。
 * 坑 1：reset_at === -1 表示无数据，必须显示「暂无重置时间」，绝不能落成 1969 年。
 * @param {number} resetAt 原始秒/毫秒时间戳或 RFC3339 字符串，-1 表示无数据
 * @returns {string}
 */
function formatResetTime(resetAt) {
  const ms = parseTimeValue(resetAt);
  if (ms === -1) return '暂无重置时间';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '暂无重置时间';
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 进度条 / 圆环的着色分级。
 *
 * ⚠️ 注意入参语义：这里收的是**展示值**，也就是「剩余容量百分比」
 * （进度条走的是倒计时口径：数字随消耗下降、条子随消耗变短）。
 * 所以判定方向是「剩余越少越危险」，跟直觉里的「占用率越高越危险」是镜像的：
 *   剩余 > 40%        → normal（主紫，充裕）
 *   15% < 剩余 ≤ 40%  → warn（亮紫，过半）
 *   剩余 ≤ 15%        → danger（警示红紫，快见底）
 *
 * @param {number} remaining 剩余容量百分比（0–100）
 * @returns {'normal'|'warn'|'danger'}
 */
function classifyLevel(remaining) {
  const p = Number(remaining);
  if (!Number.isFinite(p)) return 'normal';
  if (p <= REMAIN_DANGER) return 'danger';
  if (p <= REMAIN_WARN) return 'warn';
  return 'normal';
}
/**
 * 周期标签归一。
 * 坑 5：session 与 5h 是同一维度的两种叫法，都要映射到 '5h'。
 * （Coding Plan 后端返 session，Agent Plan 返 5h。）
 * @param {string} label 原始 label
 * @returns {'5h'|'week'|'month'|null} 归一键；未知维度返回 null（如 daily，不展示）
 */
function normalizePeriodLabel(label) {
  const key = String(label === null || label === undefined ? '' : label)
    .trim()
    .toLowerCase();
  if (key === 'session' || key === '5h' || key === '5hr' || key === '5hour') return '5h';
  if (key === 'weekly' || key === 'week') return 'week';
  if (key === 'monthly' || key === 'month') return 'month';
  return null;
}

/**
 * 将任意输入钳制为 0–100 的百分比，保留 1 位小数。
 * @param {number} percent
 * @returns {number}
 */
function clampPercent(percent) {
  let p = Number(percent);
  if (!Number.isFinite(p)) p = 0;
  if (p < 0) p = 0;
  if (p > 100) p = 100;
  return Math.round(p * 10) / 10;
}

// ---------------------------------------------------------------------------
// 核心解析
// ---------------------------------------------------------------------------

/**
 * 把单条 period 原始对象解析为归一化周期对象。
 * 坑 1（reset_at 缺失 / -1）、坑 2（秒 / 毫秒 / RFC3339 三种形态）在此处被吸收。
 *
 * 进度口径：CLI 给的是**已用** percent，但本软件展示的是**剩余**（倒计时口径 ——
 * 数字随消耗往下掉、条子随消耗变短）。两个值都在这里算好，展示层直接用
 * `remaining`，不必自己做 100-x 的减法，避免前后端口径漂移。
 *
 * @param {object} raw
 * @returns {object|null} 维度可识别时返回归一化周期，否则 null
 */
function buildPeriod(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = normalizePeriodLabel(raw.label);
  if (!key) return null; // daily 等不展示的维度

  const percent = clampPercent(raw.percent); // 已用百分比
  const remaining = clampPercent(100 - percent); // 剩余百分比（展示值）
  const resetAt = parseTimeValue(raw.reset_at);
  const usedNum = Number(raw.used);
  const totalNum = Number(raw.total);

  return {
    key,
    label: PERIOD_LABELS[key],
    percent, // 已用（内部口径）
    remaining, // 剩余（UI 展示值：进度条长度 / 圆环弧长 / 数字）
    used: Number.isFinite(usedNum) ? usedNum : null,
    total: Number.isFinite(totalNum) ? totalNum : null,
    resetAt, // 毫秒；-1 = 无数据
    resetText: formatResetTime(resetAt), // 具体重置时刻，如「09-17 18:55」
    hasData: true,
    level: classifyLevel(remaining) // 按剩余分级（剩余越少越告警）
  };
}

/**
 * 判断一条周期是否真的带数据。
 *
 * 为什么需要这个判据（实测踩到）：CLI 的 `subscribed` 字段**不可靠** ——
 * 账号明明没订 Agent Plan，`usage plan --all` 照样返回
 *   { product: 'agent-plan', subscribed: true, periods: [{label:'5h',percent:0}, ...] }
 * 三条周期全是 0% 且**一个 reset_at 都没有**。界面照 subscribed 渲染，就变成
 * 三条满进度条，看着像「额度满满」，其实根本没订。
 *
 * 可靠信号是 reset_at：官方契约明确「周期内无数据的 sentinel 不输出该字段」，
 * 所以真订阅的桶必然带 reset_at（实测 coding-plan 三条都带）。
 * 再叠加 percent / used 兜底，避免将来契约漂移时把「确实有消耗的订阅」误判成未订阅 ——
 * 那个方向的误判代价更大（会把用户真实的用量藏起来）。
 *
 * @param {object} period buildPeriod 的产物
 * @returns {boolean}
 */
function hasRealData(period) {
  if (!period) return false;
  if (Number.isFinite(period.resetAt) && period.resetAt > 0) return true;
  if (Number.isFinite(period.percent) && period.percent > 0) return true;
  if (Number.isFinite(period.used) && period.used > 0) return true;
  return false;
}

/**
 * 把单条 item（一个套餐桶）解析为归一化计划对象。
 *
 * 计划状态判定优先级（顺序不能变）：
 *   1. error 且是「未绑席位」→ no-seat（这是「订了但 caller 没绑」，不是未订阅）
 *   2. 其它 error            → error
 *   3. subscribed !== true   → unsubscribed
 *   4. 一个周期都没有         → nodata
 *   5. 有周期但一条有效数据都没有 → unsubscribed（见 hasRealData）
 *   6. 否则                  → ok
 *
 * @param {object} rawItem
 * @returns {object}
 */
function buildPlan(rawItem) {
  const src = rawItem && typeof rawItem === 'object' ? rawItem : {};
  const product = typeof src.product === 'string' ? src.product : 'unknown';
  const meta = PLAN_META[product] || {
    name: product,
    edition: typeof src.edition === 'string' ? src.edition : 'unknown',
    editionLabel: ''
  };

  const error = typeof src.error === 'string' ? src.error : null;
  const subscribed = src.subscribed === true;

  // 坑 3：subscribed === false 的 item 其 periods 可能为空数组 —— 对 periods
  // 缺失 / 非法数组做兜底，绝不抛错。
  const rawPeriods = Array.isArray(src.periods) ? src.periods : [];
  const periods = [];
  for (const rp of rawPeriods) {
    const p = buildPeriod(rp);
    if (!p) continue; // 未知维度跳过
    if (periods.some((x) => x.key === p.key)) continue; // 同维度去重
    periods.push(p);
  }
  periods.sort((a, b) => PERIOD_ORDER.indexOf(a.key) - PERIOD_ORDER.indexOf(b.key));

  let state = 'ok';
  if (error && /no seat bound/i.test(error)) state = 'no-seat';
  else if (error) state = 'error';
  else if (!subscribed) state = 'unsubscribed';
  else if (periods.length === 0) state = 'nodata';
  else if (!periods.some(hasRealData)) state = 'unsubscribed'; // ← 见 hasRealData

  return {
    product,
    name: meta.name,
    edition: meta.edition,
    editionLabel: meta.editionLabel,
    tier: typeof src.tier === 'string' ? src.tier : null,
    subscribed,
    state,
    // 未订阅时带上计划名，UI 可以直接显示「未订阅 Agent Plan」而无需自己拼
    stateLabel: state === 'unsubscribed' ? `未订阅 ${meta.name}` : STATE_LABELS[state] || '',
    error,
    updatedAt: parseTimeValue(src.updated_at),
    periods
  };
}

/**
 * 构造一个失败 / 兜底快照，并把上一次的有效数据挂上（保证 UI 不闪空）。
 *
 * 注意：EMPTY 态不携带旧数据 —— 其浮层是全屏覆盖，陈旧数据不可见，
 *       携带属无用负担；其余失败态（ERROR / NO_AUTH / NO_CLI）继续保留旧数据。
 *
 * @param {'NO_CLI'|'NO_AUTH'|'ERROR'|'EMPTY'} status
 * @param {string} message 面向用户的错误摘要
 * @param {object|null} prev 上一次的成功快照（status === 'OK'）
 * @param {object} [viewer] 若可解析出 viewer 则带上
 * @param {number} [now]
 * @returns {object}
 */
function buildFailureSnapshot(status, message, prev, viewer, now) {
  const prevGood = prev && prev.status === 'OK' ? prev : null;
  // 仅非 EMPTY 的失败态保留旧数据（「数据不闪空」铁律只针对可见场景）
  const carried =
    status !== 'EMPTY' && prevGood && Array.isArray(prevGood.plans) ? prevGood.plans : [];

  // 与 normalizeSnapshot 保持同一语义：viewer 缺失 / auth_method 缺失时记为 'unknown'，
  // 不得默认成 'none'（否则会把「元信息缺失」误读为「未登录」）。
  const authMethod =
    viewer && typeof viewer.auth_method === 'string'
      ? viewer.auth_method
      : prevGood && typeof prevGood.authMethod === 'string'
      ? prevGood.authMethod
      : 'unknown';

  const account = viewer && Object.keys(viewer).length
    ? buildAccount(viewer)
    : prevGood
    ? prevGood.account
    : null;

  return {
    ok: false,
    status,
    updatedAt: Number.isFinite(now) ? now : Date.now(),
    sourceUpdatedAt: prevGood ? prevGood.sourceUpdatedAt : -1,
    authMethod,
    viewer: viewer || (prevGood ? prevGood.viewer : {}),
    account,
    plans: carried,
    stale: carried.length > 0,
    error: message || null
  };
}

/**
 * 从 viewer 提取可展示的账号摘要。
 * @param {object} viewer
 * @returns {object|null}
 */
function buildAccount(viewer) {
  if (!viewer || typeof viewer !== 'object') return null;
  return {
    userName: typeof viewer.user_name === 'string' && viewer.user_name ? viewer.user_name : null,
    accountId: viewer.account_id !== null && viewer.account_id !== undefined ? String(viewer.account_id) : null,
    region: typeof viewer.region === 'string' && viewer.region ? viewer.region : null,
    profile: typeof viewer.profile === 'string' && viewer.profile ? viewer.profile : null
  };
}

/**
 * 取所有计划里最新的 updated_at（毫秒），无则 -1。
 * @param {Array} plans
 * @returns {number}
 */
function pickLatestUpdatedAt(plans) {
  let latest = -1;
  for (const p of plans) {
    if (p && Number.isFinite(p.updatedAt) && p.updatedAt > latest) latest = p.updatedAt;
  }
  return latest;
}

/**
 * 主归一化函数：把 `arkcli usage plan --all --format json` 的原始返回
 * 转成渲染进程可直接消费的快照对象。
 *
 * @param {object} raw CLI 输出的 JSON 对象
 * @param {object} [prev] 上一次的成功快照（异常时用于保留旧数据）
 * @param {number} [now] 当前时间（毫秒），便于单测
 * @returns {object} 归一化快照
 */
function normalizeSnapshot(raw, prev, now) {
  const nowMs = Number.isFinite(now) ? now : Date.now();

  if (!raw || typeof raw !== 'object') {
    return buildFailureSnapshot('ERROR', '返回数据为空或格式非法', prev, null, nowMs);
  }

  // 严格区分「viewer 存在」与「viewer 缺失」：只有前者才能表达登录语义。
  const hasViewer = !!raw.viewer && typeof raw.viewer === 'object' && !Array.isArray(raw.viewer);
  const viewer = hasViewer ? raw.viewer : {};
  const explicitAuth = hasViewer && typeof viewer.auth_method === 'string' ? viewer.auth_method : null;

  // NO_AUTH：仅当 viewer 存在且「显式」声明 auth_method === 'none' 时判定。
  // 若 viewer 整体缺失（官方契约漂移），不能据此误报未登录 —— 否则会把真实 items 藏起来。
  if (explicitAuth === 'none') {
    return buildFailureSnapshot('NO_AUTH', '未登录或登录态已过期', prev, viewer, nowMs);
  }

  const items = Array.isArray(raw.items) ? raw.items : [];
  // 按 product 建索引（同名只取第一条，防重复桶）
  const byProduct = new Map();
  for (const it of items) {
    if (it && typeof it.product === 'string' && !byProduct.has(it.product)) {
      byProduct.set(it.product, it);
    }
  }

  // 坑 6：`usage plan`（不带 --all）只返回探测到的桶，会把已订阅的 Agent Plan 漏掉。
  // 这里按固定顺序补齐 4 个桶：CLI 没返回的视为未订阅，UI 上照样能看到
  // 「未订阅 Agent Plan」这行，而不是整块消失。
  const plans = PLAN_ORDER.map((product) => {
    const it = byProduct.get(product);
    if (it) return buildPlan(it);
    const meta = PLAN_META[product];
    return {
      product,
      name: meta.name,
      edition: meta.edition,
      editionLabel: meta.editionLabel,
      tier: null,
      subscribed: false,
      state: 'unsubscribed',
      stateLabel: `未订阅 ${meta.name}`,
      error: null,
      updatedAt: -1,
      periods: []
    };
  });

  const usable = plans.filter((p) => p.state === 'ok');

  if (usable.length === 0) {
    // 坑 4：无任何已订阅套餐
    if (!hasViewer) {
      // 元信息缺失 + 无数据 → ERROR（降级方向偏安全的正确选择，而非 NO_AUTH）
      return buildFailureSnapshot('ERROR', '返回缺少 viewer 元信息，且无可用套餐数据', prev, null, nowMs);
    }
    return buildFailureSnapshot('EMPTY', '未检测到已订阅套餐；若已订阅，可能是登录态失效', prev, viewer, nowMs);
  }

  return {
    ok: true,
    status: 'OK',
    updatedAt: nowMs,
    sourceUpdatedAt: pickLatestUpdatedAt(usable),
    authMethod: explicitAuth === null ? 'unknown' : explicitAuth,
    viewer,
    account: buildAccount(viewer),
    plans,
    stale: false,
    error: null
  };
}

/**
 * 挑出 UI 需要渲染的计划。
 *
 * 规则：个人版全展示（未订阅也要显示「未订阅 X」这行，用户才知道自己没订）；
 *       团队版只在真有数据（state === 'ok'）时才展示，避免「未绑定席位」这种
 *       探测噪音常驻面板。
 *
 * @param {Array} plans
 * @returns {Array}
 */
function selectVisiblePlans(plans) {
  if (!Array.isArray(plans)) return [];
  return plans.filter((p) => p && (p.edition === 'personal' || p.state === 'ok'));
}

/**
 * 挑出「圆环可以盯」的计划：必须有真实周期数据。
 * @param {Array} plans
 * @returns {Array}
 */
function selectRingCandidates(plans) {
  if (!Array.isArray(plans)) return [];
  return plans.filter((p) => p && p.state === 'ok' && p.edition === 'personal');
}

/**
 * 从计划里取指定周期（默认 5h）的百分比。
 * @param {object} plan
 * @param {string} [key]
 * @returns {object|null} 命中的周期对象（含 percent 已用 / remaining 剩余 / resetText）
 */
function pickPeriod(plan, key) {
  if (!plan || !Array.isArray(plan.periods)) return null;
  const target = key || '5h';
  return plan.periods.find((p) => p && p.key === target) || null;
}

// ---------------------------------------------------------------------------
// 导出（node + 浏览器双环境）
// ---------------------------------------------------------------------------

const API = {
  // 常量
  PERIOD_LABELS,
  PERIOD_ORDER,
  PLAN_META,
  PLAN_ORDER,
  STATE_LABELS,
  MS_THRESHOLD,
  // 纯函数
  isMilliseconds,
  parseTimeValue,
  normalizeTimestamp,
  formatResetTime,
  normalizePeriodLabel,
  classifyLevel,
  clampPercent,
  buildPeriod,
  buildPlan,
  hasRealData,
  buildAccount,
  buildFailureSnapshot,
  normalizeSnapshot,
  selectVisiblePlans,
  selectRingCandidates,
  pickPeriod
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}
if (typeof window !== 'undefined') {
  window.QuotaParse = API;
}
