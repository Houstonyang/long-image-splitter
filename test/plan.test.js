// 分段数学的单测：这是"文字会不会被切在边界上"的唯一决定因素，必须覆盖到边界。
import test from 'node:test';
import assert from 'node:assert/strict';

import { planSegments, planTiles, overlapsOf } from '../src/plan.js';

test('不是长图就不分段（高度不够）', () => {
  const plan = planSegments(800, 2000);
  assert.equal(plan.split, false);
  assert.deepEqual(plan.tiles, []);
});

test('不是长图就不分段（高宽比不够）', () => {
  // 高度远超 2048，但太宽：8000/3000 = 2.67 < 3，整张缩小损失可接受，不值得切
  const plan = planSegments(3000, 8000);
  assert.equal(plan.split, false);
  assert.deepEqual(plan.tiles, []);
});

test('高宽比 3 是含端点的阈值', () => {
  assert.equal(planSegments(1000, 3000).split, true, '高宽比正好 3 应当分段');
  assert.equal(planSegments(1000, 2999).split, false, '高宽比略小于 3 不分段');
});

test('高度 2048 是含端点的阈值', () => {
  assert.equal(planSegments(100, 2049).split, true, '超过 2048 才分段');
  assert.equal(planSegments(100, 2048).split, false, '等于 2048 不分段');
});

test('默认参数下的分段几何：宽 1200 上限、高 1800 上限、重叠 120', () => {
  const plan = planSegments(1200, 6000);
  assert.equal(plan.scale, 1);
  assert.equal(plan.cropHeight, 1800);
  assert.equal(plan.overlap, 120);
  assert.equal(plan.step, 1680);
  assert.equal(plan.count, 4); // 1 + ceil((6000-1800)/1680) = 1 + 3
  for (const tile of plan.tiles) {
    assert.equal(tile.x, 0);
    assert.equal(tile.width, 1200);
    assert.ok(tile.height <= 1800);
  }
});

test('窄图不放大：宽度小于上限时 1:1 处理', () => {
  const plan = planSegments(600, 4000);
  assert.equal(plan.scale, 1);
  assert.equal(plan.cropHeight, 1800);
  assert.equal(plan.overlap, 120);
});

test('宽图先缩后裁：重叠按缩放比折算回原图坐标', () => {
  const plan = planSegments(2400, 12000);
  assert.equal(plan.scale, 0.5);
  assert.equal(plan.cropHeight, 3600);       // 1800 / 0.5
  assert.equal(plan.overlap, 240);           // 120 / 0.5
  assert.equal(plan.step, 3360);
  // 折算回缩放后的图，重叠应当还是 120
  assert.equal(plan.overlap * plan.scale, 120);
});

test('相邻段的重叠量恒定且等于 overlap', () => {
  const plan = planSegments(1000, 12000);
  const overlaps = overlapsOf(plan);
  assert.equal(overlaps.length, plan.tiles.length - 1);
  for (const o of overlaps) assert.equal(o.height, plan.overlap);
});

test('最后一段贴底，不越界', () => {
  const plan = planSegments(1000, 5000);
  const last = plan.tiles[plan.tiles.length - 1];
  assert.equal(last.y + last.height, 5000);
  assert.ok(last.height > 0 && last.height <= plan.cropHeight);
});

test('每一段都从 x=0 开始且宽度等于原图宽', () => {
  const plan = planSegments(1500, 9000);
  for (const tile of plan.tiles) {
    assert.equal(tile.x, 0);
    assert.equal(tile.width, 1500);
  }
});

test('y 严格递增，且步长等于 step', () => {
  const plan = planSegments(900, 7000);
  for (let i = 1; i < plan.tiles.length; i++) {
    assert.equal(plan.tiles[i].y - plan.tiles[i - 1].y, plan.step);
  }
});

test('段数超上限直接报错，而不是默默截断', () => {
  assert.throws(
    () => planSegments(100, 100000),
    (error) => error.code === 'TOO_MANY_TILES'
  );
});

test('像素总量超限直接报错', () => {
  assert.throws(
    () => planSegments(20000, 20000), // 4 亿像素
    (error) => error.code === 'TOO_MANY_PIXELS'
  );
});

test('非法尺寸报错', () => {
  for (const args of [[0, 100], [-1, 100], [1.5, 100], [100, 0]]) {
    assert.throws(() => planSegments(...args), (error) => error.code === 'INVALID_SIZE');
  }
});

test('阈值可覆盖：把 minAspect 调成 2 之后，原本不分段的图会分段', () => {
  assert.equal(planSegments(1000, 2500).split, false);
  assert.equal(planSegments(1000, 2500, { minAspect: 2 }).split, true);
});

test('阈值可覆盖：自定义重叠像素', () => {
  const plan = planSegments(1000, 6000, { overlap: 300 });
  assert.equal(plan.overlap, 300);
  assert.equal(plan.step, plan.cropHeight - 300);
  for (const o of overlapsOf(plan)) assert.equal(o.height, 300);
});

test('错误的参数组合（重叠大于单段高度）报错而不是死循环', () => {
  assert.throws(
    () => planSegments(1000, 6000, { overlap: 5000, maxTileHeight: 1800 }),
    (error) => error.code === 'INVALID_OPTIONS'
  );
});

test('planTiles 是 planSegments().tiles 的简写', () => {
  assert.deepEqual(planTiles(900, 4200), planSegments(900, 4200).tiles);
});

test('文案可整体替换成别的语言', () => {
  assert.throws(
    () => planSegments(100, 100000, { messages: { tooManyTiles: 'too many tiles' } }),
    (error) => error.message === 'too many tiles'
  );
});
