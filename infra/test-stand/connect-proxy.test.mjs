import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, createServer, Socket } from 'node:net';
import { test } from 'node:test';
import { createConnectProxy } from './connect-proxy.mjs';

const hostname = 'openrouter.ai';
const header = `CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\n\r\n`;
const tunnelData = 'synthetic-test-data';
const publicAnswer = (...hosts) => hosts.map((address) => ({ address, family: 4 }));

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

async function connect(port) {
  const client = createConnection({ host: '127.0.0.1', port });
  const closed = once(client, 'close');
  let response = '';
  client.setEncoding('utf8').on('data', (chunk) => { response += chunk; });
  await once(client, 'connect');
  client.write(header + tunnelData);
  await closed;
  return response;
}

test('a stalled first IPv4 falls through before CONNECT 200 and never replays buffered data', { timeout: 3000 }, async (t) => {
  const received = [];
  const addresses = [];
  const phases = [];
  const upstream = await listen(t, createServer((socket) => {
    socket.setEncoding('utf8').once('data', (data) => {
      received.push(data);
      socket.end('encapsulated-response');
    });
  }));
  const proxy = await listen(t, createConnectProxy({
    hosts: [hostname],
    lookupAddresses: async (name, options) => {
      assert.equal(name, hostname);
      assert.deepEqual(options, { family: 4, all: true });
      return publicAnswer('1.1.1.1', '8.8.8.8', '9.9.9.9');
    },
    connectTimeoutMs: 50,
    dial: ({ host, port }) => {
      assert.equal(port, 443);
      addresses.push(host);
      if (host === '1.1.1.1') {
        const stalled = new Socket();
        stalled.write = () => assert.fail('data reached a socket before connect');
        return stalled;
      }
      assert.equal(host, '8.8.8.8', 'a tunnel that already returned 200 must not dial again');
      return createConnection({ host: '127.0.0.1', port: upstream });
    },
    report: (event) => phases.push(event),
  }));
  const response = await connect(proxy);
  assert.equal(response, 'HTTP/1.1 200 Connection Established\r\n\r\nencapsulated-response');
  assert.deepEqual(addresses, ['1.1.1.1', '8.8.8.8']);
  assert.deepEqual(received, [tunnelData]);
  assert.deepEqual(phases.slice(0, 3).map(({ phase, status, candidate }) => [phase, status, candidate]), [
    ['dns', 'verified', undefined], ['dial', 'timeout', 1], ['tunnel', 'established', 2],
  ]);
  const trace = JSON.stringify(phases);
  for (const hidden of [hostname, tunnelData, ...addresses]) assert.ok(!trace.includes(hidden));
  assert.ok(phases.every(({ tunnelId }) => tunnelId === phases[0].tunnelId));
});

test('a private DNS result blocks the entire answer set before any dial', { timeout: 3000 }, async (t) => {
  const proxy = await listen(t, createConnectProxy({
    hosts: [hostname],
    lookupAddresses: async () => publicAnswer('1.1.1.1', '127.0.0.1'),
    dial: () => assert.fail('unverified answer set'),
  }));
  assert.match(await connect(proxy), /^HTTP\/1\.1 403 Forbidden\r\n/);
});

test('exhausting checked addresses returns 502 without opening a tunnel', { timeout: 3000 }, async (t) => {
  const addresses = [];
  const proxy = await listen(t, createConnectProxy({
    hosts: [hostname],
    lookupAddresses: async () => publicAnswer('1.1.1.1', '1.1.1.1', '8.8.8.8'),
    connectTimeoutMs: 50,
    dial: ({ host }) => {
      addresses.push(host);
      return new Socket();
    },
  }));
  assert.equal(await connect(proxy), 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  assert.deepEqual(addresses, ['1.1.1.1', '8.8.8.8']);
});
