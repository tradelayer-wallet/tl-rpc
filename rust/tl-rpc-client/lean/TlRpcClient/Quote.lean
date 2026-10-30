/-!
Model of `quote` in src/lib.rs, which writes a JSON string literal for the
`getblock`/`validateaddress` parameters. Characters are modelled by their Unicode
scalar values (`Nat`); the Rust function iterates `char`s.

Rust escape table: `"`→`\"`, `\`→`\\`, U+0008→`\b`, U+000C→`\f`, `\n`, `\r`, `\t`,
other code points ≤ U+001F → `\u00XY` (lowercase hex, `{:04x}`), everything else verbatim.
We prove the escaped body is decodable back to the input (so distinct parameters
never serialize to the same JSON string) and contains no raw control character or
raw quote, so it cannot terminate the literal or break the `{id,method,params}` frame.
-/
namespace TlRpcClient

def bs : Nat := 92   -- '\'
def dq : Nat := 34   -- '"'

/-- Lowercase hex digit as produced by Rust's `{:x}`. -/
def hexDigit (d : Nat) : Nat := if d < 10 then 48 + d else 97 + (d - 10)

def hexVal (c : Nat) : Option Nat :=
  if 48 ≤ c ∧ c ≤ 57 then some (c - 48)
  else if 97 ≤ c ∧ c ≤ 102 then some (c - 87)
  else none

def escape1 (c : Nat) : List Nat :=
  if c = dq then [bs, dq]
  else if c = bs then [bs, bs]
  else if c = 8 then [bs, 98]
  else if c = 12 then [bs, 102]
  else if c = 10 then [bs, 110]
  else if c = 13 then [bs, 114]
  else if c = 9 then [bs, 116]
  else if c ≤ 31 then [bs, 117, 48, 48, hexDigit (c / 16), hexDigit (c % 16)]
  else [c]

def escape (s : List Nat) : List Nat := s.flatMap escape1

/-- `quote(value)` = `"` ++ escaped body ++ `"`. -/
def quote (s : List Nat) : List Nat := dq :: escape s ++ [dq]

/-- A JSON string-body decoder restricted to the escapes `quote` can emit. -/
def unescape : List Nat → Option (List Nat)
  | [] => some []
  | 92 :: 34 :: r => (34 :: ·) <$> unescape r
  | 92 :: 92 :: r => (92 :: ·) <$> unescape r
  | 92 :: 98 :: r => (8 :: ·) <$> unescape r
  | 92 :: 102 :: r => (12 :: ·) <$> unescape r
  | 92 :: 110 :: r => (10 :: ·) <$> unescape r
  | 92 :: 114 :: r => (13 :: ·) <$> unescape r
  | 92 :: 116 :: r => (9 :: ·) <$> unescape r
  | 92 :: 117 :: 48 :: 48 :: a :: b :: r =>
    match hexVal a, hexVal b with
    | some x, some y => ((16 * x + y) :: ·) <$> unescape r
    | _, _ => none
  | 92 :: _ => none
  | c :: r => if c = 34 ∨ c < 32 then none else (c :: ·) <$> unescape r

theorem hex_roundtrip_hi : ∀ c, c < 32 → hexVal (hexDigit (c / 16)) = some (c / 16) := by
  decide

theorem hex_roundtrip_lo : ∀ c, c < 32 → hexVal (hexDigit (c % 16)) = some (c % 16) := by
  decide

theorem unescape_escape1 (c : Nat) (rest : List Nat) :
    unescape (escape1 c ++ rest) = (c :: ·) <$> unescape rest := by
  unfold escape1
  by_cases h1 : c = dq
  · subst h1; simp [dq, bs, unescape]
  by_cases h2 : c = bs
  · subst h2; simp [dq, bs, unescape]
  by_cases h3 : c = 8
  · subst h3; simp [dq, bs, unescape]
  by_cases h4 : c = 12
  · subst h4; simp [dq, bs, unescape]
  by_cases h5 : c = 10
  · subst h5; simp [dq, bs, unescape]
  by_cases h6 : c = 13
  · subst h6; simp [dq, bs, unescape]
  by_cases h7 : c = 9
  · subst h7; simp [dq, bs, unescape]
  simp only [h1, h2, h3, h4, h5, h6, h7, if_false]
  by_cases h8 : c ≤ 31
  · simp only [h8, if_true, List.cons_append, List.nil_append, bs]
    have hlt : c < 32 := by omega
    simp only [unescape, hex_roundtrip_hi c hlt, hex_roundtrip_lo c hlt]
    have : 16 * (c / 16) + c % 16 = c := by omega
    rw [this]
  · simp only [h8, if_false, List.cons_append, List.nil_append]
    simp only [dq, bs] at h1 h2
    have hne : ¬(c = 34 ∨ c < 32) := by omega
    -- `c` is neither a backslash nor a quote nor a control code: the default branch.
    rw [unescape.eq_def]
    split <;> (try simp_all) <;> (try (intro h; exfalso; omega))

/-- Decoding inverts encoding: `quote` is injective, so distinct parameters never
collide on the wire. -/
theorem unescape_escape (s : List Nat) : unescape (escape s) = some s := by
  induction s with
  | nil => rfl
  | cons c r ih =>
    simp only [escape, List.flatMap_cons] at *
    rw [unescape_escape1, ih]
    rfl

theorem escape_injective (s t : List Nat) (h : escape s = escape t) : s = t := by
  have hs := unescape_escape s
  rw [h, unescape_escape t] at hs
  exact (Option.some.inj hs).symm

/-- The escaped body contains no raw control character (< U+0020). -/
theorem escape_no_control (s : List Nat) : ∀ x ∈ escape s, 32 ≤ x := by
  intro x hx
  simp only [escape, List.mem_flatMap] at hx
  obtain ⟨c, -, hc⟩ := hx
  unfold escape1 at hc
  have hd : ∀ d, d < 16 → 32 ≤ hexDigit d := by decide
  split at hc <;> (try split at hc) <;> (try split at hc) <;> (try split at hc) <;>
    (try split at hc) <;> (try split at hc) <;> (try split at hc) <;> (try split at hc) <;>
    simp [bs, dq] at hc <;>
    first
    | omega
    | (rcases hc with rfl | rfl | rfl | rfl | rfl | rfl <;>
        first | (simp only [bs]; omega) | omega | exact hd _ (Nat.mod_lt _ (by omega)) |
          exact hd _ (by omega))

/-- A quote character only ever appears in the escaped body as the two-character
escape `\"`, so the parameter cannot close the JSON string literal early. -/
theorem escape1_quote_only_escaped (c : Nat) (h : dq ∈ escape1 c) : escape1 c = [bs, dq] := by
  by_cases hc : c < 32
  · have key : ∀ c, c < 32 → dq ∈ escape1 c → escape1 c = [bs, dq] := by decide
    exact key c hc h
  · by_cases h34 : c = 34
    · subst h34; decide
    · by_cases h92 : c = 92
      · subst h92; simp [escape1, bs, dq] at h
      · have hplain : escape1 c = [c] := by
          unfold escape1
          rw [if_neg (show ¬c = dq from h34), if_neg (show ¬c = bs from h92),
            if_neg (show ¬c = 8 by omega), if_neg (show ¬c = 12 by omega),
            if_neg (show ¬c = 10 by omega), if_neg (show ¬c = 13 by omega),
            if_neg (show ¬c = 9 by omega), if_neg (show ¬c ≤ 31 by omega)]
        rw [hplain] at h
        simp only [List.mem_singleton, dq] at h
        omega

-- Vectors from tests in src/lib.rs (`address_boundaries`, wire_vectors):
-- "a\"b" → "a\\\"b"; tab → \t; U+0001 → \u0001; U+001F → \u001f.
example : escape [97, 34, 98] = [97, 92, 34, 98] := by decide
example : escape [9] = [92, 116] := by decide
example : escape [1] = [92, 117, 48, 48, 48, 49] := by decide
example : escape [31] = [92, 117, 48, 48, 49, 102] := by decide
example : escape [233] = [233] := by decide   -- U+00E9 'é' verbatim (UTF-8 is the adapter's job)

end TlRpcClient
