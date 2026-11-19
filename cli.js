#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runSpeedtest, summarize, formatReport, formatBytes } from './speedtest.js';

const USAGE = `Usage: node cli.js <url> [--count N] [--timeout MS] [--json]

Options:
  -n, --count N      number of sequential requests (default: 10)
  -t, --timeout MS   per-request timeout in milliseconds (default: 30000)
      --json         print the result as JSON to stdout (progress goes to stderr)
  -h, --help         show this help`;

function fail(message) {
  console.error(`Error: ${message}\n\n${USAGE}`);
  process.exit(2);
}

// setTimeout() cannot wait longer than 2^31-1 ms (~24.8 days); larger values fire immediately.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const MAX_COUNT = 10_000;

// Accept only plain decimal integers: rejects "1e1", "0x10", "1.0", " 5", "-3".
function parsePositiveInt(value, name, max) {
  if (!/^[1-9]\d*$/.test(value)) fail(`--${name} must be a positive integer, got "${value}"`);
  const n = Number(value);
  if (n > max) fail(`--${name} must be at most ${max}, got ${value}`);
  return n;
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      count: { type: 'string', short: 'n', default: '10' },
      timeout: { type: 'string', short: 't', default: '30000' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (err) {
  fail(err.message);
}

const { values, positionals } = parsed;

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

if (positionals.length !== 1) fail('exactly one URL is required');

let url;
try {
  url = new URL(positionals[0]);
} catch {
  fail(`invalid URL "${positionals[0]}"`);
}
if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('only http and https URLs are supported');

const count = parsePositiveInt(values.count, 'count', MAX_COUNT);
const timeout = parsePositiveInt(values.timeout, 'timeout', MAX_TIMEOUT_MS);

// First Ctrl+C: cancel the in-flight request and print the summary of what was measured.
// The listener is registered once, so a second Ctrl+C falls back to Node's default (exit now).
const controller = new AbortController();
process.once('SIGINT', () => {
  console.error('\nInterrupted, printing results so far (Ctrl+C again to quit immediately)');
  controller.abort();
});

// Human-readable progress goes to stdout normally. In --json mode stdout carries only the
// JSON document (so it can be piped to jq etc.), and progress moves to stderr.
const log = values.json ? console.error : console.log;

log(`Downloading ${url.href} ${count} times...\n`);

const width = String(count).length;
let warnedEncoding = false;
const results = await runSpeedtest(url.href, {
  count,
  timeout,
  signal: controller.signal,
  onResult(r, i) {
    const label = `Request ${String(i + 1).padStart(width)}/${count}:`;
    log(r.ok ? `${label} ${formatBytes(r.bytes)} in ${r.ms.toFixed(0)} ms` : `${label} FAILED (${r.error})`);
    // Shown once: the numbers are still correct for the network, but not for the file size.
    if (r.encoding && !warnedEncoding) {
      warnedEncoding = true;
      log(
        `  Note: the server ignored "Accept-Encoding: identity" and sent a ${r.encoding}-compressed body.\n` +
          '  The compressed bytes received over the network are counted.',
      );
    }
  },
});

const summary = summarize(results);
const interrupted = controller.signal.aborted;

if (values.json) {
  const report = { url: url.href, count, timeoutMs: timeout, interrupted, summary, requests: results };
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\n${formatReport(summary)}`);
}

// 130 = 128 + SIGINT(2), the conventional exit code for a run stopped with Ctrl+C.
if (interrupted) process.exitCode = 130;
else if (summary.succeeded === 0) process.exitCode = 1;
