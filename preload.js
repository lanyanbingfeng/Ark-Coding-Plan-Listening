'use strict';

/**
 * preload.js —— contextBridge 最小 API 暴露
 *
 * 渲染层被上下文隔离（contextIsolation: true, nodeIntegration: false），
 * 只能通过这里的 `window.monitor` 与主进程通信。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitor', {
  /**
   * 订阅归一化快照推送。
   * 快照里额外带一个 `ringProduct` 字段：告诉渲染层 MINI 圆环当前盯哪个计划。
   * @param {(snapshot: object) => void} handler
   * @returns {() => void} 取消订阅函数
   */
  onUpdate(handler) {
    const listener = (_event, snapshot) => handler(snapshot);
    ipcRenderer.on('quota-update', listener);
    return () => ipcRenderer.removeListener('quota-update', listener);
  },

  /**
   * 订阅「光标相对小图标的位置关系」推送（由主进程光标轮询发出）。
   * 这是悬停展开 / 点击窗口期的唯一信号源 —— 渲染层不自行做命中检测，
   * 因为判定必须和「窗口是否穿透」保持一致，而穿透由主进程控制。
   *
   * @param {(hit: {interactive: boolean, near: boolean}) => void} handler
   * @returns {() => void} 取消订阅函数
   */
  onPointerOver(handler) {
    const listener = (_event, hit) => handler(hit || { interactive: false, near: false });
    ipcRenderer.on('pointer-over', listener);
    return () => ipcRenderer.removeListener('pointer-over', listener);
  },

  /**
   * 订阅瞬态提示（切换订阅成功等），渲染层负责渐入 / 淡出。
   * @param {(text: string) => void} handler
   * @returns {() => void} 取消订阅函数
   */
  onToast(handler) {
    const listener = (_event, text) => handler(String(text || ''));
    ipcRenderer.on('toast', listener);
    return () => ipcRenderer.removeListener('toast', listener);
  },

  /**
   * 上报自身姿态，供主进程的命中判定使用（展开态 = 整个窗口都算命中）。
   * @param {boolean} expanded
   */
  setExpanded(expanded) {
    ipcRenderer.send('ui-expanded', !!expanded);
  },

  /** 请求立即刷新一次额度数据。 */
  refreshNow() {
    ipcRenderer.send('refresh-now');
  },

  /**
   * 复制文本到系统剪贴板（如安装命令）。
   * @param {string} text
   */
  copyText(text) {
    ipcRenderer.send('copy-text', String(text || ''));
  },

  /** 一键唤起 `arkcli auth login volc-sso` 登录流程。 */
  openLogin() {
    ipcRenderer.send('open-login');
  },

  /**
   * 订阅「小图标在窗口内的偏移」推送。
   *
   * 图标不是钉在窗口正中的 —— 主进程为了让「图标能贴屏幕边缘」和「面板不超出屏幕」
   * 同时成立，会动态决定图标贴在窗口的哪一角（见 main.js 的 computeLayout）。
   * 渲染层拿到后负责 CSS 定位，以及让提示气泡朝面板那一侧出现。
   *
   * @param {(offset: {x: number, y: number}) => void} handler
   * @returns {() => void} 取消订阅函数
   */
  onMiniOffset(handler) {
    const listener = (_event, offset) => handler(offset || { x: 0, y: 0 });
    ipcRenderer.on('mini-offset', listener);
    return () => ipcRenderer.removeListener('mini-offset', listener);
  },

  /**
   * 主动拉取「小图标在窗口内的偏移」。
   *
   * 与 onMiniOffset 的推送是双通道：推送可能早于渲染层注册 listener（消息就丢了），
   * 而偏移一旦不一致，图标画的位置与命中判定的位置就会错位 —— 直接表现为
   * 鼠标移到图标上也打不开面板。所以渲染层启动时必须自己再拉一次兜底。
   *
   * @returns {Promise<{x: number, y: number}>}
   */
  getMiniOffset() {
    return ipcRenderer.invoke('mini-offset:get');
  },

  /** 单击小图标：在已订阅的计划之间切换圆环盯的订阅。 */
  switchRing() {
    ipcRenderer.send('switch-ring');
  },

  /**
   * 自实现拖拽：按下时开始，抬起时结束。
   *
   * 为什么不用 `-webkit-app-region: drag`：系统拖拽区会吞掉鼠标事件，
   * 「单击图标切换」就永远收不到 click；而且系统拖动不受我们控制，没法按屏幕边界钳制。
   *
   * @param {'icon'|'panel'} mode icon=拖小图标（图标钉光标）；panel=拖展开面板（面板钉光标）
   */
  dragStart(mode) {
    ipcRenderer.send('drag-start', mode === 'panel' ? 'panel' : 'icon');
  },

  dragEnd() {
    ipcRenderer.send('drag-end');
  }
});
