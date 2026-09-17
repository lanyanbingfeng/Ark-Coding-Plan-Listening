'use strict';

/**
 * smoke-main.js —— 冒烟专用 Electron 入口
 *
 * 直接 require 真实的 main.js：窗口创建、托盘、轮询、IPC 全部按生产逻辑跑一遍，
 * 然后由本文件用 webContents.executeJavaScript 去读**渲染进程的真实 DOM**，
 * 把结果打到 stdout 供 tests/smoke.js 断言。
 *
 * 为什么不走 CDP：本地实测 page 端点的 WebSocket 能握手成功但服务端不回消息，
 * 排查成本高。用 executeJavaScript 是同进程内的正规 API，稳定且不需要额外端口。
 *
 * 用法（由 tests/smoke.js 驱动，一般不单独跑）：
 *   electron tests/smoke-main.js --mock=normal --user-data-dir=<tmp> --disable-gpu
 */

const { app, BrowserWindow } = require('electron');

require('../main.js'); // ← 启动真实应用

/**
 * 抓一份页面状态快照（真实 DOM，不是主进程的自述）。
 *
 * 刻意写成 async 并顺带把「主进程下发的图标偏移」也拉一份：
 * 渲染层画图标的位置必须和主进程做命中判定用的偏移完全一致，否则鼠标移到图标上
 * 也打不开面板。这条断言直接钉住那个回归。
 */
const SNAPSHOT_EXPR = `(async function () {
  const mo = await window.monitor.getMiniOffset();
  return JSON.stringify({
    status: document.getElementById('app').dataset.status,
    state: document.getElementById('app').dataset.state,
    account: document.getElementById('account-name').textContent,
    plans: Array.from(document.querySelectorAll('.plan')).map(function (el) {
      return { product: el.dataset.product, state: el.dataset.state, height: el.offsetHeight };
    }),
    planNames: Array.from(document.querySelectorAll('.plan-name')).map(function (e) { return e.textContent; }),
    emptyTexts: Array.from(document.querySelectorAll('.plan-empty')).map(function (e) { return e.textContent; }),
    rows: document.querySelectorAll('.row').length,
    rowIds: Array.from(document.querySelectorAll('.row')).map(function (e) {
      return e.closest('.plan').dataset.product + ':' + e.dataset.key;
    }),
    pcts: Array.from(document.querySelectorAll('.row-pct')).map(function (e) { return e.textContent; }),
    resets: Array.from(document.querySelectorAll('.row-reset')).map(function (e) { return e.textContent; }),
    fills: Array.from(document.querySelectorAll('.row-fill')).map(function (e) { return e.style.width; }),
    ringPercent: document.getElementById('mini').dataset.percent,
    ringPlan: document.getElementById('mini').dataset.plan,
    ringClass: document.getElementById('mini').className,
    miniLeft: getComputedStyle(document.getElementById('mini')).left,
    miniTop: getComputedStyle(document.getElementById('mini')).top,
    ipcMiniX: mo && mo.x,
    ipcMiniY: mo && mo.y,
    winH: document.body.clientHeight,
    winW: document.body.clientWidth,
    toastHidden: document.getElementById('toast').hidden,
    toastText: document.getElementById('toast').textContent,
    errs: window.__smokeErrs || []
  });
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 给渲染层求值加超时：渲染进程若已崩溃，executeJavaScript 可能永远 pending。 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms))
  ]);
}

/** 把渲染层的错误暴露出来：未捕获异常与 unhandledrejection 都收集起来。 */
const HOOK_EXPR = `
  window.__smokeErrs = window.__smokeErrs || [];
  window.addEventListener('error', function (e) { window.__smokeErrs.push('error: ' + e.message); });
  window.addEventListener('unhandledrejection', function (e) {
    window.__smokeErrs.push('rejection: ' + String((e && e.reason) || e));
  });
  "hooked"
`;

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    // 渲染进程的 console 与崩溃事件都不走主进程的 stdout，必须显式转发
    win.webContents.on('console-message', (...args) => {
      const ev = args[0];
      const text =
        ev && typeof ev === 'object' && ev.message !== undefined
          ? `[${ev.level}] ${ev.message} @${ev.sourceId}:${ev.lineNumber}`
          : `[${args[1]}] ${args[2]} @${args[4]}:${args[3]}`;
      console.log(`SMOKE_CONSOLE ${text}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.log(`SMOKE_RENDER_GONE ${JSON.stringify(details)}`);
    });
    try {
      await win.webContents.executeJavaScript(HOOK_EXPR, true);
    } catch (_) {
      /* ignore */
    }
  }

  process.on('uncaughtException', (err) => {
    console.log(`SMOKE_MAIN_ERROR ${(err && err.stack) || err}`);
  });

  // 等首轮轮询完成 + 渲染层应用快照 + MINI 态过渡结束
  await sleep(6500);

  try {
    if (!win) {
      console.log('SMOKE_ERROR 主进程没有创建任何窗口');
      app.exit(1);
      return;
    }
    if (win.webContents.isCrashed()) {
      console.log('SMOKE_ERROR 渲染进程已崩溃（isCrashed=true）');
      app.exit(1);
      return;
    }

    const before = await withTimeout(win.webContents.executeJavaScript(SNAPSHOT_EXPR, true), 10000, '读取初始 DOM');
    console.log(`SMOKE_BEFORE ${before}`);

    // 触发一次「切换圆环订阅」，验证 IPC → 主进程 → 回推 → 渲染 的完整链路
    await withTimeout(win.webContents.executeJavaScript('window.monitor.switchRing(); "ok"', true), 8000, '触发切换');
    await sleep(900);

    const after = await withTimeout(win.webContents.executeJavaScript(SNAPSHOT_EXPR, true), 10000, '读取切换后 DOM');
    console.log(`SMOKE_AFTER ${after}`);

    console.log(`SMOKE_WIN_VISIBLE ${win.isVisible()}`);

    app.exit(0);
  } catch (e) {
    console.log(`SMOKE_ERROR ${(e && e.message) || e}`);
    app.exit(1);
  }
});
