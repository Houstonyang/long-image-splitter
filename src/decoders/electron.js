// Electron 适配器：直接用桌面端内置的 nativeImage。
//
// 为什么这是首选：Electron 自带 Chromium 的图片解码器，解码/裁剪/缩放/编码全都有，
// 不需要 ffmpeg、不需要 sharp、不装任何东西，也不起子进程。
//
// ⚠️ 只在 **Electron 主进程**里可用。headless（纯 node 启动）环境拿不到 electron 模块，
//    available() 会返回 false，由调用方回退到别的解码器。
export function createElectronDecoder({ load = () => import('electron') } = {}) {
  let nativeImage = null;

  async function ensure() {
    if (nativeImage) return nativeImage;
    const electron = await load();
    const ni = electron?.nativeImage || electron?.default?.nativeImage;
    if (!ni?.createFromBuffer) throw new Error('当前环境没有 Electron nativeImage');
    nativeImage = ni;
    return nativeImage;
  }

  return {
    name: 'electron',
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
      const ni = await ensure();
      const image = ni.createFromBuffer(Buffer.from(bytes));
      if (image.isEmpty()) throw new Error('图片无法解码');
      return wrap(image);
    }
  };

  function wrap(image) {
    return {
      get width() {
        return image.getSize().width;
      },
      get height() {
        return image.getSize().height;
      },
      // 原图坐标裁切
      crop(rect) {
        return wrap(image.crop(rect));
      },
      resize({ width }) {
        // nativeImage 的质量档位是字符串；调用方传数字时用 'best'
        return wrap(image.resize({ width, quality: 'best' }));
      },
      encode({ format, quality }) {
        if (String(format).toLowerCase() === 'png') return image.toPNG();
        return image.toJPEG(Number(quality) || 90);
      }
    };
  }
}

export const electronDecoder = createElectronDecoder();
