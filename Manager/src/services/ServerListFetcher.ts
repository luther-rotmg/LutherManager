import { Logger } from '../util/Logger.js';

const API_URL = 'https://www.realmofthemadgod.com/account/servers';

/**
 * Fetches the live server list from the RotMG API.
 * Returns a map of server name → IP address.
 */
export async function fetchServerList(accessToken: string): Promise<Record<string, string>> {
  const params = new URLSearchParams({
    accessToken,
    game_net: 'Unity',
    play_platform: 'Unity',
    game_net_user_id: '',
  });

  const res = await fetch(`${API_URL}?${params}`, {
    method: 'GET',
    headers: {
      'User-Agent': 'UnityPlayer/2021.3.31f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)',
      'X-Unity-Version': '2021.3.31f1',
    },
  });

  if (!res.ok) {
    throw new Error(`Server list API returned ${res.status}`);
  }

  const xml = await res.text();
  return parseServerXml(xml);
}

function parseServerXml(xml: string): Record<string, string> {
  const servers: Record<string, string> = {};

  // Match each <Server>...</Server> block
  const serverBlocks = xml.match(/<Server>[\s\S]*?<\/Server>/g);
  if (!serverBlocks) return servers;

  for (const block of serverBlocks) {
    // Skip admin-only servers
    if (block.includes('<AdminOnly/>') || block.includes('<AdminOnly>')) continue;

    const nameMatch = block.match(/<Name>([^<]+)<\/Name>/);
    const dnsMatch = block.match(/<DNS>([^<]+)<\/DNS>/);

    if (nameMatch && dnsMatch) {
      servers[nameMatch[1]] = dnsMatch[1];
    }
  }

  return servers;
}
