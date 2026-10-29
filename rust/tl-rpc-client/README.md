# tl-rpc-client: offline contract foundation

Status: draft. This additive crate leaves the TypeScript package and its consumers unchanged.
It contains a closed set of read-only calls, a UTF-8 request encoder, typed decoded
responses and an injected transport interface with mock tests. HTTP/TLS, raw JSON
response parsing, credentials, TradeLayer-specific RPC methods and production integration
remain follow-up work. No network adapter is shipped. Never use this scaffold to hold keys.

## Verification

With Rust 1.90.0 (rustfmt and clippy) and Node installed:

```sh
cd rust/tl-rpc-client
cargo fmt --all -- --check
cargo test --locked --offline
cargo clippy --locked --offline --all-targets -- -D warnings
node scripts/verify-wire.cjs
```

There are zero third-party Rust dependencies. The wire oracle executes the request-object
expression from `src/main/rpc-client.ts`, pinned to blob
`94649945b9603395f115de23541dea25a9f88949` at upstream commit
`53bdd90c2b72dd7e8e8fc0100fed138b23666f33`. Its clock returns ID 7 so dynamic IDs
can be compared. The Rust example emits ten byte-exact cases, including Unicode,
control characters and a method-injection-shaped string. These tests cover the selected
request encoder only. They do not establish full HTTP, response-parser or node parity.

Security PR #2 remains independent. After it merges, inspect its changed source and
explicitly rebaseline the oracle. Existing production TypeScript vulnerabilities remain
tracked in #1/#2. This scaffold does not remediate the deployed client.

## Boundary and acceptance criteria

* `Request` only accepts the six `ReadCall` variants; there is no arbitrary-method API.
  The body follows the existing `{id,method,params}` envelope. JSON-RPC 2.0 support must
  be negotiated separately. IDs increase per client, including after transport failures,
  and stop at JavaScript's exact-integer boundary. Heights use checked integers.
* `content_length()` counts UTF-8 bytes. `ValidateAddress` strings are bounded and escaped;
  chain/address validity belongs to the selected node. `GetBlock` requires 64 hex digits.
* A future transport must bound response bytes while reading, cap JSON depth, reject
  duplicate or contradictory envelope fields, correlate IDs and cancel the socket on
  the whole-exchange deadline. `Limits` is passed to adapters; the current mocks cannot
  prove socket cancellation, pre-allocation bounds or TLS behavior. The post-decode size
  check alone is insufficient to protect a production adapter.
* `Outcome::Result(None::<T>)` represents a successful JSON null. `Malformed` covers a
  missing result/error or a parse failure. RPC errors retain their signed error code,
  including when Core responds with HTTP 500. A successful-looking body on HTTP failure
  is rejected. HTTP 401 gets a dedicated error. Missing/mismatched IDs fail closed.

The next PR must select and pin an HTTP/TLS and JSON implementation with a committed
lockfile and dependency rationale, or reuse a reviewed existing adapter. Avoid writing
new crypto or a generic JSON parser to satisfy a zero-dependency preference. Application
transport dependencies stay outside `patrickdugan/TradeLayer-Rust`'s consensus crate.
That repository retains ownership of ledger, matching and replay semantics.

Transport acceptance tests: loopback mock server, stalled headers/body, truncated body,
UTF-8 byte lengths, malformed/duplicate keys, ID mismatch, HTTP 401/500, TLS trust failure,
response/depth limits, connection cleanup and zero retries. Production endpoint changes,
wallet key migration and signing require separately reviewed work.
