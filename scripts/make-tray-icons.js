'use strict';

/**
 * make-tray-icons.js —— 生成系统托盘图标 PNG
 *
 * 为什么手写 PNG 编码器：本项目「零第三方运行时依赖」是硬约束（见 README），
 * 而托盘图标必须是位图（Electron 的 Tray 不接受 SVG）。与其引入 sharp/canvas
 * 这类重型原生依赖，不如用 node 自带的 zlib 手写一份最小 PNG 编码器 ——
 * 一共几十行，且图案完全可控。
 *
 * 用法：
 *   node scripts/make-tray-icons.js
 *
 * 产物：
 *   assets/tray-16.png   标准 DPI 托盘（Windows 通知区域实际是 16×16）
 *   assets/tray-32.png   200% DPI 托盘（主进程通过 addRepresentation 挂上）
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// 最小 PNG 编码器（RGBA8 / 无隔行）
// ---------------------------------------------------------------------------

/** CRC32 查表（PNG 每个 chunk 都要算）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 组装一个 PNG chunk：长度 + 类型 + 数据 + CRC。 */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * 把 RGBA 像素缓冲编码为 PNG Buffer。
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba 长度 = width * height * 4
 * @returns {Buffer}
 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前面加一个 filter 字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------
// 绘制（简单的软件光栅化：圆角矩形 + 4×超采样抗锯齿）
// ---------------------------------------------------------------------------

/** 圆角矩形内部判定（点在矩形内，或落在四个圆角内）。 */
function insideRoundRect(px, py, x, y, w, h, r) {
  const x1 = x + w;
  const y1 = y + h;
  if (px < x || px > x1 || py < y || py > y1) return false;
  const cx = Math.min(Math.max(px, x + r), x1 - r);
  const cy = Math.min(Math.max(py, y + r), y1 - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * 用覆盖率（4× 超采样）把一个圆角矩形混合到 RGBA 缓冲上。
 * @param {Buffer} rgba
 * @param {number} size 画布边长
 * @param {object} rect {x, y, w, h, r}
 * @param {number[]} color [r, g, b]
 */
function blendRoundRect(rgba, size, rect, color) {
  const { x, y, w, h, r } = rect;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(size - 1, Math.ceil(x + w));
  const y1 = Math.min(size - 1, Math.ceil(y + h));
  const samples = [0.25, 0.75]; // 2×2 子采样

  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      let hits = 0;
      for (const oy of samples) {
        for (const ox of samples) {
          if (insideRoundRect(px + ox, py + oy, x, y, w, h, r)) hits++;
        }
      }
      if (hits === 0) continue;

      const coverage = hits / (samples.length * samples.length);
      const i = (py * size + px) * 4;

      // source-over 混合（底色是透明黑）
      const srcA = coverage;
      const dstA = rgba[i + 3] / 255;
      const outA = srcA + dstA * (1 - srcA);
      if (outA <= 0) continue;

      for (let c = 0; c < 3; c++) {
        const src = color[c];
        const dst = rgba[i + c];
        rgba[i + c] = Math.round((src * srcA + dst * dstA * (1 - srcA)) / outA);
      }
      rgba[i + 3] = Math.round(outA * 255);
    }
  }
}

/** 品牌色（与 assets/logo.svg 完全一致）。 */
const BRAND = {
  light: [0xc0, 0x84, 0xfc], // #C084FC
  main: [0xa8, 0x55, 0xf7], // #A855F7
  deep: [0x7c, 0x3a, 0xed] // #7C3AED
};

/**
 * 绘制「2×2 方块拼合的方舟标记」。
 * @param {number} size 画布边长
 * @returns {Buffer} RGBA
 */
function drawMark(size) {
  const rgba = Buffer.alloc(size * size * 4, 0);

  // 按比例换算：以 48×48 的原始 viewBox 为基准（方块 17、间距 4、起始 5）
  const s = size / 48;
  const block = Math.round(17 * s);
  const gap = Math.round(4 * s);
  const pad = Math.max(1, Math.round(5 * s));
  const radius = Math.max(1, Math.round(4 * s));

  const second = pad + block + gap;

  blendRoundRect(rgba, size, { x: pad, y: pad, w: block, h: block, r: radius }, BRAND.light);
  blendRoundRect(rgba, size, { x: second, y: pad, w: block, h: block, r: radius }, BRAND.main);
  blendRoundRect(rgba, size, { x: pad, y: second, w: block, h: block, r: radius }, BRAND.main);
  blendRoundRect(rgba, size, { x: second, y: second, w: block, h: block, r: radius }, BRAND.deep);

  return rgba;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function main() {
  const outDir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(outDir, { recursive: true });

  const targets = [
    { size: 16, file: 'tray-16.png' },
    { size: 32, file: 'tray-32.png' }
  ];

  for (const t of targets) {
    const png = encodePng(t.size, t.size, drawMark(t.size));
    const dest = path.join(outDir, t.file);
    fs.writeFileSync(dest, png);
    // eslint-disable-next-line no-console
    console.log(`[icons] ${t.file}  ${t.size}×${t.size}  ${png.length} bytes`);
  }
}

main();
