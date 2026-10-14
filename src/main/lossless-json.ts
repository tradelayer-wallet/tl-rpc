import { RpcDecimalString } from '../types/types';

/**
 * A strict, linear-time JSON parser that keeps numbers lossless. It is the only
 * JSON decoder the client uses; `rpc-client.ts` calls `parseLosslessJson` once
 * per response body.
 *
 * Number convention (see the README "Numbers" section):
 * - a safe integer (|n| <= 2^53-1, including `-0`) is a `number`;
 * - any other integer value is a `bigint`, with its exact digits;
 * - a non-integer is a `number` when its shortest double representation
 *   denotes the same decimal as the source text, otherwise an
 *   `RpcDecimalString` holding the source text verbatim.
 *
 * Everything else follows JSON.parse: same grammar (RFC 8259), same
 * whitespace, duplicate keys keep the last value, and the same string
 * escapes. Two limits are added: nesting deeper than MAX_NESTING_DEPTH and
 * integers longer than MAX_INTEGER_DIGITS are rejected with a SyntaxError.
 */

/** Deepest allowed nesting of arrays/objects. Deeper input is rejected, not recursed into. */
export const MAX_NESTING_DEPTH = 128;
/** Longest integer (in decimal digits) returned as a bigint. Bounds the work a body can cause. */
export const MAX_INTEGER_DIGITS = 1024;

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
/** Integers with at most this many digits are always safe, so no BigInt is needed. */
const ALWAYS_SAFE_DIGITS = 15;

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

/** A decimal in canonical form: no leading or trailing zeros; value = 0.digits * 10^point. */
interface Canonical {
  neg: boolean;
  digits: string;
  point: number;
}

const canonicalize = (text: string): Canonical => {
  let start = 0;
  const neg = text.charCodeAt(0) === 0x2d;
  if (neg) start = 1;
  const eIdx = text.search(/[eE]/);
  const mantissa = text.slice(start, eIdx === -1 ? text.length : eIdx);
  const exp = eIdx === -1 ? 0 : Number(text.slice(eIdx + 1));
  const dot = mantissa.indexOf('.');
  const intPart = dot === -1 ? mantissa : mantissa.slice(0, dot);
  const fracPart = dot === -1 ? '' : mantissa.slice(dot + 1);
  let digits = intPart + fracPart;
  let point = intPart.length + exp;
  let lead = 0;
  while (lead < digits.length && digits.charCodeAt(lead) === 0x30) lead++;
  digits = digits.slice(lead);
  point -= lead;
  let end = digits.length;
  while (end > 0 && digits.charCodeAt(end - 1) === 0x30) end--;
  digits = digits.slice(0, end);
  if (digits === '') return { neg: false, digits: '', point: 0 };
  return { neg, digits, point };
};

const sameDecimal = (a: Canonical, b: Canonical): boolean =>
  a.digits === b.digits && a.point === b.point && a.neg === b.neg;

const setOwn = (obj: Record<string, unknown>, key: string, value: unknown): void => {
  // Assignment would hit the `__proto__` setter; defineProperty makes it an
  // ordinary own key, so the response cannot change the object's prototype.
  if (key === '__proto__') {
    Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = value;
  }
};

class Parser {
  private i = 0;

  constructor(private readonly s: string) {}

  parseDocument(): unknown {
    this.skipWs();
    const value = this.value(0);
    this.skipWs();
    if (this.i !== this.s.length) this.fail('Unexpected content after JSON value');
    return value;
  }

  private fail(reason: string): never {
    throw new SyntaxError(`${reason} at position ${this.i}`);
  }

  private skipWs(): void {
    const s = this.s;
    let i = this.i;
    for (;;) {
      const c = s.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
    this.i = i;
  }

  /** `depth` is the number of containers already open around this value. */
  private value(depth: number): unknown {
    const c = this.s.charCodeAt(this.i);
    switch (c) {
      case 0x7b: // {
        return this.object(depth + 1);
      case 0x5b: // [
        return this.array(depth + 1);
      case 0x22: // "
        return this.string();
      case 0x74: // t
        return this.literal('true', true);
      case 0x66: // f
        return this.literal('false', false);
      case 0x6e: // n
        return this.literal('null', null);
      default:
        if (c === 0x2d || isDigit(c)) return this.number();
        if (this.i >= this.s.length) this.fail('Unexpected end of input');
        this.fail(`Unexpected token '${this.s[this.i]}'`);
    }
  }

  private literal<T>(word: string, value: T): T {
    if (!this.s.startsWith(word, this.i)) this.fail(`Unexpected token '${this.s[this.i] ?? ''}'`);
    this.i += word.length;
    return value;
  }

  private object(depth: number): Record<string, unknown> {
    if (depth > MAX_NESTING_DEPTH) this.fail(`Nesting deeper than ${MAX_NESTING_DEPTH} levels`);
    this.i++; // {
    const obj: Record<string, unknown> = {};
    this.skipWs();
    if (this.s.charCodeAt(this.i) === 0x7d) {
      this.i++;
      return obj;
    }
    for (;;) {
      this.skipWs();
      if (this.s.charCodeAt(this.i) !== 0x22) this.fail('Expected property name');
      const key = this.string();
      this.skipWs();
      if (this.s.charCodeAt(this.i) !== 0x3a) this.fail("Expected ':'");
      this.i++;
      this.skipWs();
      setOwn(obj, key, this.value(depth));
      this.skipWs();
      const c = this.s.charCodeAt(this.i);
      if (c === 0x2c) {
        this.i++;
      } else if (c === 0x7d) {
        this.i++;
        return obj;
      } else {
        this.fail("Expected ',' or '}'");
      }
    }
  }

  private array(depth: number): unknown[] {
    if (depth > MAX_NESTING_DEPTH) this.fail(`Nesting deeper than ${MAX_NESTING_DEPTH} levels`);
    this.i++; // [
    const arr: unknown[] = [];
    this.skipWs();
    if (this.s.charCodeAt(this.i) === 0x5d) {
      this.i++;
      return arr;
    }
    for (;;) {
      this.skipWs();
      arr.push(this.value(depth));
      this.skipWs();
      const c = this.s.charCodeAt(this.i);
      if (c === 0x2c) {
        this.i++;
      } else if (c === 0x5d) {
        this.i++;
        return arr;
      } else {
        this.fail("Expected ',' or ']'");
      }
    }
  }

  private string(): string {
    const s = this.s;
    let i = this.i + 1; // skip the opening quote
    let out = '';
    let start = i;
    for (;;) {
      if (i >= s.length) {
        this.i = i;
        this.fail('Unterminated string');
      }
      const c = s.charCodeAt(i);
      if (c === 0x22) {
        this.i = i + 1;
        return out + s.slice(start, i);
      }
      if (c < 0x20) {
        this.i = i;
        this.fail('Control character in string');
      }
      if (c !== 0x5c) {
        i++;
        continue;
      }
      out += s.slice(start, i);
      i++;
      switch (s.charCodeAt(i)) {
        case 0x22: out += '"'; break;
        case 0x5c: out += '\\'; break;
        case 0x2f: out += '/'; break;
        case 0x62: out += '\b'; break;
        case 0x66: out += '\f'; break;
        case 0x6e: out += '\n'; break;
        case 0x72: out += '\r'; break;
        case 0x74: out += '\t'; break;
        case 0x75: { // u
          const hex = s.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.i = i;
            this.fail('Invalid unicode escape');
          }
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          this.i = i;
          this.fail('Invalid escape sequence');
      }
      i++;
      start = i;
    }
  }

  private number(): number | bigint | RpcDecimalString {
    const s = this.s;
    const start = this.i;
    let i = start;
    if (s.charCodeAt(i) === 0x2d) i++;
    const first = s.charCodeAt(i);
    if (first === 0x30) {
      i++; // a leading zero ends the integer part: "01" is a number "0" followed by junk
    } else if (first >= 0x31 && first <= 0x39) {
      while (isDigit(s.charCodeAt(i))) i++;
    } else {
      this.i = i;
      this.fail('Invalid number');
    }
    let plain = true;
    if (s.charCodeAt(i) === 0x2e) {
      plain = false;
      i++;
      if (!isDigit(s.charCodeAt(i))) {
        this.i = i;
        this.fail('Invalid number');
      }
      while (isDigit(s.charCodeAt(i))) i++;
    }
    const e = s.charCodeAt(i);
    if (e === 0x65 || e === 0x45) {
      plain = false;
      i++;
      const sign = s.charCodeAt(i);
      if (sign === 0x2b || sign === 0x2d) i++;
      if (!isDigit(s.charCodeAt(i))) {
        this.i = i;
        this.fail('Invalid number');
      }
      while (isDigit(s.charCodeAt(i))) i++;
    }
    this.i = i;
    const token = s.slice(start, i);
    // Fast path: a short plain integer is always a safe integer (sign included in the length).
    if (plain && token.length <= ALWAYS_SAFE_DIGITS) return Number(token);
    return this.classify(token);
  }

  private classify(token: string): number | bigint | RpcDecimalString {
    const c = canonicalize(token);
    if (c.digits === '') return Number(token); // zero, possibly -0
    if (c.point >= c.digits.length) {
      // An integer value: exact digits are c.digits followed by zeros.
      if (c.point > MAX_INTEGER_DIGITS) this.fail(`Integer longer than ${MAX_INTEGER_DIGITS} digits`);
      if (c.point <= ALWAYS_SAFE_DIGITS) return Number(token);
      const magnitude = BigInt(c.digits + '0'.repeat(c.point - c.digits.length));
      if (magnitude <= MAX_SAFE_BIG) return Number(token);
      return c.neg ? -magnitude : magnitude;
    }
    const d = Number(token);
    if (Number.isFinite(d) && sameDecimal(canonicalize(String(d)), c)) return d;
    return token as RpcDecimalString;
  }
}

/**
 * Parses a JSON response body. Throws a SyntaxError on invalid JSON, nesting
 * deeper than MAX_NESTING_DEPTH, or an integer longer than MAX_INTEGER_DIGITS.
 */
export const parseLosslessJson = (text: string): unknown => new Parser(text).parseDocument();
