// Dependency-free test suite: `npm test` (or `node test/run-tests.js`).

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { validate } from '../server/validator.js';
import { execute } from '../server/executor.js';
import { createRun } from '../server/runs.js';
import { REPL_SOURCE } from '../server/modes.js';
import { isAllowed } from '../server/packages.js';
import { safePath, writeFile, readFile, deleteFile } from '../server/files.js';
import { makeToken, readToken, spaceDir, sweep } from '../server/spaces.js';

const BASE = spaceDir('f'.repeat(32));

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
check('allows import os for file work', () => {
  assert.equal(validate('import os').ok, true);
});
check('blocks subprocess import', () => {
  assert.equal(validate('import subprocess').ok, false);
});
check('blocks eval()', () => {
  assert.equal(validate('eval("1+1")').ok, false);
});
check('allows open() for the workspace', () => {
  assert.equal(validate('open("notes.txt", "w")').ok, true);
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
check('still blocks os.system', () => {
  assert.equal(validate('import os\nos.system("ls")').ok, false);
});
check('still blocks os.popen', () => {
  assert.equal(validate('import os\nos.popen("ls")').ok, false);
});
check('blocks process calls reached by alias', () => {
  assert.equal(validate('import os as x\nx.system("ls")').ok, false);
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
await checkAsync('a finished run replays to a late subscriber', async () => {
  // A fast program finishes before the browser attaches to the stream; its
  // output must still be delivered (regression).
  const run = await createRun('print("late")\n', { idleMs: 3000, maxMs: 8000 });
  await run.done;
  const seen = [];
  run.subscribe((e) => seen.push(e));
  const text = seen.filter((e) => e.type === 'output').map((e) => e.text).join('');
  assert.match(text, /late/);
  assert.equal(seen[seen.length - 1].type, 'exit');
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

console.log('\nWorkspace files');
check('rejects path traversal and absolute names', () => {
  assert.equal(safePath(BASE, '../x'), null);
  assert.equal(safePath(BASE, 'a/../b'), null);
  assert.equal(safePath(BASE, '/etc/passwd'), null);
  assert.equal(safePath(BASE, ''), null);
  assert.notEqual(safePath(BASE, 'notes.txt'), null);
  assert.notEqual(safePath(BASE, 'data/report.txt'), null);
});
await checkAsync('writes and reads a file back', async () => {
  const w = await writeFile(BASE, 'test-roundtrip.txt', Readable.from([Buffer.from('hello')]), 1024);
  assert.equal(w.ok, true);
  const f = await readFile(BASE, 'test-roundtrip.txt');
  assert.equal(f.data.toString(), 'hello');
  assert.equal(await deleteFile(BASE, 'test-roundtrip.txt'), true);
  assert.equal(await readFile(BASE, 'test-roundtrip.txt'), null);
});
await checkAsync('refuses a file over the size cap', async () => {
  const w = await writeFile(BASE, 'too-big.txt', Readable.from([Buffer.alloc(4096)]), 1024);
  assert.equal(w.ok, false);
  assert.equal(await readFile(BASE, 'too-big.txt'), null);
});
await checkAsync('deleting a file that is not there returns false', async () => {
  assert.equal(await deleteFile(BASE, 'never-existed.txt'), false);
});
await fs.rm(BASE, { recursive: true, force: true }).catch(() => {});

console.log('\nSpaces (per-visitor isolation)');
await checkAsync('tokens round-trip and forgeries are rejected', async () => {
  const id = 'a'.repeat(32);
  assert.equal(await readToken(await makeToken(id)), id);
  assert.equal(await readToken(`${id}.wrongsignature00000000`), null);
  assert.equal(await readToken('not-a-token'), null);
  assert.equal(await readToken(undefined), null);
  assert.equal(await readToken('short.abc'), null);
});
await checkAsync('the sweeper removes an idle space but keeps a fresh one', async () => {
  const idle = spaceDir('b'.repeat(32));
  const fresh = spaceDir('c'.repeat(32));
  await fs.mkdir(idle, { recursive: true });
  await fs.mkdir(fresh, { recursive: true });
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(idle, old, old);
  await sweep();
  assert.equal(await fs.stat(idle).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(fresh).then(() => true).catch(() => false), true);
  await fs.rm(fresh, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
