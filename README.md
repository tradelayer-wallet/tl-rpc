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
    timeout: 3000,           // type number default is 3000; covers the full request incl. the response body;
    secure: false,           // type boolean; default is false; use HTTPS (see notes below);
    // tls: { ca: fs.readFileSync('ca.pem') },  // TLS options when secure: true (private CA / self-signed);
};

const client = new RpcClient(options);

const test = async () => {
    const res: IRpcResult = await client.call('tl_getinfo');
    console.log(res);
}

test();
```

## Notes

- **Transport:** litecoind/bitcoind (and TradeLayer) RPC servers are
  plaintext-only — they cannot terminate TLS themselves. `secure: true` is
  intended for deployments where a TLS-terminating reverse proxy sits in
  front of the node (typically on port 443); it is not for connecting
  directly to the node's raw RPC port. Otherwise keep `host` on loopback.
- **TLS:** the optional `tls` option is merged into the HTTPS request options
  (only when `secure: true`) and accepts the TLS fields of
  `https.RequestOptions` (`ca`, `cert`, `key`, `pfx`, `passphrase`,
  `rejectUnauthorized`, `servername`, ...). For a self-signed or private-CA
  proxy, pass the CA via `tls: { ca: ... }`; certificate verification stays
  strict by default (there is deliberately no shortcut to disable it).
- **Timeout:** `timeout` now covers the whole exchange including the
  response body; a server that sends headers and then stalls is destroyed
  and resolved with `{ error: 'ETIMEDOUT' }`, as is a connection that dies
  mid-body (`{ error: 'ECONNRESET' }`).
- `call()` never rejects: all failures (including circular `params` and
  invalid configuration such as a bad port) resolve with `{ error }`.

## Changelog (unreleased)

- The `Host` request header is now derived from `host`/`port` as `host:port`
  instead of being hardcoded to `localhost`. Reverse proxies or virtual hosts
  matching exactly `localhost` (instead of the configured host) need their
  vhost/server-name updated to match.
