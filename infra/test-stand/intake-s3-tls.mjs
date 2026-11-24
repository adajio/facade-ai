import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';

// Put the existing Garage listener behind a separate TLS endpoint for this test.
const [port, certFile, keyFile] = process.argv.slice(2);
if (!/^\d+$/.test(port ?? '') || !certFile || !keyFile) {
  throw new Error('Usage: node intake-s3-tls.mjs PORT CERT KEY');
}

createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, (incoming, outgoing) => {
  const started = performance.now();
  let sent = 0;
  let received = 0;
  const upstream = request({
    hostname: '127.0.0.1', port: 13900, method: incoming.method,
    // SigV4 covers Host and the request target. Preserve both as sent by the SDK.
    path: incoming.url, headers: incoming.headers,
  }, (response) => {
    outgoing.writeHead(response.statusCode, response.headers);
    response.on('data', (chunk) => { received += chunk.length; });
    response.on('error', (error) => outgoing.destroy(error));
    response.pipe(outgoing);
  });

  incoming.on('data', (chunk) => { sent += chunk.length; });
  incoming.on('error', () => upstream.destroy());
  outgoing.on('close', () => {
    upstream.destroy();
    const query = new URL(incoming.url, 'https://loopback.invalid').searchParams;
    console.log(JSON.stringify({
      method: incoming.method, multipart: query.has('uploads') || query.has('uploadId'),
      conditionalCreate: incoming.headers['if-none-match'] === '*',
      status: outgoing.writableFinished ? outgoing.statusCode : null,
      requestBytes: sent, responseBytes: received, milliseconds: performance.now() - started,
    }));
  });
  upstream.on('error', () => {
    if (outgoing.headersSent) outgoing.destroy();
    else outgoing.writeHead(502).end();
  });
  incoming.pipe(upstream);
}).listen(Number(port), '127.0.0.1');
