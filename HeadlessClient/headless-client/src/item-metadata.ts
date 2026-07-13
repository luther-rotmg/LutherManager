import * as fs from 'fs';
import * as path from 'path';

export interface ItemInfo {
  id: number;
  name: string;
  displayName?: string;
  className?: string;
  source: string;
}

export interface ItemRef {
  id: number;
  name?: string;
  displayName?: string;
  className?: string;
}

export class ItemCatalog {
  constructor(private readonly byId: Map<number, ItemInfo>) {}

  get size(): number {
    return this.byId.size;
  }

  ref(id: number): ItemRef {
    const item = this.byId.get(id);
    return item ? { id, name: item.name, displayName: item.displayName, className: item.className } : { id };
  }

  name(id: number): string | undefined {
    return this.byId.get(id)?.name;
  }
}

/**
 * Loads RotMG XML object metadata when available. Set ROTMG_XML_DIR to one or
 * more asset directories; otherwise common extractor output locations are
 * discovered relative to the workspace.
 */
export function loadItemCatalog(cwd = process.cwd()): ItemCatalog {
  const files = discoverXmlFiles(cwd);
  const byId = new Map<number, ItemInfo>();
  for (const file of files) {
    parseObjects(file, byId);
  }
  if (byId.size > 0) {
    console.log(`item metadata loaded: ${byId.size} object id(s) from ${files.length} xml file(s)`);
  } else {
    console.warn('item metadata unavailable - set ROTMG_XML_DIR to the extracted TextAsset xml directory');
  }
  return new ItemCatalog(byId);
}

function discoverXmlFiles(cwd: string): string[] {
  const envDirs = (process.env.ROTMG_XML_DIR ?? '')
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);
  const candidates = [
    ...envDirs,
    path.resolve(cwd, 'xml'),
    path.resolve(cwd, 'data/xml'),
    path.resolve(cwd, 'assets/xml'),
    path.resolve(cwd, '../rotmg-extractor/output'),
  ];
  const files = new Set<string>();
  for (const candidate of candidates) {
    collectXmlFiles(candidate, files, 0);
  }
  return [...files].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
}

function collectXmlFiles(target: string, files: Set<string>, depth: number): void {
  if (depth > 8 || !fs.existsSync(target)) {
    return;
  }
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (target.endsWith('.xml') && looksUsefulXml(target)) {
      files.add(target);
    }
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }
  const base = path.basename(target);
  if (base === 'node_modules' || base.startsWith('.')) {
    return;
  }
  for (const entry of fs.readdirSync(target)) {
    collectXmlFiles(path.join(target, entry), files, depth + 1);
  }
}

function looksUsefulXml(file: string): boolean {
  const name = path.basename(file).toLowerCase();
  return (
    name === 'object.xml' ||
    name === 'objects.xml' ||
    name.startsWith('equip') ||
    name.endsWith('objects.xml') ||
    ['containers.xml', 'portals.xml', 'players.xml', 'pets.xml', 'skins.xml', 'dyes.xml', 'token.xml'].includes(name)
  );
}

function priority(file: string): number {
  const name = path.basename(file).toLowerCase();
  if (name === 'equip.xml') return 0;
  if (name.startsWith('equip')) return 1;
  if (name === 'object.xml' || name === 'objects.xml') return 2;
  return 3;
}

function parseObjects(file: string, byId: Map<number, ItemInfo>): void {
  const xml = fs.readFileSync(file, 'utf8');
  const objectPattern = /<Object\b([^>]*)>([\s\S]*?)<\/Object>/g;
  let match: RegExpExecArray | null;
  while ((match = objectPattern.exec(xml))) {
    const attrs = match[1];
    const body = match[2];
    const type = readAttr(attrs, 'type');
    const id = readAttr(attrs, 'id');
    if (!type || !id) {
      continue;
    }
    const numeric = Number(type);
    if (!Number.isInteger(numeric)) {
      continue;
    }
    const displayName = readTag(body, 'DisplayId');
    const className = readTag(body, 'Class');
    const name = decodeXml(displayName || id);
    byId.set(numeric, {
      id: numeric,
      name,
      displayName: displayName ? decodeXml(displayName) : undefined,
      className: className ? decodeXml(className) : undefined,
      source: path.basename(file),
    });
  }
}

function readAttr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return match ? decodeXml(match[1]) : undefined;
}

function readTag(body: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(body);
  return match ? match[1].trim() : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
