import fs from 'fs';

const p = new URL('../src/dev/public/style.css', import.meta.url);
const s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('/* ===== AUTOMATION TAB ===== */');
const endNeedle = '#item-detail-overlay {';
const end = s.indexOf(endNeedle, start === -1 ? 0 : start);
if (start === -1 || end === -1 || end <= start) {
  console.error('css markers', { start, end });
  process.exit(1);
}
const inject = `
/* ===== SCRIPTS TAB (disk .js via ScriptHost) ===== */
.scripts-toolbar {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}
.scripts-dir-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.scripts-dir-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.scripts-dir-display {
  font-size: 11px;
  color: var(--text-dim);
  word-break: break-all;
  line-height: 1.35;
}
.scripts-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.scripts-row-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.scripts-row-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.scripts-row-actions {
  display: flex;
  gap: 8px;
}
.scripts-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
}
.scripts-badge-idle {
  color: var(--text-muted);
  background: var(--bg-subtle);
}
.scripts-badge-running {
  color: #b6f5c8;
  border-color: rgba(96, 224, 160, 0.45);
  background: rgba(46, 160, 112, 0.15);
}
.scripts-log-output {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 12px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
  color: var(--text);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
.plugin-sidebar-empty {
  padding: 16px 12px;
  font-size: 12px;
  color: var(--text-muted);
}

`;
const out = s.slice(0, start) + inject + s.slice(end);
fs.writeFileSync(p, out);
console.log('strip-automation-css: ok', out.length);
