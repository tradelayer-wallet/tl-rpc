TradeLayer package for communicating via JSON-RPC with tradelayer node

```
npm install tl-rpc
```


```
import { IRpcClientOptions, IRpcResult, RpcClient } from "tl-rpc";

const options: IRpcClientOptions = {
    username: "USERNAME",    // type string; default is root;
    password: "PASSWORD",    // type string; default is password;
    host: 'localhost',       // type string; default is localhost;
    port: 9332,              // type number; default is 9332;   
    timeout: 3000,           // type number default is 3000; 
};

const client = new RpcClient(options);

const test = async () => {
    const res: IRpcResult = await client.call('tl_getinfo');
    console.log(res);
}

test();
```
