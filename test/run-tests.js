// Dependency-free test suite: `npm test` (or `node test/run-tests.js`).

import assert from 'node:assert/strict';
import { validate } from '../server/validator.js';
import { execute } from '../server/executor.js';
import { createRun } from '../server/runs.js';
import { REPL_SOURCE } from '../server/modes.js';
import { isAllowed } from '../server/packages.js';

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

// Run `code`, feeding the given lines whenever the prompt text appears.
function interactive(code, steps, opts = {}) {
  return new Promise(async (resolve) => {
    const run = await createRun(code, { idleMs: opts.idleMs ?? 8000, maxMs: opts.maxMs ?? 20000 });
    let out = '';
    let i = 0;
    run.subscribe((e) => {
      if (e.type === 'output' && e.stream === 'stdout') {
        out += e.text;
        while (i < steps.length && out.includes(steps[i].when)) {
          run.write(steps[i].send);
          i++;
        }
      } else if (e.type === 'exit') {
        resolve({ out, exit: e, run });
      }
    });
  });
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

console.log('\nOne-shot execution');
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

console.log('\nInteractive runs (live input)');
await checkAsync('streams the input() prompt', async () => {
  const { out } = await interactive('name = input("Name: ")\nprint("Hi", name)\n', [
    { when: 'Name: ', send: 'Akhilesh\n' },
  ]);
  assert.match(out, /Name: /);
  assert.match(out, /Hi Akhilesh/);
});
await checkAsync('handles several inputs in a row', async () => {
  const code = 'a = float(input("n1: "))\nb = float(input("n2: "))\nprint("sum =", a + b)\n';
  const { out } = await interactive(code, [
    { when: 'n1: ', send: '3\n' },
    { when: 'n2: ', send: '4\n' },
  ]);
  assert.match(out, /sum = 7/);
});
await checkAsync('pre-filled stdin is delivered', async () => {
  const run = await createRun('print("Hi", input())\n', { idleMs: 8000, maxMs: 20000 });
  run.write('Pre\n');
  await run.done;
  assert.match(run.stdout, /Hi Pre/);
});
await checkAsync('silent infinite loop is stopped', async () => {
  const t0 = Date.now();
  const run = await createRun('while True:\n    pass\n', { idleMs: 1500, maxMs: 20000 });
  const evt = await run.done;
  assert.equal(evt.status, 'idle_timeout');
  assert.ok(Date.now() - t0 < 6000, 'should be killed quickly');
});
await checkAsync('reports exit status of a failing program', async () => {
  const run = await createRun('raise ValueError("boom")\n', { idleMs: 8000, maxMs: 20000 });
  const evt = await run.done;
  assert.equal(evt.status, 'error');
  assert.match(run.stderr, /boom/);
});

// Start a run and answer prompts; `kick` sends the first line without waiting
// for output (a shell prints no prompt).
function driveRun(code, opts, steps) {
  return new Promise(async (resolve) => {
    const run = await createRun(code, opts);
    let out = '';
    let i = 0;
    run.subscribe((e) => {
      if (e.type === 'output') {
        out += e.text;
        while (i < steps.length && out.includes(steps[i].when)) { run.write(steps[i].send); i++; }
      } else if (e.type === 'exit') {
        resolve({ out, exit: e });
      }
    });
    if (opts.kick) {
      setTimeout(() => { if (i < steps.length) { run.write(steps[i].send); i++; } }, opts.kick);
    }
  });
}

console.log('\nModes');
await checkAsync('REPL prints a prompt and evaluates', async () => {
  const { out } = await driveRun(REPL_SOURCE, { idleMs: 2500, maxMs: 8000 }, [{ when: '>>> ', send: '6*7\n' }]);
  assert.match(out, />>> /);
  assert.match(out, /42/);
});
await checkAsync('terminal runs a shell command', async () => {
  const { out } = await driveRun('', { kind: 'bash', idleMs: 2500, maxMs: 8000, kick: 300 }, [{ when: '\u0000', send: 'echo from-the-shell\n' }]);
  assert.match(out, /from-the-shell/);
});

console.log('\nPackages');
check('allows a light package', () => assert.equal(isAllowed('rich'), true));
check('accepts underscore spelling', () => assert.equal(isAllowed('python_dateutil'), true));
check('refuses a heavy package', () => assert.equal(isAllowed('torch'), false));
check('refuses shell metacharacters', () => assert.equal(isAllowed('rich; rm -rf /'), false));
check('refuses an unknown name', () => assert.equal(isAllowed('definitely-not-a-real-pkg'), false));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
