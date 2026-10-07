/**
 * CORS proxy between the browser bundle and Ollama.
 *
 * This is NOT what makes `chrome://dino` able to reach Ollama, and no header set here
 * can make it. Chrome refuses the request outright when the page is not a secure
 * context and the target is in the loopback address space, and it refuses it locally:
 * measured on Chrome 154, no preflight and no request reach the network at all. That is
 * why it surfaces as a CORS error rather than a connection failure. Chrome enforces it
 * with the `LocalNetworkAccessChecks` feature, and the only way through is to launch
 * without that check:
 *
 *   google-chrome --disable-features=LocalNetworkAccessChecks
 *
 * (or serve the game from `http://localhost`, which is a secure context and so is not
 * gated at all).
 *
 * What this does fix is the *Ollama* side of the same request, which fails separately
 * and is what this file is actually for. Ollama's browser-origin middleware answers
 * anything carrying an `Origin` it does not allow with a bare `403` and no CORS headers,
 * and `Origin: null` is never allowed - so a preflight-only proxy still gets `403` on
 * every model call. So this proxy is the origin boundary: it drops `Origin` on the way
 * upstream, which is what gets a `200` at all, and adds `Access-Control-Allow-Origin`
 * plus `Access-Control-Allow-Private-Network` on the way back. `OLLAMA_ORIGINS` would
 * not help; Ollama still never sends the private-network header.
 *
 * Streaming responses are passed through as they arrive rather than buffered, since
 * the model endpoint answers once but /api/chat does not.
 *
 *   node scripts/cors-proxy.mjs
 *   decisaurHost = 'http://127.0.0.1:11436'   // in the console, before pasting
 */

import { createServer, request as httpRequest } from 'node:http';

const listenPort = Number(process.env.DECISAUR_PROXY_PORT ?? 11436);
const upstreamPort = Number(process.env.OLLAMA_PORT ?? 11434);
const upstreamHost = process.env.OLLAMA_HOST ?? '127.0.0.1';

/**
 * Sent on every response, preflight or not. `Origin: null` is not a wildcard, so a
 * literal `*` is the only value that covers both `chrome://dino` and real origins.
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Expose-Headers': '*',
};

/**
 * Answer the CORS preflight, including the private-network permission Chrome wants.
 * `Vary` keeps caches from serving this response to a non-browser client.
 */
function preflight(res) {
  res.writeHead(204, {
    ...CORS_HEADERS,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,Accept,User-Agent,X-Requested-With',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network',
  });
  res.end();
}

/**
 * Strip what makes Ollama refuse the call. It 403s on an unrecognised `Origin`
 * before any routing, so `Origin: null` has to go. `Host` is rewritten so upstream
 * sees its own address rather than the proxy's.
 *
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {import('node:http').OutgoingHttpHeaders}
 */
function upstreamHeaders(headers) {
  const forwarded = { ...headers };
  delete forwarded.origin;
  delete forwarded['access-control-request-private-network'];
  forwarded.host = `${upstreamHost}:${upstreamPort}`;
  return forwarded;
}

const server = createServer((req, res) => {
  if (process.env.DECISAUR_PROXY_LOG !== '0') {
    console.info(`[decisaur] ${req.method} ${req.url} origin=${req.headers.origin ?? '-'} pna=${req.headers['access-control-request-private-network'] ?? '-'}`);
  }

  if (req.method === 'OPTIONS') {
    preflight(res);
    return;
  }

  const upstream = httpRequest(
    { host: upstreamHost, port: upstreamPort, path: req.url, method: req.method, headers: upstreamHeaders(req.headers) },
    (up) => {
      // Ollama's own headers win on content negotiation; the CORS ones are ours,
      // because upstream has none to keep.
      res.writeHead(up.statusCode ?? 502, { ...up.headers, ...CORS_HEADERS });
      up.pipe(res);
    },
  );

  upstream.on('error', (error) => {
    const dead = error.code === 'ECONNREFUSED';
    res.writeHead(502, {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    });
    res.end(
      JSON.stringify({
        error: dead
          ? `ollama is not listening on ${upstreamHost}:${upstreamPort}`
          : error.message,
      }),
    );
  });

  req.pipe(upstream);
});

server.listen(listenPort, '127.0.0.1', () => {
  console.info(`[decisaur] proxy http://127.0.0.1:${listenPort} -> http://${upstreamHost}:${upstreamPort}`);
  console.info(`[decisaur] set decisaurHost = 'http://127.0.0.1:${listenPort}' before pasting the bundle`);
});