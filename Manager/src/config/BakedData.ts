declare const __PACKET_DEFINITIONS_JSON__: string | undefined;
declare const __STAT_TYPES_JSON__: string | undefined;
declare const __SERVERS_JSON__: string | undefined;

export interface BakedPacketDefinitions {
  packets: Record<string, { name: string; direction: 'client' | 'server'; fields: any[] }>;
  dataObjects: Record<string, { fields: any[] }>;
}

export interface BakedStatTypes {
  stringStats: number[];
}

let packetDefinitionsCache: BakedPacketDefinitions | null | undefined;
let statTypesCache: BakedStatTypes | null | undefined;
let serversCache: Record<string, string> | null | undefined;

function readDefinedJson(name: 'packet' | 'stat' | 'servers'): string | null {
  try {
    const raw = name === 'packet'
      ? (typeof __PACKET_DEFINITIONS_JSON__ !== 'undefined' ? __PACKET_DEFINITIONS_JSON__ : '')
      : name === 'stat'
        ? (typeof __STAT_TYPES_JSON__ !== 'undefined' ? __STAT_TYPES_JSON__ : '')
        : (typeof __SERVERS_JSON__ !== 'undefined' ? __SERVERS_JSON__ : '');
    const value = String(raw || '').trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

export function getBakedPacketDefinitions(): BakedPacketDefinitions | null {
  if (packetDefinitionsCache !== undefined) return packetDefinitionsCache;
  const raw = readDefinedJson('packet');
  if (!raw) {
    packetDefinitionsCache = null;
    return null;
  }
  try {
    packetDefinitionsCache = JSON.parse(raw) as BakedPacketDefinitions;
    return packetDefinitionsCache;
  } catch {
    packetDefinitionsCache = null;
    return null;
  }
}

export function getBakedStatTypes(): BakedStatTypes | null {
  if (statTypesCache !== undefined) return statTypesCache;
  const raw = readDefinedJson('stat');
  if (!raw) {
    statTypesCache = null;
    return null;
  }
  try {
    statTypesCache = JSON.parse(raw) as BakedStatTypes;
    return statTypesCache;
  } catch {
    statTypesCache = null;
    return null;
  }
}

export function getBakedServers(): Record<string, string> | null {
  if (serversCache !== undefined) return serversCache;
  const raw = readDefinedJson('servers');
  if (!raw) {
    serversCache = null;
    return null;
  }
  try {
    serversCache = JSON.parse(raw) as Record<string, string>;
    return serversCache;
  } catch {
    serversCache = null;
    return null;
  }
}
