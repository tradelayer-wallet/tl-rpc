import * as https from 'https';

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
   * TLS options merged into the request options for HTTPS requests
   * (applied only when `secure: true`). Use this for self-signed or
   * private-CA deployments, e.g. `{ ca: fs.readFileSync('ca.pem') }`.
   *
   * Accepts the TLS-specific fields of `https.RequestOptions` (`ca`, `cert`,
   * `key`, `pfx`, `passphrase`, `rejectUnauthorized`, `servername`, ...).
   * Certificate verification stays strict by default; prefer supplying `ca`
   * over disabling verification. Request-framing fields (`host`, `port`,
   * `auth`, `headers`, `method`, `agent`) are owned by the client and cannot
   * be overridden here.
   */
  tls?: https.RequestOptions;
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
