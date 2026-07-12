import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./paperclip-issue-update.sh', import.meta.url));

test('includes evalScore as a number in dry-run payloads', () => {
  const output = execFileSync(
    scriptPath,
    ['--issue-id', 'issue-1', '--status', 'done', '--eval-score', '8.5', '--dry-run'],
    { encoding: 'utf8', input: 'Evaluation passed.\n' },
  );

  assert.deepEqual(JSON.parse(output), {
    status: 'done',
    comment: 'Evaluation passed.',
    evalScore: 8.5,
  });
});

test('preserves an explicit zero evalScore', () => {
  const output = execFileSync(
    scriptPath,
    ['--issue-id', 'issue-1', '--status', 'done', '--eval-score', '0', '--dry-run'],
    { encoding: 'utf8' },
  );

  assert.equal(JSON.parse(output).evalScore, 0);
});

test('rejects non-finite or non-numeric evalScore values', () => {
  for (const value of ['', 'NaN', 'Infinity', '8/10', '8 points']) {
    const result = spawnSync(
      scriptPath,
      ['--issue-id', 'issue-1', '--status', 'done', '--eval-score', value, '--dry-run'],
      { encoding: 'utf8' },
    );

    assert.notEqual(result.status, 0, `expected ${JSON.stringify(value)} to be rejected`);
    assert.match(result.stderr, /Invalid eval score/);
  }
});
