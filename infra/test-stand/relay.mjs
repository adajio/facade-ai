import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';

const targets = { postgres: ['postgres', 5432], api: ['api', 3000], objects: ['objects', 3900] };

if (['host', 'host-api'].includes(process.argv[2])) {
  const [docker, container, certOrContext, key] = process.argv.slice(3);
  const apiOnly = process.argv[2] === 'host-api';
  const context = apiOnly ? certOrContext : 'orbstack';
  function forward(service) {
    return (socket) => {
      const child = spawn(docker, [
        '--context', context, 'exec', '-i', container, 'node', '/relay.mjs', service,
      ], { stdio: ['pipe', 'pipe', 'ignore'] });
      socket.setNoDelay(true);
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
      socket.on('close', () => child.kill());
      socket.on('error', () => socket.destroy());
      child.on('error', () => socket.destroy());
      child.on('exit', () => socket.end());
      child.stdin.on('error', () => socket.destroy());
    };
  }
  if (apiOnly) {
    const server = createServer(forward('api'));
    server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`));
  } else {
    createServer(forward('postgres')).listen(15432, '127.0.0.1');
    createServer(forward('objects')).listen(13900, '127.0.0.1');
    createServer(forward('api')).listen(18080, '127.0.0.1');
    createTlsServer({
      cert: readFileSync(certOrContext),
      key: readFileSync(key),
      minVersion: 'TLSv1.2',
    }, forward('api')).listen(18443, '127.0.0.1');
  }
} else {
  const [host, port] = targets[process.argv[2]];
  const upstream = createConnection({ host, port });
  upstream.setNoDelay(true);
  upstream.on('error', () => { process.exitCode = 1; process.stdin.destroy(); });
  upstream.on('close', () => process.stdin.destroy());
  process.stdout.on('error', () => upstream.destroy());
  process.stdin.pipe(upstream);
  upstream.pipe(process.stdout, { end: false });
}
