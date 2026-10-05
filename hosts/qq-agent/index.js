// QQ Agent 适配层：把宿主无关的核心接到 QQ Agent 的插件钩子上。
//
// 整个文件只做三件事：探测解码器、把请求体转交给核心、把结果还回去。
// 所有分段逻辑都在 ./lib/（由 tools/build-plugin.mjs 从 ../../src/ 复制生成）。
//
// ── 关于"宿主升级后还能不能用"的设计取舍 ─────────────────────────────
// 1) setup() 永不抛错。宿主 plugin-loader 在 setup 抛错时会把插件登记为"加载失败"，
//    用户只能看到一句报错；而这里改成"加载成功 + 自述状态"，问题一眼可见。
// 2) 探测不到任何解码器 → 进入**静默放行**模式：provider 原样返回请求体，
//    绝不改动图片。宁可什么都不做，也不能把用户的消息搞坏。
// 3) 解码器是惰性探测的：不在加载期 import('electron')，所以 Electron 没了
//    也不会导致插件加载失败，只会自动退回 sharp / jimp。
//
// ── 为什么生产链路里没有内置的 BMP 解码器 ────────────────────────────
// BMP 是未压缩格式：1200×1800 的分段会有 6MB 以上，而且视觉模型接口基本不认
// image/bmp。它在本项目里的定位是"测试与演示用的零依赖解码器"，拿来当生产回退
// 只会让每张长图都撞上体积上限。所以正式链路是 electron → sharp → jimp；
// 都没有就空转，并且日志里会说清楚该装什么。
import { resolveDecoder } from './lib/decoder.js';
import { splitRequestImages } from './lib/split.js';
import { stripRejectedImages } from './lib/fallback.js';
import { createElectronDecoder } from './lib/decoders/electron.js';
import { nodeDecoders } from './lib/decoders/node.js';

const TAG = '[长图分段器]';

let log = (...args) => console.log(TAG, ...args);
let ready = false;
let decoder = null;

/**
 * @param {object} [api] 宿主注入的插件 API（只用 api.log，缺了也能跑）
 * @param {object} [test] 测试用的注入点：{ decoder } 直接指定解码器，跳过探测
 */
export async function setup(api, test = {}) {
  log = (...args) => (api?.log ? api.log(...args) : console.log(TAG, ...args));
  ready = false;
  decoder = null;

  if (test.decoder) {
    decoder = test.decoder;
    ready = true;
    log(`已就绪（指定解码器）：${decoder.name}`);
    return;
  }

  const candidates = [createElectronDecoder(), ...nodeDecoders()];
  try {
    decoder = await resolveDecoder(candidates);
    ready = true;
    log(`已就绪：解码器 = ${decoder.name}；长图将按 1200px 宽 / 1800px 高 / 120px 重叠分段`);
  } catch {
    // 不抛错：保持插件"已加载"状态，但对外是一个不做任何事的安全空转
    log('未找到可用解码器（桌面版用 Electron 内置解码器；headless 请在本目录 npm i sharp），' +
        '已进入静默放行模式：不会改动任何图片');
  }
}

/** 宿主热重载/禁用时会调用（若宿主支持）。 */
export function deactivate() {
  ready = false;
  decoder = null;
}

export const providers = {
  // 提交前改写请求体：把长图换成"说明 + 连续分段"
  'llm.request-params': ({ body }) => {
    if (!ready || !decoder) return { body };
    return splitRequestImages(body, { decoder, log });
  },

  // 接口明确拒收图片时给出降级建议（去掉图片、改发纯文字重试）
  'llm.retry-advisor': (args) => (ready ? stripRejectedImages(args) : null)
};

/** 给控制台/调试用的自述信息。 */
export function status() {
  return { ready, decoder: decoder?.name || null };
}
