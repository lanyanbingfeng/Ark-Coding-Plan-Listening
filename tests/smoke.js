'use strict';

/**
 * smoke.js —— 启动冒烟（零依赖，纯 node 驱动）
 *
 *   node tests/smoke.js            # mock=normal
 *   node tests/smoke.js edge       # 指定 mock 场景
 *   node tests/smoke.js empty
 *
 * 它做的事：
 *   1. 用 managed node 拉起 Electron（清掉 ELECTRON_RUN_AS_NODE，否则 electron 会退化成纯 node）
 *   2. 用独立 --user-data-dir 启动 → **完全不碰用户真实的 config.json**
 *   3. 入口是 tests/smoke-main.js：它 require 真实的 main.js 跑完整逻辑，
 *      再用 executeJavaScript 读渲染进程的真实 DOM
 *   4. 断言：双计划分组、6 条进度条、剩余口径、圆环盯的计划、未订阅占位
 *   5. 触发一次 switchRing()，断言「切换订阅 + 渐入提示」全链路
 *   6. 收尾：kill 进程 + 删掉临时 user-data-dir
 *
 * 退出码：0 = 全部断言通过；1 = 有断言失败；2 = 环境缺失。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ELECTRON_CLI = path.join(ROOT, 'node_modules', 'electron', 'cli.js');
const USER_DATA = path.join(os.tmpdir(), `volc-quota-smoke-${Date.now()}`);

const scenario = process.argv[2] || 'normal';

/**
 * 沙箱 / 无显卡环境下的 Chromium 开关。
 *
 * 环境背景：在没有可用 GPU 的机器（容器、RDP、部分虚拟机）里，Electron 的 GPU 进程会
 * 反复启动失败，最终 `FATAL:gpu_data_manager_impl_private.cc(449) GPU process isn't usable`
 * 直接退出（exitCode 2147483651）。这是**环境问题，不是本软件缺陷** ——
 * 用户本机有正常显卡时不需要任何这些参数，`npm start` 直接跑。
 *
 * --disable-gpu 单独一个在部分环境仍不够（GPU 进程照样被拉起），
 * 再叠 --in-process-gpu 把 GPU 收进主进程，才能在这类环境里稳定起来。
 * 可用 SMOKE_EXTRA_FLAGS 环境变量追加。
 */
const CHROMIUM_FLAGS = [
  '--disable-gpu',
  '--in-process-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage'
].concat(
  (process.env.SMOKE_EXTRA_FLAGS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 各 mock 场景「首屏应抵达」的数据状态。 */
const EXPECT_STATUS = {
  normal: 'OK',
  low: 'OK',
  edge: 'OK',
  empty: 'EMPTY',
  noauth: 'NO_AUTH',
  error: 'ERROR',
  no_cli: 'NO_CLI'
};

/**
 * 各场景的圆环期望值。
 *   ring*  = 首屏（默认盯「5 小时剩余最少」的那条）
 *   after* = 调一次 switchRing 之后（轮换到另一个已订阅计划）
 */
const EXPECT_RING = {
  // normal 场景里 Agent Plan 只有 subscribed 标记、没有任何用量数据 → 不算候选，
  // 圆环只剩 Coding Plan 一个目标；此时点击切换，主进程会明确回「当前只订阅了 X」
  // 而不是硬切到同一个计划上。
  normal: { ringPlan: 'coding-plan', ringPercent: '52', afterPlan: 'coding-plan', afterPercent: '52' },
  // low 场景里 Agent Plan 的 5 小时只剩 4%，比 Coding Plan 的 8.5% 更紧张 → 默认盯 Agent Plan
  low: { ringPlan: 'agent-plan', ringPercent: '4', afterPlan: 'coding-plan', afterPercent: '8.5' }
};

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}

/** 从子进程 stdout 里抓一行 SMOKE_* 输出。 */
function pick(out, tag) {
  const line = out.split(/\r?\n/).find((l) => l.startsWith(`${tag} `));
  return line ? line.slice(tag.length + 1).trim() : null;
}

async function main() {
  if (!fs.existsSync(ELECTRON_CLI)) {
    console.error(`找不到 electron：${ELECTRON_CLI}（先在项目目录跑 npm install）`);
    process.exit(2);
  }

  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE; // 关键：带着它 electron 会退化成纯 node，main.js 直接崩

  const child = spawn(
    process.execPath,
    [
      ELECTRON_CLI,
      path.join('tests', 'smoke-main.js'),
      `--mock=${scenario}`,
      `--user-data-dir=${USER_DATA}`,
      ...CHROMIUM_FLAGS
    ],
    { cwd: ROOT, env, windowsHide: true }
  );

  let stdout = '';
  let stderr = '';
  let exitCode = null;
  let exited = false;
  if (child.stdout) child.stdout.on('data', (d) => (stdout += d.toString()));
  if (child.stderr) child.stderr.on('data', (d) => (stderr += d.toString()));
  child.on('exit', (code) => {
    exitCode = code;
    exited = true;
  });

  // 等 smoke-main 自己跑完并退出（它约 7.5s 出结果）
  const deadline = Date.now() + 60000;
  while (!exited && Date.now() < deadline) await sleep(400);

  if (!exited) {
    check('冒烟进程在 60s 内自行结束', false, '超时未退出');
    try {
      child.kill();
    } catch (_) {
      /* ignore */
    }
  } else {
    check('冒烟进程正常退出（exit=0）', exitCode === 0, `exitCode=${exitCode}`);
  }

  const errLine = pick(stdout, 'SMOKE_ERROR');
  check('没有捕获到运行时异常', !errLine, errLine || '');
  check('stderr 无 GPU / 未捕获异常', !/FATAL|Uncaught|TypeError|ReferenceError/.test(stderr), stderr.slice(-400));

  const beforeRaw = pick(stdout, 'SMOKE_BEFORE');
  const afterRaw = pick(stdout, 'SMOKE_AFTER');
  const before = beforeRaw ? JSON.parse(beforeRaw) : null;
  const after = afterRaw ? JSON.parse(afterRaw) : null;

  check('拿到渲染层 DOM 快照', !!before && !!after, before ? '' : 'SMOKE_BEFORE 缺失');

  if (before) {
    check(
      `应用状态符合预期（${scenario} → ${EXPECT_STATUS[scenario] || 'OK'}）`,
      before.status === (EXPECT_STATUS[scenario] || 'OK'),
      `status=${before.status}`
    );
    if ((EXPECT_STATUS[scenario] || 'OK') === 'OK') {
      check('渲染层已进入 MINI 收起态', before.state === 'MINI', `state=${before.state}`);
    }

    // 图标位置：主进程下发的偏移必须让图标完整落在窗口内（窗口 360×316、图标 40×40）
    {
      const left = parseFloat(before.miniLeft);
      const top = parseFloat(before.miniTop);
      check(
        '小图标按主进程下发的偏移定位，且完整落在窗口内',
        Number.isFinite(left) &&
          Number.isFinite(top) &&
          left >= 0 &&
          top >= 0 &&
          left + 40 <= before.winW &&
          top + 40 <= before.winH,
        `left=${before.miniLeft} top=${before.miniTop} win=${before.winW}×${before.winH}`
      );

      // 回归断言：渲染层画图标用的位置，必须和主进程做命中判定用的偏移完全一致。
      // 不一致的后果是「鼠标移到图标上打不开面板」—— 因为主进程在另一处找图标。
      // 之前的问题就出在「偏移只推一次」，消息早于 listener 注册时丢了。
      check(
        '渲染层的图标位置与主进程下发偏移一致（回归：面板打不开）',
        Math.abs(left - Number(before.ipcMiniX)) < 1 && Math.abs(top - Number(before.ipcMiniY)) < 1,
        `css=(${before.miniLeft}, ${before.miniTop}) ipc=(${before.ipcMiniX}, ${before.ipcMiniY})`
      );
    }

    if (scenario === 'normal' || scenario === 'low') {
      const expect = EXPECT_RING[scenario];
      check('面板渲染出 2 个计划分组', before.plans.length === 2, JSON.stringify(before.plans));
      check('分组为 Agent Plan / Coding Plan', before.planNames.join('|') === 'Agent Plan|Coding Plan', before.planNames.join('|'));
      check(
        '百分比是纯数字（不带「剩」字）',
        before.pcts.length > 0 && before.pcts.every((t) => /^\d+(\.\d+)?%$/.test(t)),
        before.pcts.join('|')
      );
      check(
        '进度条长度 = 百分比数值',
        before.fills.every((w, i) => Math.abs(parseFloat(w) - parseFloat(before.pcts[i])) < 0.05),
        `fills=${before.fills.join('|')} pcts=${before.pcts.join('|')}`
      );
      check(
        '重置时刻显示为「具体时间 + 重置」',
        before.resets.length > 0 && before.resets.every((t) => /\d{2}-\d{2} \d{2}:\d{2} 重置$/.test(t)),
        before.resets.join('|')
      );
      check('圆环盯 ' + expect.ringPlan, before.ringPlan === expect.ringPlan, `ringPlan=${before.ringPlan}`);
      check('圆环百分比 = 该计划 5 小时剩余', before.ringPercent === expect.ringPercent, `ringPercent=${before.ringPercent}`);
    }

    if (scenario === 'normal') {
      // Agent Plan 只有 subscribed 标记、一条用量数据都没有 → 必须显示「未订阅」，
      // 而不是渲染成三条 100% 的满进度条（那就是用户报的问题）
      const ap = before.plans.find((p) => p.product === 'agent-plan') || {};
      check('Agent Plan 状态为 unsubscribed', ap.state === 'unsubscribed', JSON.stringify(before.plans));
      check('Agent Plan 显示「未订阅」占位', before.emptyTexts.includes('未订阅 Agent Plan'), before.emptyTexts.join('|'));
      check('Agent Plan 不再渲染进度条（只剩 Coding Plan 的 3 条）', before.rows === 3, `rows=${before.rows}`);
      check(
        '三条行都归属 Coding Plan',
        before.rowIds.join(',') === 'coding-plan:5h,coding-plan:week,coding-plan:month',
        before.rowIds.join(',')
      );

      // 回归断言：未订阅的分组只有「标题 + 一行状态」，必须按内容收缩，
      // 不能跟有数据的计划等分高度 —— 否则标题下和文字下会各空出一大块（用户报过）。
      const hAgent = (before.plans.find((p) => p.product === 'agent-plan') || {}).height;
      const hCoding = (before.plans.find((p) => p.product === 'coding-plan') || {}).height;
      check(
        '未订阅分组按内容收缩（高度不足有数据分组的一半）',
        Number.isFinite(hAgent) && Number.isFinite(hCoding) && hAgent < hCoding * 0.5,
        `agent-plan=${hAgent}px coding-plan=${hCoding}px`
      );
    }

    if (scenario === 'low') {
      // low 场景两个计划都带 reset_at，都该正常渲染
      check('两个计划都有真实数据 → 6 条进度条', before.rows === 6, `rows=${before.rows}`);
      check(
        '行覆盖两个计划 × 5h/week/month',
        before.rowIds.join(',') ===
          'agent-plan:5h,agent-plan:week,agent-plan:month,coding-plan:5h,coding-plan:week,coding-plan:month',
        before.rowIds.join(',')
      );
    }

    if (scenario === 'edge') {
      check('edge 渲染 3 个分组（含未订阅的 Agent Plan）', before.plans.length === 3, JSON.stringify(before.plans));
      check('未订阅计划显示占位文案', before.emptyTexts.includes('未订阅 Agent Plan'), before.emptyTexts.join('|'));
    }

    if (scenario === 'empty') {
      check('empty 场景进入 EMPTY', before.status === 'EMPTY', `status=${before.status}`);
      check('empty 场景不渲染计划分组', before.plans.length === 0, `plans=${before.plans.length}`);
    }
  }

  if (after) {
    // 只有一个可切换目标时，主进程会明确回「当前只订阅了 X」而不是硬切 —— 两种都算合格反馈
    check(
      '切换有明确反馈（已切换 / 仅一个订阅）',
      after.toastHidden === false && /已切换到 .+ · 5 小时|当前只订阅了|暂时没有可显示的订阅/.test(after.toastText),
      `hidden=${after.toastHidden} text=${after.toastText}`
    );
    if (scenario === 'normal' || scenario === 'low') {
      const expect = EXPECT_RING[scenario];
      check('切换后圆环轮到另一个已订阅计划', after.ringPlan === expect.afterPlan, `ringPlan=${after.ringPlan}`);
      check('切换后圆环百分比随之变化', after.ringPercent === expect.afterPercent, `ringPercent=${after.ringPercent}`);
    }
  }

  // ---- 收尾：杀进程 + 清临时目录（不碰用户数据） ----
  if (!exited) {
    try {
      child.kill();
    } catch (_) {
      /* ignore */
    }
    await sleep(1200);
  }
  try {
    fs.rmSync(USER_DATA, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }

  console.log(`\n=== smoke (mock=${scenario}) ===`);
  for (const c of checks) {
    console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `  ← ${c.detail}`}`);
  }
  if (stderr.trim()) console.log(`\n[stderr]\n${stderr.trim().slice(-600)}`);

  const failed = checks.filter((c) => !c.ok).length;
  // 失败时把子进程输出贴出来，省得再来一轮「加日志重跑」
  if (failed > 0) {
    const smokeLines = stdout
      .split(/\r?\n/)
      .filter((l) => l.startsWith('SMOKE_'))
      .join('\n');
    if (smokeLines) console.log(`\n[stdout]\n${smokeLines.slice(0, 2500)}`);
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('smoke 运行失败：', e);
  try {
    fs.rmSync(USER_DATA, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
