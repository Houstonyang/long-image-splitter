// 跨 Node 版本都可靠的单测入口。
//
// 为什么不直接在 package.json 里写 `node --test test/`：
//   · Node 18~20：`--test <目录>` 可用
//   · Node 22+ ：位置参数被当作 **glob**，裸目录不再匹配，会报 MODULE_NOT_FOUND
// 这里自己枚举出测试文件再显式传给 --test，任何版本行为一致；
// 而且新增测试文件不用回来改配置。
//
// stdio 用 inherit 而不是 pipe：让子进程直接继承终端的颜色与实时输出。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

const files = fs
  .readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(TEST_DIR, name));

if (!files.length) {
  console.error(`没有在 ${TEST_DIR} 找到任何 *.test.js`);
  process.exit(1);
}

console.log(`运行 ${files.length} 个测试文件：${files.map((f) => path.basename(f)).join(', ')}\n`);

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: ROOT
});

if (result.error) {
  console.error('无法启动测试进程：', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
