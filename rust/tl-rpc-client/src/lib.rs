//! Offline RPC contract scaffold. A reviewed HTTP/JSON adapter is still required.
//! Transport implementations must enforce the supplied deadline and streaming cap.
//! This crate holds no credentials and provides no signing or broadcast operation.
#![forbid(unsafe_code)]

use std::fmt;
use std::time::Duration;

/// Largest integer represented exactly by the legacy JavaScript client.
pub const MAX_WIRE_INTEGER: u64 = 9_007_199_254_740_991;

/// Explicit read-only operations. Arbitrary method names cannot enter this API.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadCall {
    GetBestBlockHash,
    GetBlock(String),
    GetBlockCount,
    GetBlockHash(u64),
    GetBlockchainInfo,
    ValidateAddress(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidRequest,
    IdExhausted,
    InvalidLimits,
    Unauthorized,
    MissingId,
    IdMismatch,
    ResponseTooLarge,
    Http(u16),
    Rpc { code: i64, message: String },
    Malformed,
    Transport(TransportError),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for Error {}

/// A validated, immutable legacy envelope: {id, method, params}.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    id: u64,
    body: Vec<u8>,
}

impl Request {
    pub fn new(id: u64, call: ReadCall) -> Result<Self, Error> {
        if id == 0 || id > MAX_WIRE_INTEGER {
            return Err(Error::IdExhausted);
        }
        let (method, params) = match call {
            ReadCall::GetBestBlockHash => ("getbestblockhash", String::new()),
            ReadCall::GetBlockCount => ("getblockcount", String::new()),
            ReadCall::GetBlockchainInfo => ("getblockchaininfo", String::new()),
            ReadCall::GetBlock(hash) => {
                if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(Error::InvalidRequest);
                }
                ("getblock", quote(&hash))
            }
            ReadCall::GetBlockHash(height) => {
                if height > MAX_WIRE_INTEGER {
                    return Err(Error::InvalidRequest);
                }
                ("getblockhash", height.to_string())
            }
            ReadCall::ValidateAddress(address) => {
                // The server decides address validity; this is a resource bound.
                if address.is_empty() || address.len() > 128 {
                    return Err(Error::InvalidRequest);
                }
                ("validateaddress", quote(&address))
            }
        };
        let body = format!("{{\"id\":{id},\"method\":\"{method}\",\"params\":[{params}]}}").into_bytes();
        Ok(Self { id, body })
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn body(&self) -> &[u8] {
        &self.body
    }

    /// HTTP adapters must use this UTF-8 byte length, including for Unicode.
    pub fn content_length(&self) -> usize {
        self.body.len()
    }
}

fn quote(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c <= '\u{1f}' => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    timeout: Duration,
    max_response_bytes: usize,
}

impl Limits {
    pub fn new(timeout: Duration, max_response_bytes: usize) -> Result<Self, Error> {
        if timeout.is_zero()
            || timeout > Duration::from_secs(120)
            || max_response_bytes == 0
            || max_response_bytes > 16 * 1024 * 1024
        {
            return Err(Error::InvalidLimits);
        }
        Ok(Self {
            timeout,
            max_response_bytes,
        })
    }

    pub fn timeout(self) -> Duration {
        self.timeout
    }

    pub fn max_response_bytes(self) -> usize {
        self.max_response_bytes
    }
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(3),
            max_response_bytes: 1024 * 1024,
        }
    }
}

/// Decoded response supplied by an adapter. JSON null can be Result(None::<T>).
/// The adapter must reject duplicate envelope keys and ambiguous result/error pairs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome<T> {
    Result(T),
    RpcError { code: i64, message: String },
    Malformed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Response<T> {
    pub id: Option<u64>,
    pub status_code: u16,
    pub body_bytes: usize,
    pub outcome: Outcome<T>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransportError {
    Timeout,
    Closed,
    Other(String),
}

/// Future adapters own HTTP/TLS and JSON decoding. They must cap bytes before
/// allocation and cancel the socket when the whole exchange deadline expires.
/// These obligations are a contract; the offline scaffold cannot enforce I/O.
pub trait Transport {
    type Value;

    fn exchange(
        &mut self,
        request: &Request,
        limits: Limits,
    ) -> Result<Response<Self::Value>, TransportError>;
}

pub struct Client<T> {
    transport: T,
    next_id: u64,
    limits: Limits,
}

impl<T: Transport> Client<T> {
    pub fn new(transport: T, limits: Limits) -> Self {
        Self {
            transport,
            next_id: 1,
            limits,
        }
    }

    /// One exchange, without automatic retries. IDs are scoped to this client.
    pub fn call(&mut self, call: ReadCall) -> Result<T::Value, Error> {
        let request = Request::new(self.next_id, call)?;
        self.next_id += 1; // The validated ID is at most 2^53 - 1.
        let response = self
            .transport
            .exchange(&request, self.limits)
            .map_err(Error::Transport)?;
        if response.body_bytes > self.limits.max_response_bytes {
            return Err(Error::ResponseTooLarge);
        }
        if response.status_code == 401 {
            return Err(Error::Unauthorized);
        }
        match response.id {
            None => return Err(Error::MissingId),
            Some(id) if id != request.id => return Err(Error::IdMismatch),
            Some(_) => {}
        }
        match response.outcome {
            Outcome::RpcError { code, message } => Err(Error::Rpc { code, message }),
            Outcome::Malformed => Err(Error::Malformed),
            Outcome::Result(value) if (200..300).contains(&response.status_code) => Ok(value),
            Outcome::Result(_) => Err(Error::Http(response.status_code)),
        }
    }

    pub fn into_transport(self) -> T {
        self.transport
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Mock {
        response: Result<Response<Option<u64>>, TransportError>,
        seen: Vec<(u64, Limits)>,
    }

    impl Transport for Mock {
        type Value = Option<u64>;

        fn exchange(
            &mut self,
            request: &Request,
            limits: Limits,
        ) -> Result<Response<Self::Value>, TransportError> {
            self.seen.push((request.id(), limits));
            self.response.clone()
        }
    }

    fn response() -> Response<Option<u64>> {
        Response {
            id: Some(1),
            status_code: 200,
            body_bytes: 40,
            outcome: Outcome::Result(Some(0)),
        }
    }

    fn run(r: Response<Option<u64>>) -> Result<Option<u64>, Error> {
        Client::new(
            Mock {
                response: Ok(r),
                seen: vec![],
            },
            Limits::default(),
        )
        .call(ReadCall::GetBlockCount)
    }

    #[test]
    fn zero_height_is_valid() {
        assert_eq!(run(response()), Ok(Some(0)));
    }

    #[test]
    fn explicit_null_is_valid() {
        let mut r = response();
        r.outcome = Outcome::Result(None);
        assert_eq!(run(r), Ok(None));
    }

    #[test]
    fn missing_id_is_rejected() {
        let mut r = response();
        r.id = None;
        assert_eq!(run(r), Err(Error::MissingId));
    }

    #[test]
    fn wrong_id_is_rejected() {
        let mut r = response();
        r.id = Some(2);
        assert_eq!(run(r), Err(Error::IdMismatch));
    }

    #[test]
    fn unauthorized_precedes_body_shape() {
        let mut r = response();
        r.status_code = 401;
        r.id = None;
        assert_eq!(run(r), Err(Error::Unauthorized));
    }

    #[test]
    fn http_error_cannot_be_success() {
        let mut r = response();
        r.status_code = 503;
        assert_eq!(run(r), Err(Error::Http(503)));
    }

    #[test]
    fn rpc_error_code_is_preserved() {
        let mut r = response();
        r.status_code = 500;
        r.outcome = Outcome::RpcError {
            code: -32601,
            message: "unknown method".into(),
        };
        assert_eq!(
            run(r),
            Err(Error::Rpc {
                code: -32601,
                message: "unknown method".into()
            })
        );
    }

    #[test]
    fn oversized_body_is_rejected() {
        let mut r = response();
        r.body_bytes = 1024 * 1024 + 1;
        assert_eq!(run(r), Err(Error::ResponseTooLarge));
    }

    #[test]
    fn malformed_body_is_rejected() {
        let mut r = response();
        r.outcome = Outcome::Malformed;
        assert_eq!(run(r), Err(Error::Malformed));
    }

    #[test]
    fn transport_failure_is_not_retried() {
        let mock = Mock {
            response: Err(TransportError::Timeout),
            seen: vec![],
        };
        let mut client = Client::new(mock, Limits::default());
        assert_eq!(
            client.call(ReadCall::GetBlockCount),
            Err(Error::Transport(TransportError::Timeout))
        );
        assert_eq!(client.into_transport().seen.len(), 1);
    }

    #[test]
    fn ids_advance_after_failure_and_limits_are_forwarded() {
        let limits = Limits::new(Duration::from_secs(1), 100).unwrap();
        let mock = Mock {
            response: Err(TransportError::Closed),
            seen: vec![],
        };
        let mut client = Client::new(mock, limits);
        let _ = client.call(ReadCall::GetBlockCount);
        let _ = client.call(ReadCall::GetBlockCount);
        assert_eq!(client.into_transport().seen, vec![(1, limits), (2, limits)]);
    }

    #[test]
    fn id_exhaustion_never_wraps() {
        let mock = Mock {
            response: Err(TransportError::Closed),
            seen: vec![],
        };
        let mut client = Client::new(mock, Limits::default());
        client.next_id = MAX_WIRE_INTEGER;
        let _ = client.call(ReadCall::GetBlockCount);
        assert_eq!(client.call(ReadCall::GetBlockCount), Err(Error::IdExhausted));
        assert_eq!(client.into_transport().seen.len(), 1);
    }

    #[test]
    fn invalid_call_never_reaches_transport() {
        let mock = Mock {
            response: Err(TransportError::Closed),
            seen: vec![],
        };
        let mut client = Client::new(mock, Limits::default());
        assert_eq!(
            client.call(ReadCall::GetBlock("wrong".into())),
            Err(Error::InvalidRequest)
        );
        assert!(client.into_transport().seen.is_empty());
    }

    #[test]
    fn wire_integer_boundaries() {
        assert!(Request::new(0, ReadCall::GetBlockCount).is_err());
        assert!(Request::new(MAX_WIRE_INTEGER, ReadCall::GetBlockHash(MAX_WIRE_INTEGER)).is_ok());
        assert!(Request::new(1, ReadCall::GetBlockHash(MAX_WIRE_INTEGER + 1)).is_err());
        assert!(Request::new(MAX_WIRE_INTEGER + 1, ReadCall::GetBlockCount).is_err());
    }

    #[test]
    fn address_boundaries() {
        assert!(Request::new(1, ReadCall::ValidateAddress(String::new())).is_err());
        assert!(Request::new(1, ReadCall::ValidateAddress("a".repeat(128))).is_ok());
        assert!(Request::new(1, ReadCall::ValidateAddress("a".repeat(129))).is_err());
    }

    #[test]
    fn block_hash_boundaries() {
        assert!(Request::new(1, ReadCall::GetBlock("a".repeat(64))).is_ok());
        assert!(Request::new(1, ReadCall::GetBlock("g".repeat(64))).is_err());
        assert!(Request::new(1, ReadCall::GetBlock("a".repeat(63))).is_err());
    }

    #[test]
    fn utf8_content_length_uses_bytes() {
        let r = Request::new(7, ReadCall::ValidateAddress("é中🚀".into())).unwrap();
        assert_eq!(r.content_length(), r.body().len());
        assert!(r.content_length() > String::from_utf8(r.body().to_vec()).unwrap().chars().count());
    }

    #[test]
    fn limits_are_bounded() {
        assert!(Limits::new(Duration::ZERO, 1).is_err());
        assert!(Limits::new(Duration::from_secs(121), 1).is_err());
        assert!(Limits::new(Duration::from_secs(1), 0).is_err());
        assert!(Limits::new(Duration::from_secs(1), 16 * 1024 * 1024 + 1).is_err());
    }
}
