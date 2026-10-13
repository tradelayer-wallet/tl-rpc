import * as http from 'http';
import * as https from 'https';
import { IComplex, IRpcClientOptions, IRpcResult } from '../types/types';
import { Complex } from './complex';

export class RpcClient {
  private _complex: IComplex;
  private _nextRequestId = 1;
  private options: IRpcClientOptions = {
    username: 'root',
    password: 'passsword',
    host: 'localhost',
    port: 9332,
    timeout: 3000,
    secure: false,
  };

  constructor(options: IRpcClientOptions) {
    this.options = { ...this.options, ...options };
    this._complex = new Complex(this);
  }

  get complex() {
    return this._complex;
  }

  async call(method: string, ...args: any[]): Promise<IRpcResult> {
    const { host, port, username, password, timeout, secure, tls } = this.options;

    // The promise must never reject: every failure path resolves { error }.
    return new Promise((res) => {
      let request: http.ClientRequest | undefined;
      let requestJSON = '';
      let reqTimeOut: ReturnType<typeof setTimeout> | undefined;
      // Every terminal path funnels through here: first settlement wins and
      // the timeout is always cleared with it.
      const done = (result: IRpcResult) => {
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
        // TLS passthrough first so it cannot override request framing,
        // credentials or headers owned by the client below.
        const requestOptions: https.RequestOptions = {
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
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        // A connection that dies mid-body never emits 'end'; without these the
        // promise would stay pending forever. Resolve ECONNRESET and free the
        // socket instead of deadlocking.
        const bodyBroken = () => {
          request?.destroy();
          done({ error: 'ECONNRESET' });
        };
        response.on('aborted', bodyBroken);
        response.on('error', bodyBroken);
        response.on('close', () => {
          if (!response.complete) bodyBroken();
        });
        response.on('end', () => {
          const { statusCode } = response;
          try {
            const buffer = Buffer.concat(chunks).toString('utf8');
            if (statusCode === 401) return done({ error: 'Unauthorized', statusCode, IECode: 4 });
            // if (statusCode !== 200) return done({ error: 'Undefined Error', statusCode, IECode: 5 })
            const decRes = JSON.parse(buffer);
            decRes.hasOwnProperty('error') && decRes.error !== null
              ? done({
                  error: decRes.error.message,
                  statusCode,
                  IECode: 2,
                  EECode: decRes.error.code || 0,
                })
              : decRes.hasOwnProperty('result')
              ? done({ data: decRes.result, statusCode })
              : done({
                  error: decRes.error?.message || 'Undefined Error',
                  statusCode,
                  IECode: 3,
                  EECode: decRes.error?.code || 0,
                });
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
