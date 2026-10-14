import * as http from 'http';
import * as https from 'https';
import { constants as bufferConstants } from 'buffer';
import { TextDecoder } from 'util';
import { IComplex, IRpcClientOptions, IRpcResult, IRpcTlsOptions } from '../types/types';
import { Complex } from './complex';
import { parseLosslessJson } from './lossless-json';

/**
 * The only `tls` keys the client forwards. The `satisfies` check makes this
 * list match `IRpcTlsOptions` exactly: a field added to or removed from the
 * type fails to compile until it is reflected here.
 */
const TLS_OPTION_KEYS = Object.keys({
  ca: true,
  cert: true,
  key: true,
  pfx: true,
  passphrase: true,
  rejectUnauthorized: true,
  servername: true,
  ciphers: true,
  minVersion: true,
  maxVersion: true,
} satisfies Record<keyof IRpcTlsOptions, true>) as (keyof IRpcTlsOptions)[];

/** Copies only the allowlisted TLS fields; every other key is dropped. */
const pickTlsOptions = (tls: IRpcTlsOptions | undefined): IRpcTlsOptions => {
  const picked: Record<string, unknown> = {};
  if (tls) {
    for (const key of TLS_OPTION_KEYS) {
      if (tls[key] !== undefined) picked[key] = tls[key];
    }
  }
  return picked as IRpcTlsOptions;
};

/** Node's largest `setTimeout` delay (2^31-1 ms); larger values overflow and fire at once. */
const MAX_INT32 = 2147483647;
/** Largest body `toString` can decode in one string; a larger cap could never be used. */
const MAX_BODY_BYTES = Math.min(MAX_INT32, bufferConstants.MAX_STRING_LENGTH);
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Resolved options. `port` stays `unknown` on purpose: it is validated at the
 * point a request is made, so a bad value becomes `{ error }`, not a dial.
 */
type ResolvedOptions = Omit<IRpcClientOptions, 'port' | 'tls'> & {
  port: unknown;
  timeout: number;
  maxResponseBytes: number;
  tls?: IRpcTlsOptions;
};

/**
 * A usable integer for a numeric option: non-numbers, NaN, +/-Infinity and
 * values below 1 fall back to the default; fractions are floored; values
 * above `max` are capped.
 */
const resolveCount = (value: unknown, fallback: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.min(Math.floor(value), max);
  return n >= 1 ? n : fallback;
};

/** Numeric strings (e.g. from an environment variable) are accepted as ports. */
const normalizePort = (value: unknown): unknown =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

/**
 * Node treats any falsy port (0, NaN, null, '') as "use the default", which is
 * port 80 for HTTP, so the client rejects anything that is not an integer in
 * 1..65535 before it dials.
 */
const isValidPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;

/** Strict UTF-8: invalid bytes fail the call instead of becoming U+FFFD. A leading BOM is dropped. */
const utf8 = new TextDecoder('utf-8', { fatal: true });
const decodeBody = (bytes: Buffer): string => {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new Error('Response body is not valid UTF-8');
  }
};

/** The client asks for `identity`; anything else means the body is still encoded. */
const isIdentityEncoding = (value: string | undefined): boolean => {
  const coding = (value ?? '').trim().toLowerCase();
  return coding === '' || coding === 'identity';
};

/** JSON-RPC error text: a string, or an object's non-empty `message`. Never empty, so a failure cannot read as success. */
const rpcErrorMessage = (err: unknown): string => {
  const message = typeof err === 'string' ? err : (err as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message !== '' ? message : 'Undefined Error';
};

const rpcErrorCode = (err: unknown): number => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : 0;
};

const DEFAULT_OPTIONS = {
  username: 'root',
  password: 'passsword',
  host: 'localhost',
  port: 9332,
  timeout: DEFAULT_TIMEOUT_MS,
  secure: false,
  maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
};

/**
 * The single place caller options are merged with the defaults and
 * normalized. An explicit `undefined` means "not set" and keeps the default:
 * otherwise `port: process.env.X` with X unset would override 9332 and
 * `username: undefined` would send the credential `undefined:<password>`. The
 * TLS allowlist is copied here too, so later changes to the caller's `tls`
 * object (or getters/Proxy traps on it) cannot change what a call sends.
 */
const normalizeOptions = (input: IRpcClientOptions): ResolvedOptions => {
  const given = Object.fromEntries(
    Object.entries(input ?? {}).filter(([, value]) => value !== undefined)
  );
  const merged: IRpcClientOptions = { ...DEFAULT_OPTIONS, ...given };
  return {
    ...merged,
    port: normalizePort(merged.port),
    timeout: resolveCount(merged.timeout, DEFAULT_TIMEOUT_MS, MAX_INT32),
    maxResponseBytes: resolveCount(merged.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, MAX_BODY_BYTES),
    tls: merged.secure ? pickTlsOptions(merged.tls) : undefined,
  };
};

export class RpcClient {
  private _complex: IComplex;
  private _nextRequestId = 1;
  // ES private field, not a property: the options (which hold the password)
  // are not enumerable, so util.inspect, JSON and Object.keys cannot print them.
  #options: ResolvedOptions;

  constructor(options: IRpcClientOptions) {
    this.#options = normalizeOptions(options);
    this._complex = new Complex(this);
  }

  get complex() {
    return this._complex;
  }

  async call<T = any>(method: string, ...args: any[]): Promise<IRpcResult<T>> {
    const { host, port, username, password, timeout, secure, tls, maxResponseBytes } = this.#options;

    // The promise must never reject: every failure path resolves { error }.
    return new Promise<IRpcResult<T>>((res) => {
      let request: http.ClientRequest | undefined;
      let requestJSON = '';
      let reqTimeOut: ReturnType<typeof setTimeout> | undefined;
      // Every terminal path funnels through here: the first settlement wins
      // and the timeout is always cleared with it.
      let settled = false;
      const done = (result: IRpcResult<T>) => {
        if (settled) return;
        settled = true;
        if (reqTimeOut !== undefined) clearTimeout(reqTimeOut);
        res(result);
      };

      try {
        const requestObj = {
          id: this._nextRequestId++,
          method: method,
          params: args,
        };
        // JSON.stringify throws on circular params — resolve, don't reject.
        requestJSON = JSON.stringify(requestObj);
        if (!isValidPort(port)) throw new RangeError(`Invalid port: ${String(port)}`);
        const requestOptions: https.RequestOptions = {
          // `tls` is the allowlisted copy made at construction. The client-owned
          // fields below come after it, so they could not be overridden even if
          // the allowlist grew.
          ...(secure ? tls : undefined),
          host: host,
          port: port,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Must be the UTF-8 byte length, not the JS string length: a
            // non-ASCII param would otherwise declare too few bytes and desync
            // the request framing.
            'Content-Length': Buffer.byteLength(requestJSON),
            // Ask every hop not to re-encode the response: the body must be
            // the bytes the node produced, and the decode below assumes it.
            'Accept-Encoding': 'identity',
          },
          agent: false,
          auth: username + ':' + password,
        };
        // Construction throws on e.g. an out-of-range port — resolve, don't reject.
        request = secure
          ? https.request(requestOptions)
          : http.request(requestOptions);
      } catch (error: any) {
        return done({ error: error.message });
      }

      // Armed before any I/O and kept armed until the response body has
      // completed: headers arriving is not the end of the exchange, and a
      // server that stalls mid-body must not hold the call open (and its
      // socket) forever.
      reqTimeOut = setTimeout(() => {
        done({ error: 'ETIMEDOUT' });
        request?.destroy();
      }, timeout);

      request.on('error', (error: any) => {
        request?.destroy();
        done({ error: error.message });
      });
      request.on('response', (response: http.IncomingMessage) => {
        // Collect raw bytes and decode once, after the full body has arrived.
        // Decoding each chunk as it comes (`buffer += chunk`) corrupts a UTF-8
        // sequence split across TCP segments: each half becomes U+FFFD.
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        // Every early exit from the body goes through here. Settle first, then
        // destroy the socket: destroying can emit 'error' synchronously, which
        // must not overwrite the result chosen here.
        const abort = (result: IRpcResult<T>) => {
          chunks.length = 0;
          done(result);
          request?.destroy();
        };
        // The cap is enforced while streaming: the socket is destroyed as soon
        // as the limit is crossed, so an oversized body is never buffered whole.
        response.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maxResponseBytes) return abort({ error: 'E2BIG' });
          chunks.push(chunk);
        });
        // A connection that dies mid-body never emits 'end'; without these the
        // promise would stay pending forever. Resolve ECONNRESET and free the
        // socket instead of deadlocking.
        const bodyBroken = () => abort({ error: 'ECONNRESET' });
        response.on('aborted', bodyBroken);
        response.on('error', bodyBroken);
        response.on('close', () => {
          if (!response.complete) bodyBroken();
        });
        // A declared Content-Length over the cap is refused before any byte is read.
        const declaredBytes = Number(response.headers['content-length']);
        if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
          return abort({ error: 'E2BIG' });
        }
        response.on('end', () => {
          const { statusCode } = response;
          try {
            if (statusCode === 401) return done({ error: 'Unauthorized', statusCode, IECode: 4 });
            // if (statusCode !== 200) return done({ error: 'Undefined Error', statusCode, IECode: 5 })
            // A server or proxy that compresses despite `identity` is reported
            // as such, not parsed as binary garbage.
            if (!isIdentityEncoding(response.headers['content-encoding'])) {
              throw new Error('Unsupported Content-Encoding');
            }
            // The one JSON decode in the client. Numbers that a double would
            // round come back as bigint or RpcDecimalString (see lossless-json.ts).
            const decRes: unknown = parseLosslessJson(decodeBody(Buffer.concat(chunks)));
            // Own-property checks only, and a non-object envelope counts as
            // empty, so no response key (e.g. "hasOwnProperty") can break them.
            const envelope = typeof decRes === 'object' && decRes !== null ? (decRes as Record<string, unknown>) : {};
            if (Object.hasOwn(envelope, 'error') && envelope.error !== null) {
              return done({
                error: rpcErrorMessage(envelope.error),
                statusCode,
                IECode: 2,
                EECode: rpcErrorCode(envelope.error),
              });
            }
            if (Object.hasOwn(envelope, 'result')) return done({ data: envelope.result as T, statusCode });
            done({ error: 'Undefined Error', statusCode, IECode: 3, EECode: 0 });
          } catch (error: any) {
            statusCode !== 200
              ? done({ error: error.message, statusCode })
              : done({ error: error.message, statusCode, IECode: 1 });
          }
        });
      });

      try {
        request.end(requestJSON);
      } catch (error: any) {
        request.destroy();
        done({ error: error.message });
      }
    });
  }
}
