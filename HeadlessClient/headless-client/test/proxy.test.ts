import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { connectThroughProxy, createProxyAgent, parseProxyConfig } from '../src/proxy';

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return (server.address() as net.AddressInfo).port;
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('parseProxyConfig accepts URL, inline auth, and host:port:user:pass forms', () => {
  assert.deepEqual(parseProxyConfig('socks5://user:p%40ss@proxy.example:1080'), {
    protocol: 'socks5',
    host: 'proxy.example',
    port: 1080,
    username: 'user',
    password: 'p@ss',
  });
  assert.deepEqual(parseProxyConfig('proxy.example:8080:user:pass', { protocol: 'http' }), {
    protocol: 'http',
    host: 'proxy.example',
    port: 8080,
    username: 'user',
    password: 'pass',
  });
});

test('SOCKS HTTPS agents delegate destination DNS to the proxy', () => {
  const socks4 = createProxyAgent(parseProxyConfig('socks4://127.0.0.1:1080')) as unknown as { shouldLookup: boolean };
  const socks5 = createProxyAgent(parseProxyConfig('socks5://127.0.0.1:1080')) as unknown as { shouldLookup: boolean };
  assert.equal(socks4.shouldLookup, false);
  assert.equal(socks5.shouldLookup, false);
});

test('HTTP CONNECT sends basic proxy authentication', async () => {
  let request = '';
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      request += chunk.toString('latin1');
      if (request.includes('\r\n\r\n')) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
  });
  const port = await listen(server);
  const socket = await connectThroughProxy(
    { protocol: 'http', host: '127.0.0.1', port, username: 'alpha', password: 'beta' },
    'game.example',
    2050,
  );
  assert.match(request, /^CONNECT game\.example:2050 HTTP\/1\.1/m);
  assert.match(request, /Proxy-Authorization: Basic YWxwaGE6YmV0YQ/i);
  socket.destroy();
  await close(server);
});

test('SOCKS5 negotiates username/password and a domain target', async () => {
  let stage = 0;
  let username = '';
  let password = '';
  let target = '';
  let targetPort = 0;
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      if (stage === 0) {
        assert.deepEqual([...chunk], [0x05, 0x02, 0x00, 0x02]);
        stage = 1;
        socket.write(Buffer.from([0x05, 0x02]));
        return;
      }
      if (stage === 1) {
        const userLength = chunk[1];
        username = chunk.subarray(2, 2 + userLength).toString();
        const passwordLength = chunk[2 + userLength];
        password = chunk.subarray(3 + userLength, 3 + userLength + passwordLength).toString();
        stage = 2;
        socket.write(Buffer.from([0x01, 0x00]));
        return;
      }
      const hostLength = chunk[4];
      target = chunk.subarray(5, 5 + hostLength).toString();
      targetPort = chunk.readUInt16BE(5 + hostLength);
      stage = 3;
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x08, 0x02]));
    });
  });
  const port = await listen(server);
  const socket = await connectThroughProxy(
    { protocol: 'socks5', host: '127.0.0.1', port, username: 'alpha', password: 'beta' },
    'game.example',
    2050,
  );
  assert.equal(stage, 3);
  assert.equal(username, 'alpha');
  assert.equal(password, 'beta');
  assert.equal(target, 'game.example');
  assert.equal(targetPort, 2050);
  socket.destroy();
  await close(server);
});

test('SOCKS4a sends its username and domain target', async () => {
  let request = Buffer.alloc(0);
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      request = Buffer.concat([request, chunk]);
      socket.write(Buffer.from([0x00, 0x5a, 0x08, 0x02, 0, 0, 0, 1]));
    });
  });
  const port = await listen(server);
  const socket = await connectThroughProxy(
    { protocol: 'socks4', host: '127.0.0.1', port, username: 'alpha' },
    'game.example',
    2050,
  );
  assert.equal(request[0], 0x04);
  assert.equal(request[1], 0x01);
  assert.equal(request.readUInt16BE(2), 2050);
  assert.equal(request.subarray(8, request.indexOf(0, 8)).toString(), 'alpha');
  assert.match(request.toString('latin1'), /game\.example\0$/);
  socket.destroy();
  await close(server);
});
