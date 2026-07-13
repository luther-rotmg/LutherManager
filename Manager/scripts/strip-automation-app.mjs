import fs from 'fs';

const p = new URL('../src/dev/public/app.js', import.meta.url);
let s = fs.readFileSync(p, 'utf8');

const startNeedle = '  //  AUTOMATION TAB  (Steps 3-13)';
const needleAt = s.indexOf(startNeedle);
const start = needleAt === -1 ? -1 : s.lastIndexOf('\n', needleAt - 1) + 1;
const endKeep = s.indexOf('  function handlePluginToggleError(msg) {');
if (start === -1 || endKeep === -1 || endKeep <= start) {
  console.error('markers', { start, endKeep });
  process.exit(1);
}

const inject = `  // --- Stubs after removal of visual automation (disk scripts: Scripts tab) ---
  var homeLastCompletedScript = { name: '', durationMs: 0, endedAt: 0, status: '' };
  var runnerState = 'idle';
  var selectedScriptId = null;
  function getScript() { return null; }
  function getHomeScriptRuntimeMs() { return 0; }
  function getHomeCurrentStatus() { return '--'; }
  function startRunner() {}
  function stopRunner() {}
  function pauseRunner() {}
  function updateTransportButtons() {}
  var automationInited = false;
  function populateScriptSelect() {
    var sel = document.getElementById('home-script-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">Use Scripts tab</option>';
    sel.value = '';
    sel.disabled = true;
  }

`;

const out = s.slice(0, start) + inject + s.slice(endKeep);
fs.writeFileSync(p, out);
console.log('strip-automation-app: wrote', out.length, 'bytes');
