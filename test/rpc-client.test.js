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
