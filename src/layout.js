'use strict';

/**
 * layout.js —— 图标与面板的屏幕边界解算（纯函数，零运行时依赖）
 *
 * 为什么单独成文件：这段「图标能贴屏幕边 / 面板不能越界」的解算是本次改造的核心，
 * 里面有三个容易写错的钳制步骤，必须能被单测直接钉住。它不碰 electron，
 * 显示器工作区由调用方以数组传入，因此可以在纯 node 下跑。
 *
 * 术语与不变式：
 *   icon   —— 小图标左上角在**屏幕**坐标系里的位置
 *   offset —— 小图标左上角在**窗口**坐标系里的偏移
 *   win    —— 窗口左上角在屏幕坐标系里的位置
 *   不变式：win + offset === icon（这条成立，图标视觉位置才不会跳）
 */

/**
 * 数值钳制。
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 取包含 (x, y) 的工作区。
 *
 * 两种情况都要有确定答案：
 *   1. 点落在某块显示器内 → 用那块
 *   2. 点落在多屏拼接的缝隙、或某块屏刚被拔掉 → 取中心最近的那块
 *
 * @param {Array<{x:number,y:number,width:number,height:number}>} areas
 * @param {number} x
 * @param {number} y
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function workAreaNear(areas, x, y) {
  const list = Array.isArray(areas) ? areas.filter(Boolean) : [];
  // 一块屏都拿不到时给个保守的兜底矩形，绝不抛错
  if (list.length === 0) return { x: 0, y: 0, width: 1920, height: 1080 };

  for (const a of list) {
    if (x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height) return a;
  }

  let best = list[0];
  let bestDist = Infinity;
  for (const a of list) {
    const dx = x - (a.x + a.width / 2);
    const dy = y - (a.y + a.height / 2);
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  return best;
}

/**
 * 把「期望的图标屏幕位置」解算成「图标在窗口内的偏移 + 窗口位置」。
 *
 * 为什么需要这个解算（用户实际撞到的问题）：早先图标钉在窗口正中，而窗口尺寸就等于
 * 面板尺寸（360×316）。于是「把图标拖到屏幕左边缘」意味着窗口必须跑到 x=-160 ——
 * 结果是**图标永远离屏幕边缘至少 160px、根本贴不了边**，而且窗口大半在屏幕之外，
 * 还会被系统往回拉（表现就是拖到边缘位置被"强制挪走"）。
 *
 * 解法是保留「图标在窗口内可移位」这个自由度，于是两个约束可以分别求解、互不干扰：
 *   ① 图标约束：图标必须完整落在工作区内（可以贴边，但不能越界）
 *   ② 面板约束：窗口（= 面板）必须完整落在工作区内 → 自动朝屏幕内侧展开
 *
 * @param {object} input
 * @param {number} input.iconX 期望的图标左上角屏幕 X
 * @param {number} input.iconY 期望的图标左上角屏幕 Y
 * @param {Array} input.areas 所有显示器的工作区
 * @param {number} input.winW 窗口宽度
 * @param {number} input.winH 窗口高度
 * @param {number} input.miniSize 图标边长
 * @returns {{icon:{x:number,y:number}, offset:{x:number,y:number}, win:{x:number,y:number}}}
 */
function computeLayout(input) {
  const { iconX, iconY, areas, winW, winH, miniSize } = input;
  const area = workAreaNear(areas, iconX, iconY);

  // ① 图标先钳进工作区：拖到边缘就停住，但绝不越界
  const ix = clamp(iconX, area.x, area.x + area.width - miniSize);
  const iy = clamp(iconY, area.y, area.y + area.height - miniSize);

  // ② 面板朝屏幕内侧展开：右侧空间不足时把图标推到窗口右端（offset 变大），面板就朝左开。
  //    上限用 max(0, …) 兜底，防止窗口尺寸小于图标时出现负数区间。
  const maxOffX = Math.max(0, winW - miniSize);
  const maxOffY = Math.max(0, winH - miniSize);
  const offsetX = clamp(ix + winW - (area.x + area.width), 0, maxOffX);
  const offsetY = clamp(iy + winH - (area.y + area.height), 0, maxOffY);

  // ③ 窗口位置 = 图标屏幕位置 − 图标在窗口内的偏移（图标视觉位置纹丝不动）
  return {
    icon: { x: ix, y: iy },
    offset: { x: offsetX, y: offsetY },
    win: { x: ix - offsetX, y: iy - offsetY }
  };
}

module.exports = {
  clamp,
  workAreaNear,
  computeLayout
};
