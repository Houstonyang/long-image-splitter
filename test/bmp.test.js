// 纯 JS BMP 编解码器单测 —— 它是本项目"零依赖也能端到端跑通"的底气所在。
import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeBmp, decodeBmp, createRgbaImage, pixelAt, bmpDecoder, memoryDecoder } from '../src/decoders/bmp.js';

const paint = (x, y) => [(x * 9) & 255, (y * 5) & 255, (x + y) & 255, 255];

test('24 位 BMP 编解码可逆（宽度取奇数以覆盖行对齐补位）', () => {
  const image = createRgbaImage(7, 5, paint);
  const bytes = encodeBmp({ width: 7, height: 5, rgba: image.bytes });
  assert.equal(bytes[0], 0x42); // 'B'
  assert.equal(bytes[1], 0x4d); // 'M'

  const decoded = decodeBmp(bytes);
  assert.equal(decoded.width, 7);
  assert.equal(decoded.height, 5);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 7; x++) {
      const [r, g, b] = pixelAt(decoded, x, y);
      assert.deepEqual([r, g, b], [(x * 9) & 255, (y * 5) & 255, (x + y) & 255], `(${x},${y})`);
    }
  }
});

test('能读自下而上和自上而下两种 BMP', () => {
  const image = createRgbaImage(3, 3, (x, y) => [x * 40, y * 40, 0, 255]);

  const bottomUp = encodeBmp({ width: 3, height: 3, rgba: image.bytes });
  const a = decodeBmp(bottomUp);
  assert.deepEqual(pixelAt(a, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixelAt(a, 2, 2), [80, 80, 0, 255]);

  // 把高度改成负数 = 声明"自上而下"。同一份数据应当被解读成上下镜像 ——
  // 这正好证明解码器真的读了高度符号，而不是永远按自下而上处理。
  const topDown = bottomUp.slice();
  new DataView(topDown.buffer).setInt32(22, -3, true);
  const b = decodeBmp(topDown);
  assert.deepEqual(pixelAt(b, 0, 0), [0, 80, 0, 255], '原图最下面一行应当出现在最上面');
  assert.deepEqual(pixelAt(b, 2, 2), [80, 0, 0, 255], '原图最上面一行应当出现在最下面');
  assert.deepEqual(pixelAt(b, 0, 2), [0, 0, 0, 255], '中间行不受影响');
});

test('能读 32 位 BMP（带 alpha 通道）', () => {
  // 手工拼一个 2×2 的 32 位自上而下 BMP
  const rowSize = 2 * 4;
  const bytes = new Uint8Array(54 + rowSize * 2);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x42; bytes[1] = 0x4d;
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, 2, true);
  view.setInt32(22, -2, true); // 负数 = 自上而下
  view.setUint16(26, 1, true);
  view.setUint16(28, 32, true);
  view.setUint32(30, 0, true);
  // 第 0 行：(10,20,30,255) (40,50,60,128)
  bytes.set([30, 20, 10, 255, 60, 50, 40, 128], 54);
  // 第 1 行：(70,80,90,255) (100,110,120,255)
  bytes.set([90, 80, 70, 255, 120, 110, 100, 255], 54 + rowSize);

  const decoded = decodeBmp(bytes);
  assert.deepEqual(pixelAt(decoded, 0, 0), [10, 20, 30, 255]);
  assert.deepEqual(pixelAt(decoded, 1, 0), [40, 50, 60, 128]);
  assert.deepEqual(pixelAt(decoded, 1, 1), [100, 110, 120, 255]);
});

test('非 BMP 文件被拒绝', () => {
  assert.throws(() => decodeBmp(new Uint8Array([1, 2, 3, 4])), /不是 BMP/);
});

test('压缩过的 BMP 被明确拒绝（而不是静默解出错图）', () => {
  const image = createRgbaImage(2, 2, paint);
  const bytes = encodeBmp({ width: 2, height: 2, rgba: image.bytes });
  new DataView(bytes.buffer).setUint32(30, 1, true); // BI_RLE8
  assert.throws(() => decodeBmp(bytes), /未压缩/);
});

test('不支持的位深被拒绝', () => {
  const image = createRgbaImage(2, 2, paint);
  const bytes = encodeBmp({ width: 2, height: 2, rgba: image.bytes });
  new DataView(bytes.buffer).setUint16(28, 8, true);
  assert.throws(() => decodeBmp(bytes), /只支持 24\/32 位/);
});

test('裁切取的是正确区域', () => {
  const image = createRgbaImage(10, 10, (x, y) => [x * 10, y * 10, 0, 255]);
  const cropped = image.crop({ x: 2, y: 3, width: 4, height: 5 });
  assert.equal(cropped.width, 4);
  assert.equal(cropped.height, 5);
  assert.deepEqual(pixelAt({ width: 4, rgba: cropped.bytes }, 0, 0), [20, 30, 0, 255]);
  assert.deepEqual(pixelAt({ width: 4, rgba: cropped.bytes }, 3, 4), [50, 70, 0, 255]);
});

test('裁切越界会报错而不是返回空图', () => {
  const image = createRgbaImage(4, 4, paint);
  assert.throws(() => image.crop({ x: 10, y: 10, width: 4, height: 4 }), /超出图片范围/);
});

test('缩放按宽度等比，且高度至少 1 像素', () => {
  const image = createRgbaImage(200, 300, paint);
  const small = image.resize({ width: 50 });
  assert.equal(small.width, 50);
  assert.equal(small.height, 75);

  const flat = createRgbaImage(200, 1, paint).resize({ width: 10 });
  assert.equal(flat.height, 1);
});

test('缩放采样落在正确位置（最近邻）', () => {
  const image = createRgbaImage(4, 4, (x, y) => [x * 60, y * 60, 0, 255]);
  const half = image.resize({ width: 2 });
  assert.deepEqual(pixelAt({ width: 2, rgba: half.bytes }, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixelAt({ width: 2, rgba: half.bytes }, 1, 1), [120, 120, 0, 255]);
});

test('只支持编码 bmp，其它格式明确报错', () => {
  const image = createRgbaImage(2, 2, paint);
  assert.throws(() => image.encode({ format: 'jpeg' }), /只能编码 bmp/);
});

test('bmpDecoder 走的是真实的字节解码路径', () => {
  const image = createRgbaImage(5, 4, paint);
  const decoded = bmpDecoder.decode(encodeBmp({ width: 5, height: 4, rgba: image.bytes }));
  assert.equal(decoded.width, 5);
  assert.equal(decoded.height, 4);
  assert.equal(bmpDecoder.available(), true);
  assert.deepEqual(bmpDecoder.formats, ['bmp']);
});

test('memoryDecoder 可以把任意造图函数包成解码器（测试注入用）', () => {
  const decoder = memoryDecoder((bytes) => createRgbaImage(bytes.length, 1, () => [1, 2, 3, 255]));
  const image = decoder.decode(new Uint8Array(9));
  assert.equal(image.width, 9);
});
