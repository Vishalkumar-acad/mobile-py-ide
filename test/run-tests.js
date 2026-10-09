// Simple dependency-free test suite: `npm test` (or `node test/run-tests.js`).

import assert from 'node:assert/strict';
import { validate } from '../server/validator.js';
import { execute } from '../server/executor.js';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

console.log('\nValidator');
check('allows plain code', () => {
  assert.equal(validate('print("hi")').ok, true);
});
check('allows safe imports', () => {
  assert.equal(validate('import math\nfrom random import randint').ok, true);
});
check('blocks heavy ML libraries', () => {
  const r = validate('import torch');
  assert.equal(r.ok, false);
  assert.match(r.reason, /torch/);
});
check('blocks os import', () => {
  assert.equal(validate('import os').ok, false);
});
check('blocks subprocess import', () => {
  assert.equal(validate('import subprocess').ok, false);
});
check('blocks eval()', () => {
  assert.equal(validate('eval("1+1")').ok, false);
});
check('blocks open()', () => {
  assert.equal(validate('open("/etc/passwd")').ok, false);
});
check('blocks __import__', () => {
  assert.equal(validate('__import__("os")').ok, false);
});
check('blocks sandbox-escape dunders', () => {
  assert.equal(validate('().__class__').ok, false);
});
check('does NOT trip on blocked words inside strings', () => {
  assert.equal(validate('print("import torch; eval(1)")').ok, true);
});
check('does NOT trip on blocked words inside comments', () => {
  assert.equal(validate('# import os\nprint("ok")').ok, true);
});
check('rejects empty code', () => {
  assert.equal(validate('   ').ok, false);
});

console.log('\nExecutor');
await checkAsync('runs hello world', async () => {
  const r = await execute({ code: 'print("hello")' });
  assert.equal(r.status, 'success');
  assert.equal(r.stdout.trim(), 'hello');
});
await checkAsync('captures runtime errors', async () => {
  const r = await execute({ code: 'print(1/0)' });
  assert.equal(r.status, 'error');
  assert.match(r.stderr, /ZeroDivisionError/);
});
await checkAsync('passes stdin to input()', async () => {
  const r = await execute({ code: 'print(input().upper())', stdin: 'abc\n' });
  assert.equal(r.stdout.trim(), 'ABC');
});
await checkAsync('enforces the timeout', async () => {
  const r = await execute({ code: 'while True:\n    pass' });
  assert.equal(r.status, 'timeout');
});
await checkAsync('math works', async () => {
  const r = await execute({ code: 'import math\nprint(math.factorial(5))' });
  assert.equal(r.stdout.trim(), '120');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
