import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const [docker, container, port] = process.argv.slice(2);
assert.match(container, /^facade-ai-project-memory-api-(?:live|rehearsal)-[a-f0-9]{12}$/u);
assert.match(port, /^18[0-9]{3}$/u);
assert.notEqual(port, '18443');
const guest = `const connection = require('node:net').connect(3000, '127.0.0.1');
connection.on('error', () => process.exit(1));
connection.on('close', () => process.stdin.destroy());
process.stdin.pipe(connection);
connection.pipe(process.stdout, { end: false });`;

createServer((socket) => {
  const child = spawn(docker, ['--context', 'orbstack', 'exec', '-i', container, 'node', '-e', guest],
    { stdio: ['pipe', 'pipe', 'ignore'] });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => child.kill());
  child.on('error', () => socket.destroy());
  child.on('exit', () => socket.end());
  child.stdin.on('error', () => socket.destroy());
  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
}).listen(Number(port), '127.0.0.1');
