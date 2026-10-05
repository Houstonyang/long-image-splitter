// 解码器契约与 base64 工具的单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import { toBase64, fromBase64, mimeOf, normalizeFormat, pickFormat, resolveDecoder } from '../src/decoder.js';

test('base64 编解码可逆（覆盖各种长度余数）', () => {
  for (let length = 0; length < 300; length++) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 11) & 255;
    const round = fromBase64(toBase64(bytes));
    assert.deepEqual(Array.from(round), Array.from(bytes), `长度 ${length}`);
  }
});

test('base64 遇到换行也能解（宿主传进来的串可能带换行）', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const b64 = toBase64(bytes);
  const wrapped = `${b64.slice(0, 4)}\r\n${b64.slice(4)}`;
  assert.deepEqual(Array.from(fromBase64(wrapped)), Array.from(bytes));
});

test('MIME 映射', () => {
  assert.equal(mimeOf('jpeg'), 'image/jpeg');
  assert.equal(mimeOf('jpg'), 'image/jpeg');
  assert.equal(mimeOf('png'), 'image/png');
  assert.equal(mimeOf('bmp'), 'image/bmp');
  assert.equal(mimeOf('nope'), 'application/octet-stream');
});

test('格式名归一化：jpg 就是 jpeg', () => {
  assert.equal(normalizeFormat('JPG'), 'jpeg');
  assert.equal(normalizeFormat(undefined), 'jpeg');
  assert.equal(normalizeFormat('PNG'), 'png');
});

test('解码器不支持目标格式时退回它声明支持的第一个格式', () => {
  const onlyBmp = { name: 'bmp', formats: ['bmp'] };
  assert.equal(pickFormat(onlyBmp, 'jpeg'), 'bmp');
  assert.equal(pickFormat({ name: 'x', formats: ['jpeg', 'png'] }, 'png'), 'png');
  assert.equal(pickFormat({ name: 'x' }, 'jpeg'), 'jpeg', '没声明就默认 jpeg');
});

test('resolveDecoder 挑第一个真正可用的', async () => {
  const no = { name: 'no', available: () => false };
  const boom = { name: 'boom', available: () => { throw new Error('环境不对'); } };
  const yes = { name: 'yes', available: async () => true };
  const chosen = await resolveDecoder([no, boom, yes]);
  assert.equal(chosen.name, 'yes');
});

test('没有 available 的解码器视为可用（约定：不声明就是无条件可用）', async () => {
  const chosen = await resolveDecoder([{ name: 'plain' }]);
  assert.equal(chosen.name, 'plain');
});

test('一个都不可用时抛出 NO_DECODER', async () => {
  await assert.rejects(
    () => resolveDecoder([{ name: 'no', available: () => false }]),
    (error) => error.code === 'NO_DECODER' && /没有可用的图片解码器/.test(error.message)
  );
});

test('空的候选列表也会抛 NO_DECODER 而不是返回 undefined', async () => {
  await assert.rejects(() => resolveDecoder([]), (error) => error.code === 'NO_DECODER');
});
