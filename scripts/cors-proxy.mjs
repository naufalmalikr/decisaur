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

import { Agent, createServer, request as httpRequest } from 'node:http';

const listenPort = Number(process.env.DECISAUR_PROXY_PORT ?? 11436);
const upstreamPort = Number(process.env.OLLAMA_PORT ?? 11434);
const upstreamHost = process.env.OLLAMA_HOST ?? '127.0.0.1';

/**
 * Keep-alive towards Ollama. Without this every POST opens a new TCP connection
 * (the default globalAgent has `keepAlive: false`), paying a handshake plus a
 * fresh accept on Ollama per query. With this the socket is reused across
 * obstacles (far band -> near band). `maxSockets` is loose so preflights and
 * other GETs never queue behind a model POST.
 */
const upstreamAgent = new Agent({
  keepAlive: true,
  keepAliveMsecs: 10_000,
  maxSockets: 10,
  maxFreeSockets: 5,
});

/** Hop-by-hop headers belong to one connection only — never forward them, let Node set them. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

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
  for (const name of HOP_BY_HOP) delete forwarded[name];
  forwarded.host = `${upstreamHost}:${upstreamPort}`;
  return forwarded;
}

/**
 * Strip hop-by-hop headers from the upstream response before passing it to the
 * browser. `content-length` / `content-type` pass through; `connection` /
 * `transfer-encoding` are left for Node to write for the reused browser->proxy
 * socket.
 *
 * @param {import('node:http').IncomingHttpHeaders} headers
 */
function downstreamHeaders(headers) {
  const forwarded = { ...headers };
  for (const name of HOP_BY_HOP) delete forwarded[name];
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
    {
      host: upstreamHost,
      port: upstreamPort,
      path: req.url,
      method: req.method,
      headers: upstreamHeaders(req.headers),
      agent: upstreamAgent,
    },
    (up) => {
      // Ollama's own headers win on content negotiation; the CORS ones are ours,
      // because upstream has none to keep.
      res.writeHead(up.statusCode ?? 502, { ...downstreamHeaders(up.headers), ...CORS_HEADERS });
      up.pipe(res);
    },
  );

  // Browser went away (navigation / tab closed) -> don't leave the upstream keep-alive socket hanging.
  req.on('aborted', () => upstream.destroy());
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

/**
 * Browser->proxy side. Browsers reuse connections automatically as long as the
 * server allows it; Node's default `keepAliveTimeout` of 5s is too short across
 * widely spaced obstacles, so the connection drops and is reopened. 30s bridges
 * the gap between obstacles without holding idle sockets long. `headersTimeout`
 * must stay above it (a Node requirement). Set before `listen` so the first
 * connection already uses them.
 */
server.keepAliveTimeout = 30_000;
server.headersTimeout = 35_000;

server.listen(listenPort, '127.0.0.1', () => {
  console.info(`[decisaur] proxy http://127.0.0.1:${listenPort} -> http://${upstreamHost}:${upstreamPort}`);
  console.info(`[decisaur] set decisaurHost = 'http://127.0.0.1:${listenPort}' before pasting the bundle`);
});