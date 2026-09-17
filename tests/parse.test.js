'use strict';

/**
 * parse.test.js —— 解析层单测（零依赖，纯 node 跑）
 *
 *   node tests/parse.test.js
 *
 * 为什么值得单独维护：解析层踩过的坑全是「真实契约与假设不符」造成的，
 * 而且症状很隐蔽（有数据却显示「暂无重置时间」、明明订阅了却不显示）。
 * 这些用例把每个坑都钉死在回归测试里。
 */

const assert = require('assert');
const {
  parseTimeValue,
  formatResetTime,
  normalizePeriodLabel,
  classifyLevel,
  clampPercent,
  buildPeriod,
  buildPlan,
  hasRealData,
  normalizeSnapshot,
  buildFailureSnapshot,
  selectVisiblePlans,
  selectRingCandidates,
  pickPeriod
} = require('../src/parse');
const { getMockScenario, iso } = require('../src/mock');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err && err.message}`);
  }
}

function group(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
group('时间解析（核心 bug 修复：RFC3339 字符串）');

test('RFC3339 带时区偏移的字符串能被解析', () => {
  // 这是真实 arkcli 的 reset_at 形态 —— 老实现只认数字，Number() 出 NaN → 永远显示「暂无重置时间」
  const ms = parseTimeValue('2026-09-17T18:55:54+08:00');
  assert.strictEqual(ms, Date.parse('2026-09-17T18:55:54+08:00'));
  assert.ok(Number.isFinite(ms) && ms > 0);
});

test('秒级数字时间戳按秒换算', () => {
  assert.strictEqual(parseTimeValue(1789635443), 1789635443000);
});

test('毫秒级数字时间戳原样保留', () => {
  assert.strictEqual(parseTimeValue(1789635443000), 1789635443000);
});

test('数字字符串按数字处理', () => {
  assert.strictEqual(parseTimeValue('1789635443'), 1789635443000);
});

test('哨兵与非法值统一回落 -1', () => {
  assert.strictEqual(parseTimeValue(-1), -1);
  assert.strictEqual(parseTimeValue(0), -1);
  assert.strictEqual(parseTimeValue(null), -1);
  assert.strictEqual(parseTimeValue(undefined), -1);
  assert.strictEqual(parseTimeValue(''), -1);
  assert.strictEqual(parseTimeValue('not-a-date'), -1);
  assert.strictEqual(parseTimeValue(NaN), -1);
});

test('formatResetTime 输出 MM-DD HH:mm（不是 1969 年）', () => {
  const text = formatResetTime('2026-09-17T18:55:54+08:00');
  assert.match(text, /^\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.ok(!text.includes('1970') && !text.includes('1969'));
  assert.strictEqual(formatResetTime(-1), '暂无重置时间');
  assert.strictEqual(formatResetTime('not-a-date'), '暂无重置时间');
});

// ---------------------------------------------------------------------------
group('周期标签与分级');

test('session 与 5h 归一为同一维度', () => {
  assert.strictEqual(normalizePeriodLabel('session'), '5h');
  assert.strictEqual(normalizePeriodLabel('5h'), '5h');
  assert.strictEqual(normalizePeriodLabel('weekly'), 'week');
  assert.strictEqual(normalizePeriodLabel('MONTHLY'), 'month');
});

test('daily 等未知维度返回 null（不展示）', () => {
  assert.strictEqual(normalizePeriodLabel('daily'), null);
  assert.strictEqual(normalizePeriodLabel(''), null);
});

test('分级按「剩余」判定：剩余越少越告警', () => {
  assert.strictEqual(classifyLevel(80), 'normal');
  assert.strictEqual(classifyLevel(41), 'normal');
  assert.strictEqual(classifyLevel(40), 'warn');
  assert.strictEqual(classifyLevel(16), 'warn');
  assert.strictEqual(classifyLevel(15), 'danger');
  assert.strictEqual(classifyLevel(0), 'danger');
});

test('百分比钳制在 0–100 且保留一位小数', () => {
  assert.strictEqual(clampPercent(-5), 0);
  assert.strictEqual(clampPercent(130), 100);
  assert.strictEqual(clampPercent(47.971292500000004), 48.0);
});

// ---------------------------------------------------------------------------
group('周期对象：已用 → 剩余 的口径转换');

test('remaining = 100 - percent，重置时刻取具体时间', () => {
  const p = buildPeriod({ label: 'session', percent: 47.971292500000004, reset_at: '2026-09-17T18:55:54+08:00' });
  assert.strictEqual(p.key, '5h');
  assert.strictEqual(p.percent, 48.0); // 已用
  assert.strictEqual(p.remaining, 52.0); // 剩余（展示值）
  assert.strictEqual(p.level, 'normal');
  assert.match(p.resetText, /^\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('没有 reset_at 字段时显示「暂无重置时间」，且 remaining 正常', () => {
  const p = buildPeriod({ label: '5h', percent: 0 });
  assert.strictEqual(p.remaining, 100);
  assert.strictEqual(p.resetText, '暂无重置时间');
  assert.strictEqual(p.resetAt, -1);
});

// ---------------------------------------------------------------------------
group('多计划归一化：Agent Plan 必须出现');

test('--all 的 4 个桶全部解析出来', () => {
  const snap = normalizeSnapshot(getMockScenario('normal').data);
  assert.strictEqual(snap.status, 'OK');
  assert.strictEqual(snap.plans.length, 4);
  assert.deepStrictEqual(
    snap.plans.map((p) => p.product),
    ['agent-plan', 'coding-plan', 'agent-plan-team', 'coding-plan-team']
  );
});

test('带 subscribed 标记但一条用量数据都没有 → 判定为未订阅', () => {
  // 实测：账号没订 Agent Plan，CLI 依旧返回 subscribed:true + 三条 percent:0 且无 reset_at。
  // 老实现照 subscribed 渲染，就变成三条满进度条，看着像「额度满满」。
  const snap = normalizeSnapshot(getMockScenario('normal').data);
  const ap = snap.plans.find((p) => p.product === 'agent-plan');
  assert.strictEqual(ap.subscribed, true); // CLI 的原始标记仍然是 true
  assert.strictEqual(ap.state, 'unsubscribed');
  assert.strictEqual(ap.stateLabel, '未订阅 Agent Plan');
  assert.strictEqual(ap.periods.length, 3); // 周期照旧解析出来，只是不按进度条展示
});

test('hasRealData：reset_at / percent / used 任一有值即算真实数据', () => {
  assert.strictEqual(hasRealData({ resetAt: 1789635443000, percent: 0, used: null }), true);
  assert.strictEqual(hasRealData({ resetAt: -1, percent: 12.5, used: null }), true);
  assert.strictEqual(hasRealData({ resetAt: -1, percent: 0, used: 500 }), true);
  assert.strictEqual(hasRealData({ resetAt: -1, percent: 0, used: 0 }), false);
  assert.strictEqual(hasRealData({ resetAt: -1, percent: 0, used: null }), false);
  assert.strictEqual(hasRealData(null), false);
});

test('Coding Plan 的 RFC3339 reset_at 能落到 resetText', () => {
  const snap = normalizeSnapshot(getMockScenario('normal').data);
  const cp = snap.plans.find((p) => p.product === 'coding-plan');
  const five = pickPeriod(cp, '5h');
  assert.ok(five);
  assert.strictEqual(five.remaining, 52.0);
  assert.notStrictEqual(five.resetText, '暂无重置时间');
});

test('未订阅的计划仍产出占位，且带「未订阅 X」文案', () => {
  const snap = normalizeSnapshot(getMockScenario('edge').data);
  const ap = snap.plans.find((p) => p.product === 'agent-plan');
  assert.strictEqual(ap.state, 'unsubscribed');
  assert.strictEqual(ap.stateLabel, '未订阅 Agent Plan');
  assert.strictEqual(ap.subscribed, false);
});

test('CLI 完全没返回的桶也会补成「未订阅」占位', () => {
  // edge 场景里 agent-plan-team 整个缺失
  const snap = normalizeSnapshot(getMockScenario('edge').data);
  assert.ok(snap.plans.some((p) => p.product === 'agent-plan-team'));
});

test('团队版「未绑席位」识别为 no-seat，而不是未订阅', () => {
  const snap = normalizeSnapshot(getMockScenario('normal').data);
  const t = snap.plans.find((p) => p.product === 'agent-plan-team');
  assert.strictEqual(t.state, 'no-seat');
  assert.strictEqual(t.subscribed, true);
});

// ---------------------------------------------------------------------------
group('边界场景（edge）');

test('session 与 5h 同维度去重，且 daily 被跳过', () => {
  const snap = normalizeSnapshot(getMockScenario('edge').data);
  const cp = snap.plans.find((p) => p.product === 'coding-plan');
  assert.deepStrictEqual(cp.periods.map((p) => p.key), ['5h', 'week', 'month']);
  assert.strictEqual(cp.periods[0].remaining, 11.2); // session 88.8 胜出
  assert.strictEqual(cp.periods[0].level, 'danger');
});

test('reset_at=-1 与非法时间字符串都回落为「暂无重置时间」', () => {
  const snap = normalizeSnapshot(getMockScenario('edge').data);
  const cp = snap.plans.find((p) => p.product === 'coding-plan');
  assert.strictEqual(pickPeriod(cp, 'week').resetText, '暂无重置时间');
  assert.strictEqual(pickPeriod(cp, 'month').resetText, '暂无重置时间');
});

test('团队版有真实数据时状态为 ok（可被展示）', () => {
  const snap = normalizeSnapshot(getMockScenario('edge').data);
  const t = snap.plans.find((p) => p.product === 'coding-plan-team');
  assert.strictEqual(t.state, 'ok');
  assert.strictEqual(t.periods.length, 3);
});

test('visiblePlans：个人版全展示 + 有数据的团队版也展示', () => {
  const snap = normalizeSnapshot(getMockScenario('edge').data);
  const visible = selectVisiblePlans(snap.plans).map((p) => p.product);
  assert.deepStrictEqual(visible, ['agent-plan', 'coding-plan', 'coding-plan-team']);
});

test('ringCandidates：只有「有真实数据的个人版」能当圆环目标', () => {
  // normal 场景里 Agent Plan 只有 subscribed 标记、没有任何用量数据 → 不算候选
  const snap = normalizeSnapshot(getMockScenario('normal').data);
  const cands = selectRingCandidates(snap.plans).map((p) => p.product);
  assert.deepStrictEqual(cands, ['coding-plan']);

  const lowSnap = normalizeSnapshot(getMockScenario('low').data);
  const lowFive = pickPeriod(lowSnap.plans.find((p) => p.product === 'coding-plan'), '5h');
  assert.strictEqual(lowFive.remaining, 8.5);
  assert.strictEqual(lowFive.level, 'danger');
});

// ---------------------------------------------------------------------------
group('异常兜底与空数据');

test('empty 场景 → EMPTY', () => {
  const snap = normalizeSnapshot(getMockScenario('empty').data);
  assert.strictEqual(snap.status, 'EMPTY');
  assert.deepStrictEqual(snap.plans, []); // EMPTY 不携带陈旧数据
});

test('noauth 场景 → NO_AUTH', () => {
  const snap = normalizeSnapshot(getMockScenario('noauth').data);
  assert.strictEqual(snap.status, 'NO_AUTH');
});

test('返回非法对象 → ERROR 而不是抛错', () => {
  assert.strictEqual(normalizeSnapshot(null).status, 'ERROR');
  assert.strictEqual(normalizeSnapshot('oops').status, 'ERROR');
  assert.strictEqual(normalizeSnapshot({}).status, 'ERROR');
});

test('失败快照保留上一次的有效 plans（数据不闪空）', () => {
  const good = normalizeSnapshot(getMockScenario('normal').data);
  const bad = normalizeSnapshot({ viewer: { auth_method: 'sso' }, items: 'not-an-array' }, good);
  assert.strictEqual(bad.status, 'EMPTY');
  // EMPTY 按设计不带旧数据
  assert.strictEqual(bad.plans.length, 0);

  const err = buildFailureSnapshot('ERROR', '炸了', good);
  assert.strictEqual(err.stale, true);
  assert.strictEqual(err.plans.length, 4);
  assert.strictEqual(err.error, '炸了');
});

test('buildPlan 容忍 periods 缺失 / 非法', () => {
  const p1 = buildPlan({ product: 'agent-plan', subscribed: true });
  assert.strictEqual(p1.state, 'nodata');
  const p2 = buildPlan({ product: 'agent-plan', subscribed: true, periods: 'nope' });
  assert.strictEqual(p2.state, 'nodata');
  const p3 = buildPlan(null);
  assert.strictEqual(p3.product, 'unknown');
});

test('mock 的 iso() 产出的字符串能被解析回同一时刻（含时区）', () => {
  const s = iso(3600 * 1000);
  const ms = parseTimeValue(s);
  assert.ok(Number.isFinite(ms) && ms > 0);
  // 允许 2 秒误差（生成时截断到秒）
  assert.ok(Math.abs(ms - (Date.now() + 3600 * 1000)) < 2000);
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
