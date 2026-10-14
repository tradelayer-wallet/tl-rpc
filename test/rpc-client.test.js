'use strict';
// Regression tests for RpcClient. Run with `npm test` (builds lib/ first).
// Each test exercises a finding from the security review; the comment on each
// test names the finding and the behaviour it pins down.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { RpcClient } = require('../lib/index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal raw HTTP/1.1 server: reads one request (headers + Content-Length
// body) and hands the socket plus the request to `onRequest`, so tests can
// control the exact bytes and their segmentation on the wire.
function rawServer(onRequest) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      buf = Buffer.concat([buf, chunk]);
      const headEnd = buf.indexOf('\r\n\r\n');
      if (headEnd === -1) return;
      const head = buf.subarray(0, headEnd).toString('latin1');
      const m = /content-length:\s*(\d+)/i.exec(head);
      const len = m ? Number(m[1]) : 0;
      if (buf.length < headEnd + 4 + len) return;
      handled = true;
      onRequest(socket, {
        head,
        body: buf.subarray(headEnd + 4, headEnd + 4 + len).toString('utf8'),
      });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close: () => {
          for (const s of sockets) s.destroy();
          return new Promise((r) => server.close(r));
        },
      })
    )
  );
}

const jsonResponse = (status, obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  return {
    head: `HTTP/1.1 ${status} X\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
    body,
  };
};

// Writes `buf` in pieces split at `cuts` (byte offsets), with a gap between
// writes so each piece reaches the client as its own TCP read.
async function writeSplit(socket, buf, cuts, gapMs = 20) {
  let prev = 0;
  for (const cut of [...cuts, buf.length]) {
    socket.write(buf.subarray(prev, cut));
    prev = cut;
    if (cut < buf.length) await sleep(gapMs);
  }
}

// N6: a UTF-8 sequence split across TCP segments must decode intact. The old
// code decoded each chunk separately (`buffer += chunk`) and returned U+FFFD.
test('N6: multibyte UTF-8 split across TCP segments decodes intact (result)', async () => {
  const obj = { result: '日本語🚀 héllo', error: null, id: 1 };
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const jp = payload.indexOf(Buffer.from('日'));
  const rocket = payload.indexOf(Buffer.from('🚀'));
  // Cuts inside the 3-byte CJK char and inside the 4-byte emoji.
  const cuts = [jp + 1, jp + 2, rocket + 1, rocket + 3];
  const srv = await rawServer(async (socket) => {
    const r = jsonResponse(200, obj);
    socket.write(r.head);
    await writeSplit(socket, payload, cuts);
  });
  try {
    const res = await new RpcClient({ host: '127.0.0.1', port: srv.port, timeout: 5000 }).call('x');
    assert.equal(res.data, '日本語🚀 héllo');
  } finally {
    await srv.close();
  }
});

// N6 (error path): the JSON-RPC error message goes through the same single
// decode, so a split sequence in an error body must not be corrupted either.
test('N6: multibyte UTF-8 split across TCP segments decodes intact (error message)', async () => {
  const obj = { result: null, error: { code: -1, message: 'bad ✓ input' }, id: 1 };
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const check = payload.indexOf(Buffer.from('✓'));
  const srv = await rawServer(async (socket) => {
    const r = jsonResponse(500, obj);
    socket.write(r.head);
    await writeSplit(socket, payload, [check + 1, check + 2]);
  });
  try {
    const res = await new RpcClient({ host: '127.0.0.1', port: srv.port, timeout: 5000 }).call('x');
    assert.equal(res.error, 'bad ✓ input');
    assert.equal(res.IECode, 2);
  } finally {
    await srv.close();
  }
});

// N5: the client asks every hop not to re-encode the body, so the bytes it
// decodes are the bytes the node sent.
test('N5: request sends Accept-Encoding: identity', async () => {
  let seenHead = '';
  const srv = await rawServer((socket, req) => {
    seenHead = req.head;
    const r = jsonResponse(200, { result: 1, error: null, id: 1 });
    socket.end(r.head + r.body.toString('utf8'));
  });
  try {
    await new RpcClient({ host: '127.0.0.1', port: srv.port, timeout: 5000 }).call('x');
    assert.match(seenHead, /^accept-encoding: identity$/im);
  } finally {
    await srv.close();
  }
});

// --- TLS fixtures (N11) -----------------------------------------------------
// A throwaway self-signed certificate is generated with the openssl CLI into a
// temp dir (nothing is committed). Tests that need it are skipped if openssl
// is not installed.
let tlsFixture = null;
let tlsFixtureError = null;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-rpc-test-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
    { stdio: 'ignore' }
  );
  tlsFixture = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), dir };
} catch (err) {
  tlsFixtureError = err.message;
}
const tlsSkip = tlsFixture ? false : `openssl unavailable: ${tlsFixtureError}`;

function tlsServer(onRequest) {
  const server = https.createServer({ key: tlsFixture.key, cert: tlsFixture.cert }, onRequest);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) })
    )
  );
}

// N11: a `tls` object must not be able to redirect the connection or change
// request framing/credentials. Only the ten allowlisted TLS fields are used.
test('N11: tls.socketPath / createConnection / lookup / framing overrides are ignored', { skip: tlsSkip }, async () => {
  const unixPath = path.join(tlsFixture.dir, 'evil.sock');
  let unixHits = 0;
  const unix = net.createServer((sock) => {
    unixHits++;
    sock.destroy();
  });
  await new Promise((r) => unix.listen(unixPath, r));

  let seen = null;
  const tcp = await tlsServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { method: req.method, auth: req.headers.authorization, evil: req.headers['x-evil'], body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: 'tcp', error: null, id: 1 }));
    });
  });

  let createConnectionCalls = 0;
  let lookupCalls = 0;
  try {
    const client = new RpcClient({
      username: 'alice',
      password: 'pw',
      host: '127.0.0.1',
      port: tcp.port,
      timeout: 5000,
      secure: true,
      tls: {
        ca: tlsFixture.cert,
        servername: 'localhost',
        socketPath: unixPath,
        createConnection: () => {
          createConnectionCalls++;
          return net.connect(unixPath);
        },
        lookup: (h, o, cb) => {
          lookupCalls++;
          cb(null, '127.0.0.1', 4);
        },
        setHost: false,
        agent: new https.Agent(),
        headers: { 'X-Evil': 'yes', 'Content-Length': '1' },
        method: 'GET',
        auth: 'evil:evil',
        path: '/evil',
      },
    });
    const res = await client.call('getinfo', 'arg');
    assert.equal(res.data, 'tcp', JSON.stringify(res));
    assert.equal(unixHits, 0, 'tls.socketPath redirected the connection');
    assert.equal(createConnectionCalls, 0, 'tls.createConnection was called');
    assert.equal(lookupCalls, 0, 'tls.lookup was called');
    assert.equal(seen.method, 'POST');
    assert.equal(seen.auth, 'Basic ' + Buffer.from('alice:pw').toString('base64'));
    assert.equal(seen.evil, undefined);
    assert.equal(JSON.parse(seen.body).method, 'getinfo');
  } finally {
    await tcp.close();
    await new Promise((r) => unix.close(r));
  }
});

// N11 (positive side): the allowlisted fields still work, so a private-CA
// deployment is not broken by the allowlist.
test('N11: allowlisted tls.ca is honored (private-CA deployment works, untrusted fails)', { skip: tlsSkip }, async () => {
  const tcp = await tlsServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: 'pinned', error: null, id: 1 }));
  });
  try {
    const untrusted = await new RpcClient({
      host: 'localhost', port: tcp.port, timeout: 5000, secure: true,
    }).call('x');
    assert.equal(untrusted.data, undefined, 'self-signed cert accepted without ca');
    assert.ok(untrusted.error, 'expected a certificate error');

    const pinned = await new RpcClient({
      host: 'localhost', port: tcp.port, timeout: 5000, secure: true, tls: { ca: tlsFixture.cert },
    }).call('x');
    assert.equal(pinned.data, 'pinned', JSON.stringify(pinned));
  } finally {
    await tcp.close();
  }
});

// N15: response bodies are capped while streaming. The socket is destroyed as
// soon as the cap is crossed, so the server stops sending instead of the
// client buffering the whole body.
test('N15: a body over maxResponseBytes (no Content-Length) aborts early with E2BIG', async () => {
  const chunk = Buffer.alloc(1024, 0x61); // 1 KiB
  const totalChunks = 200;
  let serverStopped = false;
  let chunksWritten = 0;
  const srv = await rawServer(async (socket) => {
    socket.on('close', () => {
      serverStopped = true;
    });
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n');
    for (let i = 0; i < totalChunks; i++) {
      if (socket.destroyed) break;
      socket.write(chunk.length.toString(16) + '\r\n');
      socket.write(chunk);
      socket.write('\r\n');
      chunksWritten++;
      await sleep(5);
    }
    socket.end('0\r\n\r\n');
  });
  try {
    const client = new RpcClient({ host: '127.0.0.1', port: srv.port, timeout: 5000, maxResponseBytes: 8 * 1024 });
    const res = await client.call('x');
    assert.equal(res.error, 'E2BIG', JSON.stringify(res));
    assert.equal(res.data, undefined);
    await sleep(100);
    assert.equal(serverStopped, true, 'client did not destroy the socket');
    assert.ok(chunksWritten < totalChunks, `server sent all ${chunksWritten} chunks`);
  } finally {
    await srv.close();
  }
});

// N15: a declared Content-Length over the cap is refused before any body byte
// is read.
test('N15: a Content-Length over maxResponseBytes is refused up front with E2BIG', async () => {
  const body = 'y'.repeat(64 * 1024);
  const srv = await rawServer((socket) => {
    socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`);
    socket.end(body);
  });
  try {
    const client = new RpcClient({ host: '127.0.0.1', port: srv.port, timeout: 5000, maxResponseBytes: 1024 });
    const res = await client.call('x');
    assert.equal(res.error, 'E2BIG', JSON.stringify(res));
  } finally {
    await srv.close();
  }
});

test('N15: a body within maxResponseBytes is returned in full', async () => {
  const big = 'z'.repeat(256 * 1024);
  const srv = await rawServer((socket) => {
    const r = jsonResponse(200, { result: big, error: null, id: 1 });
    socket.end(r.head + r.body.toString('utf8'));
  });
  try {
    const client = new RpcClient({ host: '127.0.0.1', port: srv.port, timeout: 5000, maxResponseBytes: 1024 * 1024 });
    const res = await client.call('x');
    assert.equal(res.data, big);
  } finally {
    await srv.close();
  }
});

// N16: a timeout that is not a usable number must not disable or shorten the
// deadline. undefined, 0, fractions below 1, NaN and Infinity fall back to the
// 3000 ms default, so a 300 ms response succeeds.
for (const timeout of [undefined, 0, 0.5, NaN, Infinity, -1]) {
  test(`N16: timeout=${timeout} falls back to the default and does not fire early`, async () => {
    const srv = await rawServer((socket) => {
      setTimeout(() => {
        const r = jsonResponse(200, { result: 'ok', error: null, id: 1 });
        socket.end(r.head + r.body.toString('utf8'));
      }, 300);
    });
    try {
      const res = await new RpcClient({ host: '127.0.0.1', port: srv.port, timeout }).call('x');
      assert.equal(res.data, 'ok', JSON.stringify(res));
    } finally {
      await srv.close();
    }
  });
}

// N16: a timeout above setTimeout's ceiling is capped instead of overflowing
// (which would fire at once and emit TimeoutOverflowWarning).
test('N16: timeout above 2^31-1 is capped without a TimeoutOverflowWarning', async () => {
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on('warning', onWarning);
  const srv = await rawServer((socket) => {
    setTimeout(() => {
      const r = jsonResponse(200, { result: 'ok', error: null, id: 1 });
      socket.end(r.head + r.body.toString('utf8'));
    }, 100);
  });
  try {
    const res = await new RpcClient({ host: '127.0.0.1', port: srv.port, timeout: 2 ** 32 }).call('x');
    await sleep(10);
    assert.equal(res.data, 'ok', JSON.stringify(res));
    assert.deepEqual(warnings, []);
  } finally {
    process.off('warning', onWarning);
    await srv.close();
  }
});

// The normalized timeout is still enforced when it is a usable value.
test('N16: a stalled response still times out at the configured timeout', async () => {
  const srv = await rawServer(() => {});
  try {
    const started = Date.now();
    const res = await new RpcClient({ host: '127.0.0.1', port: srv.port, timeout: 200 }).call('x');
    assert.equal(res.error, 'ETIMEDOUT');
    assert.ok(Date.now() - started < 2000);
  } finally {
    await srv.close();
  }
});

// --- Round-3 regressions -----------------------------------------------------
// A server that answers one request with the given status, headers and raw
// body bytes (Content-Length is computed here unless Transfer-Encoding is set).
function rawBodyServer({ status = 200, headers = {}, body = Buffer.alloc(0), onRequest }) {
  return rawServer((socket, req) => {
    if (onRequest) onRequest(req);
    const head = [`HTTP/1.1 ${status} X`];
    for (const [k, v] of Object.entries(headers)) head.push(`${k}: ${v}`);
    if (!('Transfer-Encoding' in headers)) head.push(`Content-Length: ${body.length}`);
    head.push('Connection: close', '', '');
    socket.end(Buffer.concat([Buffer.from(head.join('\r\n'), 'latin1'), body]));
  });
}

// R3 credentials: util.inspect / Object.keys of the client must not print the
// password. Old code kept the options as an enumerable property.
test('R3: the client does not expose the password through util.inspect or Object.keys', () => {
  const util = require('node:util');
  const client = new RpcClient({ host: '127.0.0.1', port: 9332, username: 'alice', password: 'SECRET-PW-123' });
  assert.equal(util.inspect(client).includes('SECRET-PW-123'), false);
  assert.equal(util.inspect(client, { showHidden: true, depth: 10 }).includes('SECRET-PW-123'), false);
  assert.equal(Object.keys(client).some((k) => k === 'options'), false);
});

// R3 options: an explicit `undefined` means "not set". Old code let it replace
// the default, sending the credential "undefined:passsword".
test('R3: undefined username/password keep the defaults (no "undefined:" credential)', async () => {
  let auth = null;
  const srv = await rawBodyServer({
    body: Buffer.from('{"result":"ok","error":null}'),
    onRequest: (req) => (auth = /^authorization: (.*)$/im.exec(req.head)[1]),
  });
  try {
    const res = await new RpcClient({ host: '127.0.0.1', port: srv.port, timeout: 5000, username: undefined, password: undefined }).call('x');
    assert.equal(res.data, 'ok', JSON.stringify(res));
    assert.equal(auth, 'Basic ' + Buffer.from('root:passsword').toString('base64'));
  } finally {
    await srv.close();
  }
});

// R3 port: Node treats any falsy port as "use the default" (port 80 for HTTP),
// so the Basic credential would go to whatever listens on port 80. Such a value
// must be refused before anything is dialed.
for (const port of [0, NaN, null, '', 65536, -1, 9332.5, 'abc']) {
  test(`R3: port=${String(port)} resolves Invalid port instead of dialing port 80`, async () => {
    const res = await new RpcClient({ host: '127.0.0.1', port, timeout: 1000 }).call('x');
    assert.match(res.error ?? '', /^Invalid port: /, JSON.stringify(res));
  });
}

// R3 port: an unset (undefined) port means the default 9332, and a numeric
// string (e.g. from an environment variable) is accepted as a port number.
// The http.request spy throws so nothing is dialed.
test('R3: undefined port uses 9332; a numeric string port is converted to a number', async () => {
  const seen = [];
  const realRequest = http.request;
  http.request = (opts) => {
    seen.push(opts.port);
    throw new Error('spy: not dialed');
  };
  try {
    await new RpcClient({ host: '127.0.0.1', port: undefined, timeout: 1000 }).call('x');
    await new RpcClient({ host: '127.0.0.1', port: '1234', timeout: 1000 }).call('x');
  } finally {
    http.request = realRequest;
  }
  assert.deepEqual(seen, [9332, 1234]);
});

// R3 TLS: the allowlisted tls fields are copied when the client is constructed.
// Old code read the caller's object at each call, so a later change leaked into
// the request. The https.request spy throws so nothing is dialed.
test('R3: a tls object changed after construction does not change what a call sends', async () => {
  const seen = [];
  const realRequest = https.request;
  https.request = (opts) => {
    seen.push(opts.ca);
    throw new Error('spy: not dialed');
  };
  try {
    const tls = { ca: 'CA-AT-CONSTRUCTION' };
    const client = new RpcClient({ host: '127.0.0.1', port: 9, timeout: 1000, secure: true, tls });
    tls.ca = 'CA-MUTATED-LATER';
    await client.call('x');
    assert.deepEqual(seen, ['CA-AT-CONSTRUCTION']);
  } finally {
    https.request = realRequest;
  }
});

// R3 error payload: a JSON-RPC error that is a bare string, or an object without
// a message, must still produce a non-empty `error`. Old code returned
// `{ error: undefined, IECode: 2 }`, which callers that test `res.error` read as
// success.
test('R3: a JSON-RPC error without a usable message never reads as success', async () => {
  const cases = [
    [{ result: null, error: 'boom' }, { error: 'boom', IECode: 2, EECode: 0 }],
    [{ result: null, error: { code: -5 } }, { error: 'Undefined Error', IECode: 2, EECode: -5 }],
    [{ result: null, error: { message: '', code: -6 } }, { error: 'Undefined Error', IECode: 2, EECode: -6 }],
  ];
  for (const [body, expected] of cases) {
    const srv = await rawBodyServer({
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(body)),
    });
    try {
      const res = await new RpcClient({ host: '127.0.0.1', port: srv.port, timeout: 5000 }).call('x');
      assert.equal(res.data, undefined);
      assert.ok(res.error, `empty error for ${JSON.stringify(body)}: ${JSON.stringify(res)}`);
      assert.deepEqual({ error: res.error, IECode: res.IECode, EECode: res.EECode }, expected);
    } finally {
      await srv.close();
    }
  }
});

// R3 envelope: own-property checks only. A response key named like an Object
// prototype method used to throw inside the parser and discard a valid result; a
// non-object envelope is an undefined response, not a TypeError.
test('R3: envelope keys cannot shadow the own-property checks', async () => {
  const bodies = [
    ['{"hasOwnProperty":1,"result":5,"error":null}', { data: 5 }],
    ['null', { error: 'Undefined Error', IECode: 3, EECode: 0 }],
  ];
  for (const [text, expected] of bodies) {
    const srv = await rawBodyServer({ body: Buffer.from(text) });
    try {
      const res = await new RpcClient({ host: '127.0.0.1', port: srv.port, timeout: 5000 }).call('x');
      assert.deepEqual(
        Object.fromEntries(Object.entries(res).filter(([k]) => k !== 'statusCode')),
        expected,
        JSON.stringify(res)
      );
    } finally {
      await srv.close();
    }
  }
});

// R3 encoding: a body that arrives UTF-8 BOM-prefixed decodes as its JSON text
// (the BOM is dropped, as a WHATWG decoder does), rather than failing to parse.
test('R3: a leading UTF-8 BOM is dropped and the JSON parses', async () => {
  const srv = await rawBodyServer({ body: Buffer.from('﻿{"result":1,"error":null}', 'utf8') });
  try {
    const res = await new RpcClient({ host: '127.0.0.1', port: srv.port, timeout: 5000 }).call('x');
    assert.equal(res.data, 1, JSON.stringify(res));
  } finally {
    await srv.close();
  }
});

// R3 encoding: invalid UTF-8 is an error, not silently replaced with U+FFFD.
// Old code returned 'a�b' as if the node had sent that.
test('R3: invalid UTF-8 in the body fails the call instead of substituting U+FFFD', async () => {
  const body = Buffer.concat([Buffer.from('{"result":"a'), Buffer.from([0xff]), Buffer.from('b"}')]);
  const srv = await rawBodyServer({ body });
  try {
    const res = await new RpcClient({ host: '127.0.0.1', port: srv.port, timeout: 5000 }).call('x');
    assert.equal(res.data, undefined, JSON.stringify(res));
    assert.match(res.error ?? '', /not valid UTF-8/);
    assert.equal(res.IECode, 1);
  } finally {
    await srv.close();
  }
});

// R3 encoding: a server that compresses despite `Accept-Encoding: identity` is
// reported as an unsupported encoding. Old code surfaced a JSON parse error whose
// message contained the raw compressed bytes.
test('R3: a compressed response (ignoring identity) fails with Unsupported Content-Encoding', async () => {
  const zlib = require('node:zlib');
  const srv = await rawBodyServer({
    headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' },
    body: zlib.gzipSync(Buffer.from('{"result":1,"error":null}')),
  });
  try {
    const res = await new RpcClient({ host: '127.0.0.1', port: srv.port, timeout: 5000 }).call('x');
    assert.equal(res.error, 'Unsupported Content-Encoding', JSON.stringify(res));
    assert.equal(res.data, undefined);
  } finally {
    await srv.close();
  }
});

// R3 encoding: a 401 is still reported as Unauthorized even if its body is compressed.
test('R3: a 401 with a compressed body still resolves Unauthorized', async () => {
  const zlib = require('node:zlib');
  const srv = await rawBodyServer({
    status: 401,
    headers: { 'Content-Encoding': 'gzip' },
    body: zlib.gzipSync(Buffer.from('nope')),
  });
  try {
    const res = await new RpcClient({ host: '127.0.0.1', port: srv.port, timeout: 5000 }).call('x');
    assert.deepEqual(res, { error: 'Unauthorized', statusCode: 401, IECode: 4 });
  } finally {
    await srv.close();
  }
});

// R3 hygiene: package-lock.json's root version must match package.json. It was
// left at 1.0.3 after the package was bumped to 1.0.4.
test('R3: package-lock.json root version matches package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});
