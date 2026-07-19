import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PanelConfigInfo, PanelConfigScope } from '@luthermanager/sdk';

interface StoredPanelConfig extends PanelConfigInfo {
  version: 1;
  scriptId: string;
  scope: PanelConfigScope;
  accountId?: string;
  values: Record<string, unknown>;
}

function safeSegment(value: string): string {
  const source = String(value || '').trim() || 'default';
  const readable = source
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48) || 'config';
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 10);
  return `${readable}-${hash}`;
}

function defaultRoot(): string {
  return join(process.env.USERPROFILE || homedir(), 'Documents', 'Hive', 'ScriptConfigs');
}

export class ScriptPanelConfigStore {
  constructor(private readonly rootDir = defaultRoot()) {}

  private scopeDir(
    scriptId: string,
    scope: PanelConfigScope,
    accountId?: string,
  ): string {
    const scriptDir = join(this.rootDir, safeSegment(scriptId));
    return scope === 'account'
      ? join(scriptDir, 'accounts', safeSegment(accountId || 'unbound'))
      : join(scriptDir, 'global');
  }

  private configPath(
    scriptId: string,
    scope: PanelConfigScope,
    accountId: string | undefined,
    name: string,
  ): string {
    return join(this.scopeDir(scriptId, scope, accountId), `${safeSegment(name)}.json`);
  }

  load(
    scriptId: string,
    scope: PanelConfigScope,
    accountId: string | undefined,
    name: string,
  ): StoredPanelConfig | null {
    const path = this.configPath(scriptId, scope, accountId, name);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredPanelConfig>;
      if (parsed.version !== 1 || !parsed.values || typeof parsed.values !== 'object' || Array.isArray(parsed.values)) {
        return null;
      }
      return {
        version: 1,
        scriptId,
        scope,
        ...(scope === 'account' ? { accountId } : {}),
        name: String(parsed.name || name),
        updatedAt: Number(parsed.updatedAt) || 0,
        values: { ...parsed.values },
      };
    } catch {
      return null;
    }
  }

  save(
    scriptId: string,
    scope: PanelConfigScope,
    accountId: string | undefined,
    name: string,
    values: Record<string, unknown>,
  ): PanelConfigInfo {
    const normalizedName = String(name || '').trim() || 'default';
    const dir = this.scopeDir(scriptId, scope, accountId);
    const path = this.configPath(scriptId, scope, accountId, normalizedName);
    const updatedAt = Date.now();
    const record: StoredPanelConfig = {
      version: 1,
      scriptId,
      scope,
      ...(scope === 'account' ? { accountId } : {}),
      name: normalizedName,
      updatedAt,
      values,
    };
    mkdirSync(dir, { recursive: true });
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, serialized, 'utf8');
    try {
      renameSync(temporaryPath, path);
    } catch {
      writeFileSync(path, serialized, 'utf8');
      rmSync(temporaryPath, { force: true });
    }
    return { name: normalizedName, updatedAt };
  }

  delete(
    scriptId: string,
    scope: PanelConfigScope,
    accountId: string | undefined,
    name: string,
  ): boolean {
    const path = this.configPath(scriptId, scope, accountId, name);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  list(
    scriptId: string,
    scope: PanelConfigScope,
    accountId?: string,
  ): PanelConfigInfo[] {
    const dir = this.scopeDir(scriptId, scope, accountId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.toLowerCase().endsWith('.json'))
      .map((file) => {
        try {
          const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Partial<StoredPanelConfig>;
          const name = String(parsed.name || '').trim();
          return name ? { name, updatedAt: Number(parsed.updatedAt) || 0 } : null;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is PanelConfigInfo => entry !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
  }
}
