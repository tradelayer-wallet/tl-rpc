import * as tls from 'tls';

/**
 * TLS options accepted in `IRpcClientOptions.tls` (used only when
 * `secure: true`). This is a closed allowlist: exactly the ten fields below
 * are honored, and any other key in the `tls` object is ignored (not
 * rejected). Connection target, request framing and credentials (`host`,
 * `port`, `socketPath`, `createConnection`, `lookup`, `setHost`, `agent`,
 * `headers`, `auth`, `method`, `path`, ...) are owned by the client and cannot
 * be set through `tls`.
 */
export interface IRpcTlsOptions {
  /**
   * Trusted CA certificate(s) for verifying the server: PEM string/Buffer,
   * or an array of them. Use this for self-signed or private-CA deployments
   * (`tls: { ca: fs.readFileSync('ca.pem') }`). When omitted, Node's default
   * trust store is used and an untrusted certificate fails the call.
   */
  ca?: tls.SecureContextOptions['ca'];
  /**
   * Client certificate (PEM string/Buffer) for mutual TLS, if the TLS-
   * terminating proxy requires client certificates.
   */
  cert?: tls.SecureContextOptions['cert'];
  /** Private key (PEM string/Buffer) matching `cert`. */
  key?: tls.SecureContextOptions['key'];
  /** PKCS#12 bundle (string/Buffer) — an alternative to `cert`/`key`. */
  pfx?: tls.SecureContextOptions['pfx'];
  /** Passphrase for an encrypted `key` or `pfx`. */
  passphrase?: tls.SecureContextOptions['passphrase'];
  /**
   * Verify the server certificate (default `true`). Setting this to `false`
   * disables certificate verification and makes the connection MITM-able.
   * It is honored as set, but strongly discouraged: prefer supplying `ca`.
   */
  rejectUnauthorized?: tls.ConnectionOptions['rejectUnauthorized'];
  /**
   * SNI name and hostname to verify the certificate against (defaults to the
   * configured `host`). Affects certificate verification and the TLS SNI
   * extension only; it cannot redirect the TCP connection.
   */
  servername?: tls.ConnectionOptions['servername'];
  /** OpenSSL cipher list restricting/reordering the offered cipher suites. */
  ciphers?: tls.SecureContextOptions['ciphers'];
  /** Minimum acceptable TLS version, e.g. `'TLSv1.2'`. */
  minVersion?: tls.SecureContextOptions['minVersion'];
  /** Maximum acceptable TLS version, e.g. `'TLSv1.3'`. */
  maxVersion?: tls.SecureContextOptions['maxVersion'];
}

/**
 * Client options. Any option set to `undefined` is treated as unset and keeps
 * its default. `port` must be an integer in 1..65535 (a numeric string is
 * accepted); any other value makes each call resolve `{ error: 'Invalid port: ...' }`
 * without connecting.
 */
export interface IRpcClientOptions {
  username: string;
  password: string;
  host: string;
  /** Integer 1..65535; a numeric string (e.g. from an env var) is also accepted. See the note above. */
  port: number | string;
  /**
   * Milliseconds before the call is aborted with `{ error: 'ETIMEDOUT' }`.
   * Covers the whole exchange, including the response body: a server that
   * sends headers and then stalls can no longer hold the call open forever.
   * Non-finite values and values below 1 ms fall back to the default (3000
   * ms); fractions are rounded down; values above 2^31-1 are capped there,
   * because `setTimeout` fires immediately on a larger delay. Untyped callers
   * may pass a numeric string (e.g. from an environment variable), read as a number.
   */
  timeout: number;
  /**
   * Use HTTPS instead of plain HTTP. Defaults to false.
   * Strongly recommended (or restrict `host` to loopback) whenever the node
   * is not on localhost: credentials are sent via HTTP Basic auth and would
   * otherwise be readable by any on-path observer.
   *
   * Note: litecoind/bitcoind (and thus TradeLayer) RPC servers speak plain
   * HTTP only — they cannot terminate TLS themselves. `secure: true` targets
   * a TLS-terminating reverse proxy in front of the node (typically on port
   * 443), not the node's raw RPC port.
   */
  secure?: boolean;
  /**
   * TLS options for HTTPS requests (applied only when `secure: true`), e.g.
   * `{ ca: fs.readFileSync('ca.pem') }` for a private CA. Only the fields
   * listed in {@link IRpcTlsOptions} are honored; every other key is ignored.
   * The allowlisted fields are copied when the client is constructed, so a
   * later change to this object has no effect. Certificate verification stays
   * strict by default; prefer `ca` over disabling verification.
   */
  tls?: IRpcTlsOptions;
  /**
   * Maximum response-body size in bytes. Defaults to 32 MiB (33554432). A
   * response over the limit is aborted as soon as the limit is crossed (or
   * refused up front when its Content-Length is over it), and the call
   * resolves `{ error: 'E2BIG' }`. Non-finite values and values below 1 fall
   * back to the default; fractions are rounded down; values above 2^31-1 are
   * capped there, and at Node's maximum string length (which bounds the
   * decode). Untyped callers may pass a numeric string, read as a number.
   */
  maxResponseBytes?: number;
}

/**
 * A JSON number whose value a JS `number` cannot hold exactly: the original
 * token text, verbatim (e.g. `"0.10000000000000000001"`). Typed as a string
 * subtype, so it is safe to print, compare or pass to a decimal library.
 * The brand is compile-time only; at runtime it is an ordinary string.
 */
export type RpcDecimalString = string & { readonly __rpcDecimal: 'RpcDecimalString' };

/**
 * Every shape a JSON number can take in a response (see the README "Numbers"
 * section): a `number` for safe integers and for decimals that round-trip,
 * a `bigint` for integers outside the safe range, and an `RpcDecimalString`
 * for decimals that a `number` would round.
 */
export type RpcNumber = number | bigint | RpcDecimalString;

export interface IRpcResult<T = any> {
  error?: string;
  /**
   * The JSON-RPC `result`. The client does not know the shape of each method's
   * result, so the default is `any`; pass a type argument to `call<T>()` to
   * describe it. Numeric fields may hold an {@link RpcNumber}.
   */
  data?: T;
  statusCode?: number;
  IECode?: number;
  EECode?: number;
}

export interface IComplex {
  bestBlock: () => Promise<IRpcResult>;
}
