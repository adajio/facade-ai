import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';

const targets = { postgres: ['postgres', 5432], api: ['api', 3000], objects: ['objects', 3900] };

if (process.argv[2] === 'host') {
  const [docker, container, cert, key] = process.argv.slice(3);
  function forward(service) {
    return (socket) => {
      const child = spawn(docker, [
        '--context', 'orbstack', 'exec', '-i', container, 'node', '/relay.mjs', service,
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
  createServer(forward('postgres')).listen(15432, '127.0.0.1');
  createServer(forward('objects')).listen(13900, '127.0.0.1');
  createServer(forward('api')).listen(18080, '127.0.0.1');
  createTlsServer({
    cert: readFileSync(cert),
    key: readFileSync(key),
    minVersion: 'TLSv1.2',
  }, forward('api')).listen(18443, '127.0.0.1');
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
