use tl_rpc_client::{ReadCall, Request};

fn main() {
    let cases = [
        ("best_hash", ReadCall::GetBestBlockHash),
        ("block", ReadCall::GetBlock("ab".repeat(32))),
        ("count", ReadCall::GetBlockCount),
        ("genesis", ReadCall::GetBlockHash(0)),
        ("chain_info", ReadCall::GetBlockchainInfo),
        ("address", ReadCall::ValidateAddress("example".into())),
        ("unicode", ReadCall::ValidateAddress("é中🚀".into())),
        ("escaped", ReadCall::ValidateAddress("a\"\\\n\t".into())),
        (
            "controls",
            ReadCall::ValidateAddress("\0\u{8}\u{c}\r\u{1f}".into()),
        ),
        (
            "injection",
            ReadCall::ValidateAddress("x\"}],\"method\":\"sendtoaddress".into()),
        ),
    ];
    for (name, call) in cases {
        let request = Request::new(7, call).expect("fixture request");
        let body = std::str::from_utf8(request.body()).expect("UTF-8 encoder");
        println!("{name}\t{body}");
    }
}
