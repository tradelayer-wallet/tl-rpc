/-!
Model of the response checks in `Client::call` (src/lib.rs), in their Rust order:
size cap, HTTP 401, response id, then outcome with the 2xx requirement.
The adapter's JSON decoding is abstracted to `Outcome`.
-/
namespace TlRpcClient

inductive Outcome where
  | result (v : Nat)
  | rpcError (code : Int)
  | malformed
deriving DecidableEq, Repr

structure Response where
  id : Option Nat
  status : Nat
  bodyBytes : Nat
  outcome : Outcome
deriving DecidableEq, Repr

inductive Err where
  | responseTooLarge
  | unauthorized
  | missingId
  | idMismatch
  | rpc (code : Int)
  | malformed
  | http (status : Nat)
deriving DecidableEq, Repr

def classify (maxBytes reqId : Nat) (r : Response) : Except Err Nat :=
  if r.bodyBytes > maxBytes then .error .responseTooLarge
  else if r.status = 401 then .error .unauthorized
  else match r.id with
    | none => .error .missingId
    | some id =>
      if id ≠ reqId then .error .idMismatch
      else match r.outcome with
        | .rpcError code => .error (.rpc code)
        | .malformed => .error .malformed
        | .result v => if 200 ≤ r.status ∧ r.status < 300 then .ok v else .error (.http r.status)

/-- A value is returned only for a 2xx, size-bounded response that echoes the request
id and carries a result: no HTTP error, foreign id or RPC fault is ever a success. -/
theorem classify_ok (maxBytes reqId v : Nat) (r : Response) (h : classify maxBytes reqId r = .ok v) :
    r.bodyBytes ≤ maxBytes ∧ 200 ≤ r.status ∧ r.status < 300 ∧ r.id = some reqId ∧
      r.outcome = .result v := by
  unfold classify at h
  split at h
  · simp at h
  · rename_i hb
    split at h
    · simp at h
    · split at h
      · simp at h
      · rename_i id hid
        split at h
        · simp at h
        · rename_i heq
          split at h
          · simp at h
          · simp at h
          · rename_i w hw
            split at h
            · rename_i hs
              simp only [Except.ok.injEq] at h
              subst h
              refine ⟨by omega, hs.1, hs.2, ?_, hw⟩
              rw [hid]; simp only [Option.some.injEq]; omega
            · simp at h

/-- 401 is reported as Unauthorized before the body or id is interpreted. -/
theorem unauthorized_first (maxBytes reqId : Nat) (r : Response) (hb : r.bodyBytes ≤ maxBytes)
    (h : r.status = 401) : classify maxBytes reqId r = .error .unauthorized := by
  simp [classify, h, Nat.not_lt.mpr hb]

/-- Oversized bodies are refused whatever they contain. -/
theorem oversize_first (maxBytes reqId : Nat) (r : Response) (hb : maxBytes < r.bodyBytes) :
    classify maxBytes reqId r = .error .responseTooLarge := by
  simp [classify, hb]

/-- An RPC fault keeps its code and is never converted into a value. -/
theorem rpc_error_preserved (maxBytes reqId : Nat) (r : Response) (code : Int)
    (hb : r.bodyBytes ≤ maxBytes) (hs : r.status ≠ 401) (hid : r.id = some reqId)
    (ho : r.outcome = .rpcError code) : classify maxBytes reqId r = .error (.rpc code) := by
  simp [classify, Nat.not_lt.mpr hb, hs, hid, ho]

def errOf {α : Type} : Except Err α → Option Err
  | .error e => some e
  | .ok _ => none

-- Vectors from src/lib.rs tests.
def base : Response := ⟨some 1, 200, 10, .result 0⟩
example : (classify 1048576 1 base).toOption = some 0 := by decide                 -- zero_height_is_valid
example : errOf (classify 1048576 1 { base with id := none }) = some .missingId := by decide
example : errOf (classify 1048576 1 { base with id := some 2 }) = some .idMismatch := by decide
example : errOf (classify 1048576 1 { base with status := 401, outcome := .malformed }) =
    some .unauthorized := by decide                                     -- unauthorized_precedes_body_shape
example : errOf (classify 1048576 1 { base with status := 500 }) = some (.http 500) := by decide
example : errOf (classify 1048576 1 { base with status := 500, outcome := .rpcError (-8) }) =
    some (.rpc (-8)) := by decide                                       -- rpc_error_code_is_preserved
example : errOf (classify 1048576 1 { base with bodyBytes := 1048577 }) =
    some .responseTooLarge := by decide
example : errOf (classify 1048576 1 { base with outcome := .malformed }) = some .malformed := by
  decide

end TlRpcClient
