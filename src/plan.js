// 分段数学：纯函数，不碰图片、不碰宿主、不碰任何 IO。
//
// 这是整个项目最该被测试覆盖的部分 —— 它决定了"文字会不会被切在边界上"。
// 坐标系约定：**全部在原图像素坐标下计算**，缩放交给编码阶段。
// 这样做的理由：缩小和裁切的顺序会显著影响清晰度，先算好原图上的裁切矩形、
// 再缩放到目标宽度，比"先把整张缩窄再在缩略图上裁"少一次重采样。
import { resolveOptions, fail, text } from './limits.js';

/**
 * 计算分段方案。
 * @param {number} width  原图宽（整数像素）
 * @param {number} height 原图高（整数像素）
 * @param {object} [options] 见 limits.js 的 DEFAULTS
 * @returns {{split:boolean,width:number,height:number,scale:number,cropHeight:number,
 *            overlap:number,step:number,count:number,tiles:Array<{x:number,y:number,width:number,height:number}>}}
 * @throws {Error} code = INVALID_SIZE | TOO_MANY_PIXELS | INVALID_OPTIONS | TOO_MANY_TILES
 */
export function planSegments(width, height, options = {}) {
  const o = resolveOptions(options);

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw fail('INVALID_SIZE', o.messages.invalidSize);
  }
  // 像素上限先于"是不是长图"判断：哪怕它不是长图，解码它也可能把内存打爆。
  if (width * height > o.maxPixels) {
    throw fail('TOO_MANY_PIXELS', o.messages.tooManyPixels);
  }

  const notLongEnough = height <= o.minHeight || height / width < o.minAspect;
  if (notLongEnough) {
    return { split: false, width, height, scale: 1, cropHeight: height, overlap: 0, step: height, count: 0, tiles: [] };
  }

  // 宽度超限才缩放；已经比 1200 窄就按 1:1 处理（不放大）。
  const scale = Math.min(1, o.maxWidth / width);
  // 目标高度折算回原图坐标：floor 保证缩放后不会超过 maxTileHeight。
  const cropHeight = Math.floor(o.maxTileHeight / scale);
  const overlap = Math.ceil(o.overlap / scale);
  const step = cropHeight - overlap;
  if (step <= 0 || o.maxTiles < 1) {
    throw fail('INVALID_OPTIONS', o.messages.invalidOptions);
  }

  const count = 1 + Math.ceil(Math.max(0, height - cropHeight) / step);
  if (count > o.maxTiles) {
    throw fail('TOO_MANY_TILES', text(o.messages.tooManyTiles, { maxTiles: o.maxTiles, count }));
  }

  const tiles = Array.from({ length: count }, (_, index) => ({
    x: 0,
    y: index * step,
    width,
    // 最后一段贴底：不足 cropHeight 就按剩余高度，避免裁出图外
    height: Math.min(cropHeight, height - index * step)
  }));

  return { split: true, width, height, scale, cropHeight, overlap, step, count, tiles };
}

/** 只要矩形数组的简写（兼容旧调用）。 */
export function planTiles(width, height, options) {
  return planSegments(width, height, options).tiles;
}

/**
 * 相邻段的重叠区在原图坐标下的区间，用于自检与测试。
 * 返回 [{ from, to, height }]，第 i 项是第 i 段与第 i+1 段的重叠。
 */
export function overlapsOf(plan) {
  const out = [];
  for (let i = 0; i + 1 < plan.tiles.length; i++) {
    const a = plan.tiles[i];
    const b = plan.tiles[i + 1];
    const from = b.y;
    const to = a.y + a.height;
    out.push({ from, to, height: Math.max(0, to - from) });
  }
  return out;
}
