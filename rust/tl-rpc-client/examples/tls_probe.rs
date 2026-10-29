use std::fs;
use tl_rpc_client::http::{Credentials, HttpTransport};
use tl_rpc_client::{Client, Limits, ReadCall};

fn main() {
    let mut args = std::env::args().skip(1);
    let url = args.next().expect("fixture URL");
    let cert = fs::read(args.next().expect("fixture CA path")).unwrap();
    let credentials = || Credentials::new("alice", "pw").unwrap();
    let untrusted = HttpTransport::new(&url, credentials(), None).unwrap();
    assert!(Client::new(untrusted, Limits::default())
        .call(ReadCall::GetBlockCount).is_err(), "unexpected trust of self-signed certificate");
    let trusted = HttpTransport::new(&url, credentials(), Some(&cert)).unwrap();
    let value = Client::new(trusted, Limits::default()).call(ReadCall::GetBlockCount).unwrap();
    assert_eq!(value.as_u64(), Some(0));
}
