'use strict';

/**
 * layout.test.js —— 图标 / 面板屏幕边界解算的单测（零依赖，纯 node 跑）
 *
 *   node tests/layout.test.js
 *
 * 这段解算是「图标能贴屏幕边、面板又不越界」的核心。它有三个容易写错的钳制步骤，
 * 而真机上很难把「贴四角 / 拖到屏幕外 / 多屏 / 任务栏偏移」这几种情况都手测一遍，
 * 所以用穷举扫描把两条不变式钉死：
 *   ① win + offset === icon                （图标视觉位置不跳）
 *   ② 图标与面板都完整落在工作区内           （谁都不越界）
 */

const assert = require('assert');
const { clamp, workAreaNear, computeLayout } = require('../src/layout');

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

const WIN_W = 360;
const WIN_H = 316;
const MINI = 40;

/** 单屏 1920×1080，工作区与屏幕等大（假设无任务栏占位）。 */
const SINGLE = [{ x: 0, y: 0, width: 1920, height: 1080 }];

/** 双屏：左屏 (0,0)，右屏紧邻其右。 */
const DUAL = [
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 1920, y: 0, width: 1920, height: 1080 }
];

function lay(iconX, iconY, areas) {
  return computeLayout({
    iconX,
    iconY,
    areas: areas || SINGLE,
    winW: WIN_W,
    winH: WIN_H,
    miniSize: MINI
  });
}

// ---------------------------------------------------------------------------
group('四角与中央');

test('屏幕中央：offset 为 0，窗口就是图标位置', () => {
  const r = lay(900, 400);
  assert.deepStrictEqual(r.offset, { x: 0, y: 0 });
  assert.deepStrictEqual(r.win, { x: 900, y: 400 });
});

test('图标贴左上角：面板朝右下展开，两者都贴住屏幕角', () => {
  const r = lay(0, 0);
  assert.deepStrictEqual(r.icon, { x: 0, y: 0 });
  assert.deepStrictEqual(r.offset, { x: 0, y: 0 });
  assert.deepStrictEqual(r.win, { x: 0, y: 0 });
});

test('图标贴右下角：面板向左上展开，窗口右下角正好压住屏幕右下角', () => {
  const r = lay(1920 - MINI, 1080 - MINI);
  assert.deepStrictEqual(r.icon, { x: 1880, y: 1040 });
  assert.deepStrictEqual(r.offset, { x: WIN_W - MINI, y: WIN_H - MINI });
  assert.strictEqual(r.win.x + WIN_W, 1920);
  assert.strictEqual(r.win.y + WIN_H, 1080);
});

test('图标贴右上角：水平向内、垂直向外各自独立决定', () => {
  const r = lay(1880, 0);
  assert.strictEqual(r.offset.x, WIN_W - MINI);
  assert.strictEqual(r.offset.y, 0);
  assert.strictEqual(r.win.x + WIN_W, 1920);
  assert.strictEqual(r.win.y, 0);
});

test('图标贴左下角：水平向外、垂直向内', () => {
  const r = lay(0, 1040);
  assert.strictEqual(r.offset.x, 0);
  assert.strictEqual(r.offset.y, WIN_H - MINI);
  assert.strictEqual(r.win.x, 0);
  assert.strictEqual(r.win.y + WIN_H, 1080);
});

// ---------------------------------------------------------------------------
group('越界钳制');

test('拖到屏幕左上方很远：图标被拉回 (0,0)，不越界', () => {
  assert.deepStrictEqual(lay(-500, -500).icon, { x: 0, y: 0 });
});

test('拖到屏幕右下方很远：图标停在右下极限位置', () => {
  assert.deepStrictEqual(lay(9999, 9999).icon, { x: 1920 - MINI, y: 1080 - MINI });
});

// ---------------------------------------------------------------------------
group('两条不变式（穷举扫描）');

test('不变式 ①：win + offset 恒等于 icon', () => {
  for (let x = -800; x <= 2600; x += 137) {
    for (let y = -800; y <= 1600; y += 149) {
      const r = lay(x, y);
      assert.strictEqual(r.win.x + r.offset.x, r.icon.x, `x 不匹配 @(${x},${y})`);
      assert.strictEqual(r.win.y + r.offset.y, r.icon.y, `y 不匹配 @(${x},${y})`);
    }
  }
});

test('不变式 ②：面板（窗口）恒完整落在工作区内', () => {
  for (let x = -800; x <= 2600; x += 137) {
    for (let y = -800; y <= 1600; y += 149) {
      const r = lay(x, y);
      assert.ok(r.win.x >= 0 && r.win.x + WIN_W <= 1920, `面板 x 越界 @(${x},${y}) → ${JSON.stringify(r.win)}`);
      assert.ok(r.win.y >= 0 && r.win.y + WIN_H <= 1080, `面板 y 越界 @(${x},${y}) → ${JSON.stringify(r.win)}`);
    }
  }
});

test('不变式 ③：图标恒完整落在工作区内', () => {
  for (let x = -800; x <= 2600; x += 137) {
    for (let y = -800; y <= 1600; y += 149) {
      const r = lay(x, y);
      assert.ok(r.icon.x >= 0 && r.icon.x + MINI <= 1920, `图标 x 越界 @(${x},${y})`);
      assert.ok(r.icon.y >= 0 && r.icon.y + MINI <= 1080, `图标 y 越界 @(${x},${y})`);
    }
  }
});

// ---------------------------------------------------------------------------
group('多屏与工作区偏移');

test('图标在第二块屏：用第二块的工作区，面板留在那块屏内', () => {
  const r = lay(1920 + 100, 100, DUAL);
  assert.strictEqual(r.win.x + r.offset.x, 2020);
  assert.ok(r.win.x >= 1920, `面板应落在右屏，实际 ${r.win.x}`);
  assert.ok(r.win.x + WIN_W <= 3840);
});

test('图标落在两屏之间的缝隙：回落到最近的显示器', () => {
  const areas = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 2200, y: 0, width: 1920, height: 1080 } // 中间空 280px
  ];
  const r = lay(2000, 500, areas); // 正好在缝里
  assert.ok(r.win.x >= 0 && r.win.x + WIN_W <= 1920, `应回落到左屏，实际 ${JSON.stringify(r.win)}`);
});

test('工作区顶部被任务栏占掉（y 从 40 起）：图标被钳到工作区顶部', () => {
  const areas = [{ x: 0, y: 40, width: 1920, height: 1040 }];
  const r = lay(0, 0, areas);
  assert.strictEqual(r.icon.y, 40);
  assert.ok(r.win.y >= 40);
  assert.ok(r.win.y + WIN_H <= 1080);
});

test('工作区比窗口还小：不能算出负数区间或抛错', () => {
  const tiny = [{ x: 0, y: 0, width: 200, height: 200 }];
  const r = lay(50, 50, tiny);
  assert.ok(Number.isFinite(r.win.x) && Number.isFinite(r.win.y));
  assert.ok(r.offset.x >= 0 && r.offset.y >= 0);
});

// ---------------------------------------------------------------------------
group('工具函数');

test('clamp 基本行为', () => {
  assert.strictEqual(clamp(5, 0, 10), 5);
  assert.strictEqual(clamp(-5, 0, 10), 0);
  assert.strictEqual(clamp(15, 0, 10), 10);
});

test('workAreaNear：命中 / 缝隙 / 空输入都有确定答案', () => {
  assert.strictEqual(workAreaNear(SINGLE, 100, 100).width, 1920);
  assert.strictEqual(workAreaNear(DUAL, 2000, 100).x, 1920);
  assert.strictEqual(workAreaNear([], 0, 0).width, 1920); // 空数组兜底
  assert.strictEqual(workAreaNear(null, 0, 0).width, 1920); // 非数组兜底
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
