import { appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const LOG_FILE = join(tmpdir(), 'realm-engine-proxy.log');
function fileLog(line: string): void {
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

/**
 * Simple formatted console logger.
 */
export class Logger {
  private static readonly packetDebugEnabled =
    process.env.PROXY_PACKET_DEBUG === '1'
    || process.env.PROXY_PACKET_DEBUG === 'true';

  static isPacketDebugEnabled(): boolean {
    return Logger.packetDebugEnabled;
  }

  static log(module: string, message: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] [${module}] ${message}`;
    console.log(line);
    fileLog(line);
  }

  static warn(module: string, message: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] [${module}] WARN: ${message}`;
    console.warn(line);
    fileLog(line);
  }

  static error(module: string, message: string, err?: Error): void {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] [${module}] ERROR: ${message}`;
    console.error(line);
    if (err?.stack) console.error(err.stack);
    fileLog(line + (err?.stack ? '\n' + err.stack : ''));
  }
}
