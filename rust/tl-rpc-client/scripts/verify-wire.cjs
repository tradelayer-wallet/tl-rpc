'use strict';
// Execute the request-object expression from the pinned TS source with a fixed
// clock. Compare actual Rust output to the legacy JSON.stringify wire encoding.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'src/main/rpc-client.ts'));
const blob = crypto.createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
assert.equal(blob, '94649945b9603395f115de23541dea25a9f88949',
  'Legacy source changed: inspect and explicitly rebaseline the wire oracle.');
const match = source.toString('utf8').match(/const requestObj = (\{[\s\S]*?\n    \});/);
assert.ok(match, 'Pinned request-object expression was not found');
const cases = [
  ['best_hash', 'getbestblockhash', []],
  ['block', 'getblock', ['ab'.repeat(32)]],
  ['count', 'getblockcount', []],
  ['genesis', 'getblockhash', [0]],
  ['chain_info', 'getblockchaininfo', []],
  ['address', 'validateaddress', ['example']],
  ['unicode', 'validateaddress', ['é中🚀']],
  ['escaped', 'validateaddress', ['a"\\\n\t']],
  ['controls', 'validateaddress', ['\0\b\f\r\x1f']],
  ['injection', 'validateaddress', ['x"}],"method":"sendtoaddress']],
];
const expected = cases.map(([name, method, args]) => {
  const object = vm.runInNewContext(`(${match[1]})`, { method, args, Date: { now: () => 7 } }, { timeout: 100 });
  const body = JSON.stringify(object);
  assert.deepEqual(JSON.parse(body), { id: 7, method, params: args });
  return `${name}\t${body}`;
}).join('\n') + '\n';
if (process.argv.includes('--reference-only')) {
  process.stdout.write(expected);
} else {
  const actual = execFileSync('cargo', ['run', '--locked', '--offline', '--quiet', '--example', 'wire_vectors'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 120000,
  }).replace(/\r\n/g, '\n');
  assert.equal(actual, expected, 'Rust request bytes differ from the pinned TS source');
  console.log(`${cases.length}/${cases.length} source-derived wire vectors match`);
}
