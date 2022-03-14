import * as http from 'http';
import { IRpcClientOptions, IRpcResult } from '../types/types';

export class RpcClient {
  private options: IRpcClientOptions = {
    username: 'root',
    password: 'passsword',
    host: 'localhost',
    port: 9332,
    timeout: 3000,
  };
  constructor(options: IRpcClientOptions) {
    this.options = { ...this.options, ...options };
  }

  async call(method: string, ...args: any[]): Promise<IRpcResult> {
    const requestObj = {
      id: Date.now(),
      method: method,
      params: args,
    };
    const requestJSON = JSON.stringify(requestObj);
    const { host, port, username, password, timeout } = this.options;
    const requestOptions = {
      host: host,
      port: port,
      method: 'POST',
      headers: {
        Host: 'localhost',
        'Content-Length': requestJSON.length,
      },
      agent: false,
      auth: username + ':' + password,
    };
    const request = http.request(requestOptions);

    return new Promise((res, rej) => {
      const reqTimeOut = setTimeout(() => res({ error: 'ETIMEDOUT' }), timeout);
      request.on('error', (error: any) => res({ error: error.message }));
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
