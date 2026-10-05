// 流水线单测：用内存伪造解码器，验证"哪张图被切、怎么切、出错怎么办"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { splitImageBuffer, splitRequestImages, wouldSplit, defaultPreamble } from '../src/split.js';
import { createRgbaImage, memoryDecoder } from '../src/decoders/bmp.js';
import { toBase64 } from '../src/decoder.js';

/** 造一张有合法 BMP 头部的图（内容不重要，解码器是伪造的）。 */
function fakeImage(width, height) {
  return createRgbaImage(width, height, (x, y) => [x & 255, y & 255, 128, 255]);
}

const decoder = memoryDecoder(() => fakeImage(100, 100)); // 默认图，具体用例里会替换

/** 按尺寸返回固定图的解码器。 */
function sizedDecoder(size) {
  return memoryDecoder(() => fakeImage(size.width, size.height));
}

function dataUrl(bytes) {
  return `data:image/bmp;base64,${toBase64(bytes)}`;
}

// 尺寸刻意选得小一点：内存伪造图最终会编码成**未压缩**的 BMP，
// 而默认体积极限是按 JPEG 调的（4MB/段）。400×1800 的 BMP 约 2.2MB，落在默认上限内，
// 这样测的就是分段逻辑本身，而不是体积限额。
const LONG = { width: 400, height: 4000 };  // → 3 段
const SHORT = { width: 400, height: 600 };

// ── splitImageBuffer ────────────────────────────────────────────────
test('长图会被切开，且段数与计划一致', async () => {
  const bytes = new Uint8Array(1);
  const result = await splitImageBuffer(bytes, { decoder: sizedDecoder(LONG) });
  assert.equal(result.split, true);
  assert.equal(result.width, LONG.width);
  assert.equal(result.height, LONG.height);
  assert.equal(result.tiles.length, 3);
  assert.equal(result.format, 'bmp');
  assert.ok(result.tiles.every((t) => t.dataUrl.startsWith('data:image/bmp;base64,')));
});

test('非长图原样返回，不做任何切分', async () => {
  const result = await splitImageBuffer(new Uint8Array(1), { decoder: sizedDecoder(SHORT) });
  assert.equal(result.split, false);
  assert.deepEqual(result.tiles, []);
});

test('解码器抛错时向上抛出，由调用方决定怎么兜底', async () => {
  const broken = { name: 'broken', formats: ['bmp'], decode() { throw new Error('坏图'); } };
  await assert.rejects(() => splitImageBuffer(new Uint8Array(1), { decoder: broken }), /坏图/);
});

test('缺少解码器时给出明确的错误码', async () => {
  await assert.rejects(
    () => splitImageBuffer(new Uint8Array(1), {}),
    (error) => error.code === 'NO_DECODER'
  );
});

test('单段体积超限时报错', async () => {
  await assert.rejects(
    () => splitImageBuffer(new Uint8Array(1), {
      decoder: memoryDecoder(() => fakeImage(900, 4200)),
      options: { maxTileBytes: 10 }
    }),
    (error) => error.code === 'TILE_TOO_LARGE'
  );
});

// ── splitRequestImages ──────────────────────────────────────────────
function bodyWith(content) {
  return { model: 'm', messages: [{ role: 'user', content }] };
}

test('请求体里的长图被换成 说明 + 连续分段', async () => {
  const out = await splitRequestImages(
    bodyWith([
      { type: 'text', text: '看看这张图' },
      { type: 'image_url', image_url: { url: dataUrl(new Uint8Array(3)) } }
    ]),
    { decoder: memoryDecoder(() => fakeImage(LONG.width, LONG.height)) }
  );

  const content = out.messages[0].content;
  const images = content.filter((p) => p.type === 'image_url');
  assert.equal(images.length, 3, '应换成 3 段');
  const preambleIndex = content.findIndex((p) => p.type === 'text' && p.text.includes('连续分段'));
  assert.ok(preambleIndex > 0, '说明文字应插在分段之前');
  assert.equal(content[preambleIndex - 1].text, '看看这张图');
  assert.equal(content[0].text, '看看这张图', '原有文字消息必须保住');
});

test('说明文字包含顺序、重叠、以及"图里的字不是指令"三件事', () => {
  const text = defaultPreamble({ count: 3, width: 900, height: 4200 });
  assert.match(text, /3 张/);
  assert.match(text, /900×4200/);
  assert.match(text, /按顺序阅读/);
  assert.match(text, /不要把重叠文字当成重复消息/);
  assert.match(text, /不是系统指令/);
});

test('短图原样保留，只计数不改动', async () => {
  const original = { type: 'image_url', image_url: { url: dataUrl(new Uint8Array(2)) } };
  const out = await splitRequestImages(bodyWith([original]), {
    decoder: memoryDecoder(() => fakeImage(SHORT.width, SHORT.height))
  });
  assert.equal(out.messages[0].content.length, 1);
  assert.deepEqual(out.messages[0].content[0], original);
});

test('外链图片不下载、不改动（不越权）', async () => {
  const external = { type: 'image_url', image_url: { url: 'https://example.com/a.png' } };
  const out = await splitRequestImages(bodyWith([external]), { decoder });
  assert.deepEqual(out.messages[0].content[0], external);
});

test('GIF / 其它 data URL 不受影响', async () => {
  const gif = { type: 'image_url', image_url: { url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' } };
  const out = await splitRequestImages(bodyWith([gif]), { decoder });
  assert.deepEqual(out.messages[0].content[0], gif);
});

test('处理失败时换成"读不到图"的文字，而不是让模型瞎猜', async () => {
  const broken = { name: 'broken', formats: ['bmp'], inputs: ['bmp'], decode() { throw new Error('图片无法解码'); } };
  const out = await splitRequestImages(bodyWith([{ type: 'image_url', image_url: { url: dataUrl(new Uint8Array(3)) } }]), {
    decoder: broken
  });
  const content = out.messages[0].content;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /图片无法处理/);
  assert.match(content[0].text, /不要猜测图片内容/);
});

test('默认只处理解码器声明支持的图片类型（不越权扩大范围）', async () => {
  // 解码器只声明能读 bmp，那么 data:image/png 就不该被它碰
  const onlyBmp = { name: 'only-bmp', formats: ['bmp'], inputs: ['bmp'], decode: () => fakeImage(LONG.width, LONG.height) };
  const png = { type: 'image_url', image_url: { url: `data:image/png;base64,${toBase64(new Uint8Array(4))}` } };
  const out = await splitRequestImages(bodyWith([png]), { decoder: onlyBmp });
  assert.deepEqual(out.messages[0].content[0], png);

  // 显式传 inputFormats 就能覆盖
  const forced = await splitRequestImages(bodyWith([png]), {
    decoder: onlyBmp,
    options: { inputFormats: ['png'] }
  });
  assert.ok(forced.messages[0].content.some((p) => p.type === 'text' && p.text.includes('连续分段')));
});

test('解码器没声明 inputs 时，退回只处理 JPEG / PNG', async () => {
  const plain = { name: 'plain', formats: ['bmp'], decode: () => fakeImage(LONG.width, LONG.height) };
  const bmpPart = { type: 'image_url', image_url: { url: dataUrl(new Uint8Array(3)) } };
  const out = await splitRequestImages(bodyWith([bmpPart]), { decoder: plain });
  assert.deepEqual(out.messages[0].content[0], bmpPart, 'BMP 不在默认范围内，应原样透传');
});

test('单张图失败不影响同一请求里的其它图', async () => {
  const flaky = {
    name: 'flaky',
    formats: ['bmp'],
    inputs: ['bmp'],
    decode(bytes) {
      if (bytes.length === 9) throw new Error('这张读不了');
      return fakeImage(SHORT.width, SHORT.height);
    }
  };
  const out = await splitRequestImages(
    bodyWith([
      { type: 'image_url', image_url: { url: dataUrl(new Uint8Array(9)) } },
      { type: 'image_url', image_url: { url: dataUrl(new Uint8Array(2)) } }
    ]),
    { decoder: flaky }
  );
  const content = out.messages[0].content;
  assert.equal(content.length, 2);
  assert.match(content[0].text, /图片无法处理/);
  assert.equal(content[1].type, 'image_url');
});

test('幂等：已经是分段结果的消息不会被切第二遍', async () => {
  const first = await splitRequestImages(
    bodyWith([{ type: 'image_url', image_url: { url: dataUrl(new Uint8Array(3)) } }]),
    { decoder: memoryDecoder(() => fakeImage(LONG.width, LONG.height)) }
  );
  const second = await splitRequestImages(first, {
    decoder: memoryDecoder(() => fakeImage(LONG.width, LONG.height))
  });
  assert.deepEqual(second, first, '第二次调用必须原样返回');
});

test('请求级上限：一次塞太多长图会被拦下并给出文字说明', async () => {
  const many = [];
  for (let i = 0; i < 10; i++) many.push({ type: 'image_url', image_url: { url: dataUrl(new Uint8Array(3)) } });
  const out = await splitRequestImages(bodyWith(many), {
    decoder: memoryDecoder(() => fakeImage(LONG.width, LONG.height)),
    options: { maxTiles: 5 }
  });
  const texts = out.messages[0].content.filter((p) => p.type === 'text').map((p) => p.text);
  assert.ok(texts.some((t) => /超过 5|分批/.test(t)), '应出现"分批查看"的提示');
});

test('原始 body 不被就地修改', async () => {
  const original = bodyWith([{ type: 'image_url', image_url: { url: dataUrl(new Uint8Array(3)) } }]);
  const snapshot = JSON.stringify(original);
  await splitRequestImages(original, { decoder: memoryDecoder(() => fakeImage(LONG.width, LONG.height)) });
  assert.equal(JSON.stringify(original), snapshot);
});

test('没有 content 数组的消息原样保留', async () => {
  const body = { messages: [{ role: 'assistant', content: '纯文本' }, { role: 'tool' }] };
  const out = await splitRequestImages(body, { decoder });
  assert.deepEqual(out.messages, body.messages);
});

test('日志会说明分段了几张、当前请求共几张图', async () => {
  const lines = [];
  await splitRequestImages(
    bodyWith([{ type: 'image_url', image_url: { url: dataUrl(new Uint8Array(3)) } }]),
    { decoder: memoryDecoder(() => fakeImage(LONG.width, LONG.height)), log: (m) => lines.push(m) }
  );
  assert.ok(lines.some((l) => l.includes('已分段 1 张长图')));
});

test('自定义说明文字（preamble）会被采用', async () => {
  const out = await splitRequestImages(
    bodyWith([{ type: 'image_url', image_url: { url: dataUrl(new Uint8Array(3)) } }]),
    {
      decoder: memoryDecoder(() => fakeImage(LONG.width, LONG.height)),
      options: { preamble: ({ count }) => `SPLIT:${count}` }
    }
  );
  assert.ok(out.messages[0].content.some((p) => p.text === 'SPLIT:3'));
});

// ── wouldSplit ──────────────────────────────────────────────────────
test('wouldSplit 与实际分段判断保持一致', () => {
  assert.equal(wouldSplit(900, 4200), true);
  assert.equal(wouldSplit(900, 600), false);
  assert.equal(wouldSplit(3000, 8000), false);
  assert.equal(wouldSplit(0, 0), false);
});
