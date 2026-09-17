import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runUsageCli } from '../src/usage-cli.mjs';

test('prints a DeepSeek monetary balance instead of empty quota rows', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiwidgets-cli-'));
  const dataPath = path.join(directory, 'usage.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(dataPath, JSON.stringify({
    updatedAt: '2026-09-16T23:27:00.000Z',
    settings: { enabledProviders: ['deepseek'] },
    providers: [{
      id: 'deepseek',
      name: 'DeepSeek API',
      balance: { currency: 'USD', totalBalance: 13.8, fundedBalance: 20, included: 20, used: 6.2 },
      note: 'Updated just now.',
    }],
  }));
  const lines = [];
  const originalLog = console.log;
  console.log = (...values) => lines.push(values.join(' '));
  try {
    assert.equal(await runUsageCli(['--no-refresh'], { dataPath }), 0);
  } finally {
    console.log = originalLog;
  }
  const output = lines.join('\n');
  assert.match(output, /31% used/);
  assert.match(output, /\$13\.80 available/);
  assert.match(output, /\$6\.20 used of \$20\.00/);
  assert.doesNotMatch(output, /Session\s+no data/);
});
