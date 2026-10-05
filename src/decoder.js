// 解码器接口：本项目的"可插拔点"。
//
// 分段算法只依赖下面这个极小的契约，不关心你用什么库解图：
//
//   Decoder = {
//     name: string,
//     formats?: string[],                       // 支持编码的格式，默认 ['jpeg']
//     available?(): boolean | Promise<boolean>, // 运行环境是否可用（如 Electron 里才有 nativeImage）
//     decode(bytes): Image | Promise<Image>     // Uint8Array -> Image
//   }
//
//   Image = {
//     width: number, height: number,
//     crop({x,y,width,height}): Image | Promise<Image>,   // 原图坐标
//     resize({width, quality}): Image | Promise<Image>,   // 只按宽度等比缩放
//     encode({format, quality}): Uint8Array | Promise<Uint8Array>
//   }
//
// 这个形状是照 Electron nativeImage 定的（createFromBuffer/getSize/crop/resize/toJPEG），
// 所以 Electron 适配器几乎是零成本；sharp / jimp / BMP 各自写一层薄包装即可。
import { fail } from './limits.js';

export const MIME_BY_FORMAT = Object.freeze({
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  bmp: 'image/bmp'
});

export function mimeOf(format) {
  return MIME_BY_FORMAT[String(format || '').toLowerCase()] || 'application/octet-stream';
}

/** 归一化格式名：jpg 和 jpeg 是同一个东西。 */
export function normalizeFormat(format) {
  const f = String(format || 'jpeg').toLowerCase();
  return f === 'jpg' ? 'jpeg' : f;
}

/**
 * 挑一个真正可用的解码器。
 * @param {Array} candidates 按优先级排列
 * @returns {Promise<object>} 第一个 available() 为真的解码器
 * @throws code = NO_DECODER
 */
export async function resolveDecoder(candidates = []) {
  const list = candidates.filter(Boolean);
  for (const candidate of list) {
    try {
      if (typeof candidate.available !== 'function') return candidate;
      if (await candidate.available()) return candidate;
    } catch {
      // available() 抛错 = 这个环境用不了它，继续试下一个
    }
  }
  throw fail('NO_DECODER', `没有可用的图片解码器（尝试了 ${list.length} 个）`);
}

/** 解码器是否支持指定输出格式；不支持就退回它声明的第一个格式。 */
export function pickFormat(decoder, wanted) {
  const want = normalizeFormat(wanted);
  const supported = (decoder?.formats || ['jpeg']).map(normalizeFormat);
  return supported.includes(want) ? want : supported[0];
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 运行环境无关的 base64 编码：有 Buffer 用 Buffer，没有就手写。 */
export function toBase64(bytes) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes).toString('base64');
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

/** 运行环境无关的 base64 解码。 */
export function fromBase64(text) {
  const clean = String(text).replace(/[\r\n]/g, '');
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return new Uint8Array(Buffer.from(clean, 'base64'));
  }
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) lookup[B64.charCodeAt(i)] = i;
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    if (ch === '=') break;
    const v = lookup[ch.charCodeAt(0)];
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}
