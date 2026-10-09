// One-shot execution helper, built on the streaming run engine.
//
// Used by POST /api/run and by the tests: supply all of stdin up front, then
// collect stdout/stderr and return a single JSON result.

import config from './config.js';
import { createRun } from './runs.js';

const STATUS_MAP = {
  success: 'success',
  error: 'error',
  idle_timeout: 'timeout',
  timeout: 'timeout',
  output_limit: 'error',
  killed: 'error',
};

/**
 * @param {{code: string, stdin?: string}} params
 * @returns {Promise<object>}
 */
export async function execute({ code, stdin = '' }) {
  const run = await createRun(code, { idleMs: config.timeoutMs, maxMs: config.timeoutMs });
  if (stdin) run.write(stdin.endsWith('\n') ? stdin : `${stdin}\n`);
  run.endInput();

  const evt = await run.done;
  const timedOut = evt.status === 'idle_timeout' || evt.status === 'timeout';

  let stderr = run.stderr;
  if (timedOut) {
    stderr = `${stderr}\n⏱ Execution stopped: exceeded ${config.timeoutMs} ms limit.`.trim();
  }

  return {
    status: STATUS_MAP[evt.status] || 'error',
    stdout: run.stdout,
    stderr,
    output: run.stdout, // convenience alias used by simple clients
    exit_code: evt.exit_code,
    execution_time: `${(evt.elapsed_ms / 1000).toFixed(2)}s`,
    execution_time_ms: evt.elapsed_ms,
    truncated: evt.truncated,
  };
}
