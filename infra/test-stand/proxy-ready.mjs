import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const address = networkInterfaces().priv0?.find(entry => entry.family === 'IPv4')?.address;
if (!address) throw Error('The proxy private IPv4 interface is missing');

function acceptsConnections() {
  return new Promise(resolve => {
    const socket = createConnection({ host: address, port: 3128 });
    const done = ready => {
      socket.destroy();
      resolve(ready);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(250, () => done(false));
  });
}

const deadline = performance.now() + 5_000;
while (!(await acceptsConnections())) {
  if (performance.now() >= deadline) throw Error('The proxy TCP listener did not become ready');
  await delay(100);
}
