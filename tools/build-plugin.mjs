// 同步两份产物：
//   1. hosts/qq-agent/lib/      —— src/ 的副本，让插件目录自包含
//   2. dist/long-image-splitter/ —— **可以直接整个拷进 QQ Agent 的成品目录**
//
// 为什么需要 dist：QQ Agent 是在 `plugins/<目录名>/` 这一层找 plugin.json 的。
// 直接把项目根目录拷进去（里面还有 src/ test/ README.md…）会导致清单找不到，
// 控制台报"缺少 skill.json / plugin.json"、版本显示 0.0.0。dist 就是为了消灭这个坑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const HOST = path.join(ROOT, 'hosts', 'qq-agent');
const DIST_NAME = 'long-image-splitter';
const DIST = path.join(ROOT, 'dist', DIST_NAME);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

const count = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);

// 1) 插件自包含副本
fs.rmSync(path.join(HOST, 'lib'), { recursive: true, force: true });
copyDir(SRC, path.join(HOST, 'lib'));
console.log(`已同步插件副本：src/ -> hosts/qq-agent/lib/（${count(path.join(HOST, 'lib'))} 个文件）`);

// 2) 可直接拷贝的成品目录
const manifest = JSON.parse(fs.readFileSync(path.join(HOST, 'plugin.json'), 'utf8'));
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
fs.copyFileSync(path.join(HOST, 'plugin.json'), path.join(DIST, 'plugin.json'));
fs.copyFileSync(path.join(HOST, 'index.js'), path.join(DIST, 'index.js'));
copyDir(SRC, path.join(DIST, 'lib'));

// 自检：清单必须就在这一层，且入口存在 —— 放错层级是这套插件体系最常见的坑
const problems = [];
if (!fs.existsSync(path.join(DIST, 'plugin.json'))) problems.push('plugin.json 不在根层');
if (!fs.existsSync(path.join(DIST, 'index.js'))) problems.push('index.js 不在根层');
if (!fs.existsSync(path.join(DIST, 'lib', 'index.js'))) problems.push('lib/ 不完整');

console.log(`已生成可直接拷贝的插件目录：dist/${DIST_NAME}/（${count(DIST)} 个文件）`);
console.log(`  清单：${manifest.id} v${manifest.version}（apiVersion ${manifest.apiVersion}）`);
console.log('');
console.log('安装：把 dist/long-image-splitter 整个拷到');
console.log('  <QQ Agent>\\resources\\app\\plugins\\long-image-splitter');
console.log('（拷的是这个目录本身；拷完该目录下应直接看到 plugin.json / index.js / lib）');

if (problems.length) {
  console.error('\n❌ 产物自检未通过：' + problems.join('；'));
  process.exit(1);
}
