// QQ Agent 插件适配层单测。
//
// 这里同时验证两件容易出事的东西：
//   1. 清单是否符合宿主 plugin-loader / normalizeManifest 的规则
//   2. 环境不满足时是否**安全空转**（绝不改动用户的消息）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = path.join(ROOT, 'hosts', 'qq-agent');
const LIB = path.join(PLUGIN_DIR, 'lib');

// lib/ 是构建产物；没构建过就先构建一次，保证这个测试单跑也能过
if (!fs.existsSync(path.join(LIB, 'index.js'))) {
  await import('../tools/build-plugin.mjs');
}

const { createRgbaImage, bmpDecoder } = await import('../src/decoders/bmp.js');
const { toBase64 } = await import('../src/decoder.js');
const adapter = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href);

const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8'));

// 生产链路（electron → sharp → jimp）在纯 Node 测试环境里一个都不可用，
// 所以行为类用例通过 setup 的注入点指定内置解码器；这也顺带验证了注入点本身可用。
const bmpBytes = (width, height) =>
  createRgbaImage(width, height, (x, y) => [x & 255, y & 255, 60, 255]).encode({ format: 'bmp' });

const dataUrl = (width, height) => `data:image/bmp;base64,${toBase64(bmpBytes(width, height))}`;

// 600×2500 → 2 段，每段 BMP 约 3.2MB / 1.3MB，落在默认体积极限内
const longDataUrl = dataUrl(600, 2500);
const shortDataUrl = dataUrl(600, 400);

const bodyWith = (url) => ({
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: '帮我看看' }, { type: 'image_url', image_url: { url } }] }]
});

const silent = { log: () => {} };
const withBmp = { decoder: bmpDecoder };

// ── 清单合规 ────────────────────────────────────────────────────────
test('manifest.id 符合宿主的正则（字母数字加 . _ -）', () => {
  assert.match(manifest.id, /^[a-z0-9][a-z0-9._-]*$/i);
});

test('apiVersion 不超过宿主当前支持的上限（1）', () => {
  assert.equal(Number(manifest.apiVersion), 1);
  assert.ok(Number(manifest.apiVersion) <= 1);
});

test('category 属于宿主允许的取值', () => {
  assert.ok(['model', 'message', 'knowledge', 'media', 'utility'].includes(manifest.category), manifest.category);
});

test('确定性型插件必须声明能力，否则宿主会判定"没有 provides"', () => {
  assert.ok(Array.isArray(manifest.capabilities));
  assert.ok(manifest.capabilities.length > 0);
});

test('默认关闭，避免覆盖掉用户已经在用的插件', () => {
  assert.equal(manifest.enabledByDefault, false);
});

test('入口文件存在且插件目录自包含（不引用目录外的代码）', () => {
  const entry = manifest.entry || 'index.js';
  assert.ok(fs.existsSync(path.join(PLUGIN_DIR, entry)), `缺少入口 ${entry}`);
  assert.ok(fs.existsSync(path.join(LIB, 'index.js')), 'lib/ 未构建');
  const source = fs.readFileSync(path.join(PLUGIN_DIR, 'index.js'), 'utf8');
  assert.ok(!/from\s+'\.\.\/\.\.\/src/.test(source), '入口不得直接引用插件目录外的 src/');
});

test('声明的每个能力都真的有实现', () => {
  for (const capability of manifest.capabilities) {
    assert.equal(typeof adapter.providers[capability], 'function', `能力 ${capability} 没有对应实现`);
  }
});

// ── 行为 ────────────────────────────────────────────────────────────
test('setup() 不抛错（抛错会被宿主登记成加载失败）', async () => {
  await adapter.setup(silent, withBmp);
  assert.equal(adapter.status().ready, true);
});

test('长图被切成 2 段，并插入顺序说明', async () => {
  await adapter.setup(silent, withBmp);
  const result = await adapter.providers['llm.request-params']({ body: bodyWith(longDataUrl) });
  const body = result.body || result;
  const content = body.messages[0].content;
  assert.equal(content.filter((p) => p.type === 'image_url').length, 2);
  assert.ok(content.some((p) => p.type === 'text' && p.text.includes('连续分段')));
  assert.equal(content[0].text, '帮我看看', '原有文字必须保留');
});

test('短图原样放行', async () => {
  await adapter.setup(silent, withBmp);
  const result = await adapter.providers['llm.request-params']({ body: bodyWith(shortDataUrl) });
  const body = result.body || result;
  assert.equal(body.messages[0].content.length, 2);
  assert.equal(body.messages[0].content[1].type, 'image_url');
});

test('重复执行是幂等的（两个分段插件同时启用也不会切两遍）', async () => {
  await adapter.setup(silent, withBmp);
  const once = await adapter.providers['llm.request-params']({ body: bodyWith(longDataUrl) });
  const twice = await adapter.providers['llm.request-params']({ body: once.body || once });
  assert.deepEqual(twice.body || twice, once.body || once);
});

test('retry-advisor：命中图片拒收时给出降级建议', async () => {
  await adapter.setup(silent, withBmp);
  const advice = await adapter.providers['llm.retry-advisor']({
    body: bodyWith(shortDataUrl),
    errorText: JSON.stringify({ error: { message: 'unsupported image format' } }),
    status: 400
  });
  assert.ok(advice);
  assert.match(advice.reason, /去掉图片重试文字回复/);
});

test('retry-advisor：其它错误返回 null，把决定权还给宿主', async () => {
  await adapter.setup(silent, withBmp);
  const advice = await adapter.providers['llm.retry-advisor']({
    body: bodyWith(shortDataUrl),
    errorText: JSON.stringify({ error: { message: 'Invalid API key' } }),
    status: 401
  });
  assert.equal(advice, null);
});

// ── 最关键的：环境不满足时必须安全空转 ──────────────────────────────
test('纯 Node 环境（无 Electron / sharp / jimp）不抛错，进入空转', async () => {
  await adapter.setup(silent);
  assert.equal(adapter.status().ready, false);
  assert.equal(adapter.status().decoder, null);
});

test('未就绪时静默放行：请求体一个字节都不改', async () => {
  await adapter.setup(silent); // 不注入解码器 = 模拟宿主上没有可用解码器
  const body = bodyWith(longDataUrl);
  const snapshot = JSON.stringify(body);

  const result = await adapter.providers['llm.request-params']({ body });
  assert.equal(JSON.stringify(result.body || result), snapshot, '未就绪时绝不能改动消息');
  assert.equal(
    await adapter.providers['llm.retry-advisor']({ body, errorText: '{}', status: 400 }),
    null
  );
});

test('deactivate 之后同样安全空转（宿主禁用插件时的行为）', async () => {
  await adapter.setup(silent, withBmp);
  adapter.deactivate();
  assert.equal(adapter.status().ready, false);

  const body = bodyWith(longDataUrl);
  const snapshot = JSON.stringify(body);
  const result = await adapter.providers['llm.request-params']({ body });
  assert.equal(JSON.stringify(result.body || result), snapshot);
});

test('setup 可以重复调用（宿主热重载会反复调），状态自洽', async () => {
  await adapter.setup(silent, withBmp);
  await adapter.setup(silent, withBmp);
  await adapter.setup(silent, withBmp);
  assert.equal(adapter.status().ready, true);
});

test('缺少 api.log 也不会崩（宿主版本差异时的自我保护）', async () => {
  await adapter.setup(undefined, withBmp);
  assert.equal(adapter.status().ready, true);
});
