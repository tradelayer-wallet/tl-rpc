//! Native-node integration: every read call against a real Bitcoin Core regtest node.
//! Ignored by default. Run against a throwaway node with synthetic credentials:
//!
//!   TL_RPC_NODE_URL=http://127.0.0.1:18999 TL_RPC_NODE_USER=u TL_RPC_NODE_PASS=p \
//!   TL_RPC_NODE_ADDRESS=<a regtest address> cargo test --test regtest_node -- --ignored
use tl_rpc_client::http::{Credentials, HttpTransport};
use tl_rpc_client::{Client, Error, Limits, ReadCall};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} not set"))
}

fn client(pass: &str) -> Client<HttpTransport> {
    let creds = Credentials::new(env("TL_RPC_NODE_USER"), pass).unwrap();
    let transport = HttpTransport::new(&env("TL_RPC_NODE_URL"), creds, None).unwrap();
    Client::new(transport, Limits::default())
}

#[test]
#[ignore = "needs a local regtest node; see module docs"]
fn every_read_call_against_a_regtest_node() {
    let mut c = client(&env("TL_RPC_NODE_PASS"));

    let info = c.call(ReadCall::GetBlockchainInfo).unwrap();
    assert_eq!(info["chain"], "regtest");

    let count = c.call(ReadCall::GetBlockCount).unwrap().as_u64().unwrap();
    assert!(count >= 1, "mine at least one block first");

    let best = c.call(ReadCall::GetBestBlockHash).unwrap();
    let best = best.as_str().unwrap().to_owned();
    assert_eq!(best.len(), 64);

    let block = c.call(ReadCall::GetBlock(best.clone())).unwrap();
    assert_eq!(block["hash"], best.as_str());
    assert_eq!(block["height"].as_u64(), Some(count));

    let tip_hash = c.call(ReadCall::GetBlockHash(count)).unwrap();
    assert_eq!(tip_hash.as_str(), Some(best.as_str()));
    let genesis = c.call(ReadCall::GetBlockHash(0)).unwrap();
    assert_eq!(genesis.as_str().map(str::len), Some(64));

    // The legacy two-call helper accepts and reports the same height.
    assert_eq!(c.best_block_height().unwrap(), count);

    let v = c
        .call(ReadCall::ValidateAddress(env("TL_RPC_NODE_ADDRESS")))
        .unwrap();
    assert_eq!(v["isvalid"], true);
    let v = c
        .call(ReadCall::ValidateAddress("not-an-address".into()))
        .unwrap();
    assert_eq!(v["isvalid"], false);

    // RPC faults keep the node's code: unknown block is RPC_INVALID_ADDRESS_OR_KEY (-5).
    match c.call(ReadCall::GetBlock("00".repeat(32))) {
        Err(Error::Rpc { code, .. }) => assert_eq!(code, -5),
        other => panic!("expected RPC error, got {other:?}"),
    }
    // Height beyond the tip is RPC_INVALID_PARAMETER (-8).
    match c.call(ReadCall::GetBlockHash(count + 1_000)) {
        Err(Error::Rpc { code, .. }) => assert_eq!(code, -8),
        other => panic!("expected RPC error, got {other:?}"),
    }
}

#[test]
#[ignore = "needs a local regtest node; see module docs"]
fn wrong_password_is_unauthorized_against_a_regtest_node() {
    let mut c = client("definitely-wrong-password");
    assert!(matches!(
        c.call(ReadCall::GetBlockCount),
        Err(Error::Unauthorized)
    ));
}
