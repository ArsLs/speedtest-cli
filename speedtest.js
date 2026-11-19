import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const { version } = createRequire(import.meta.url)('./package.json');

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HEADERS = {
  // Ask intermediaries not to serve a cached copy.
  'Cache-Control': 'no-cache',
  // Ask for the raw body. node:http never decompresses, so if a server ignores this, we count
  // the compressed bytes that actually went over the network and report the encoding.
  'Accept-Encoding': 'identity',
  // Some CDNs reject requests without a User-Agent.
  'User-Agent': `speedtest-cli/${version}`,
};

/** Send one GET request (no redirect handling) and resolve with the response once headers arrive. */
function get(url, signal, agents, isRetry = false) {
  const isHttps = url.protocol === 'https:';
  const client = isHttps ? https : http;
  // A caller-provided agent (keep-alive, custom CA); `false` means a fresh connection.
  const agent = (isHttps ? agents?.https : agents?.http) ?? false;
  return new Promise((resolve, reject) => {
    let responded = false;
    // `signal` aborts the request at any stage: DNS, connect, headers or body.
    const req = client.get(url, { headers: HEADERS, agent, signal }, (res) => {
      responded = true;
      resolve(res);
    });
    req.on('error', (err) => {
      // A server may close an idle keep-alive connection right when we reuse it. That is not
      // a network failure, so retry once; the agent opens a fresh connection for the retry.
      const staleSocket = req.reusedSocket && !responded && (err.code === 'ECONNRESET' || err.code === 'EPIPE');
      if (staleSocket && !isRetry && !signal.aborted) {
        resolve(get(url, signal, agents, true));
      } else {
        reject(err);
      }
    });
  });
}

/** Read the body to the end and return its size in bytes; reject if it was cut off. */
async function countBody(res) {
  let bytes = 0;
  try {
    for await (const chunk of res) {
      bytes += chunk.length;
    }
  } catch (err) {
    // The stream errors if the connection drops before the end of the message: fewer bytes
    // than Content-Length, or a chunked body without its final chunk (tested on Node 18-24).
    throw new Error(`Incomplete body: connection lost after ${bytes} bytes (${err.message})`);
  }
  return bytes;
}

/**
 * Download the URL once, following redirects and reading the final body to the last byte.
 * Resolves with { bytes, ms } and, if the server compressed the body anyway, `encoding`.
 * Rejects on network error, non-2xx status, cut-off body, empty body or timeout,
 * and with InterruptedError if `signal` is aborted.
 * `agents` ({ http, https }) lets the caller reuse connections or trust a custom CA.
 */
export async function downloadOnce(url, timeoutMs, signal, { agents } = {}) {
  if (signal?.aborted) throw new InterruptedError();

  // Own controller + timer: we detect the timeout by checking our flag, not by error name.
  // The outer `signal` (Ctrl+C) is wired in by hand; AbortSignal.any() needs Node 20.3+.
  // One timer for the whole call, so it covers DNS, connection, every redirect and the body.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  const start = performance.now();
  try {
    let current = new URL(url);
    let res;
    for (let redirects = 0; ; redirects++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new Error(`Unsupported protocol "${current.protocol}"`);
      }
      res = await get(current, controller.signal, agents);
      if (!REDIRECT_STATUSES.has(res.statusCode)) break;

      // Discard the redirect body (not counted) so the connection can be reused.
      res.resume();
      const location = res.headers.location;
      if (!location) throw new Error(`HTTP ${res.statusCode} redirect without Location header`);
      if (redirects === MAX_REDIRECTS) throw new Error(`Too many redirects (${MAX_REDIRECTS})`);
      // Resolve relative locations ("/ok", "../ok", "ok") against the current URL.
      try {
        current = new URL(location, current);
      } catch {
        throw new Error(`HTTP ${res.statusCode} redirect to invalid Location "${location}"`);
      }
    }

    if (res.statusCode < 200 || res.statusCode > 299) {
      res.resume();
      throw new Error(`HTTP ${res.statusCode} ${res.statusMessage ?? ''}`.trim());
    }

    const bytes = await countBody(res);
    const ms = performance.now() - start;

    // 0 bytes means only latency was measured, not throughput: treat as a failed sample.
    if (bytes === 0) {
      throw new Error('Empty response body, download speed cannot be measured from this request');
    }

    const encoding = res.headers['content-encoding'];
    return encoding && encoding !== 'identity' ? { bytes, ms, encoding } : { bytes, ms };
  } catch (err) {
    if (signal?.aborted) {
      throw new InterruptedError();
    }
    if (timedOut) {
      throw new Error(`Timed out after ${timeoutMs} ms`);
    }
    // When a host has several addresses (e.g. localhost -> ::1 and 127.0.0.1), Node 20+ tries
    // them all and throws an AggregateError with an empty message; report each attempt instead.
    if (!err.message) {
      const details = err.errors?.map((e) => e.message).join('; ') || err.code || 'unknown error';
      throw new Error(`Connection failed: ${details}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Thrown when the run is cancelled from outside (e.g. Ctrl+C), as opposed to a failed request. */
export class InterruptedError extends Error {
  constructor() {
    super('Interrupted');
    this.name = 'InterruptedError';
  }
}

/**
 * Perform `count` downloads strictly one after another.
 * A failed request does not stop the run; it is recorded with ok: false.
 * If `signal` is aborted, the in-flight request is cancelled and not recorded, the loop
 * stops, and the results collected so far are returned (check signal.aborted to tell).
 * `onResult` is called after each request (used by the CLI for progress output).
 */
export async function runSpeedtest(url, { count = 10, timeout = 30000, signal, onResult } = {}) {
  // Keep-alive agents for this run: only the first request pays for DNS, TCP and TLS, the rest
  // reuse the connection. One socket per host is enough for strictly sequential requests.
  // Explicit agents behave the same on every Node version (the global agent's keepAlive default
  // changed in Node 19) and are destroyed at the end, so no sockets keep the process alive.
  const agents = {
    http: new http.Agent({ keepAlive: true, maxSockets: 1 }),
    https: new https.Agent({ keepAlive: true, maxSockets: 1 }),
  };
  const results = [];
  try {
    for (let i = 0; i < count; i++) {
      let result;
      try {
        const r = await downloadOnce(url, timeout, signal, { agents });
        result = { ok: true, ...r };
      } catch (err) {
        if (err instanceof InterruptedError) break;
        result = { ok: false, error: err.message };
      }
      results.push(result);
      onResult?.(result, i);
    }
  } finally {
    agents.http.destroy();
    agents.https.destroy();
  }
  return results;
}

/**
 * Aggregate results. Only successful requests count towards bytes, time and speed.
 * Speed = total bytes / total time of successful requests.
 * Units: Mbit/s and MB/s, decimal (1 Mbit = 10^6 bits, 1 MB = 10^6 bytes).
 */
export function summarize(results) {
  const ok = results.filter((r) => r.ok);
  const totalBytes = ok.reduce((sum, r) => sum + r.bytes, 0);
  const totalMs = ok.reduce((sum, r) => sum + r.ms, 0);
  const totalSec = totalMs / 1000;
  const times = ok.map((r) => r.ms).sort((a, b) => a - b);

  return {
    total: results.length,
    succeeded: ok.length,
    failed: results.length - ok.length,
    totalBytes,
    totalMs,
    avgMs: ok.length ? totalMs / ok.length : null,
    // The mean is skewed by outliers (e.g. the first request also pays for DNS and TLS),
    // so min / median / max are reported alongside it.
    minMs: times.length ? times[0] : null,
    medianMs: median(times),
    maxMs: times.length ? times[times.length - 1] : null,
    mbps: totalSec > 0 ? (totalBytes * 8) / totalSec / 1e6 : null,
    megabytesPerSec: totalSec > 0 ? totalBytes / totalSec / 1e6 : null,
  };
}

/** Median of an already sorted array; null for an empty one. */
export function median(sorted) {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function formatBytes(bytes) {
  return `${(bytes / 1e6).toFixed(2)} MB`;
}

export function formatReport(s) {
  const lines = [
    `Requests:      ${s.succeeded}/${s.total} succeeded${s.failed ? ` (${s.failed} failed, skipped)` : ''}`,
    `Total data:    ${formatBytes(s.totalBytes)} (${s.totalBytes} bytes)`,
  ];
  if (s.succeeded > 0) {
    lines.push(`Average time:  ${s.avgMs.toFixed(1)} ms`);
    lines.push(
      `Min/med/max:   ${s.minMs.toFixed(0)} / ${s.medianMs.toFixed(0)} / ${s.maxMs.toFixed(0)} ms`,
    );
    lines.push(
      s.mbps === null
        ? 'Speed:         n/a (zero elapsed time)'
        : `Speed:         ${s.mbps.toFixed(2)} Mbit/s (${s.megabytesPerSec.toFixed(2)} MB/s)`,
    );
  } else if (s.total === 0) {
    lines.push('Speed:         n/a (no requests completed)');
  } else {
    lines.push('Speed:         n/a (all requests failed)');
  }
  return lines.join('\n');
}
