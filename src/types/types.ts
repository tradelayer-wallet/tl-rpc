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

export interface IRpcClientOptions {
  username: string;
  password: string;
  host: string;
  port: number;
  /**
   * Milliseconds before the call is aborted with `{ error: 'ETIMEDOUT' }`.
   * Covers the whole exchange, including the response body: a server that
   * sends headers and then stalls can no longer hold the call open forever.
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
   * Certificate verification stays strict by default; prefer `ca` over
   * disabling verification.
   */
  tls?: IRpcTlsOptions;
}

export interface IRpcResult {
  error?: string;
  data?: any;
  statusCode?: number;
  IECode?: number;
  EECode?: number;
}

export interface IComplex {
  bestBlock: () => Promise<IRpcResult>;
}
