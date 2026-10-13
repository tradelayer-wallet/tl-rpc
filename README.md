TradeLayer package for communicating via JSON-RPC with tradelayer node

```
npm install tl-rpc
```


```
import { IRpcClientOptions, IRpcResult, RpcClient } from "tl-rpc";

const options: IRpcClientOptions = {
    username: "USERNAME",    // type string; default is root;
    password: "PASSWORD",    // type string; default is passsword (sic, as in the source);
    host: 'localhost',       // type string; default is localhost;
    port: 9332,              // type number; default is 9332;
    timeout: 3000,           // type number; default 3000 ms; covers the whole call incl. the response body (see notes);
    secure: false,           // type boolean; default is false; use HTTPS (see notes below);
    // tls: { ca: fs.readFileSync('ca.pem') },  // TLS options when secure: true (see notes);
    // maxResponseBytes: 33554432,              // type number; default 32 MiB; larger responses fail with { error: 'E2BIG' };
};

const client = new RpcClient(options);

const test = async () => {
    const res: IRpcResult = await client.call('tl_getinfo');
    console.log(res);
}

test();
```

## Notes

- **Transport:** litecoind/bitcoind (and TradeLayer) RPC servers are
  plaintext-only — they cannot terminate TLS themselves. `secure: true` is
  intended for deployments where a TLS-terminating reverse proxy sits in
  front of the node (typically on port 443); it is not for connecting
  directly to the node's raw RPC port. Otherwise keep `host` on loopback.
- **TLS:** the `tls` option is used only when `secure: true`. It is an
  allowlist of exactly these fields: `ca`, `cert`, `key`, `pfx`,
  `passphrase`, `rejectUnauthorized`, `servername`, `ciphers`, `minVersion`,
  `maxVersion`. Any other key is ignored, not rejected. The connection target
  and the request itself (`host`, `port`, `socketPath`, `createConnection`,
  `lookup`, `setHost`, `agent`, `headers`, `auth`, `method`, `path`) are
  always set by the client and cannot be changed through `tls`.
  For a self-signed or private-CA proxy, pass the CA via `tls: { ca: ... }`.
  Certificate verification is strict by default. Setting
  `tls: { rejectUnauthorized: false }` is honored as written, which disables
  verification and makes the connection open to a man-in-the-middle; it is
  strongly discouraged. Prefer `ca`.
- **Timeout:** `timeout` is the budget for each `call()` and covers the whole
  exchange, including the response body. A server that sends headers and then
  stalls is destroyed and the call resolves `{ error: 'ETIMEDOUT' }`. A
  connection that dies mid-body resolves `{ error: 'ECONNRESET' }`.
  Because the budget includes the body transfer, a large response on a slow
  link can exceed the 3 s default. Raise `timeout` for bulk calls (e.g.
  10000–60000), or use a second `RpcClient` with a larger timeout for heavy
  calls. A value that is not a finite number of at least 1 ms falls back to
  3000 ms, fractions are rounded down, and values above 2^31-1 ms are capped
  there.
- **Response size:** the response body is limited to `maxResponseBytes`
  (default 32 MiB, 33554432). The limit is enforced while the body is read:
  the connection is closed as soon as it is passed, and a `Content-Length`
  over the limit is refused before the body is read. Either way the call
  resolves `{ error: 'E2BIG' }`. Raise the limit only for responses that
  legitimately need it. Non-finite and sub-1 values fall back to the default,
  and values are capped at 2^31-1 (and at Node's maximum string length).
- **Encoding:** requests send `Accept-Encoding: identity`. The response body
  is collected as raw bytes and decoded as UTF-8 once, after the whole body has
  arrived, so multibyte characters split across TCP segments are not corrupted.
  A proxy that ignores `identity` and compresses the body makes the call fail
  with a parse error; it does not return corrupted data.
- `call()` never rejects: every failure, including `E2BIG`, `ETIMEDOUT`,
  `ECONNRESET`, circular `params` and an invalid configuration such as a bad
  port, resolves with `{ error }`.

## Changelog (unreleased)

- **Breaking:** the `Host` request header is now derived from `host`/`port` as
  `host:port` instead of being hardcoded to `localhost`. Reverse proxies or
  virtual hosts matching exactly `localhost` (instead of the configured host)
  need their vhost/server-name updated to match.
- **Breaking:** `tls` is now an allowlist (see Notes). Keys such as
  `socketPath`, `createConnection`, `lookup`, `headers`, `auth` and `method`
  are ignored. Code that relied on them will silently use the configured
  `host`/`port` instead.
- **Behavior change:** `timeout` covers the response body (see Notes), so a
  body that takes longer than `timeout` now fails with `ETIMEDOUT`.
- **Behavior change:** responses over `maxResponseBytes` (default 32 MiB) now
  fail with `E2BIG`. Previously they were buffered without limit.
- New `maxResponseBytes` option (default 32 MiB).
- `timeout` and `maxResponseBytes` are normalized in the constructor:
  non-finite or sub-1 values fall back to the default, and values are capped
  at 2^31-1. A `timeout` of `undefined`, `0` or `Infinity` previously fired
  immediately or overflowed `setTimeout`.
- Fixed: multibyte UTF-8 characters split across TCP segments were returned
  as U+FFFD replacement characters.
- Requests send `Accept-Encoding: identity`.
- `IRpcTlsOptions` is exported from the package.
- Build: `@types/node` is now `^22.20.5` (it was `^17.0.21`, which does not
  compile with the TypeScript 5.9 used here), and `typescript` is a
  devDependency so `npx tsc` works without a global compiler. Run the regression
  tests with `npm test`.
