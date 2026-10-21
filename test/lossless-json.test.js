'use strict';
// Differential tests for the response parser (src/main/lossless-json.ts)
// against JSON.parse. The fuzzer uses a fixed seed, so every run sees the same
// documents; raise FUZZ_SCALE in the environment for a longer local soak.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLosslessJson, MAX_NESTING_DEPTH, MAX_INTEGER_DIGITS } = require('../lib/main/lossless-json.js');

const SCALE = Number(process.env.FUZZ_SCALE || 1);
const SEED = 0x5eed1e55;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32).
// ---------------------------------------------------------------------------
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = prng(SEED);
const ri = (n) => Math.floor(R() * n);
const pick = (arr) => arr[ri(arr.length)];
const digits = (n) => Array.from({ length: n }, () => String(ri(10))).join('');
const nonZero = () => String(1 + ri(9));

// ---------------------------------------------------------------------------
// Independent oracle. It classifies a JSON number token from its exact decimal
// value (BigInt arithmetic), not from the parser's own code path.
// ---------------------------------------------------------------------------
const NUMBER_RE = /^(-?)(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

function exactDecimal(tok) {
  const m = NUMBER_RE.exec(tok);
  const neg = m[1] === '-';
  const frac = m[3] ? m[3].slice(1) : '';
  let mant = BigInt(m[2] + frac);
  let e = (m[4] ? Number(m[4].slice(1)) : 0) - frac.length;
  if (mant === 0n) return { neg, mant: 0n, e: 0 };
  while (mant % 10n === 0n) {
    mant /= 10n;
    e++;
  }
  return { neg, mant, e };
}

function oracleNumber(tok) {
  const d = exactDecimal(tok);
  if (d.mant === 0n) return { kind: 'number', value: tok.startsWith('-') ? -0 : 0 };
  if (d.e >= 0) {
    if (d.mant.toString().length + d.e > MAX_INTEGER_DIGITS) return { kind: 'limit' };
    const mag = d.mant * 10n ** BigInt(d.e);
    if (mag <= BigInt(Number.MAX_SAFE_INTEGER)) return { kind: 'number', value: Number(tok) };
    return { kind: 'bigint', value: d.neg ? -mag : mag };
  }
  // A decimal stays a number only if the double's shortest form has the same exact value.
  const dbl = Number(tok);
  if (Number.isFinite(dbl)) {
    const s = exactDecimal(String(dbl));
    if (s.neg === d.neg && s.mant === d.mant && s.e === d.e) return { kind: 'number', value: dbl };
  }
  return { kind: 'string', value: tok };
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------
const EDGE_NUMBERS = [
  '0', '-0', '0.0', '-0.0', '0e0', '-0e5', '0E+2', '1', '-1', '1.0', '1.50', '1e2', '1E+2', '100e-2', '1e-7', '1e+21',
  '0.1', '-0.1', '9007199254740991', '9007199254740992', '-9007199254740991', '-9007199254740992', '9007199254740993',
  '2e53', '1e21', '1e20', '12345678901234567890', '123456789.12345678', '5e-324', '2.5e-324', '4.9e-324',
  '1.7976931348623157e308', '1.7976931348623159e308', '1e309', '1e400', '1e-400', '-1e-400', '1.5e-323',
  '0.10000000000000000001', '0.30000000000000004', '9007199254740992.5', '12345678901234567.5', '0.99999999999999999999',
];

function numberToken() {
  const r = R();
  if (r < 0.15) return pick(EDGE_NUMBERS);
  if (r < 0.35) return (R() < 0.3 ? '-' : '') + (ri(2) ? '0' : nonZero() + digits(ri(15)));
  if (r < 0.45) return (R() < 0.5 ? '-' : '') + nonZero() + digits(15 + ri(30));
  if (r < 0.7) return (R() < 0.3 ? '-' : '') + (R() < 0.4 ? '0' : nonZero() + digits(ri(20))) + '.' + digits(1 + ri(25));
  if (r < 0.85) {
    const mant = R() < 0.5 ? nonZero() + digits(ri(20)) : '0.' + digits(1 + ri(20));
    return (R() < 0.3 ? '-' : '') + mant + pick(['e', 'E']) + pick(['', '', '+', '-']) + ri(340);
  }
  // Doubles printed in many forms: shortest, toPrecision, toExponential, toFixed.
  const d = (R() - 0.5) * 10 ** (ri(60) - 30);
  const forms = [String(d), d.toPrecision(1 + ri(21)), d.toExponential(ri(20)), d.toFixed(ri(25)), String(Math.abs(d))];
  const t = pick(forms);
  return NUMBER_RE.test(t) ? t : String(Math.abs(d));
}

const KEYS = ['a', '', '__proto__', 'constructor', 'prototype', 'hasOwnProperty', '1', '01', '-0', '4294967295', '9007199254740993', 'é', '\ud800'];
const WS = [' ', '\t', '\n', '\r'];
const ws = () => (R() < 0.6 ? '' : Array.from({ length: 1 + ri(3) }, () => pick(WS)).join(''));
const hex4 = () => Array.from({ length: 4 }, () => '0123456789abcdefABCDEF'[ri(22)]).join('');
const SIMPLE_ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function stringNode() {
  let text = '"';
  let value = '';
  const n = ri(12);
  for (let i = 0; i < n; i++) {
    const r = R();
    if (r < 0.55) {
      const c = String.fromCharCode(0x20 + ri(95));
      text += c === '"' || c === '\\' ? '\\' + c : c;
      value += c;
    } else if (r < 0.65) {
      const k = pick(Object.keys(SIMPLE_ESCAPES));
      text += '\\' + k;
      value += SIMPLE_ESCAPES[k];
    } else if (r < 0.75) {
      const h = hex4();
      text += '\\u' + h;
      value += String.fromCharCode(parseInt(h, 16));
    } else if (r < 0.82) {
      const c = String.fromCharCode(0x80 + ri(0xd800 - 0x80));
      text += c;
      value += c;
    } else if (r < 0.88) {
      const s = String.fromCodePoint(0x10000 + ri(0x100000));
      text += s;
      value += s;
    } else if (r < 0.92) {
      text += '\\uD800';
      value += '\uD800';
    } else {
      text += '\\uDC00';
      value += '\uDC00';
    }
  }
  return { t: 'str', text: text + '"', value };
}

// A node is generated once, then rendered to text (with random whitespace)
// and turned into an expected value by the oracle.
function node(depth, maxDepth) {
  const r = R();
  // Deep documents are single-child chains; wide ones would branch exponentially.
  const width = (n) => (maxDepth > 10 ? 1 : n);
  if (depth >= maxDepth || (maxDepth <= 10 && r < 0.5)) {
    const s = R();
    if (s < 0.45) return { t: 'num', tok: numberToken() };
    if (s < 0.6) return { t: 'lit', v: pick([true, false, null]) };
    return stringNode();
  }
  if (r < 0.75) {
    const items = [];
    for (let i = width(ri(6)); i > 0; i--) items.push(node(depth + 1, maxDepth));
    return { t: 'arr', items };
  }
  const entries = [];
  for (let i = width(ri(6)); i > 0; i--) {
    entries.push([R() < 0.7 ? pick(KEYS) : digits(1 + ri(4)), node(depth + 1, maxDepth)]);
  }
  return { t: 'obj', entries };
}

function render(n) {
  switch (n.t) {
    case 'num': return n.tok;
    case 'lit': return n.v === null ? 'null' : String(n.v);
    case 'str': return n.text;
    case 'arr': return '[' + n.items.map((x) => ws() + render(x) + ws()).join(',') + ']';
    case 'obj': return '{' + n.entries.map(([k, x]) => ws() + JSON.stringify(k) + ws() + ':' + ws() + render(x) + ws()).join(',') + '}';
  }
}

// mode 'oracle' gives the expected parser output; mode 'jp' gives the JSON.parse value.
function expected(n, mode) {
  switch (n.t) {
    case 'num': {
      if (mode === 'jp') return Number(n.tok);
      const o = oracleNumber(n.tok);
      assert.notEqual(o.kind, 'limit', 'generator produced a limit token');
      return o.kind === 'string' ? n.tok : o.value;
    }
    case 'lit': return n.v;
    case 'str': return n.value;
    case 'arr': return n.items.map((x) => expected(x, mode));
    case 'obj': {
      const o = {};
      for (const [k, x] of n.entries) {
        Object.defineProperty(o, k, { value: expected(x, mode), writable: true, enumerable: true, configurable: true });
      }
      return o;
    }
  }
}

const depthOf = (v) => (v === null || typeof v !== 'object' ? 0 : 1 + Math.max(0, ...Object.values(v).map(depthOf)));

// ---------------------------------------------------------------------------
// Comparisons.
// ---------------------------------------------------------------------------
// Exact comparison: same types, Object.is for numbers (so -0 matters), same
// key order, own data properties, and Object.prototype as the prototype.
function sameValue(a, b, path = '$') {
  if (typeof a !== typeof b) return `${path}: type ${typeof a} vs ${typeof b}`;
  if (typeof a === 'number') return Object.is(a, b) ? null : `${path}: ${a} vs ${b}`;
  if (typeof a !== 'object' || a === null) return a === b ? null : `${path}: ${String(a)} vs ${String(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array mismatch`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}: length`;
    for (let i = 0; i < a.length; i++) {
      const e = sameValue(a[i], b[i], `${path}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return `${path}: prototype`;
  const ka = Reflect.ownKeys(a);
  const kb = Reflect.ownKeys(b);
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return `${path}: keys`;
  for (const k of ka) {
    const da = Object.getOwnPropertyDescriptor(a, k);
    const db = Object.getOwnPropertyDescriptor(b, k);
    if (!('value' in da) || !('value' in db)) return `${path}.${String(k)}: accessor`;
    const e = sameValue(da.value, db.value, `${path}.${String(k)}`);
    if (e) return e;
  }
  return null;
}

// Parallel walk of our output against JSON.parse's output, for mutated input
// whose number tokens we cannot classify from the text alone. A number in our
// output may be a number, a bigint, or a decimal string; each must denote the
// JSON.parse value.
const NUMBER_TEXT = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
function sameAsJsonParse(ours, jp, path = '$') {
  if (typeof jp === 'number') {
    if (typeof ours === 'number') return Object.is(ours, jp) ? null : `${path}: ${ours} vs ${jp}`;
    if (typeof ours === 'bigint') {
      return Number(ours) === jp && Math.abs(jp) > Number.MAX_SAFE_INTEGER ? null : `${path}: bigint ${ours} vs ${jp}`;
    }
    if (typeof ours === 'string') {
      return NUMBER_TEXT.test(ours) && Object.is(Number(ours), jp) ? null : `${path}: text ${ours} vs ${jp}`;
    }
    return `${path}: type ${typeof ours} where JSON.parse has a number`;
  }
  if (typeof jp !== 'object' || jp === null) return sameValue(ours, jp, path);
  if (Array.isArray(jp)) {
    if (!Array.isArray(ours) || ours.length !== jp.length) return `${path}: array shape`;
    for (let i = 0; i < jp.length; i++) {
      const e = sameAsJsonParse(ours[i], jp[i], `${path}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  if (typeof ours !== 'object' || ours === null || Array.isArray(ours)) return `${path}: object shape`;
  const ko = Reflect.ownKeys(ours);
  const kj = Reflect.ownKeys(jp);
  if (Object.getPrototypeOf(ours) !== Object.prototype || ko.length !== kj.length || ko.some((k, i) => k !== kj[i])) {
    return `${path}: object keys or prototype`;
  }
  for (const k of kj) {
    const e = sameAsJsonParse(Object.getOwnPropertyDescriptor(ours, k).value, jp[k], `${path}.${String(k)}`);
    if (e) return e;
  }
  return null;
}

// True when some number-like run in the text is an integer over MAX_INTEGER_DIGITS.
const hasLimitToken = (text) =>
  (text.match(/-?\d+(\.\d+)?([eE][+-]?\d+)?/g) || []).some((t) => NUMBER_RE.test(t) && oracleNumber(t).kind === 'limit');
const isLimitError = (e) => /^(Nesting deeper than 128 levels|Integer longer than 1024 digits) at position \d+$/.test(e.message);

// One document through both parsers. Returns a divergence description or null.
function compareDocument(text) {
  let jp;
  let jpError = null;
  try {
    jp = JSON.parse(text);
  } catch (e) {
    jpError = e;
  }
  let ours;
  let ourError = null;
  try {
    ours = parseLosslessJson(text);
  } catch (e) {
    ourError = e;
  }
  if (jpError && ourError) return null;
  if (jpError) return 'accepted, but JSON.parse rejects';
  if (ourError) {
    // Documented limits are the only accepted rejections of valid JSON, and
    // each must really be exceeded by the input.
    if (!isLimitError(ourError)) return `rejected: ${ourError.message}`;
    if (/^Nesting/.test(ourError.message)) return depthOf(jp) > MAX_NESTING_DEPTH ? null : `depth ${depthOf(jp)} rejected`;
    return hasLimitToken(text) ? null : 'integer limit reported without an oversized integer';
  }
  return sameAsJsonParse(ours, jp);
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------
const CURATED = [
  '', ' ', '﻿1', '1﻿', ' 1', ' 1', '\u000b1', '\u000c1', '\t1\r\n',
  '01', '-01', '00', '-00', '1.', '.5', '-.5', '+1', '-', '--1', '1e', '1e+', '1E-', '1.e5', '0x1F', 'NaN', 'Infinity', '-Infinity',
  '1_000', '1.2.3', '1 2', '[1,]', '[,1]', '{"a":1,}', '{,}', '{"a" 1}', "{'a':1}", '/*x*/1', '{"a":1}}', '[1]]',
  '"\\u12"', '"\\uD800"', '"\\uDC00"', '"\\x41"', '"\\ "', '"\t"', '"\u0001"', '"\\', '"', '"abc', '"\\U0041"', '"\\uzzzz"',
  'tru', 'truex', '[true,false,null]', '{"__proto__":{"x":1}}', '{"__proto__":1,"__proto__":2}', '{"a":1,"a":2}',
  '{"1":1,"0":2,"b":3,"-1":4}', '[' .repeat(128) + ']'.repeat(128), '['.repeat(129) + ']'.repeat(129),
  '1' + '0'.repeat(1023), '1' + '0'.repeat(1024), '1e1023', '1e1024', '0.' + '0'.repeat(5000) + '1',
  '9007199254740993', '[9007199254740993,0.1]', '{"result":9007199254740993,"error":null}',
];

test('fuzz: curated edge documents agree with JSON.parse (or are a documented limit)', () => {
  for (const text of CURATED) {
    const div = compareDocument(text);
    assert.equal(div, null, `${JSON.stringify(text.slice(0, 80))}: ${div}`);
  }
});

test('fuzz: generated documents decode to the oracle value (number class, -0, key order, prototype)', () => {
  const kinds = { number: 0, bigint: 0, string: 0 };
  const cases = Math.floor(2500 * SCALE);
  for (let i = 0; i < cases; i++) {
    const n = node(0, R() < 0.03 ? 128 + ri(3) : 1 + ri(6));
    const text = ws() + render(n) + ws();
    const jp = JSON.parse(text); // generator output is valid by construction
    if (depthOf(jp) > MAX_NESTING_DEPTH) {
      assert.throws(() => parseLosslessJson(text), (e) => isLimitError(e), text.slice(0, 80));
      continue;
    }
    const ours = parseLosslessJson(text);
    const want = expected(n, 'oracle');
    const err = sameValue(ours, want);
    assert.equal(err, null, `${err} in ${text.slice(0, 200)}`);
    assert.equal(sameAsJsonParse(ours, jp), null, text.slice(0, 200));
    (function tally(x) {
      if (x.t === 'num') kinds[oracleNumber(x.tok).kind] += 1;
      else if (x.t === 'arr') x.items.forEach(tally);
      else if (x.t === 'obj') x.entries.forEach(([, v]) => tally(v));
    })(n);
  }
  // The generator really does produce every number class; a regression in the
  // generator would otherwise make the test pass without covering anything.
  assert.ok(kinds.number > 0 && kinds.bigint > 0 && kinds.string > 0, JSON.stringify(kinds));
});

test('fuzz: single number tokens in several containers match the oracle exactly', () => {
  const wraps = ['%', '[%]', '{"k":%}', '[ % , 0 ]'];
  for (let i = 0; i < Math.floor(1500 * SCALE); i++) {
    const tok = numberToken();
    const o = oracleNumber(tok);
    if (o.kind === 'limit') continue;
    const wrap = pick(wraps);
    const got = parseLosslessJson(wrap.replace('%', tok));
    const first = wrap === '%' ? got : wrap.startsWith('{') ? got.k : got[0];
    assert.equal(sameValue(first, o.value, tok), null, `${wrap} ${tok}`);
  }
});

test('fuzz: mutated documents agree with JSON.parse on accept/reject and on values', () => {
  const ALPHABET = '{}[],:"\\/ tfnrue0123456789.+-EeXxaAbBcCdDfF\n\r\t\u0000\u001f𐀀﻿  \u007f\u000b\u000c';
  for (let i = 0; i < Math.floor(3000 * SCALE); i++) {
    let text = render(node(0, 1 + ri(5)));
    for (let k = 1 + ri(3); k > 0; k--) {
      const r = R();
      const p = ri(text.length + 1);
      if (r < 0.35) text = text.slice(0, p) + pick(ALPHABET) + text.slice(p);
      else if (r < 0.6 && text.length) text = text.slice(0, p) + text.slice(p + 1);
      else if (r < 0.75 && text.length) text = text.slice(0, p) + pick(ALPHABET) + text.slice(p + 1);
      else if (r < 0.85) {
        const a = ri(text.length + 1);
        text = text.slice(0, p) + text.slice(a, Math.min(text.length, a + ri(12))) + text.slice(p);
      } else text = text.slice(0, p);
    }
    const div = compareDocument(text);
    assert.equal(div, null, `${JSON.stringify(text.slice(0, 120))}: ${div}`);
  }
});

test('fuzz: random short garbage agrees with JSON.parse on accept/reject', () => {
  const ALPHABET = '{}[],:"\\ tfnrue0123456789.+-Ee\n\u0000\u001f\uD800﻿';
  for (let i = 0; i < Math.floor(1000 * SCALE); i++) {
    let text = '';
    for (let k = ri(14); k > 0; k--) text += pick(ALPHABET);
    const div = compareDocument(text);
    assert.equal(div, null, `${JSON.stringify(text)}: ${div}`);
  }
});

test('boundaries: the documented result for each boundary value', () => {
  const cases = [
    ['9007199254740991', 9007199254740991],
    ['-9007199254740991', -9007199254740991],
    ['9007199254740992', 9007199254740992n],
    ['-9007199254740992', -9007199254740992n],
    ['9007199254740993.0', 9007199254740993n],
    ['1e21', 10n ** 21n],
    ['1e309', 10n ** 309n],
    ['1e-7', 1e-7],
    ['0.1', 0.1],
    ['1.50', 1.5],
    ['1.0', 1],
    ['1e2', 100],
    ['100e-2', 1],
    ['0.10000000000000000001', '0.10000000000000000001'],
    ['123456789.12345678', 123456789.12345678],
    ['5e-324', 5e-324],
    ['2.5e-324', '2.5e-324'],
    ['1e-400', '1e-400'],
    // Integer-valued text: exact bigint, not Infinity or the nearest double.
    ['1.7976931348623157e308', 17976931348623157n * 10n ** 292n],
    ['1.7976931348623159e308', 17976931348623159n * 10n ** 292n],
    ['-1e400', -(10n ** 400n)],
    // Edges of the short-decimal fast path: few significant digits, but an integer or subnormal.
    ['9.5e18', 9500000000000000000n],
    ['1.5e300', 15n * 10n ** 299n],
    ['0.5e1', 5],
    ['2.2250738585072014e-308', 2.2250738585072014e-308],
    ['2.2250738585072009e-308', '2.2250738585072009e-308'],
    ['0.123456789012345', 0.123456789012345],
    ['99999999999999.9', 99999999999999.9],
  ];
  for (const [text, want] of cases) {
    const got = parseLosslessJson(text);
    assert.equal(sameValue(got, want), null, text);
  }
  assert.ok(Object.is(parseLosslessJson('-0'), -0));
  assert.ok(Object.is(parseLosslessJson('-0.0e-5'), -0));
});

test('limits: depth 128 parses, 129 is rejected; 1024 integer digits parse, 1025 are rejected', () => {
  assert.equal(parseLosslessJson('['.repeat(128) + ']'.repeat(128)).length, 1);
  assert.throws(() => parseLosslessJson('['.repeat(129) + ']'.repeat(129)), /^SyntaxError: Nesting deeper than 128 levels/);
  assert.equal(typeof parseLosslessJson('1' + '0'.repeat(1023)), 'bigint');
  assert.throws(() => parseLosslessJson('1' + '0'.repeat(1024)), /^SyntaxError: Integer longer than 1024 digits/);
  assert.equal(MAX_NESTING_DEPTH, 128);
  assert.equal(MAX_INTEGER_DIGITS, 1024);
});
