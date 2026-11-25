import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { BlockList, createConnection, isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const openrouter = ['openrouter.ai', 'eu.openrouter.ai', 'us.openrouter.ai'];
const cheaperinference = ['api.cheaperinference.com'];
export const allowlists = {
  openrouter,
  cheaperinference,
  mixed: [...openrouter, ...cheaperinference],
  featherless: ['api.featherless.ai'],
  'openrouter+featherless': [...openrouter, 'api.featherless.ai'],
  'cheaperinference+featherless': [...cheaperinference, 'api.featherless.ai'],
  'openrouter+cheaperinference+featherless': [...openrouter, ...cheaperinference, 'api.featherless.ai'],
  import: ['cloud-api.yandex.net', 'downloader.disk.yandex.ru', 'downloader.disk.yandex.net'],
};
const blocked = new BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(prefix, bits, 'ipv4');

export function createConnectProxy({
  hosts, lookupAddresses = lookup, dial = createConnection, report = () => {}, connectTimeoutMs = 10_000,
}) {
  const server = createServer((_request, response) => {
    response.writeHead(405, { Connection: 'close' }).end();
  });
  server.maxConnections = 32;
  server.headersTimeout = 5_000;
  let nextTunnelId = 0;

  server.on('connect', async (request, client, head) => {
    const tunnelId = ++nextTunnelId;
    const started = performance.now();
    let upstream;
    const log = (phase, status, fields = {}) => report({
      tunnelId, phase, status, elapsedMs: Math.round(performance.now() - started), ...fields,
    });
    const reject = (status) => {
      if (!client.destroyed) client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    client.on('error', () => client.destroy());
    client.once('close', () => upstream?.destroy());
    const hostname = hosts.find((host) => request.url === `${host}:443`);
    if (!hostname) {
      log('authority', 'denied');
      return reject('403 Forbidden');
    }

    let addresses;
    try {
      addresses = await lookupAddresses(hostname, { family: 4, all: true });
    } catch {
      log('dns', 'failed');
      return reject('502 Bad Gateway');
    }
    if (!addresses.length || addresses.some(({ address }) => !isIPv4(address) || blocked.check(address, 'ipv4'))) {
      log('dns', 'denied');
      return reject('403 Forbidden');
    }
    const candidates = [...new Set(addresses.map(({ address }) => address))];
    const deadline = performance.now() + 2 * connectTimeoutMs;
    log('dns', 'verified', { candidateCount: candidates.length });

    function dialNext(index) {
      if (client.destroyed) return;
      const remaining = deadline - performance.now();
      if (index === candidates.length || remaining <= 0) {
        log('dial', 'exhausted');
        return reject('502 Bad Gateway');
      }

      // Only a checked numeric address enters the socket. TLS remains end-to-end.
      const socket = dial({ host: candidates[index], port: 443 });
      const candidate = index + 1;
      upstream = socket;
      let established = false;
      let failure;
      const timer = setTimeout(() => {
        failure = 'timeout';
        socket.destroy();
      }, Math.min(connectTimeoutMs, remaining));

      socket.once('connect', () => {
        clearTimeout(timer);
        if (client.destroyed || socket.destroyed) return socket.destroy();
        established = true;
        log('tunnel', 'established', { candidate });
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) socket.write(head);
        socket.setTimeout(120_000, () => {
          failure = 'idle_timeout';
          socket.destroy();
        });
        client.pipe(socket).pipe(client);
      });
      socket.on('error', () => {
        failure ??= 'socket_error';
        socket.destroy();
      });
      socket.once('close', () => {
        clearTimeout(timer);
        if (established) {
          log('tunnel', failure ?? (client.destroyed ? 'client_closed' : 'upstream_closed'), { candidate });
          client.destroy();
          return;
        }
        if (!client.destroyed) {
          log('dial', failure ?? 'closed', { candidate });
          dialNext(index + 1);
        }
      });
    }
    dialNext(0);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const route = process.argv[2];
  const hosts = Object.hasOwn(allowlists, route) ? allowlists[route] : undefined;
  const bind = networkInterfaces().priv0?.find((entry) => entry.family === 'IPv4')?.address;
  if (!hosts || !bind) throw Error('A known route and the private interface are required');
  createConnectProxy({
    hosts, report: (event) => console.info(JSON.stringify({ component: 'connect-proxy', route, ...event })),
  }).listen(3128, bind);
}
