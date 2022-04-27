export interface IRpcClientOptions {
  username: string;
  password: string;
  host: string;
  port: number;
  timeout: number;
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
