import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { BlockList, createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';

const allowlists = {
  openrouter: ['openrouter.ai', 'eu.openrouter.ai', 'us.openrouter.ai'],
  import: ['cloud-api.yandex.net', 'downloader.disk.yandex.ru', 'downloader.disk.yandex.net'],
};
const hosts = allowlists[process.argv[2]];
const bind = networkInterfaces().priv0?.find((entry) => entry.family === 'IPv4')?.address;
if (!hosts || !bind) throw Error('A known route and the private interface are required');

const blocked = new BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(prefix, bits, 'ipv4');

const server = createServer((_request, response) => {
  response.writeHead(405, { Connection: 'close' }).end();
});
server.maxConnections = 32;
server.headersTimeout = 5_000;

server.on('connect', async (request, client, head) => {
  client.on('error', () => client.destroy());
  const reject = (status) => client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  const authority = request.url ?? '';
  const hostname = hosts.find((host) => authority === `${host}:443`);
  if (!hostname) return reject('403 Forbidden');

  let addresses;
  try {
    addresses = await lookup(hostname, { family: 4, all: true });
  } catch {
    return reject('502 Bad Gateway');
  }
  if (!addresses.length || addresses.some(({ address }) => blocked.check(address, 'ipv4'))) {
    return reject('403 Forbidden');
  }
  if (client.destroyed) return;
  // Dial the checked numeric address. The client negotiates TLS with its original hostname.
  const upstream = createConnection({ host: addresses[0].address, port: 443 });
  let established = false;
  const connectTimeout = setTimeout(() => upstream.destroy(), 10_000);
  upstream.once('connect', () => {
    established = true;
    clearTimeout(connectTimeout);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.setTimeout(120_000, () => upstream.destroy());
    client.pipe(upstream).pipe(client);
  });
  upstream.on('error', () => upstream.destroy());
  upstream.on('close', () => {
    clearTimeout(connectTimeout);
    if (established) client.destroy();
    else reject('502 Bad Gateway');
  });
  client.on('close', () => upstream.destroy());
});
server.listen(3128, bind);
