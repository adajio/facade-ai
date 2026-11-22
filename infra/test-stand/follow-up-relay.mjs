import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const [docker, container, port] = process.argv.slice(2);
const ports = new Map([
  ['facade-ai-followup-source', '18083'], ['facade-ai-followup-restore', '18084'],
  ['facade-ai-step15-api', '18085'],
]);
if (ports.get(container) !== port) {
  throw new Error('Use a dedicated API and its matching loopback port');
}
const guest = `const s=require('node:net').connect(3000,'127.0.0.1');
  s.on('error',()=>process.exit(1)); s.on('close',()=>process.stdin.destroy());
  process.stdin.pipe(s); s.pipe(process.stdout,{end:false});`;
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
