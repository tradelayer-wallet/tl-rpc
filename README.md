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
  is collected as raw bytes and decoded as strict UTF-8 once, after the whole
  body has arrived, so multibyte characters split across TCP segments are not
  corrupted. Invalid UTF-8 fails the call with `Response body is not valid
  UTF-8` (it is not replaced with U+FFFD). A leading BOM is dropped. A response
  that is still compressed (a proxy ignored `identity`) fails with `Unsupported
  Content-Encoding`; it is never parsed as binary. A 401 is still reported as
  `Unauthorized`.
- **Port and credentials:** `port` must be an integer in 1..65535 (a numeric
  string is accepted). Any other value, including `0`, `NaN` and `null`, makes
  each call resolve `{ error: 'Invalid port: ...' }` without connecting; Node
  would otherwise fall back to port 80 and send the Basic credentials there. An
  option set to `undefined` keeps its default. The password is not included in
  `util.inspect` or `Object.keys` output of the client.
- **Error payloads:** a JSON-RPC `error` that is a string is used as the
  message. An object without a non-empty `message` gives `error: 'Undefined
  Error'`, with `EECode` taken from its numeric `code`. An `error` is never
  empty, so a failed call cannot read as a success.
- `call()` never rejects: every failure, including `E2BIG`, `ETIMEDOUT`,
  `ECONNRESET`, circular `params` and an invalid configuration such as a bad
  port, resolves with `{ error }`. The constructor is the exception: it reads
  the options (and the `tls` allowlist) once, so a getter or Proxy trap on them
  that throws makes `new RpcClient(...)` throw.

## Numbers

Responses are decoded by the client's own JSON parser, which keeps every
number exact. Nothing is rounded silently. Each JSON number becomes one of:

| Source text | Result | Type |
| --- | --- | --- |
| an integer with |value| <= 2^53-1 (`-0` too) | `number` | `number` |
| an integer outside that range (`9007199254740993`, `12345678901234567890`, `1e20`) | `bigint`, exact | `bigint` |
| a decimal whose double denotes the same value (`0.1`, `1.50`, `1e-7`) | `number` | `number` |
| a decimal a double would round (`0.10000000000000000001`, `1e-400`) | the original text | `RpcDecimalString` |

- `RpcDecimalString` is a `string` at runtime. It is branded in the types so it
  can be told apart from ordinary strings at compile time. Runtime cannot tell
  them apart, so read the field's documented type to know which one to expect.
- `RpcNumber` (`number | bigint | RpcDecimalString`) is exported for typing
  numeric fields.
- A `bigint` cannot be mixed with a `number` in arithmetic (`x + 1` throws a
  `TypeError`), and `JSON.stringify` throws on one. Convert explicitly, for
  example `Number(x)` where precision is no longer needed, or keep it as a
  `bigint` for amounts.
- Limits: an integer longer than 1024 digits, or nesting deeper than 128
  levels, fails the call with `IECode: 1` (a parse error). The response
  size cap (`maxResponseBytes`) applies to the body before it is parsed.
- Grammar is strict RFC 8259 JSON, as with `JSON.parse`: leading zeros, a bare
  `.5` or `1.`, `+1`, `NaN` and `Infinity` are rejected. Duplicate keys keep the
  last value. A key named `__proto__` is an ordinary key and does not change
  any prototype.
- Typing: `call<T>()` returns `IRpcResult<T>`. The default `T` is `any`,
  because the client does not know each method's result shape. Pass the shape
  you expect, and use `RpcNumber` for numeric fields that can be large:

```
interface IBalance { amount: RpcNumber; symbol: string }
const res = await client.call<IBalance>('getbalance', 'addr');
```

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
- **Behavior change:** invalid UTF-8 in a response now fails with `Response
  body is not valid UTF-8` (IECode 1 on a 200) instead of returning U+FFFD
  substitutes.
- **Behavior change:** a compressed response now fails with `Unsupported
  Content-Encoding` instead of a JSON parse error that echoed the raw bytes.
- **Behavior change:** a `port` that is not an integer in 1..65535 now resolves
  `{ error: 'Invalid port: ...' }`. Before, `0`, `NaN`, `null` and `''` dialed
  port 80.
- Fixed: an explicit `undefined` option (for example `username: undefined`) no
  longer replaces its default. Before, the request carried `undefined:<password>`
  and an undefined `port` dialed port 80.
- Fixed: `util.inspect(client)` no longer prints the password. The options are
  now an ES private field (`#options`), so they are not visible to
  `Object.keys`, `util.inspect` or `JSON`.
- **Breaking:** response numbers are no longer always JavaScript numbers.
  Integers outside the safe range come back as `bigint`, and decimals a double
  would round come back as `RpcDecimalString` (their original text). Before,
  `9007199254740993` silently became `9007199254740992`. Code that assumed
  `typeof x === 'number'` or mixed these values with `number` arithmetic must
  handle the new types (see Numbers).
- **Behavior change:** JSON nesting deeper than 128 levels, and integers longer
  than 1024 digits, fail with `IECode: 1`. Parse error texts now come from the
  client's own parser, so they differ from `JSON.parse`'s wording.
- **Typing:** `call<T>()` returns `IRpcResult<T>` (default `any`). New exported
  types: `RpcNumber`, `RpcDecimalString`.
- **Behavior change:** the `tls` allowlist is copied when the client is
  constructed. Later changes to the `tls` object do not affect calls.
- Fixed: a JSON-RPC error that is a string, or an object without a message,
  used to resolve `{ error: undefined, IECode: 2 }`, which reads as success.
  It now resolves a non-empty `error`.
- Fixed: a response key named like an `Object.prototype` method (for example
  `hasOwnProperty`) made the envelope check throw and discard a valid result.
  A top-level JSON value that is not an object (such as `null`) now resolves
  `Undefined Error` (IECode 3), not a TypeError message.
- Requests send `Accept-Encoding: identity`.
- `IRpcTlsOptions` is exported from the package.
- Build: `@types/node` is now `^22.20.5` (it was `^17.0.21`, which does not
  compile with the TypeScript 5.9 used here), and `typescript` is a
  devDependency so `npx tsc` works without a global compiler. Run the regression
  tests with `npm test`.
