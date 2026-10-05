// 默认阈值与限额。全部可被调用方覆盖 —— 没有一个是硬编码在算法里的。
//
// 取值依据（默认值与原版插件完全一致，保证升级后行为不变）：
//   minHeight 2048   高度不超过这个值的长宽比再大也不值得切（切了反而丢上下文）
//   minAspect 3      高宽比不到 3 的图片整张缩小的损失可以接受，不必切
//   maxWidth 1200    分段宽度上限：超过就等比缩到 1200，保住文字可读性
//   maxTileHeight 1800  单段高度上限（缩放后）：按缩放比折算回原图坐标再裁
//   overlap 120      相邻段重叠像素（缩放后）：防止一行字正好被切在边界上
//   maxTiles 24      单张图最多切多少段：再多说明这张图不该一次喂
//   maxPixels 8000万 原图像素上限：超过直接拒绝，避免解码阶段把内存打爆
export const DEFAULTS = Object.freeze({
  minHeight: 2048,
  minAspect: 3,
  maxWidth: 1200,
  maxTileHeight: 1800,
  overlap: 120,
  maxTiles: 24,
  maxPixels: 80_000_000,
  maxInputBase64: 28 * 1024 * 1024,
  maxTileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  quality: 90,
  format: 'jpeg',
  // null = 用解码器自己声明的 inputs（推荐）；显式传数组则覆盖它
  inputFormats: null
});

// 字节上限是按 **JPEG（有损压缩）** 口径定的：1200×1800 的 q90 JPEG 通常只有几百 KB，
// 4MB 已经非常宽松。但如果解码器只能输出**未压缩**格式（如纯 JS BMP 解码器），
// 同样尺寸会膨胀到 4.8MB 以上，必然被判"分段文件过大"。
//
// 所以：DEFAULTS 的数字保持不变（生产路径就是 JPEG），
// 用未压缩格式做演示/校验时，显式把下面这组预设展开进去：
//
//   splitImageBuffer(bytes, { decoder, options: UNCOMPRESSED_LIMITS })
//
export const UNCOMPRESSED_LIMITS = Object.freeze({
  maxTileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024
});

// 错误文案默认中文，可整体替换（见 messages 选项），方便接非中文宿主。
export const MESSAGES = Object.freeze({
  invalidSize: '无效图片尺寸',
  tooManyPixels: '图片像素过多，请分开发送',
  tooManyTiles: '长图超过 {maxTiles} 段，请分开发送',
  invalidOptions: '分段参数不合法',
  decodeFailed: '图片无法解码',
  encodeFailed: '分段编码失败',
  tileTooLarge: '分段文件过大或编码失败',
  totalTooLarge: '分段图片总量过大',
  inputTooLarge: '图片文件过大',
  batchTooLarge: '本次长图分段总数超过 {maxTiles}，请分批查看图片'
});

/** 构造一个带错误码的 Error，宿主可以按 code 做本地化或降级判断。 */
export function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 合并默认值；messages 单独深合并，避免调用方只改一条时丢掉其余默认文案。 */
export function resolveOptions(options = {}) {
  const { messages, ...rest } = options;
  return {
    ...DEFAULTS,
    ...rest,
    messages: { ...MESSAGES, ...(messages || {}) }
  };
}

/** 文案插值：tooManyTiles / batchTooLarge 里带 {maxTiles} 占位。 */
export function text(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m
  );
}
