import * as net from 'net';
import * as tls from 'tls';
import type { Agent } from 'http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

export type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5';

export interface ProxyConfig {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProxyTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

const PROXY_PROTOCOLS = new Set<ProxyProtocol>(['http', 'https', 'socks4', 'socks5']);
const DEFAULT_PROXY_PORTS: Record<ProxyProtocol, number> = {
  http: 8080,
  https: 443,
  socks4: 1080,
  socks5: 1080,
};

function normalizeProtocol(value: string | undefined): ProxyProtocol {
  const protocol = String(value || 'socks5').trim().toLowerCase().replace(/:$/, '');
  if (protocol === 'socks' || protocol === 'socks5h') return 'socks5';
  if (protocol === 'socks4a') return 'socks4';
  if (!PROXY_PROTOCOLS.has(protocol as ProxyProtocol)) {
    throw new Error(`Unsupported proxy protocol "${protocol}".`);
  }
  return protocol as ProxyProtocol;
}

/**
 * Parses `scheme://user:pass@host:port`, `user:pass@host:port`,
 * `host:port:user:pass`, or a plain `host:port` value.
 */
export function parseProxyConfig(
  value: string,
  defaults: { protocol?: ProxyProtocol | string; username?: string; password?: string } = {},
): ProxyConfig {
  let input = String(value || '').trim();
  if (!input) throw new Error('Proxy address is required.');

  let protocol = normalizeProtocol(defaults.protocol);
  if (!input.includes('://')) {
    const colonAuth = /^([^:\s]+):(\d{1,5}):([^:]*):(.*)$/.exec(input);
    if (colonAuth) {
      const [, host, port, username, password] = colonAuth;
      input = `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    } else {
      input = `${protocol}://${input}`;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Proxy must use host:port or protocol://host:port format.');
  }

  protocol = normalizeProtocol(parsed.protocol);
  const host = parsed.hostname.trim();
  const port = Number(parsed.port || DEFAULT_PROXY_PORTS[protocol]);
  if (!host) throw new Error('Proxy host is required.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Proxy port must be between 1 and 65535.');
  }

  const urlUsername = parsed.username ? decodeURIComponent(parsed.username) : '';
  const urlPassword = parsed.password ? decodeURIComponent(parsed.password) : '';
  const username = defaults.username !== undefined ? String(defaults.username) : urlUsername;
  const password = defaults.password !== undefined ? String(defaults.password) : urlPassword;
  return {
    protocol,
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

export function proxyConfigToUrl(proxy: ProxyConfig, includeCredentials = true): string {
  const auth = includeCredentials && (proxy.username || proxy.password)
    ? `${encodeURIComponent(proxy.username || '')}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  const host = proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
  return `${proxy.protocol}://${auth}${host}:${proxy.port}`;
}

/** Agent used by Axios/Node HTTPS requests so auth and character-list calls share the proxy. */
export function createProxyAgent(proxy: ProxyConfig): Agent {
  const url = proxyConfigToUrl(proxy, true);
  if (proxy.protocol === 'socks4' || proxy.protocol === 'socks5') {
    // The agent's `h`/`a` schemes keep DNS resolution inside the proxy tunnel.
    const remoteDnsUrl = url.replace(/^socks4:/, 'socks4a:').replace(/^socks5:/, 'socks5h:');
    return new SocksProxyAgent(remoteDnsUrl);
  }
  return new HttpsProxyAgent(url);
}

function proxyConnectError(proxy: ProxyConfig, message: string): Error {
  return new Error(`${proxy.protocol.toUpperCase()} proxy ${proxy.host}:${proxy.port}: ${message}`);
}

function connectProxyEndpoint(proxy: ProxyConfig, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const secure = proxy.protocol === 'https';
    const socket: net.Socket = secure
      ? tls.connect({ host: proxy.host, port: proxy.port, servername: net.isIP(proxy.host) ? undefined : proxy.host })
      : net.connect({ host: proxy.host, port: proxy.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(proxyConnectError(proxy, 'connection timed out.'));
    }, timeoutMs);
    const event = secure ? 'secureConnect' : 'connect';
    const onError = (error: Error): void => {
      clearTimeout(timer);
      reject(proxyConnectError(proxy, error.message));
    };
    socket.once('error', onError);
    socket.once(event, () => {
      clearTimeout(timer);
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

function readExact(socket: net.Socket, size: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const timer = setTimeout(() => finish(new Error('proxy handshake timed out.')), timeoutMs);
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error('proxy closed during handshake.'));
    const onReadable = (): void => {
      while (received < size) {
        const chunk = socket.read(size - received) as Buffer | null;
        if (!chunk) break;
        chunks.push(chunk);
        received += chunk.length;
      }
      if (received === size) finish();
    };
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.off('readable', onReadable);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, size));
    };
    socket.on('readable', onReadable);
    socket.once('error', onError);
    socket.once('close', onClose);
    onReadable();
  });
}

function readHeaders(socket: net.Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('proxy CONNECT timed out.')), timeoutMs);
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error('proxy closed during CONNECT.'));
    const onReadable = (): void => {
      let chunk: Buffer | null;
      while ((chunk = socket.read() as Buffer | null)) {
        data = Buffer.concat([data, chunk]);
        if (data.length > 64 * 1024) {
          finish(new Error('proxy returned an oversized CONNECT response.'));
          return;
        }
        const end = data.indexOf('\r\n\r\n');
        if (end >= 0) {
          const remainder = data.subarray(end + 4);
          if (remainder.length) socket.unshift(remainder);
          finish(undefined, data.subarray(0, end + 4).toString('latin1'));
          return;
        }
      }
    };
    const finish = (error?: Error, headers?: string): void => {
      clearTimeout(timer);
      socket.off('readable', onReadable);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) reject(error);
      else resolve(headers || '');
    };
    socket.on('readable', onReadable);
    socket.once('error', onError);
    socket.once('close', onClose);
    onReadable();
  });
}

async function establishHttpTunnel(
  socket: net.Socket,
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<void> {
  const target = `${targetHost}:${targetPort}`;
  const lines = [
    `CONNECT ${target} HTTP/1.1`,
    `Host: ${target}`,
    'Proxy-Connection: Keep-Alive',
  ];
  if (proxy.username || proxy.password) {
    const auth = Buffer.from(`${proxy.username || ''}:${proxy.password || ''}`, 'utf8').toString('base64');
    lines.push(`Proxy-Authorization: Basic ${auth}`);
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
  const headers = await readHeaders(socket, timeoutMs);
  const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(headers)?.[1];
  if (!status || Number(status) < 200 || Number(status) >= 300) {
    const detail = headers.split('\r\n')[0] || 'invalid response';
    throw proxyConnectError(proxy, `CONNECT failed (${detail}).`);
  }
}

async function establishSocks4Tunnel(
  socket: net.Socket,
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<void> {
  const user = Buffer.from(proxy.username || '', 'utf8');
  const host = Buffer.from(targetHost, 'utf8');
  const request = Buffer.alloc(10 + user.length + host.length);
  request[0] = 0x04;
  request[1] = 0x01;
  request.writeUInt16BE(targetPort, 2);
  request.set([0x00, 0x00, 0x00, 0x01], 4); // SOCKS4a resolves the target at the proxy.
  user.copy(request, 8);
  request[8 + user.length] = 0;
  host.copy(request, 9 + user.length);
  request[request.length - 1] = 0;
  socket.write(request);
  const response = await readExact(socket, 8, timeoutMs);
  if (response[1] !== 0x5a) {
    throw proxyConnectError(proxy, `SOCKS4 request rejected (code 0x${response[1].toString(16)}).`);
  }
}

async function establishSocks5Tunnel(
  socket: net.Socket,
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<void> {
  const hasAuth = !!(proxy.username || proxy.password);
  socket.write(hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
  const greeting = await readExact(socket, 2, timeoutMs);
  if (greeting[0] !== 0x05 || greeting[1] === 0xff) {
    throw proxyConnectError(proxy, 'SOCKS5 authentication method was rejected.');
  }
  if (greeting[1] === 0x02) {
    const username = Buffer.from(proxy.username || '', 'utf8');
    const password = Buffer.from(proxy.password || '', 'utf8');
    if (username.length > 255 || password.length > 255) {
      throw proxyConnectError(proxy, 'SOCKS5 credentials exceed 255 bytes.');
    }
    socket.write(Buffer.concat([
      Buffer.from([0x01, username.length]),
      username,
      Buffer.from([password.length]),
      password,
    ]));
    const auth = await readExact(socket, 2, timeoutMs);
    if (auth[1] !== 0x00) throw proxyConnectError(proxy, 'SOCKS5 username/password was rejected.');
  } else if (greeting[1] !== 0x00) {
    throw proxyConnectError(proxy, `SOCKS5 selected unsupported auth method 0x${greeting[1].toString(16)}.`);
  }

  const host = Buffer.from(targetHost, 'utf8');
  if (host.length > 255) throw new Error('Target hostname is too long for SOCKS5.');
  const port = Buffer.alloc(2);
  port.writeUInt16BE(targetPort, 0);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]));

  const response = await readExact(socket, 4, timeoutMs);
  if (response[0] !== 0x05 || response[1] !== 0x00) {
    throw proxyConnectError(proxy, `SOCKS5 connection rejected (code 0x${response[1].toString(16)}).`);
  }
  if (response[3] === 0x01) await readExact(socket, 4 + 2, timeoutMs);
  else if (response[3] === 0x04) await readExact(socket, 16 + 2, timeoutMs);
  else if (response[3] === 0x03) {
    const length = (await readExact(socket, 1, timeoutMs))[0];
    await readExact(socket, length + 2, timeoutMs);
  } else {
    throw proxyConnectError(proxy, 'SOCKS5 returned an invalid address type.');
  }
}

/** Opens a TCP tunnel through the configured proxy to a game or test endpoint. */
export async function connectThroughProxy(
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number,
  timeoutMs = 15_000,
): Promise<net.Socket> {
  const socket = await connectProxyEndpoint(proxy, timeoutMs);
  try {
    if (proxy.protocol === 'http' || proxy.protocol === 'https') {
      await establishHttpTunnel(socket, proxy, targetHost, targetPort, timeoutMs);
    } else if (proxy.protocol === 'socks4') {
      await establishSocks4Tunnel(socket, proxy, targetHost, targetPort, timeoutMs);
    } else {
      await establishSocks5Tunnel(socket, proxy, targetHost, targetPort, timeoutMs);
    }
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** Tests a proxy with a real tunnel and TLS handshake to the RotMG web service. */
export async function testProxy(
  proxy: ProxyConfig,
  options: { host?: string; port?: number; timeoutMs?: number } = {},
): Promise<ProxyTestResult> {
  const started = Date.now();
  const host = options.host || 'www.realmofthemadgod.com';
  const port = options.port || 443;
  const timeoutMs = options.timeoutMs || 15_000;
  let socket: net.Socket | undefined;
  try {
    socket = await connectThroughProxy(proxy, host, port, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      const secure = tls.connect({ socket, servername: host });
      socket = secure;
      const timer = setTimeout(() => {
        secure.destroy();
        reject(new Error('TLS verification timed out.'));
      }, timeoutMs);
      secure.once('secureConnect', () => {
        clearTimeout(timer);
        resolve();
      });
      secure.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    socket.end();
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    socket?.destroy();
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
