# TradeLayer RPC Rust transport (RUST-06)

This additive Rust crate retains the original TypeScript client unchanged while
introducing read-only HTTP/JSON-RPC support. No production endpoint is configured.

## Architecture

The closed ReadCall enum exposes six safe read operations. Request serialization
uses the pinned legacy {id,method,params} format; it has no jsonrpc="2.0" field.
Only exact numeric response IDs are accepted. Body JSON errors, duplicate envelope
keys, contradictory result/error fields and oversized replies fail closed.
An explicit JSON null result remains valid; an RPC fault with result:null is valid.

HttpTransport requires explicit credentials. HTTPS validates certificate chains
with system/bundled trust and optionally an additional PEM CA. Plain HTTP is allowed
only for loopback hostnames/IPs. URL credentials, query strings and fragments are
rejected. Redirects and environment proxies are disabled to avoid forwarding
Basic credentials. No certificate-verification bypass is offered.

The Tokio/reqwest transport uses a cancellable whole-exchange deadline and checks advertised body
size and reads through a cap+1 streaming reader (1 MiB default, 16 MiB absolute
configurable maximum). Unsupported content encodings are not enabled. HTTP 401,
other HTTP failures, JSON-RPC error codes, and malformed bodies are distinguished.
There are no automatic retries. Errors and Debug output never contain credentials.
Only the configured endpoint is contacted. The HTTP hostname localhost is pinned to 127.0.0.1.

For the legacy bestBlock workflow, best_block_height first calls
getbestblockhash, then getblock, accepting genesis height zero.

## Verification

Toolchain Rust 1.90.0. Node, Python 3 and OpenSSL are needed for fixture tests.

    cd rust/tl-rpc-client
    cargo test --locked --offline
    node scripts/verify-wire.cjs
    python3 scripts/test-tls.py
    cargo clippy --locked --offline --all-targets -- -D warnings
    cargo fmt --all -- --check

The golden-wire script runs the request-object expression from the upstream
TypeScript source pinned to blob 94649945b9603395f115de23541dea25a9f88949.
It compares ten exact request serializations. Keep this baseline until the
existing TypeScript hardening PR #2 is reviewed and intentionally rebased.

Integration tests use ephemeral localhost HTTP and HTTPS fixtures. They exercise
authentication headers, UTF-8 byte lengths, HTTP 401/500/503 and redirects,
RPC fault preservation, duplicate/ambiguous keys, ID matching, nested depth,
streaming cap, stalled headers/body, truncated responses and the two-step
height-zero call. TLS fixtures generate a disposable localhost CA via OpenSSL.

## Boundaries

This is application transport, separate from patrickdugan/TradeLayer-Rust's
consensus/ledger/replay crate. TLS, serde and reqwest dependencies are pinned
through Cargo.lock. HTTPS trust still relies on appropriate CA management and
the caller's endpoint selection. Only synthetic credentials and local mock
servers are exercised in CI. Signing, key migration, production deployment
and extension integration require separate review. The frontend and npm
package still use the existing TypeScript implementation until cutover.

Follow-up security review should cover DNS/loopback resolution assumptions,
TLS trust-store policy, transport resource bounds under adversarial long-lived
streams, request and response schema compatibility across Litecoin/Bitcoin
node versions, and the broader set of TradeLayer-specific read methods.

## Port coverage and Lean verification

The legacy TypeScript surface is `RpcClient.call(method, ...args)` and
`Complex.bestBlock()` (`src/main/rpc-client.ts`, `src/main/complex.ts`).
`bestBlock` is ported as `best_block_height`. The arbitrary-method `call` is
deliberately not ported: only the closed `ReadCall` set can reach the wire
(repaired defect: the legacy client forwards any method, including wallet and
broadcast RPCs, with default credentials `root`/`passsword`).

`lean/` (Lean 4 v4.34.1, core only, no Mathlib) models three pieces of
`src/lib.rs` and proves:

| Theorem | Models | Statement |
|---|---|---|
| `unescape_escape`, `escape_injective` | `quote` | the JSON string escaping is decodable and injective, so distinct parameters never serialize identically |
| `escape_no_control` | `quote` | the escaped body has no raw control character |
| `escape1_quote_only_escaped` | `quote` | a quote appears only as the escape `\"`, so a parameter cannot close the literal |
| `classify_ok` | `Client::call` checks | a value is returned only for a size-bounded 2xx response echoing the request id with a result |
| `unauthorized_first`, `oversize_first`, `rpc_error_preserved` | same | check order and fault preservation |
| `issue_in_range`, `exhausted_forever`, `run_strictly_increasing` | `Request::new` + `next_id` | ids are in 1..2^53-1, never wrap, and strictly increase per client |

Characters are modelled as code points (`Nat`) and JSON decoding by the adapter is
abstracted to `Outcome`. `decide` examples replay the unit-test vectors
(`zero_height_is_valid`, `missing_id_is_rejected`, `unauthorized_precedes_body_shape`,
`rpc_error_code_is_preserved`, `id_exhaustion_never_wraps`, ...). Run:

    cd lean && lake build && lake env lean AxiomCheck.lean

Axioms reported: only `propext`, `Quot.sound`, `Classical.choice`. The CI `lean`
job in `.github/workflows/rust-rpc.yml` repeats this; it has not run (not pushed).
