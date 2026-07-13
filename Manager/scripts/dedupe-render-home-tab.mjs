import fs from 'fs';

const p = new URL('../src/dev/public/app.js', import.meta.url);
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);

const needle = '  function renderHomeTab() {';
const idxs = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i] === needle) idxs.push(i);
}
if (idxs.length !== 2) {
  console.error('expected 2 renderHomeTab, got', idxs.length);
  process.exit(1);
}
const a = idxs[0];
const b = idxs[1];
// Remove second function (from line b through line before "// WebSocket connection")
let end = b;
while (end < lines.length && lines[end].trim() !== '// WebSocket connection') end++;
if (end >= lines.length) {
  console.error('no WebSocket marker');
  process.exit(1);
}
const out = [...lines.slice(0, b), ...lines.slice(end)];
fs.writeFileSync(p, out.join('\n'));
console.log('removed lines', b, 'to', end - 1);
