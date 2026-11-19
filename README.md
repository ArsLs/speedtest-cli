# speedtest-cli

[![CI](https://github.com/ArsLs/speedtest-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/ArsLs/speedtest-cli/actions/workflows/ci.yml)

Console script that measures download speed: it downloads a given URL several times
sequentially (10 by default), waits for each full response, and prints the average
request time, the total amount of downloaded data and the resulting download speed.

No runtime dependencies, only Node.js built-ins.

## Requirements

- Node.js 18.11 or newer (uses `node:http` / `node:https` and `util.parseArgs`).
  CI runs the tests on 18.11.0, 18, 20, 22 and 24.

## Run

```bash
git clone https://github.com/ArsLs/speedtest-cli.git
cd speedtest-cli
node cli.js 'https://speed.cloudflare.com/__down?bytes=10000000'
```

Put the URL in quotes: characters like `?` and `&` are special in zsh/bash.

Or via npm:

```bash
npm start -- 'https://speed.cloudflare.com/__down?bytes=10000000'
```

### Options

| Option | Default | Description |
|---|---|---|
| `-n, --count N` | `10` | Number of sequential requests (1 to 10000) |
| `-t, --timeout MS` | `30000` | Timeout for one request: connection, redirects and full body, in ms |
| `--json` | off | Print the result as JSON to stdout; progress goes to stderr |
| `-h, --help` | | Show help |

Press **Ctrl+C** during a run to stop it and still get the summary of the requests
completed so far. A second Ctrl+C quits immediately.

### Example output

```
Downloading https://speed.cloudflare.com/__down?bytes=10000000 10 times...

Request  1/10: 10.00 MB in 2155 ms
Request  2/10: 10.00 MB in 1543 ms
Request  3/10: 10.00 MB in 988 ms
Request  4/10: 10.00 MB in 1060 ms
Request  5/10: 10.00 MB in 978 ms
Request  6/10: 10.00 MB in 1017 ms
Request  7/10: 10.00 MB in 989 ms
Request  8/10: 10.00 MB in 1009 ms
Request  9/10: 10.00 MB in 1032 ms
Request 10/10: 10.00 MB in 1001 ms

Requests:      10/10 succeeded
Total data:    100.00 MB (100000000 bytes)
Average time:  1177.2 ms
Min/med/max:   978 / 1013 / 2155 ms
Speed:         67.96 Mbit/s (8.50 MB/s)
```

### JSON output

```bash
node cli.js 'https://speed.cloudflare.com/__down?bytes=10000000' --json 2>/dev/null | jq '.summary.mbps'
```

```json
{
  "url": "https://speed.cloudflare.com/__down?bytes=10000000",
  "count": 10,
  "timeoutMs": 30000,
  "interrupted": false,
  "summary": {
    "total": 10, "succeeded": 10, "failed": 0,
    "totalBytes": 100000000, "totalMs": 11772.0,
    "avgMs": 1177.2, "minMs": 978.0, "medianMs": 1013.0, "maxMs": 2155.0,
    "mbps": 67.96, "megabytesPerSec": 8.5
  },
  "requests": [{ "ok": true, "bytes": 10000000, "ms": 2155.0 }, "..."]
}
```

Failed requests appear in `requests` as `{ "ok": false, "error": "..." }`. If the server sent
a compressed body despite `Accept-Encoding: identity`, the request also has `"encoding": "gzip"`
(or `br`, ...). Time values are not rounded in the real output.

## Units

- **Speed** is printed in **Mbit/s** (megabits per second), the unit ISPs use,
  with **MB/s** (megabytes per second) in parentheses.
- Decimal prefixes: 1 Mbit = 1,000,000 bits, 1 MB = 1,000,000 bytes.
- **Time** is in milliseconds.

## How it is measured

1. Requests are made strictly one after another: the next one starts only after the
   previous body has been read to the last byte.
2. Time of one request = from sending the request to receiving the last byte of the body
   (`performance.now()`). It includes DNS, connection and TLS setup and any redirects,
   so the first request is usually slower; subsequent ones reuse the keep-alive connection.
3. Data volume = bytes of the response body as received from the network, summed chunk by
   chunk: after removing chunked transfer framing, but never decompressed.
4. **Average time** = total time of successful requests / number of successful requests.
   **Min / median / max** are reported next to it because the mean is sensitive to outliers.
5. **Speed** = total bytes / total time of successful requests:
   `bytes * 8 / seconds / 10^6` Mbit/s.

## Design decisions

**Speed is total bytes over total time, not the mean of per-request speeds.**
Example: 1 MB in 1 s (8 Mbit/s) and 1 MB in 0.1 s (80 Mbit/s). The mean of speeds says
44 Mbit/s, but 2 MB actually took 1.1 s, which is 14.5 Mbit/s. The mean of rates
overweights fast requests; the ratio of totals is what the link actually delivered.

**A failed request is skipped, not fatal.** A single timeout or 5xx out of ten should not
throw away nine good samples. Failures are shown as `FAILED (reason)` and excluded from
time, volume and speed. If every request fails, the speed is `n/a` and the exit code is 1.

**An empty body counts as a failure.** A 204 or an empty 200 only measures latency, so it
cannot tell anything about download speed and would drag the averages down. It is reported
as `FAILED (Empty response body, download speed cannot be measured from this request)`.

**`node:http` / `node:https` instead of `fetch`.** `fetch` always decompresses gzip/br bodies,
even when we ask for `identity`, so a server that ignores the request would make the script
count decoded bytes and overstate the speed. `node:http` hands over the body exactly as it
arrived. The price is handling redirects, keep-alive and cut-off bodies ourselves; each of
these has a test.

**Bytes are counted from the stream, not taken from `Content-Length`.** The header may be
missing (chunked responses) or not match what was delivered. It is used only as a check: a
body cut off mid-stream (fewer bytes than promised, or a chunked body without its final chunk)
is a failure, not a partial success.

**One keep-alive connection per run.** Every run creates its own agent with one socket per
host, so requests 2..N reuse the connection opened by the first one, independent of the Node
version's defaults. The agent is destroyed at the end of the run. If the server has already
closed that connection when the next request reuses it (`ECONNRESET` before any response),
the request is retried once on a fresh connection instead of being counted as a failure.

**One timeout per request covers everything:** connection, redirects, headers and body.
It is implemented with our own `AbortController` and timer, so a timeout is detected by
state rather than by error name, which differs between Node versions. The Ctrl+C signal is
connected to the same controller by hand instead of `AbortSignal.any()`, which keeps
Node 18.11 support.

**Redirects are followed** (301, 302, 303, 307, 308; up to 20 hops, relative `Location`
supported, http and https in both directions), and the final response is the one measured.
Redirect hops are included in the request time; their bodies are not counted.

**Strict argument validation.** `--count` and `--timeout` accept only plain decimal
integers (`1e1`, `0x10` and `1.0` are rejected). The timeout is capped at 2^31-1 ms
because a larger `setTimeout` delay fires immediately. Invalid input exits with code 2,
so it is never mistaken for a network failure.

**No runtime dependencies.** Everything needed (`node:https`, `parseArgs`, `node:test`) ships
with Node, so there is nothing to install and nothing to audit.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | At least one request succeeded |
| `1` | All requests failed |
| `2` | Invalid arguments |
| `130` | Interrupted with Ctrl+C (summary of completed requests is still printed) |

## Limitations

- Requests are sent with `Cache-Control: no-cache` and `Accept-Encoding: identity`
  to avoid cached and compressed responses, but a server or CDN may ignore them.
  A compressed body is counted as received (the compressed size), and the script prints
  a note, because the result then says less about the size of the file itself.
- HTTP/1.1 only, no HTTP/2 or HTTP/3.
- A redirect body is read to the end (and not counted) before the next hop, so that the
  connection can be reused. Redirect bodies are tiny in practice, but a slow one adds its
  time to the request.
- Measures HTTP download throughput to one specific server, which may be limited by
  that server rather than by your connection. Pick a large file (10 MB or more) on a fast host.
- Only the response body is counted; HTTP headers and TLS overhead are not.

## Tests

```bash
npm test
```

Tests use the built-in `node:test` runner and a local HTTP server, so they do not need
internet access. They cover:

- the full body is read and requests never overlap;
- failed requests are skipped and the run continues;
- timeouts (one for the whole redirect chain), refused connections and HTTP error statuses;
- empty 200 and 204 responses, bodies truncated mid-stream (with and without Content-Length);
- a gzip body counted as received, not decompressed;
- redirects: absolute, relative, chains, loops, missing Location, unsupported protocol;
- HTTPS with a self-signed test certificate (`test/fixtures/`), certificate verification
  and an http to https redirect;
- one keep-alive connection per run;
- cancellation: the in-flight request is aborted at once and not counted;
- the summary math: totals, average, min/median/max, speed and edge cases.

## Project structure

```
cli.js              argument parsing, progress output, --json, Ctrl+C, exit codes
speedtest.js        download, aggregation and formatting logic
speedtest.test.js   tests
test/fixtures/      self-signed certificate for the HTTPS tests (test only, not a secret)
.github/workflows/  CI
```
