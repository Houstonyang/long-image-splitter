// 兜底与降级单测：重点是"什么错误该管、什么错误不该管"。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  unavailablePart,
  stripRejectedImages,
  looksLikeImageRejection,
  REJECTION_PATTERN,
  DEGRADED_NOTICE
} from '../src/fallback.js';

const body = () => ({
  model: 'm',
  messages: [
    { role: 'system', content: '人设' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '看这个' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }
      ]
    }
  ]
});

const errorWith = (message) => JSON.stringify({ error: { message } });

test('unavailablePart 的措辞包含三段意思：读不到 / 不许猜 / 可行替代', () => {
  const part = unavailablePart('图片无法解码');
  assert.equal(part.type, 'text');
  assert.match(part.text, /图片无法处理：图片无法解码/);
  assert.match(part.text, /不要猜测图片内容/);
  assert.match(part.text, /分开发送较短截图/);
});

test('接口说"不支持这种图片"时给出降级建议', () => {
  const result = stripRejectedImages({ body: body(), errorText: errorWith('unsupported image format'), status: 400 });
  assert.ok(result);
  assert.match(result.reason, /去掉图片重试文字回复/);
  const parts = result.body.messages[1].content;
  assert.equal(parts.filter((p) => p.type === 'image_url').length, 0, '图片必须全部去掉');
  assert.equal(parts.filter((p) => p.type === 'text').length, 2, '原来的文字要留下，另加一条说明');
  assert.match(parts[1].text, new RegExp(DEGRADED_NOTICE.slice(0, 10)));
});

test('普通 400（Key 无效 / 模型名写错）不该被当成图片问题重试', () => {
  const cases = [
    'Invalid API key',
    'The model `gpt-nope` does not exist',
    'invalid request: temperature out of range',
    'context length exceeded'
  ];
  for (const message of cases) {
    assert.equal(stripRejectedImages({ body: body(), errorText: errorWith(message), status: 400 }), null, message);
  }
});

test('非 400/422 的状态码一律不降级', () => {
  for (const status of [401, 403, 429, 500, 503]) {
    assert.equal(
      stripRejectedImages({ body: body(), errorText: errorWith('unsupported image format'), status }),
      null,
      `status ${status}`
    );
  }
});

test('响应不是 JSON 时安全返回 null，不抛错', () => {
  assert.equal(stripRejectedImages({ body: body(), errorText: '<html>502</html>', status: 400 }), null);
  assert.equal(stripRejectedImages({ body: body(), errorText: '', status: 400 }), null);
});

test('请求里本来就没有图片时返回 null（没什么可去掉的）', () => {
  const noImage = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
  assert.equal(stripRejectedImages({ body: noImage, errorText: errorWith('unsupported image'), status: 400 }), null);
});

test('拒收特征覆盖常见的几种说法', () => {
  const samples = [
    'unsupported image',
    'invalid image',
    'image format is not supported',
    'image type not supported',
    'failed to decode image',
    'could not process image'
  ];
  for (const s of samples) {
    assert.ok(REJECTION_PATTERN.test(s), s);
    assert.equal(looksLikeImageRejection(errorWith(s)), true, s);
  }
});

test('可以自定义拒收特征（例如某个网关的特殊文案）', () => {
  const custom = /图片格式不支持/;
  const result = stripRejectedImages({
    body: body(),
    errorText: errorWith('图片格式不支持'),
    status: 400,
    pattern: custom
  });
  assert.ok(result);
});

test('可以自定义触发降级的状态码（例如把 415 也算上）', () => {
  const args = { body: body(), errorText: errorWith('unsupported image'), status: 415 };
  assert.equal(stripRejectedImages(args), null, '默认不含 415');
  assert.ok(stripRejectedImages({ ...args, statuses: [400, 415, 422] }), '显式传入后应生效');
});

test('只返回建议、不自己发请求：返回结构里没有 fetch / 副作用字段', () => {
  const result = stripRejectedImages({ body: body(), errorText: errorWith('unsupported image'), status: 422 });
  assert.deepEqual(Object.keys(result).sort(), ['body', 'reason']);
});

test('原始 body 不被就地修改', () => {
  const original = body();
  const snapshot = JSON.stringify(original);
  stripRejectedImages({ body: original, errorText: errorWith('unsupported image'), status: 400 });
  assert.equal(JSON.stringify(original), snapshot);
});
