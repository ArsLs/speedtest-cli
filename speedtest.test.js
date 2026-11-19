import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { downloadOnce, runSpeedtest, summarize, formatReport, median, InterruptedError } from './speedtest.js';

const BODY_SIZE = 256 * 1024; // 256 KiB
const body = Buffer.alloc(BODY_SIZE, 'a');
const gzipped = zlib.gzipSync(body);

// Self-signed certificate for 127.0.0.1, used only by the HTTPS tests.
// Regenerate with: openssl req -x509 -newkey rsa:2048 -nodes -keyout test/fixtures/key.pem
//   -out test/fixtures/cert.pem -days 36500 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"
const tls = {
  key: readFileSync(new URL('./test/fixtures/key.pem', import.meta.url)),
  cert: readFileSync(new URL('./test/fixtures/cert.pem', import.meta.url)),
};

let active = 0;
let maxActive = 0;
let hits = 0;
let flakyCalls = 0;
let connections = 0;
let lastHeaders = {};
let httpsPort = 0;
// Sockets that already served a request on /reset-on-reuse.
const usedSockets = new WeakSet();

function handler(req, res) {
  hits++;
  lastHeaders = req.headers;
  // Route by path only, so that redirects with a query string reach the same handler.
  const path = new URL(req.url, 'http://x').pathname;

  if (path === '/ok') {
    // Track concurrent /ok requests: +1 on arrival, -1 once the full body is sent.
    active++;
    maxActive = Math.max(maxActive, active);
    res.on('finish', () => { active--; });
    // Send in two chunks with a small delay so the client must read the whole stream.
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write(body.subarray(0, BODY_SIZE / 2));
    setTimeout(() => res.end(body.subarray(BODY_SIZE / 2)), 5);
  } else if (path === '/flaky') {
    // Every second request fails.
    flakyCalls++;
    if (flakyCalls % 2 === 0) {
      res.writeHead(500);
      res.end('error');
    } else {
      res.writeHead(200);
      res.end(body);
    }
  } else if (path === '/empty') {
    res.writeHead(200, { 'Content-Length': '0' });
    res.end();
  } else if (path === '/no-content') {
    res.writeHead(204);
    res.end();
  } else if (path === '/truncated') {
    // Promise 1000 bytes, send 500 and drop the connection.
    res.writeHead(200, { 'Content-Length': '1000' });
    res.write(Buffer.alloc(500, 'b'));
    setTimeout(() => res.socket.destroy(), 5);
  } else if (path === '/truncated-chunked') {
    // Chunked body (no Content-Length) cut off before the terminating chunk.
    res.writeHead(200);
    res.write(Buffer.alloc(500, 'b'));
    setTimeout(() => res.socket.destroy(), 5);
  } else if (path === '/gzip') {
    // Ignores Accept-Encoding: identity and sends a compressed body anyway.
    res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': String(gzipped.length) });
    res.end(gzipped);
  } else if (path === '/redirect') {
    res.writeHead(302, { Location: `http://${req.headers.host}/ok` });
    res.end();
  } else if (path === '/redirect-relative') {
    res.writeHead(301, { Location: '/ok' });
    res.end();
  } else if (path === '/r3' || path === '/r2' || path === '/r1') {
    // Chain /r3 -> /r2 -> /r1 -> /ok. Redirect bodies must not be counted.
    const next = { '/r3': ['/r2', 301], '/r2': ['/r1', 302], '/r1': ['/ok', 307] }[path];
    res.writeHead(next[1], { Location: next[0] });
    res.end('redirect body that must not be counted');
  } else if (path === '/dir/up') {
    res.writeHead(303, { Location: '../ok?x=1' }); // resolves to /ok?x=1
    res.end();
  } else if (path === '/sibling') {
    res.writeHead(303, { Location: 'ok' }); // resolves to /ok
    res.end();
  } else if (path === '/loop') {
    res.writeHead(302, { Location: '/loop' });
    res.end();
  } else if (path === '/no-location') {
    res.writeHead(302);
    res.end();
  } else if (path === '/to-ftp') {
    res.writeHead(302, { Location: 'ftp://127.0.0.1/file' });
    res.end();
  } else if (path === '/to-https') {
    res.writeHead(302, { Location: `https://127.0.0.1:${httpsPort}/ok` });
    res.end();
  } else if (path === '/slow-redirect') {
    // Wait, then redirect to a response that never ends: the timeout must count from the start.
    setTimeout(() => {
      res.writeHead(302, { Location: '/hang' });
      res.end();
    }, Number(new URL(req.url, 'http://x').searchParams.get('delay')));
  } else if (path === '/reset-on-reuse') {
    // Simulates a server that closed an idle keep-alive connection: any second request on the
    // same socket is answered by dropping the connection, a fresh connection works.
    if (usedSockets.has(req.socket)) {
      req.socket.destroy();
      return;
    }
    usedSockets.add(req.socket);
    res.writeHead(200);
    res.end(body);
  } else if (path === '/bad-location') {
    res.writeHead(302, { Location: 'http://[' });
    res.end();
  } else if (path === '/hang') {
    res.writeHead(200);
    res.write('partial'); // never ends
  } else {
    res.writeHead(404);
    res.end('not found');
  }
}

// Servers are started with top-level await rather than in a before() hook: the Node 18.11
// test runner does not run a top-level before() before the tests.
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Node 18.11 also skips a top-level after(), so make sure the test servers and their sockets
  // never keep the process alive on their own. On newer versions after() closes them explicitly.
  server.unref();
  server.on('connection', (socket) => {
    connections++;
    socket.unref();
  });
  // A TLS server reports client handshake errors here; they are expected in the "untrusted" test.
  server.on('tlsClientError', () => {});
  return server.address().port;
}

const server = http.createServer(handler);
const baseUrl = `http://127.0.0.1:${await listen(server)}`;
const httpsServer = https.createServer(tls, handler);
httpsPort = await listen(httpsServer);
const httpsUrl = `https://127.0.0.1:${httpsPort}`;
// Agents that trust the test certificate (and nothing else).
const trustingAgents = () => ({ https: new https.Agent({ ca: tls.cert }) });

after(() => {
  for (const s of [server, httpsServer]) {
    s.closeAllConnections?.();
    s.close();
  }
});

// Find a port nothing listens on: open a server on a random port, then close it.
async function freePort() {
  const tmp = http.createServer();
  await new Promise((resolve) => tmp.listen(0, '127.0.0.1', resolve));
  const { port } = tmp.address();
  await new Promise((resolve) => tmp.close(resolve));
  return port;
}

test('downloadOnce reads the full body and measures time', async () => {
  const r = await downloadOnce(`${baseUrl}/ok`, 5000);
  assert.equal(r.bytes, BODY_SIZE);
  assert.ok(r.ms > 0);
  assert.equal(r.encoding, undefined);
});

test('downloadOnce sends no-cache, identity encoding and a User-Agent', async () => {
  await downloadOnce(`${baseUrl}/ok`, 5000);
  assert.equal(lastHeaders['cache-control'], 'no-cache');
  assert.equal(lastHeaders['accept-encoding'], 'identity');
  assert.match(lastHeaders['user-agent'], /^speedtest-cli\/\d+\.\d+\.\d+$/);
});

test('downloadOnce rejects on HTTP error status', async () => {
  await assert.rejects(downloadOnce(`${baseUrl}/missing`, 5000), /HTTP 404 Not Found/);
});

test('downloadOnce rejects on timeout', async () => {
  await assert.rejects(downloadOnce(`${baseUrl}/hang`, 200), /timed out/i);
});

test('downloadOnce rejects an empty 200 body: speed cannot be measured', async () => {
  await assert.rejects(downloadOnce(`${baseUrl}/empty`, 5000), /Empty response body/);
});

test('downloadOnce rejects 204 No Content', async () => {
  await assert.rejects(downloadOnce(`${baseUrl}/no-content`, 5000), /Empty response body/);
});

test('downloadOnce rejects a body cut off mid-stream instead of counting partial bytes', async () => {
  await assert.rejects(downloadOnce(`${baseUrl}/truncated`, 5000), /Incomplete body/);
});

test('downloadOnce rejects a chunked body cut off before the last chunk', async () => {
  await assert.rejects(downloadOnce(`${baseUrl}/truncated-chunked`, 5000), /Incomplete body/);
});

test('downloadOnce counts compressed bytes as received, without decompressing', async () => {
  const r = await downloadOnce(`${baseUrl}/gzip`, 5000);
  assert.equal(r.bytes, gzipped.length);
  assert.ok(r.bytes < BODY_SIZE);
  assert.equal(r.encoding, 'gzip');
});

test('downloadOnce follows an absolute redirect and counts the final body', async () => {
  const r = await downloadOnce(`${baseUrl}/redirect`, 5000);
  assert.equal(r.bytes, BODY_SIZE);
});

test('downloadOnce follows a relative redirect', async () => {
  const r = await downloadOnce(`${baseUrl}/redirect-relative`, 5000);
  assert.equal(r.bytes, BODY_SIZE);
});

test('downloadOnce follows a 301 -> 302 -> 307 chain and ignores redirect bodies', async () => {
  const r = await downloadOnce(`${baseUrl}/r3`, 5000);
  assert.equal(r.bytes, BODY_SIZE);
});

test('downloadOnce resolves ../path and bare relative Location values', async () => {
  assert.equal((await downloadOnce(`${baseUrl}/dir/up`, 5000)).bytes, BODY_SIZE);
  assert.equal((await downloadOnce(`${baseUrl}/sibling`, 5000)).bytes, BODY_SIZE);
});

test('downloadOnce stops a redirect loop after 20 hops', async () => {
  hits = 0;
  await assert.rejects(downloadOnce(`${baseUrl}/loop`, 5000), /Too many redirects \(20\)/);
  assert.equal(hits, 21, 'the original request plus 20 followed redirects');
});

test('downloadOnce rejects a redirect without Location', async () => {
  await assert.rejects(downloadOnce(`${baseUrl}/no-location`, 5000), /HTTP 302 redirect without Location/);
});

test('downloadOnce rejects a redirect to a non-HTTP protocol', async () => {
  await assert.rejects(downloadOnce(`${baseUrl}/to-ftp`, 5000), /Unsupported protocol "ftp:"/);
});

test('downloadOnce rejects a redirect to an invalid Location and shows it', async () => {
  await assert.rejects(downloadOnce(`${baseUrl}/bad-location`, 5000), /HTTP 302 redirect to invalid Location "http:\/\/\["/);
});

test('the timeout covers the whole redirect chain, not each hop', async () => {
  // A per-hop timer would fire at about delay + timeout = 1600 ms; the right one at 1000 ms.
  const timeout = 1000;
  const started = Date.now();
  await assert.rejects(downloadOnce(`${baseUrl}/slow-redirect?delay=600`, timeout), /Timed out after 1000 ms/);
  assert.ok(Date.now() - started < 1400, 'timer must not restart on the redirect');
});

test('downloadOnce reports connection errors with the error code', async () => {
  const port = await freePort();
  await assert.rejects(downloadOnce(`http://127.0.0.1:${port}/`, 5000), new RegExp(`ECONNREFUSED 127\\.0\\.0\\.1:${port}`));
});

test('downloadOnce reports a refused connection to a multi-address host (AggregateError)', async () => {
  // "localhost" may resolve to both ::1 and 127.0.0.1; Node 20+ then tries both and throws an
  // AggregateError whose message is empty. The error code must still reach the user.
  const port = await freePort();
  await assert.rejects(downloadOnce(`http://localhost:${port}/`, 5000), new RegExp(`ECONNREFUSED .*:${port}`));
});

test('downloadOnce downloads over HTTPS with a trusted certificate', async () => {
  const r = await downloadOnce(`${httpsUrl}/ok`, 5000, undefined, { agents: trustingAgents() });
  assert.equal(r.bytes, BODY_SIZE);
});

test('downloadOnce verifies the TLS certificate', async () => {
  await assert.rejects(downloadOnce(`${httpsUrl}/ok`, 5000), /self[- ]signed certificate/i);
});

test('downloadOnce follows a redirect from http to https', async () => {
  const r = await downloadOnce(`${baseUrl}/to-https`, 5000, undefined, { agents: trustingAgents() });
  assert.equal(r.bytes, BODY_SIZE);
});

test('runSpeedtest makes N sequential requests', async () => {
  hits = 0;
  maxActive = 0;
  const results = await runSpeedtest(`${baseUrl}/ok`, { count: 5, timeout: 5000 });
  assert.equal(results.length, 5);
  assert.equal(hits, 5);
  assert.equal(maxActive, 1, 'requests must not overlap');
  assert.ok(results.every((r) => r.ok && r.bytes === BODY_SIZE));
});

test('runSpeedtest reuses one keep-alive connection for all requests', async () => {
  const before = connections;
  await runSpeedtest(`${baseUrl}/ok`, { count: 5, timeout: 5000 });
  assert.equal(connections - before, 1);
});

test('runSpeedtest retries once when the server closed the reused keep-alive connection', async () => {
  const results = await runSpeedtest(`${baseUrl}/reset-on-reuse`, { count: 3, timeout: 5000 });
  assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
});

test('runSpeedtest skips failed requests and keeps going', async () => {
  flakyCalls = 0;
  const results = await runSpeedtest(`${baseUrl}/flaky`, { count: 4, timeout: 5000 });
  assert.equal(results.length, 4);
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.equal(results.filter((r) => !r.ok).length, 2);
  assert.match(results.find((r) => !r.ok).error, /HTTP 500/);
});

test('runSpeedtest stops on abort and returns the results collected so far', async () => {
  const controller = new AbortController();
  const results = await runSpeedtest(`${baseUrl}/ok`, {
    count: 10,
    timeout: 5000,
    signal: controller.signal,
    onResult: (_r, i) => { if (i === 2) controller.abort(); },
  });
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.ok));
});

test('aborting cancels the in-flight request immediately, without waiting for the timeout', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  const results = await runSpeedtest(`${baseUrl}/hang`, { count: 3, timeout: 10_000, signal: controller.signal });
  assert.equal(results.length, 0, 'the cancelled request must not be recorded as a failure');
  assert.ok(Date.now() - started < 2000);
});

test('downloadOnce rejects with InterruptedError when the signal is already aborted', async () => {
  await assert.rejects(downloadOnce(`${baseUrl}/ok`, 5000, AbortSignal.abort()), InterruptedError);
});

test('summarize computes totals, average and speed from successful requests only', () => {
  const s = summarize([
    { ok: true, bytes: 1_000_000, ms: 1000 },
    { ok: false, error: 'HTTP 500' },
    { ok: true, bytes: 3_000_000, ms: 1000 },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.succeeded, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.totalBytes, 4_000_000);
  assert.equal(s.avgMs, 1000);
  // 4 MB in 2 s = 2 MB/s = 16 Mbit/s
  assert.equal(s.mbps, 16);
  assert.equal(s.megabytesPerSec, 2);
});

test('summarize handles the all-failed case', () => {
  const s = summarize([{ ok: false, error: 'x' }]);
  assert.equal(s.succeeded, 0);
  assert.equal(s.totalBytes, 0);
  assert.equal(s.avgMs, null);
  assert.equal(s.minMs, null);
  assert.equal(s.medianMs, null);
  assert.equal(s.maxMs, null);
  assert.equal(s.mbps, null);
});

test('summarize reports min, median and max of successful requests', () => {
  const s = summarize([
    { ok: true, bytes: 1, ms: 300 },
    { ok: true, bytes: 1, ms: 100 },
    { ok: false, error: 'ignored' },
    { ok: true, bytes: 1, ms: 2000 },
  ]);
  assert.equal(s.minMs, 100);
  assert.equal(s.medianMs, 300);
  assert.equal(s.maxMs, 2000);
});

test('median averages the two middle values for an even count', () => {
  assert.equal(median([1, 2, 3, 10]), 2.5);
  assert.equal(median([5]), 5);
  assert.equal(median([]), null);
});

test('formatReport shows the min/median/max line', () => {
  const out = formatReport(summarize([{ ok: true, bytes: 1, ms: 100 }, { ok: true, bytes: 1, ms: 300 }]));
  assert.match(out, /Min\/med\/max:\s+100 \/ 200 \/ 300 ms/);
});

test('summarize returns null speed for zero elapsed time instead of Infinity', () => {
  const s = summarize([{ ok: true, bytes: 100, ms: 0 }]);
  assert.equal(s.mbps, null);
  assert.match(formatReport(s), /n\/a \(zero elapsed time\)/);
});

test('formatReport does not claim failures when no request completed', () => {
  assert.match(formatReport(summarize([])), /n\/a \(no requests completed\)/);
});

test('formatReport includes speed with units', () => {
  const out = formatReport(summarize([{ ok: true, bytes: 1_000_000, ms: 1000 }]));
  assert.match(out, /8\.00 Mbit\/s/);
  assert.match(out, /1\.00 MB\/s/);
});
