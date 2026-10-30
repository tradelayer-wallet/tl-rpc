/-!
Model of request-id handling in `Request::new` and `Client::call` (src/lib.rs).
`Request::new` refuses `id = 0` and `id > MAX_WIRE_INTEGER` (2^53 - 1, exact in the
JavaScript client) with `IdExhausted`; `call` increments `next_id` only after a request
was built. An invalid call (bad hash/address) is refused before the id advances.
-/
namespace TlRpcClient

def maxWire : Nat := 9007199254740991

/-- One `call`: `none` = refused (`IdExhausted` or invalid call), else the id used and
the next counter. `valid` abstracts the per-call parameter checks. -/
def issue (next : Nat) (valid : Bool) : Option (Nat × Nat) :=
  if next = 0 ∨ next > maxWire then none
  else if !valid then none
  else some (next, next + 1)

/-- Every id placed on the wire is in `1..=2^53-1`. -/
theorem issue_in_range (next : Nat) (valid : Bool) (id n' : Nat)
    (h : issue next valid = some (id, n')) : 1 ≤ id ∧ id ≤ maxWire ∧ n' = id + 1 := by
  unfold issue at h
  split at h
  · simp at h
  · split at h
    · simp at h
    · simp only [Option.some.injEq, Prod.mk.injEq] at h
      obtain ⟨rfl, rfl⟩ := h
      omega

/-- Ids never wrap: once the counter passes the wire maximum every call is refused. -/
theorem exhausted_forever (next : Nat) (valid : Bool) (h : maxWire < next) :
    issue next valid = none := by
  simp [issue, h]

/-- Run a sequence of calls from a counter, collecting the ids actually sent. -/
def run : Nat → List Bool → List Nat
  | _, [] => []
  | next, v :: vs =>
    match issue next v with
    | some (id, n') => id :: run n' vs
    | none => run next vs

theorem run_ge (next : Nat) (vs : List Bool) : ∀ x ∈ run next vs, next ≤ x := by
  induction vs generalizing next with
  | nil => simp [run]
  | cons v vs ih =>
    intro x hx
    simp only [run] at hx
    split at hx
    · rename_i id n' h
      have := issue_in_range _ _ _ _ h
      unfold issue at h
      split at h
      · simp at h
      · split at h
        · simp at h
        · simp only [Option.some.injEq, Prod.mk.injEq] at h
          obtain ⟨rfl, rfl⟩ := h
          simp only [List.mem_cons] at hx
          rcases hx with rfl | hx
          · omega
          · have := ih _ x hx; omega
    · exact ih _ x hx

/-- Ids sent by one client are strictly increasing, hence pairwise distinct, so a
response can only ever match the request it answers. -/
theorem run_strictly_increasing (next : Nat) (vs : List Bool) :
    (run next vs).Pairwise (· < ·) := by
  induction vs generalizing next with
  | nil => simp [run]
  | cons v vs ih =>
    simp only [run]
    split
    · rename_i id n' h
      have hr := issue_in_range _ _ _ _ h
      refine List.Pairwise.cons ?_ (ih n')
      intro y hy
      have := run_ge n' vs y hy
      omega
    · exact ih next

-- `ids_advance_after_failure_and_limits_are_forwarded`, `invalid_call_never_reaches_transport`,
-- `id_exhaustion_never_wraps`.
example : run 1 [true, false, true] = [1, 2] := by decide
example : run maxWire [true, true] = [maxWire] := by decide
example : issue 0 true = none := by decide

end TlRpcClient
