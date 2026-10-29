use std::{io::{Read, Write}, net::{TcpListener, TcpStream}, thread, time::Duration};
use serde_json::{json, Value};
use tl_rpc_client::{Client, Error, Limits, ReadCall, TransportError};
use tl_rpc_client::http::{Credentials, HttpTransport};

fn serve<F>(count: usize, mut handler: F) -> (String, thread::JoinHandle<()>)
where F: FnMut(TcpStream, Value) + Send + 'static {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let handle = thread::spawn(move || {
        for _ in 0..count {
            let (mut conn, _) = listener.accept().unwrap();
            conn.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut data = Vec::new();
            let end = loop {
                let mut chunk = [0; 4096];
                let n = conn.read(&mut chunk).unwrap();
                assert!(n > 0, "client disconnected early");
                data.extend_from_slice(&chunk[..n]);
                if let Some(i) = data.windows(4).position(|s| s == b"\r\n\r\n") { break i + 4; }
                assert!(data.len() < 32768);
            };
            let headers = String::from_utf8(data[..end].to_vec()).unwrap();
            let length: usize = headers.lines().find(|l|
                l.to_ascii_lowercase().starts_with("content-length:")
            ).unwrap().split_once(':').unwrap().1.trim().parse().unwrap();
            while data.len() - end < length {
                let mut chunk = [0; 4096];
                let n = conn.read(&mut chunk).unwrap();
                assert!(n > 0); data.extend_from_slice(&chunk[..n]);
            }
            assert_eq!(data.len() - end, length);
            assert!(headers.starts_with("POST / HTTP/1.1\r\n"));
            assert!(headers.to_ascii_lowercase().contains("authorization: basic ywxpy2u6chc="));
            handler(conn, serde_json::from_slice(&data[end..]).unwrap());
        }
    });
    (url, handle)
}
fn reply(mut conn: TcpStream, status: &str, extra: &str, body: &[u8]) {
    let headers = format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{extra}\r\n", body.len());
    conn.write_all(headers.as_bytes()).unwrap();
    conn.write_all(body).unwrap();
}
fn client(url: &str, limit: usize, timeout: Duration) -> Client<HttpTransport> {
    Client::new(
        HttpTransport::new(url, Credentials::new("alice", "pw").unwrap(), None).unwrap(),
        Limits::new(timeout, limit).unwrap(),
    )
}
#[test]
fn utf8_content_length_and_success() {
    let (url, handle) = serve(1, |conn, v| {
        assert_eq!(v["method"], "validateaddress");
        assert_eq!(v["params"], json!(["é中🚀"]));
        let body = json!({"result":{"isvalid":false},"error":null,"id":v["id"]}).to_string();
        reply(conn, "200 OK", "", body.as_bytes());
    });
    let result = client(&url, 2048, Duration::from_secs(1))
        .call(ReadCall::ValidateAddress("é中🚀".into())).unwrap();
    assert_eq!(result["isvalid"], false);
    handle.join().unwrap();
}
#[test]
fn http_500_preserves_rpc_fault() {
    let (url, handle) = serve(1, |conn, v| {
        let body = json!({"result":null,"error":{"code":-32601,"message":"unknown method"},"id":v["id"]}).to_string();
        reply(conn, "500 Internal Server Error", "", body.as_bytes());
    });
    assert_eq!(
        client(&url, 2048, Duration::from_secs(1)).call(ReadCall::GetBlockCount),
        Err(Error::Rpc { code: -32601, message: "unknown method".into() })
    );
    handle.join().unwrap();
}
#[test]
fn auth_redirect_and_http_failures() {
    for (status, extra, expected) in [
        ("401 Unauthorized", "", Error::Unauthorized),
        ("503 Service Unavailable", "", Error::Http(503)),
        ("302 Found", "Location: http://localhost:1/secret\r\n", Error::Http(302)),
    ] {
        let (url, handle) = serve(1, move |conn, _| reply(conn, status, extra, b"not json"));
        assert_eq!(
            client(&url, 2048, Duration::from_secs(1)).call(ReadCall::GetBlockCount),
            Err(expected)
        );
        handle.join().unwrap();
    }
}
#[test]
fn missing_mismatch_duplicate_and_contradictory_envelopes() {
    for (body, expected) in [
        (r#"{"result":42,"error":null}"#, Error::MissingId),
        (r#"{"id":2,"result":42,"error":null}"#, Error::IdMismatch),
        (r#"{"id":1,"id":1,"result":42,"error":null}"#, Error::Malformed),
        (r#"{"id":1,"result":1,"error":{"code":-1,"message":"both"}}"#, Error::Malformed),
        (r#"{"id":1,"result":1,"result":2}"#, Error::Malformed),
    ] {
        let body = body.to_owned();
        let (url, handle) = serve(1, move |conn, _| reply(conn, "200 OK", "", body.as_bytes()));
        assert_eq!(
            client(&url, 2048, Duration::from_secs(1)).call(ReadCall::GetBlockCount),
            Err(expected)
        );
        handle.join().unwrap();
    }
}
#[test]
fn excessive_json_depth_fails() {
    let body = format!("{{\"id\":1,\"result\":{}{}}}", "[".repeat(150), "]".repeat(150));
    let (url, handle) = serve(1, move |conn, _| reply(conn, "200 OK", "", body.as_bytes()));
    assert_eq!(
        client(&url, 4096, Duration::from_secs(1)).call(ReadCall::GetBlockCount),
        Err(Error::Malformed)
    );
    handle.join().unwrap();
}
#[test]
fn chunked_stream_limit_is_enforced() {
    let (url, handle) = serve(1, |mut conn, _| {
        let body = vec![b'X'; 2000];
        conn.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
        conn.write_all(format!("{:x}\r\n", body.len()).as_bytes()).unwrap();
        conn.write_all(&body).unwrap();
        conn.write_all(b"\r\n0\r\n\r\n").unwrap();
    });
    assert_eq!(
        client(&url, 100, Duration::from_secs(1)).call(ReadCall::GetBlockCount),
        Err(Error::ResponseTooLarge)
    );
    handle.join().unwrap();
}
#[test]
fn overlarge_declared_length_is_rejected() {
    let (url, handle) = serve(1, |mut conn, _| {
        conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n").unwrap();
    });
    assert_eq!(
        client(&url, 100, Duration::from_secs(1)).call(ReadCall::GetBlockCount),
        Err(Error::ResponseTooLarge)
    );
    handle.join().unwrap();
}
#[test]
fn headers_and_partial_body_timeout() {
    for body_started in [false, true] {
        let (url, handle) = serve(1, move |mut conn, _| {
            if body_started {
                conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 120\r\nConnection: close\r\n\r\n{").unwrap();
            }
            thread::sleep(Duration::from_millis(350));
        });
        let result = client(&url, 2048, Duration::from_millis(90)).call(ReadCall::GetBlockCount);
        assert!(matches!(result, Err(Error::Transport(TransportError::Timeout))), "{result:?}");
        handle.join().unwrap();
    }
}
#[test]
fn truncated_body_rejected() {
    let (url, handle) = serve(1, |mut conn, _| {
        conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 200\r\nConnection: close\r\n\r\n{\"id\":1").unwrap();
    });
    let result = client(&url, 2048, Duration::from_secs(1)).call(ReadCall::GetBlockCount);
    assert!(matches!(result, Err(Error::Transport(TransportError::Closed)) | Err(Error::Malformed)), "{result:?}");
    handle.join().unwrap();
}
#[test]
fn best_block_height_accepts_zero() {
    let (url, handle) = serve(2, |conn, v| {
        let value = match v["method"].as_str().unwrap() {
            "getbestblockhash" => json!("a".repeat(64)),
            "getblock" => {
                assert_eq!(v["params"], json!(["a".repeat(64)]));
                json!({"height":0})
            },
            method => panic!("unexpected {method}")
        };
        let body = json!({"result":value,"error":null,"id":v["id"]}).to_string();
        reply(conn, "200 OK", "", body.as_bytes());
    });
    assert_eq!(client(&url, 2048, Duration::from_secs(1)).best_block_height(), Ok(0));
    handle.join().unwrap();
}
