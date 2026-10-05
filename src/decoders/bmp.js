// 纯 JS 的 BMP 解码/编码器 + 内存图片。
//
// 存在的意义：让整个分段流水线**零依赖、可端到端验证**。
// 没有 Electron、没有 sharp 的环境（CI、headless、单元测试、演示）都能真真切切地
// 走完"解码 → 裁切 → 缩放 → 编码"全程，而不是靠 mock 假装跑通。
//
// 只支持未压缩（BI_RGB）的 24/32 位 BMP —— 覆盖生成工具的输出足够了，
// 不追求做通用图像库。
import { normalizeFormat } from '../decoder.js';

const FILE_HEADER = 14;
const INFO_HEADER = 40;

/** 解析 BMP → { width, height, rgba }（统一成自上而下的 RGBA）。 */
export function decodeBmp(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0x4d42) throw new Error('不是 BMP 文件');
  const dataOffset = view.getUint32(10, true);
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const planes = view.getUint16(26, true);
  const bpp = view.getUint16(28, true);
  const compression = view.getUint32(30, true);

  if (planes !== 1) throw new Error('BMP 平面数异常');
  if (compression !== 0) throw new Error('只支持未压缩 BMP（BI_RGB）');
  if (bpp !== 24 && bpp !== 32) throw new Error(`只支持 24/32 位 BMP，当前 ${bpp} 位`);
  if (width <= 0 || rawHeight === 0) throw new Error('BMP 尺寸异常');

  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  const bytesPerPixel = bpp / 8;
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  const rgba = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const srcRow = topDown ? y : height - 1 - y;
    const rowStart = dataOffset + srcRow * rowSize;
    for (let x = 0; x < width; x++) {
      const p = rowStart + x * bytesPerPixel;
      const o = (y * width + x) * 4;
      rgba[o] = bytes[p + 2];      // BMP 是 BGR
      rgba[o + 1] = bytes[p + 1];
      rgba[o + 2] = bytes[p];
      rgba[o + 3] = bpp === 32 ? bytes[p + 3] : 255;
    }
  }
  return { width, height, rgba };
}

/** RGBA → 24 位自下而上 BMP。 */
export function encodeBmp({ width, height, rgba }) {
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelBytes = rowSize * height;
  const out = new Uint8Array(FILE_HEADER + INFO_HEADER + pixelBytes);
  const view = new DataView(out.buffer);

  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(2, out.length, true);
  view.setUint32(10, FILE_HEADER + INFO_HEADER, true);
  view.setUint32(14, INFO_HEADER, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // 正数 = 自下而上
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(30, 0, true);
  view.setUint32(34, pixelBytes, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);

  for (let y = 0; y < height; y++) {
    const srcRow = height - 1 - y;
    const rowStart = FILE_HEADER + INFO_HEADER + y * rowSize;
    for (let x = 0; x < width; x++) {
      const o = (srcRow * width + x) * 4;
      const p = rowStart + x * 3;
      out[p] = rgba[o + 2];
      out[p + 1] = rgba[o + 1];
      out[p + 2] = rgba[o];
    }
  }
  return out;
}

/** 取某个像素，测试与演示用。 */
export function pixelAt({ width, rgba }, x, y) {
  const o = (y * width + x) * 4;
  return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]];
}

/**
 * 内存图片：带 crop / resize / encode，形状与 decoder.js 的 Image 契约一致。
 * @param {number} width
 * @param {number} height
 * @param {(x:number,y:number)=>[number,number,number,number?]} paint 逐像素上色
 */
export function createRgbaImage(width, height, paint) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y) || [0, 0, 0, 255];
      const o = (y * width + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a === undefined ? 255 : a;
    }
  }
  return wrap({ width, height, rgba });
}

function wrap({ width, height, rgba }) {
  return {
    width,
    height,
    bytes: rgba,

    crop(rect) {
      const x0 = Math.max(0, Math.floor(rect.x));
      const y0 = Math.max(0, Math.floor(rect.y));
      const w = Math.min(Math.floor(rect.width), width - x0);
      const h = Math.min(Math.floor(rect.height), height - y0);
      if (w <= 0 || h <= 0) throw new Error('裁切区域超出图片范围');
      const out = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        const src = ((y0 + y) * width + x0) * 4;
        out.set(rgba.subarray(src, src + w * 4), y * w * 4);
      }
      return wrap({ width: w, height: h, rgba: out });
    },

    // 最近邻缩放：演示与测试够用，重点是能真跑通而不是像素多漂亮
    resize({ width: targetWidth }) {
      const w = Math.max(1, Math.round(targetWidth));
      const h = Math.max(1, Math.round((height * w) / width));
      const out = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        const sy = Math.min(height - 1, Math.floor((y * height) / h));
        for (let x = 0; x < w; x++) {
          const sx = Math.min(width - 1, Math.floor((x * width) / w));
          const src = (sy * width + sx) * 4;
          const dst = (y * w + x) * 4;
          out[dst] = rgba[src];
          out[dst + 1] = rgba[src + 1];
          out[dst + 2] = rgba[src + 2];
          out[dst + 3] = rgba[src + 3];
        }
      }
      return wrap({ width: w, height: h, rgba: out });
    },

    encode({ format }) {
      if (normalizeFormat(format) !== 'bmp') {
        throw new Error(`BMP 解码器只能编码 bmp，收到 ${format}`);
      }
      return encodeBmp({ width, height, rgba });
    }
  };
}

/** 从字节解码 BMP 的解码器（bmpDecoder.decode）。 */
export const bmpDecoder = {
  name: 'bmp',
  formats: ['bmp'],
  // 声明"我能读 bmp"，流水线据此决定要不要处理 data:image/bmp 的 part。
  // 这也是为什么测试与演示不用额外配置就能跑通：解码器自己说清楚了能力。
  inputs: ['bmp'],
  available: () => true,
  decode(bytes) {
    return wrap(decodeBmp(bytes));
  }
};

/** 直接用内存图片当"解码器"，测试里注入伪造图最省事。 */
export function memoryDecoder(makeImage, { inputs = ['bmp'], formats = ['bmp'] } = {}) {
  return {
    name: 'memory',
    formats,
    inputs,
    available: () => true,
    decode: (bytes) => makeImage(bytes)
  };
}
