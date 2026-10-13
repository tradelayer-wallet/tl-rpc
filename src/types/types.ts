export interface IRpcClientOptions {
  username: string;
  password: string;
  host: string;
  port: number;
  timeout: number;
  /**
   * Use HTTPS instead of plain HTTP. Defaults to false.
   * Strongly recommended (or restrict `host` to loopback) whenever the node
   * is not on localhost: credentials are sent via HTTP Basic auth and would
   * otherwise be readable by any on-path observer.
   */
  secure?: boolean;
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
