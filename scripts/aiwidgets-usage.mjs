#!/usr/bin/env node
// Updates the file read by AI Widgets. It does not sign in or fetch provider data.
// Example: node scripts/aiwidgets-usage.mjs codex --session 61 --weekly 39 --reset "2026-09-09T07:58:00-03:00"
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const [providerId, ...args] = process.argv.slice(2);
const allowed = new Set(['claude', 'codex']);
if (!allowed.has(providerId)) {
  console.error('Usage: aiwidgets-usage.mjs <claude|codex> [--session 61] [--weekly 39] [--reset ISO-8601] [--note text]');
  process.exit(1);
}
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const number = (name) => { const value = option(name); if (value === undefined) return undefined; const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new Error(`${name} must be 0–100`); return parsed; };
const session = number('--session'); const weekly = number('--weekly'); const reset = option('--reset');
if (reset && Number.isNaN(Date.parse(reset))) throw new Error('--reset must be a valid ISO-8601 date');
const file = process.env.AIWIDGETS_DATA || path.join(homedir(), '.config', 'aiwidgets', 'usage.json');
let data;
try { data = JSON.parse(await readFile(file, 'utf8')); } catch { data = { settings: {}, providers: [] }; }
const defaults = { claude: { name: 'Claude', accent: '#f2ae93' }, codex: { name: 'Codex', accent: '#b9d6ff' } };
let provider = data.providers.find((entry) => entry.id === providerId);
if (!provider) { provider = { id: providerId, ...defaults[providerId], weekly: { available: 100, resetsAt: null } }; data.providers.push(provider); }
const applyUsage = (key, value) => { if (value !== undefined) provider[key] = { available: value, resetsAt: reset || provider[key]?.resetsAt || null }; };
applyUsage('session', session); applyUsage('weekly', weekly);
if (option('--note') !== undefined) provider.note = option('--note');
data.updatedAt = new Date().toISOString();
await mkdir(path.dirname(file), { recursive: true });
const temporary = `${file}.tmp`; await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`); await rename(temporary, file);
console.log(`Updated: ${file}`);
