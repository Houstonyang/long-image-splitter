// 可选解码器：sharp / jimp。
//
// 用途：没有 Electron 的环境（headless 服务、CI、别的 Node 宿主）想用本项目的分段能力时，
// 装上其中一个即可，不用改一行代码 —— resolveDecoder() 会自动挑到可用的那个。
//
// ⚠️ 诚实说明：本仓库**不依赖**这两个包，也没把它们装进依赖里。
//    下面的适配是按各自公开 API 写的，未安装时 available() 返回 false 直接跳过；
//    装了之后请自己跑一次 `npm run demo` 确认端到端可用。
import { normalizeFormat } from '../decoder.js';

export function createSharpDecoder({ load = () => import('sharp') } = {}) {
  let sharp = null;
  const ensure = async () => {
    if (!sharp) {
      const mod = await load();
      sharp = mod?.default || mod;
    }
    if (typeof sharp !== 'function') throw new Error('sharp 模块形状不符合预期');
    return sharp;
  };

  return {
    name: 'sharp',
    formats: ['jpeg', 'png', 'webp'],
    // 刻意只声明 JPEG/PNG：sharp 其实也能解 WebP/GIF，但宿主原本对 GIF 是原样透传的，
    // 擅自把动图拉进来处理属于扩大行为范围。需要就显式传 inputFormats。
    inputs: ['jpeg', 'jpg', 'png'],
    async available() {
      try {
        await ensure();
        return true;
      } catch {
        return false;
      }
    },
    async decode(bytes) {
      const s = await ensure();
      const buffer = Buffer.from(bytes);
      const meta = await s(buffer).metadata();
      if (!meta?.width || !meta?.height) throw new Error('图片无法解码');
      return wrap(buffer, { left: 0, top: 0, width: meta.width, height: meta.height }, null);
    }
  };

  // sharp 是"每次操作都从原 buffer 重新来一遍"的模型，
  // 所以这里保留原 buffer + 裁切矩形 + 目标尺寸，编码时才真正执行。
  function wrap(buffer, rect, out) {
    const width = out?.width ?? rect.width;
    const height = out?.height ?? rect.height;
    return {
      width,
      height,
      crop(next) {
        return wrap(buffer, {
          left: rect.left + next.x,
          top: rect.top + next.y,
          width: next.width,
          height: next.height
        }, null);
      },
      resize({ width: targetWidth }) {
        const w = Math.max(1, Math.round(targetWidth));
        return wrap(buffer, rect, { width: w, height: Math.max(1, Math.round((rect.height * w) / rect.width)) });
      },
      async encode({ format, quality }) {
        const s = await ensure();
        let pipe = s(buffer).extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
        if (out) pipe = pipe.resize(out.width, out.height);
        const fmt = normalizeFormat(format);
        if (fmt === 'png') pipe = pipe.png();
        else if (fmt === 'webp') pipe = pipe.webp({ quality: Number(quality) || 90 });
        else pipe = pipe.jpeg({ quality: Number(quality) || 90 });
        return new Uint8Array(await pipe.toBuffer());
      }
    };
  }
}

export function createJimpDecoder({ load = () => import('jimp') } = {}) {
  let Jimp = null;
  const ensure = async () => {
    if (!Jimp) {
      const mod = await load();
      Jimp = mod?.Jimp || mod?.default || mod;
    }
    if (typeof Jimp?.read !== 'function') throw new Error('jimp 模块形状不符合预期');
    return Jimp;
  };

  const mimeOf = (J, format) => {
    const fmt = normalizeFormat(format);
    if (fmt === 'png') return J.MIME_PNG || 'image/png';
    return J.MIME_JPEG || 'image/jpeg';
  };

  return {
    name: 'jimp',
    formats: ['jpeg', 'png'],
    inputs: ['jpeg', 'jpg', 'png'],
    async available() {
      try {
        await ensure();
        return true;
      } catch {
        return false;
      }
    },
    async decode(bytes) {
      const J = await ensure();
      const image = await J.read(Buffer.from(bytes));
      return wrap(image);
    }
  };

  function wrap(image) {
    const width = image.bitmap?.width ?? image.width;
    const height = image.bitmap?.height ?? image.height;
    return {
      width,
      height,
      async crop(rect) {
        // Jimp 是就地修改的，务必 clone 后再裁，否则会影响后续分段
        return wrap(image.clone().crop(rect.x, rect.y, rect.width, rect.height));
      },
      async resize({ width: targetWidth }) {
        const w = Math.max(1, Math.round(targetWidth));
        const h = Math.max(1, Math.round((height * w) / width));
        return wrap(image.clone().resize(w, h));
      },
      async encode({ format }) {
        const J = await ensure();
        const buffer = await image.getBufferAsync(mimeOf(J, format));
        return new Uint8Array(buffer);
      }
    };
  }
}

/** 按"体积/性能更优"的顺序返回可选的 Node 解码器。 */
export function nodeDecoders() {
  return [createSharpDecoder(), createJimpDecoder()];
}
