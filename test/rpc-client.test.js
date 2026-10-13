'use strict';
// Regression tests for RpcClient. Run with `npm test` (builds lib/ first).
// Each test exercises a finding from the security review; the comment on each
// test names the finding and the behaviour it pins down.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
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
