'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');

function id() {
  return crypto.randomBytes(6).toString('hex');
}

function normalizePath(v) {
  return path.resolve(String(v || '').trim());
}

class InstanceManager extends EventEmitter {
  constructor(windowHostBridge) {
    super();
    this.windowHostBridge = windowHostBridge;
    this.instances = new Map(); // instanceId -> record
    this.maxInstances = 20;
  }

  list() {
    return Array.from(this.instances.values()).map((i) => ({
      instanceId: i.instanceId,
      pid: i.pid,
      executablePath: i.executablePath,
      args: i.args,
      status: i.status,
      startedAt: i.startedAt,
      exitedAt: i.exitedAt,
      exitCode: i.exitCode,
      attachedSlotId: i.attachedSlotId || null,
      hwnd: i.hwnd || null,
      title: i.title || '',
      processName: i.processName || '',
    }));
  }

  async launch({ executablePath, args = [], cwd, env = {} }) {
    if (this.instances.size >= this.maxInstances) {
      throw new Error(`Max instances reached (${this.maxInstances})`);
    }
    const exe = normalizePath(executablePath);
    const spawnArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];
    const child = spawn(exe, spawnArgs, {
      cwd: cwd ? normalizePath(cwd) : path.dirname(exe),
      env: { ...process.env, ...env },
      detached: false,
      windowsHide: false,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const instanceId = id();
    const record = {
      instanceId,
      executablePath: exe,
      args: spawnArgs,
      pid: child.pid || 0,
      child,
      status: 'running',
      startedAt: Date.now(),
      exitedAt: null,
      exitCode: null,
      attachedSlotId: null,
      hwnd: null,
      title: '',
      processName: path.basename(exe),
    };
    this.instances.set(instanceId, record);
    this.emit('update', this.list());

    child.on('exit', (code) => {
      record.status = 'exited';
      record.exitedAt = Date.now();
      record.exitCode = code;
      this.emit('update', this.list());
    });

    return { instanceId, pid: record.pid };
  }

  async stop(instanceId) {
    const r = this.instances.get(String(instanceId));
    if (!r) return { ok: false, reason: 'not-found' };
    if (r.status === 'exited') return { ok: true };
    try {
      if (r.child && typeof r.child.kill === 'function') {
        r.child.kill();
      } else if (r.pid) {
        process.kill(Number(r.pid));
      } else {
        return { ok: false, reason: 'no-process-handle' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err && err.message) || 'kill-failed' };
    }
  }

  async trackByPid({ pid, executablePath = '', processName = '', title = '' }) {
    const pidNum = Number(pid);
    if (!Number.isFinite(pidNum) || pidNum <= 0) {
      return { ok: false, reason: 'invalid-pid' };
    }
    for (const existing of this.instances.values()) {
      if (Number(existing.pid) === pidNum) {
        return { ok: true, instanceId: existing.instanceId, existing: true };
      }
    }
    const windows = await this.windowHostBridge.listTopLevelWindows();
    const win = windows.find((w) => Number(w.pid) === pidNum);
    if (!win) return { ok: false, reason: 'window-not-found' };

    const instanceId = id();
    const record = {
      instanceId,
      executablePath: executablePath ? normalizePath(executablePath) : '',
      args: [],
      pid: pidNum,
      child: null,
      status: 'running',
      startedAt: Date.now(),
      exitedAt: null,
      exitCode: null,
      attachedSlotId: null,
      hwnd: win.hwnd || null,
      title: String(title || win.title || ''),
      processName: String(processName || win.processName || ''),
    };
    this.instances.set(instanceId, record);
    this.emit('update', this.list());
    return { ok: true, instanceId, pid: pidNum };
  }

  async discoverWindow(instanceId) {
    const r = this.instances.get(String(instanceId));
    if (!r) return { ok: false, reason: 'not-found' };
    const windows = await this.windowHostBridge.listTopLevelWindows();
    const win = windows.find((w) => Number(w.pid) === Number(r.pid));
    if (!win) return { ok: false, reason: 'window-not-found' };
    r.hwnd = win.hwnd;
    r.title = win.title;
    r.processName = win.processName;
    this.emit('update', this.list());
    return { ok: true, window: win };
  }

  async attach({ instanceId, slotId, hostHwnd }) {
    const r = this.instances.get(String(instanceId));
    if (!r) return { ok: false, reason: 'not-found' };
    if (!r.hwnd) {
      const found = await this.discoverWindow(instanceId);
      if (!found.ok) return found;
    }
    const attached = await this.windowHostBridge.attachWindow({
      slotId,
      targetHwnd: r.hwnd,
      hostHwnd,
      pid: r.pid,
    });
    if (!attached.ok) return attached;
    r.attachedSlotId = String(slotId);
    this.emit('update', this.list());
    return { ok: true };
  }

  async detach(slotId) {
    const res = await this.windowHostBridge.detachWindow(slotId);
    for (const r of this.instances.values()) {
      if (r.attachedSlotId === String(slotId)) r.attachedSlotId = null;
    }
    this.emit('update', this.list());
    return res;
  }

  async focus(instanceId) {
    const r = this.instances.get(String(instanceId));
    if (!r) return { ok: false, reason: 'not-found' };
    if (!r.hwnd) {
      const found = await this.discoverWindow(instanceId);
      if (!found.ok) return found;
    }
    return this.windowHostBridge.focusWindow(r.hwnd);
  }

  async resizeSlot(slotId, bounds) {
    return this.windowHostBridge.resizeAttachedWindow(slotId, bounds);
  }
}

module.exports = {
  InstanceManager,
};
