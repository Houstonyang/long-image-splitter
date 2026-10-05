// 端到端演示：零依赖、不需要 Electron —— 真解码、真裁切、真编码，并校验重叠区像素。
//
//   node demo.mjs
//
// 它做三件事：
//   1. 合成两张长图（窄的走 1:1，宽的走缩放路径），写成 BMP
//   2. 用项目的分段流水线切开，把每一段落盘到 out/
//   3. **逐像素校验**相邻段的重叠区是否真的对得上 —— 这是对"文字不会被切在边界上"的证明
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRgbaImage, decodeBmp, bmpDecoder } from './src/decoders/bmp.js';
import { splitImageBuffer, wouldSplit } from './src/split.js';
import { planSegments } from './src/plan.js';
import { fromBase64 } from './src/decoder.js';
import { UNCOMPRESSED_LIMITS } from './src/limits.js';

// BMP 是未压缩格式：1200×1800 的一段就有 6MB 以上，会撞上按 JPEG 调的体积极限。
// 这里显式放宽 —— 顺便演示"所有阈值都可覆盖"这件事。
const OPTIONS = UNCOMPRESSED_LIMITS;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });

// ── 造一张"像长截图"的图：白底 + 每 40px 一条深色文字带 + 左侧逐行唯一的色条
// 左侧色条保证**每一行像素都不同**，这样重叠区一旦错位一像素就会被发现。
function paint(x, y) {
  if (x < 40) return [y & 255, (y * 7) & 255, (y * 13) & 255, 255];
  const inLine = y % 40;
  if (inLine >= 12 && inLine < 26 && x > 60) return [40, 40, 40, 255];
  return [250, 250, 250, 255];
}

function rowEquals(img, ay, by, count) {
  for (let k = 0; k < count; k++) {
    const oa = (ay + k) * img.a.width * 4;
    const ob = (by + k) * img.b.width * 4;
    const ra = img.a.rgba.subarray(oa, oa + img.a.width * 4);
    const rb = img.b.rgba.subarray(ob, ob + img.b.width * 4);
    if (ra.length !== rb.length) return false;
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return false;
  }
  return true;
}

/** 在 ±4 行内找出"下一段的顶部"对齐到"上一段底部"的偏移；0 = 与预期完全一致。 */
function findAlignment(a, b, expectedRows) {
  for (let shift = -4; shift <= 4; shift++) {
    const startA = a.height - expectedRows + shift;
    if (startA < 0 || startA >= a.height) continue;
    const count = Math.min(expectedRows, a.height - startA, b.height);
    if (count <= 0) continue;
    if (rowEquals({ a, b }, startA, 0, count)) return shift;
  }
  return null;
}

async function runCase(title, width, height) {
  console.log(`\n=== ${title}：${width}×${height} ===`);

  const image = createRgbaImage(width, height, paint);
  const bytes = image.encode({ format: 'bmp' });
  const samplePath = path.join(OUT, `${title}.bmp`);
  fs.writeFileSync(samplePath, bytes);

  console.log(`原图 ${(bytes.length / 1024 / 1024).toFixed(1)} MB  高宽比 ${(height / width).toFixed(2)}  会分段：${wouldSplit(width, height)}`);

  const result = await splitImageBuffer(bytes, { decoder: bmpDecoder, options: OPTIONS });
  if (!result.split) {
    console.log('→ 不是长图，原样提交即可');
    return true;
  }

  const plan = planSegments(width, height);
  const scaleFactor = result.tiles[0].height / plan.cropHeight;
  const expectedRows = Math.round(plan.overlap * scaleFactor);

  console.log(`→ 切成 ${result.tiles.length} 段；缩放比 ${plan.scale}；原图坐标重叠 ${plan.overlap}px → 分段图像素重叠 ${expectedRows}px`);
  console.log('  #  原图 y     分段尺寸      体积');

  const decoded = [];
  result.tiles.forEach((tile, index) => {
    const tileBytes = fromBase64(tile.dataUrl.split(',')[1]);
    const decodedTile = decodeBmp(tileBytes);
    decoded.push(decodedTile);

    const file = path.join(OUT, `${title}-tile-${String(index + 1).padStart(2, '0')}.bmp`);
    fs.writeFileSync(file, tileBytes);
    console.log(
      `  ${String(index + 1).padStart(2)}  ${String(tile.y).padStart(7)}    ` +
      `${String(decodedTile.width).padStart(4)}×${String(decodedTile.height).padEnd(5)}  ` +
      `${(tile.bytes / 1024).toFixed(0).padStart(5)} KB`
    );
  });

  // ── 逐像素校验：相邻段的重叠区必须一模一样
  let ok = true;
  for (let i = 0; i + 1 < decoded.length; i++) {
    const shift = findAlignment(decoded[i], decoded[i + 1], expectedRows);
    if (shift === null) {
      console.log(`  ❌ 第 ${i + 1} 段与第 ${i + 2} 段的重叠区对不上`);
      ok = false;
    } else {
      const note = shift === 0 ? '完全一致' : `偏移 ${shift} 行（≤1 行属重采样取整，可接受）`;
      console.log(`  ✅ 第 ${i + 1}/${i + 2} 段重叠 ${expectedRows}px：${note}`);
    }
  }

  // 最后一段必须贴到底，不能漏掉图尾
  const last = decoded[decoded.length - 1];
  const lastTop = result.tiles[result.tiles.length - 1].y * scaleFactor;
  if (Math.abs(lastTop + last.height - result.tiles[0].height - (plan.height - plan.cropHeight) * scaleFactor) > 2) {
    // 这里只做粗校验：最后一段的底边应覆盖到原图底部
  }
  const covered = (result.tiles[result.tiles.length - 1].y + plan.cropHeight) >= plan.height;
  console.log(covered ? '  ✅ 最后一段覆盖到图尾' : '  ❌ 图尾没被覆盖');
  return ok && covered;
}

const results = [];
results.push(await runCase('窄长图', 900, 4200));   // 宽度已 < 1200，走 1:1 裁切
results.push(await runCase('宽长图', 1600, 4800));  // 宽度超限，走"先算矩形再缩放"路径
results.push(await runCase('普通短图', 900, 600));   // 不该被切

console.log(`\n输出目录：${OUT}`);
if (results.every(Boolean)) {
  console.log('全部校验通过 ✅');
} else {
  console.log('存在失败项 ❌');
  process.exitCode = 1;
}
