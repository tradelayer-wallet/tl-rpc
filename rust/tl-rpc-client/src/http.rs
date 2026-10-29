//! Read-only RPC transport. HTTPS always verifies TLS; plain HTTP requires loopback.
use std::{fmt, io::{self, Read}, net::IpAddr, time::Duration};
use reqwest::{blocking::Client as HttpClient, header::{ACCEPT, ACCEPT_ENCODING, CONTENT_TYPE}, redirect::Policy, Url};
use serde::{Deserialize, Deserializer, de::{self, MapAccess, Visitor}};
use serde_json::Value;
use crate::{Client, Error, Limits, Outcome, ReadCall, Request, Response, Transport, TransportError, MAX_WIRE_INTEGER};

/// A credential pair with no fallback defaults. Debug never exposes secrets.
pub struct Credentials { username: String, password: String }
impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("Credentials(<redacted>)") }
}
impl Credentials {
    pub fn new(username: impl Into<String>, password: impl Into<String>) -> Result<Self, Error> {
        let username = username.into();
        let password = password.into();
        if username.is_empty() || username.contains(':') || username.contains('\r') || username.contains('\n')
            || password.is_empty() || password.contains('\r') || password.contains('\n') {
            return Err(Error::InvalidRequest);
        }
        Ok(Self { username, password })
    }
}

/// The caller supplies a trusted URL, credentials and optionally a PEM CA root.
pub struct HttpTransport { url: Url, credentials: Credentials, client: HttpClient }
impl HttpTransport {
    pub fn new(endpoint: &str, credentials: Credentials, ca_pem: Option<&[u8]>) -> Result<Self, Error> {
        let url = Url::parse(endpoint).map_err(|_| Error::InvalidRequest)?;
        if url.host_str().is_none() || url.query().is_some() || url.fragment().is_some()
            || !url.username().is_empty() || url.password().is_some() {
            return Err(Error::InvalidRequest);
        }
        match url.scheme() {
            "https" => {},
            "http" if is_loopback_host(url.host_str().unwrap_or_default()) => {},
            _ => return Err(Error::InvalidRequest),
        }
        // No environment proxies or redirects, so Basic credentials stay at the selected origin.
        let mut builder = HttpClient::builder().no_proxy().redirect(Policy::none())
            .pool_max_idle_per_host(0).connect_timeout(Duration::from_secs(10));
        if let Some(pem) = ca_pem {
            if url.scheme() != "https" { return Err(Error::InvalidRequest); }
            let pem_text = std::str::from_utf8(pem).map_err(|_| Error::InvalidRequest)?;
            if !pem_text.contains("-----BEGIN CERTIFICATE-----") || !pem_text.contains("-----END CERTIFICATE-----") {
                return Err(Error::InvalidRequest);
            }
            let cert = reqwest::Certificate::from_pem(pem).map_err(|_| Error::InvalidRequest)?;
            builder = builder.add_root_certificate(cert);
        }
        let client = builder.build().map_err(|_| Error::Transport(TransportError::Other("TLS setup failed".into())))?;
        Ok(Self { url, credentials, client })
    }
}
fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") { return true; }
    host.trim_start_matches('[').trim_end_matches(']')
        .parse::<IpAddr>().is_ok_and(|a| a.is_loopback())
}
impl Transport for HttpTransport {
    type Value = Value;
    fn exchange(&mut self, request: &Request, limits: Limits) -> Result<Response<Value>, TransportError> {
        let response = self.client.post(self.url.clone())
            // Reqwest applies this timeout across request, headers and response body.
            .timeout(limits.timeout())
            .basic_auth(&self.credentials.username, Some(&self.credentials.password))
            .header(CONTENT_TYPE, "application/json").header(ACCEPT, "application/json")
            .header(ACCEPT_ENCODING, "identity").body(request.body().to_vec()).send()
            .map_err(map_reqwest_error)?;
        let status_code = response.status().as_u16();
        if status_code == 401 {
            return Ok(Response { id: None, status_code, body_bytes: 0, outcome: Outcome::Malformed });
        }
        if !(200..300).contains(&status_code) && status_code != 500 {
            return Ok(Response { id: Some(request.id()), status_code, body_bytes: 0, outcome: Outcome::Result(Value::Null) });
        }
        let max = limits.max_response_bytes();
        if response.content_length().is_some_and(|n| n > max as u64) {
            return Err(TransportError::ResponseTooLarge);
        }
        // Take(max+1) bounds allocations even for chunked replies without Content-Length.
        let mut bytes = Vec::new();
        response.take(max as u64 + 1).read_to_end(&mut bytes).map_err(map_io_error)?;
        if bytes.len() > max { return Err(TransportError::ResponseTooLarge); }
        let reply: WireReply = serde_json::from_slice(&bytes).map_err(|_| TransportError::MalformedResponse)?;
        let outcome = match reply.outcome {
            ParsedOutcome::Result(v) => Outcome::Result(v),
            ParsedOutcome::Fault { code, message } => Outcome::RpcError { code, message },
        };
        Ok(Response { id: reply.id, status_code, body_bytes: bytes.len(), outcome })
    }
}
fn map_reqwest_error(err: reqwest::Error) -> TransportError {
    if err.is_timeout() { TransportError::Timeout }
    else { TransportError::Other("HTTP/TLS request failed".into()) }
}
fn map_io_error(err: io::Error) -> TransportError {
    if matches!(err.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock)
        || err.to_string().to_ascii_lowercase().contains("timed out") {
        TransportError::Timeout
    } else { TransportError::Closed }
}

#[derive(Deserialize)]
struct RpcFault { code: i64, message: String }
enum ParsedOutcome { Result(Value), Fault { code: i64, message: String } }
struct WireReply { id: Option<u64>, outcome: ParsedOutcome }
impl<'de> Deserialize<'de> for WireReply {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ReplyVisitor;
        impl<'de> Visitor<'de> for ReplyVisitor {
            type Value = WireReply;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON-RPC object with an id and result or error")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let (mut seen_id, mut seen_result, mut seen_error) = (false, false, false);
                let (mut id, mut result, mut fault) = (None, None, None);
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "id" => {
                            if seen_id { return Err(de::Error::duplicate_field("id")); }
                            seen_id = true;
                            let v: Value = map.next_value()?;
                            id = if v.is_null() { None } else {
                                let n = v.as_u64().ok_or_else(|| de::Error::custom("invalid id type"))?;
                                if n > MAX_WIRE_INTEGER { return Err(de::Error::custom("id exceeds exact range")); }
                                Some(n)
                            };
                        },
                        "result" => {
                            if seen_result { return Err(de::Error::duplicate_field("result")); }
                            seen_result = true; result = Some(map.next_value::<Value>()?);
                        },
                        "error" => {
                            if seen_error { return Err(de::Error::duplicate_field("error")); }
                            seen_error = true; fault = map.next_value::<Option<RpcFault>>()?;
                        },
                        _ => { let _: de::IgnoredAny = map.next_value()?; }
                    }
                }
                let outcome = if let Some(e) = fault {
                    if result.as_ref().is_some_and(|v| !v.is_null()) {
                        return Err(de::Error::custom("contradictory result and error"));
                    }
                    ParsedOutcome::Fault { code: e.code, message: e.message }
                } else if let Some(v) = result {
                    ParsedOutcome::Result(v)
                } else {
                    return Err(de::Error::custom("missing result/error"));
                };
                Ok(WireReply { id, outcome })
            }
        }
        deserializer.deserialize_map(ReplyVisitor)
    }
}

/// The legacy two-call helper, with genesis-block height zero accepted.
impl Client<HttpTransport> {
    pub fn best_block_height(&mut self) -> Result<u64, Error> {
        let hash_value = self.call(ReadCall::GetBestBlockHash)?;
        let hash = hash_value.as_str().ok_or(Error::Malformed)?;
        let block = self.call(ReadCall::GetBlock(hash.to_owned()))?;
        let height = block.get("height").and_then(Value::as_u64).ok_or(Error::Malformed)?;
        if height > MAX_WIRE_INTEGER { return Err(Error::Malformed); }
        Ok(height)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn endpoint_policy_and_redaction() {
        let c = || Credentials::new("alice", "pw").unwrap();
        assert!(!format!("{:?}", c()).contains("pw"));
        assert!(Credentials::new("alice:invalid", "pw").is_err());
        assert!(HttpTransport::new("http://localhost:9332", c(), None).is_ok());
        assert!(HttpTransport::new("http://[::1]:9332", c(), None).is_ok());
        assert!(HttpTransport::new("http://127.0.0.1:9332", c(), None).is_ok());
        assert!(HttpTransport::new("http://192.168.1.1:9332", c(), None).is_err());
        assert!(HttpTransport::new("http://example.com:9332", c(), None).is_err());
        assert!(HttpTransport::new("https://example.com", c(), None).is_ok());
        assert!(HttpTransport::new("https://u:p@example.com", c(), None).is_err());
        assert!(HttpTransport::new("https://example.com?redirect=1", c(), None).is_err());
        assert!(HttpTransport::new("file:///etc/passwd", c(), None).is_err());
        assert!(HttpTransport::new("https://localhost", c(), Some(b"invalid")).is_err());
    }
    #[test] fn duplicate_and_ambiguous_wire_replies() {
        for body in [
            r#"{"id":1,"id":1,"result":5}"#,
            r#"{"id":1,"result":1,"result":2}"#,
            r#"{"id":1,"error":null,"error":null,"result":5}"#,
            r#"{"id":1,"result":1,"error":{"code":-1,"message":"x"}}"#,
            r#"{"id":1,"error":{"code":-1,"code":-2,"message":"x"}}"#,
            r#"{"id":9007199254740992,"result":5}"#,
            r#"{"id":1,"error":null}"#
        ] { assert!(serde_json::from_str::<WireReply>(body).is_err(), "{body}"); }
        let reply: WireReply = serde_json::from_str(r#"{"id":1,"result":null,"error":{"code":-32601,"message":"missing"}}"#).unwrap();
        assert!(matches!(reply.outcome, ParsedOutcome::Fault { code: -32601, .. }));
        let reply: WireReply = serde_json::from_str(r#"{"id":1,"result":null,"error":null}"#).unwrap();
        assert!(matches!(reply.outcome, ParsedOutcome::Result(Value::Null)));
    }
}
