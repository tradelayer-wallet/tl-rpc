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
    const requestObj = {
      id: this._nextRequestId++,
      method: method,
      params: args,
    };
    const requestJSON = JSON.stringify(requestObj);
    const { host, port, username, password, timeout, secure } = this.options;
    const requestOptions = {
      host: host,
      port: port,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Must be the UTF-8 byte length, not the JS string length: a
        // non-ASCII param would otherwise declare too few bytes and desync
        // the request framing.
        'Content-Length': Buffer.byteLength(requestJSON),
      },
      agent: false,
      auth: username + ':' + password,
    };
    const request = (secure ? https : http).request(requestOptions);

    return new Promise((res, rej) => {
      const reqTimeOut = setTimeout(() => {
        // Free the socket; otherwise a timed-out call leaks a socket + timer
        // and a late response still runs the handler.
        request.destroy();
        res({ error: 'ETIMEDOUT' });
      }, timeout);
      request.on('error', (error: any) => {
        clearTimeout(reqTimeOut);
        res({ error: error.message });
      });
      request.on('response', (response: any) => {
        clearTimeout(reqTimeOut);
        let buffer = '';
        response.on('data', (chunk: any) => (buffer += chunk));
        response.on('end', () => {
          const { statusCode } = response;
          try {
            if (statusCode === 401) return res({ error: 'Unauthorized', statusCode, IECode: 4 });
            // if (statusCode !== 200) return res({ error: 'Undefined Error', statusCode, IECode: 5 })
            const decRes = JSON.parse(buffer);
            decRes.hasOwnProperty('error') && decRes.error !== null
              ? res({
                  error: decRes.error.message,
                  statusCode,
                  IECode: 2,
                  EECode: decRes.error.code || 0,
                })
              : decRes.hasOwnProperty('result')
              ? res({ data: decRes.result, statusCode })
              : res({
                  error: decRes.error?.message || 'Undefined Error',
                  statusCode,
                  IECode: 3,
                  EECode: decRes.error?.code || 0,
                });
          } catch (error: any) {
            statusCode !== 200
              ? res({ error: error.message, statusCode })
              : res({ error: error.message, statusCode, IECode: 1 });
          }
        });
      });

      request.end(requestJSON);
    });
  }
}
