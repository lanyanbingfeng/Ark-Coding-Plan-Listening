'use strict';

/**
 * mock.js —— 内置假数据场景（零依赖，可被 QA 直接 require）
 *
 * 供 `--mock=<场景名>` 启动模式使用；主进程在 mock 模式下不调用真实 arkcli，
 * 直接消费这里的 fixture，因此 QA 可在不登录、不联网的情况下验证全部解析分支。
 *
 * 每个场景形如：
 *   { type: 'raw',  data: <arkcli 原始 JSON> | () => <原始 JSON> }  → 交给 normalizeSnapshot()
 *   { type: 'fail', status: 'ERROR', message }                      → 模拟 CLI 层失败（超时 / 未安装 / 未登录）
 *
 * `data` 允许是个函数：时间字段（reset_at）需要**相对当前时间**生成，
 * 否则写死的时间戳一过就变成「早已重置」，mock 看起来就不像真的了。
 */

// ---------------------------------------------------------------------------
// 时间工具
// ---------------------------------------------------------------------------

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * 生成「当前时间 + offsetMs」的 RFC3339 字符串（带本地时区偏移，形如 +08:00）。
 * 这正是 arkcli 输出的 reset_at 格式 —— mock 必须和真实契约保持一致，
 * 否则又会漏测「ISO 字符串解析」这条路径。
 * @param {number} offsetMs 相对当前时间的偏移（毫秒）
 * @returns {string}
 */
function iso(offsetMs) {
  const d = new Date(Date.now() + offsetMs);
  const pad = (x) => String(x).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 秒级基准时间戳（模拟 Coding Plan 的 updated_at，CLI 输出为秒）。 */
const S = 1758000000;

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

const MOCK_SCENARIOS = {
  /**
   * normal —— 真实主场景（1:1 镜像实测的 `usage plan --all` 输出）。
   *
   * 覆盖三条关键事实：
   *   1. `--all` 会同时返回 4 个桶，Agent Plan 已订阅（periods 全 0 且**没有** reset_at 字段）
   *   2. Coding Plan 的 reset_at 是 RFC3339 字符串
   *   3. team 桶返回 subscribed=true + error「no seat bound」（订了但 caller 没绑席位）
   */
  normal: {
    type: 'raw',
    data: () => ({
      viewer: {
        auth_method: 'sso',
        is_root: true,
        user_id: '2125973793',
        user_name: 'demo-root',
        account_id: '2125973793',
        profile: 'coding-plan_cn-beijing_personal',
        tenant: 'volc',
        region: 'cn-beijing',
        project_name: 'default'
      },
      items: [
        {
          product: 'agent-plan',
          edition: 'personal',
          subscribed: true,
          periods: [
            // Agent Plan 周期内无用量时：只有 percent，reset_at 字段整条不出现（sentinel 不输出）
            { label: '5h', percent: 0 },
            { label: 'weekly', percent: 0 },
            { label: 'monthly', percent: 0 }
          ]
        },
        {
          product: 'coding-plan',
          edition: 'personal',
          subscribed: true,
          updated_at: Math.floor(Date.now() / 1000),
          periods: [
            { label: 'session', percent: 47.971292500000004, reset_at: iso(2 * HOUR + 55 * MIN) },
            { label: 'weekly', percent: 55.737063666666664, reset_at: iso(3 * DAY + 5 * HOUR) },
            { label: 'monthly', percent: 27.868531833333332, reset_at: iso(28 * DAY) }
          ]
        },
        {
          product: 'agent-plan-team',
          edition: 'team',
          subscribed: true,
          error: 'no seat bound to caller for AgentPlan team; pass --seat <id> if querying on behalf of another seat'
        },
        {
          product: 'coding-plan-team',
          edition: 'team',
          subscribed: true,
          error: 'no seat bound to caller for CodingPlan team; pass --seat <id> if querying on behalf of another seat'
        }
      ]
    })
  },

  /**
   * low —— 剩余告警档：Coding Plan 快见底（剩余 8.5% / 22% / 60%），
   * 用于验证「剩余 ≤ 15% → danger 红紫」和 MINI 圆环的配色。
   */
  low: {
    type: 'raw',
    data: () => ({
      viewer: {
        auth_method: 'sso',
        is_root: true,
        user_id: '2125973793',
        user_name: 'demo-root',
        account_id: '2125973793',
        profile: 'coding-plan_cn-beijing_personal',
        tenant: 'volc',
        region: 'cn-beijing',
        project_name: 'default'
      },
      items: [
        {
          product: 'agent-plan',
          edition: 'personal',
          subscribed: true,
          periods: [
            { label: '5h', percent: 96.0, reset_at: iso(40 * MIN) },
            { label: 'weekly', percent: 88.0, reset_at: iso(2 * DAY) },
            { label: 'monthly', percent: 41.5, reset_at: iso(20 * DAY) }
          ]
        },
        {
          product: 'coding-plan',
          edition: 'personal',
          subscribed: true,
          updated_at: Math.floor(Date.now() / 1000),
          periods: [
            { label: 'session', percent: 91.5, reset_at: iso(25 * MIN) },
            { label: 'weekly', percent: 78.0, reset_at: iso(2 * DAY + 6 * HOUR) },
            { label: 'monthly', percent: 40.0, reset_at: iso(20 * DAY) }
          ]
        }
      ]
    })
  },

  /**
   * edge —— 边界：覆盖坑 1/2/3/5/6
   *  - reset_at: -1（无数据）与非法字符串
   *  - 毫秒级数字时间戳（老版本 CLI 契约）
   *  - subscribed: false 的 item（periods 为空数组）
   *  - session 与 5h 混用（同维度去重）
   *  - 某些 product 整个缺失（由解析层补「未订阅」占位）
   *  - 团队版带真实席位的计划（state === 'ok'，应被展示出来）
   */
  edge: {
    type: 'raw',
    data: () => ({
      viewer: {
        auth_method: 'sso',
        profile: 'edge',
        region: 'cn-shanghai',
        user_name: 'edge-user',
        account_id: '2100000001'
      },
      items: [
        // 未订阅：subscribed:false 且 periods 为空数组
        {
          product: 'agent-plan',
          edition: 'personal',
          subscribed: false,
          periods: []
        },
        // 已订阅：混入各种时间形态
        {
          product: 'coding-plan',
          edition: 'personal',
          subscribed: true,
          updated_at: S * 1000, // 毫秒级时间戳（老契约）
          periods: [
            { label: 'session', percent: 88.8, used: 8880, total: 10000, reset_at: iso(HOUR) },
            // 与上面同维度（5h），应被去重丢弃
            { label: '5h', percent: 5.0, used: 500, total: 10000, reset_at: iso(2 * HOUR) },
            // reset_at: -1 → 暂无重置时间
            { label: 'weekly', percent: 50.0, used: 5000, total: 10000, reset_at: -1 },
            // 非法时间字符串 → 同样回落为「暂无重置时间」，且不能抛错
            { label: 'monthly', percent: 91.5, used: 9150, total: 10000, reset_at: 'not-a-date' },
            // 未知维度（cli 可能返 daily）→ 直接跳过
            { label: 'daily', percent: 33.3, reset_at: iso(DAY) }
          ]
        },
        // 团队版：真有席位数据 → 应作为正常计划展示
        {
          product: 'coding-plan-team',
          edition: 'team',
          tier: 'pro',
          seat_id: 'seat-0001',
          subscribed: true,
          periods: [
            { label: 'session', percent: 12.0, reset_at: iso(3 * HOUR) },
            { label: 'weekly', percent: 30.0, reset_at: iso(4 * DAY) },
            { label: 'monthly', percent: 60.0, reset_at: iso(15 * DAY) }
          ]
        }
      ]
    })
  },

  /**
   * empty —— 空数据：items: []（用户未订阅任何套餐）。
   */
  empty: {
    type: 'raw',
    data: () => ({
      viewer: {
        auth_method: 'sso',
        profile: 'default',
        region: 'cn-beijing',
        user_name: 'empty-user',
        account_id: '2100000002'
      },
      items: []
    })
  },

  /**
   * noauth —— 未登录：viewer.auth_method = 'none'。
   */
  noauth: {
    type: 'raw',
    data: () => ({
      viewer: {
        auth_method: 'none',
        profile: null,
        region: null,
        user_name: null,
        account_id: null
      },
      items: []
    })
  },

  /**
   * error —— 查询失败：模拟 CLI 层异常（非 0 退出 / 超时 / JSON 解析失败）。
   */
  error: {
    type: 'fail',
    status: 'ERROR',
    message: 'arkcli 执行失败（模拟）：命令超时或返回非 0 退出码'
  },

  /**
   * no_cli —— 未安装（覆盖 NO_CLI 分支）。
   * 别名：no-cli / nocli（大小写与连字符均不敏感）。
   */
  no_cli: {
    type: 'fail',
    status: 'NO_CLI',
    message: "'arkcli' 不是内部或外部命令（模拟）：请先安装 @volcengine/ark-cli"
  }
};

/** 默认场景名。 */
const DEFAULT_MOCK_SCENARIO = 'normal';

/**
 * 场景名别名表：把各种写法（大小写 / 连字符 / 下划线）归一到正式 key。
 */
const MOCK_ALIASES = {
  normal: 'normal',
  low: 'low',
  alert: 'low',
  danger: 'low',
  edge: 'edge',
  empty: 'empty',
  noauth: 'noauth',
  'no-auth': 'noauth',
  error: 'error',
  no_cli: 'no_cli',
  'no-cli': 'no_cli',
  nocli: 'no_cli'
};

/**
 * 把用户输入的场景名归一为正式 key。
 * @param {string} name
 * @returns {string|null} 归一键；无法识别返回 null
 */
function resolveScenarioKey(name) {
  if (name === null || name === undefined) return null;
  const raw = String(name).trim().toLowerCase();
  if (!raw) return null;
  if (Object.prototype.hasOwnProperty.call(MOCK_SCENARIOS, raw)) return raw;
  if (Object.prototype.hasOwnProperty.call(MOCK_ALIASES, raw)) return MOCK_ALIASES[raw];
  // 兜底：去掉连字符 / 下划线再匹配一次
  const squashed = raw.replace(/[-_]/g, '');
  if (Object.prototype.hasOwnProperty.call(MOCK_ALIASES, squashed)) return MOCK_ALIASES[squashed];
  if (Object.prototype.hasOwnProperty.call(MOCK_SCENARIOS, squashed)) return squashed;
  return null;
}

/**
 * 取指定场景（已经把 `data` 函数求值成最终 JSON）。
 * 名称大小写 / 连字符均不敏感；未知场景名显式告警后回落默认场景。
 * @param {string} [name]
 * @returns {object} 场景对象
 */
function getMockScenario(name) {
  const key = resolveScenarioKey(name);
  if (!key && name !== null && name !== undefined && String(name).trim() !== '') {
    // 不静默回落：明确提示，方便用户自己发现拼写问题
    // eslint-disable-next-line no-console
    console.warn(
      `[mock] 未知的 mock 场景「${String(name).trim()}」，已回落为「${DEFAULT_MOCK_SCENARIO}」。` +
        ` 可用场景：${Object.keys(MOCK_SCENARIOS).join(', ')}`
    );
  }
  const scenario = MOCK_SCENARIOS[key || DEFAULT_MOCK_SCENARIO];
  if (scenario.type === 'fail') return scenario;
  return {
    type: 'raw',
    data: typeof scenario.data === 'function' ? scenario.data() : scenario.data
  };
}

/** 所有可用场景名。 */
function listMockScenarios() {
  return Object.keys(MOCK_SCENARIOS);
}

module.exports = {
  MOCK_SCENARIOS,
  DEFAULT_MOCK_SCENARIO,
  MOCK_ALIASES,
  iso,
  resolveScenarioKey,
  getMockScenario,
  listMockScenarios
};
