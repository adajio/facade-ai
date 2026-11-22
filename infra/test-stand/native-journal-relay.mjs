import { createConnection, createServer } from 'node:net';
import { networkInterfaces } from 'node:os';

const bind = networkInterfaces().priv0?.find((entry) => entry.family === 'IPv4')?.address;
if (!bind) throw Error('The private journal interface is required');
const port = Number(process.argv[2] ?? 15434);
if (port !== 15434 && port !== 15435) throw Error('Use the dedicated native journal port');

const relay = createServer((client) => {
  // OrbStack reaches the local macOS listener through its guest-to-host interface.
  const postgres = createConnection({ host: 'host.docker.internal', port });
  client.on('error', () => client.destroy());
  postgres.on('error', () => client.destroy());
  client.on('close', () => postgres.destroy());
  postgres.on('close', () => client.end());
  client.pipe(postgres).pipe(client);
});
relay.maxConnections = 12;
relay.listen(port, bind);
