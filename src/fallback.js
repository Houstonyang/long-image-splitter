// 失败兜底与降级：图片读不了时**明确说读不了**，而不是让模型瞎猜。
//
// 两件事分开放，是因为它们在宿主里的触发时机完全不同：
//   unavailablePart()      在"提交前处理失败"时用 —— 把图片换成一截文字说明
//   stripRejectedImages()  在"提交后被接口拒收"时用 —— 去掉图片重试一次纯文字
import { resolveOptions, fail } from './limits.js';

/**
 * 把一段"读不到图片"的说明做成 OpenAI content part。
 * 措辞是刻意的：先声明无法查看 → 禁止猜测 → 给出可行的替代动作。
 */
export function unavailablePart(reason, options = {}) {
  const o = resolveOptions(options);
  return {
    type: 'text',
    text: `[图片无法处理：${reason}。请明确说明无法查看，不要猜测图片内容；可请用户分开发送较短截图。]`
  };
}

// 接口明确说"这图我不认"时的错误文案特征。
// 只认这几类，避免把普通的 400（模型名写错、Key 无效）也当成图片问题重试一遍。
export const REJECTION_PATTERN =
  /(?:unsupported|invalid) image\b|image (?:format|type) (?:is )?not supported|failed to decode image|could not process image/i;

export const DEGRADED_NOTICE = '模型接口拒收图片，本轮不要再次读取同一张图片，依据已有文字继续回复';

/**
 * 给出"去掉图片、改发纯文字"的降级建议。
 *
 * 只返回建议，**不自己发请求**：超时、重试次数、计费口径都必须由宿主掌握，
 * 否则会出现"插件偷偷多打一次 API"这种既难发现又烧钱的问题。
 *
 * @param {object} args
 * @param {object} args.body      原始请求体（OpenAI Chat Completions 格式）
 * @param {string} args.errorText 接口返回的原始响应文本
 * @param {number} args.status    HTTP 状态码
 * @param {number[]} [args.statuses=[400,422]] 只在哪些状态码上考虑降级
 * @param {RegExp} [args.pattern] 自定义拒收特征
 * @returns {{body:object, reason:string}|null} null = "这个错误不归我管"
 */
export function stripRejectedImages({
  body,
  errorText,
  status,
  statuses = [400, 422],
  pattern = REJECTION_PATTERN
} = {}) {
  if (!statuses.includes(status)) return null;

  let message;
  try {
    message = JSON.parse(errorText)?.error?.message;
  } catch {
    return null;
  }
  if (typeof message !== 'string' || !pattern.test(message)) return null;

  let removed = false;
  const messages = (body?.messages || []).map((entry) => {
    if (!Array.isArray(entry.content)) return entry;
    const content = entry.content.map((part) => {
      if (part?.type !== 'image_url') return part;
      removed = true;
      return unavailablePart(DEGRADED_NOTICE);
    });
    return { ...entry, content };
  });

  if (!removed) return null;
  return {
    body: { ...body, messages },
    reason: '图片被接口拒收，已去掉图片重试文字回复'
  };
}

/** 宿主可用来判断"这个 400 是不是在说图片"的便捷判断。 */
export function looksLikeImageRejection(errorText, pattern = REJECTION_PATTERN) {
  try {
    const message = JSON.parse(errorText)?.error?.message;
    return typeof message === 'string' && pattern.test(message);
  } catch {
    return false;
  }
}

export { fail };
