import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const providerNames = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
};
const palettes = {
  claude: { foreground: [242, 174, 147], background: [58, 39, 32] },
  codex: { foreground: [201, 221, 255], background: [18, 26, 42] },
  copilot: { foreground: [184, 192, 204], background: [35, 39, 47] },
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const REFRESH_DIRECTORY = 'usage-refresh';
const RUNTIME_FILE = 'runtime.json';
const FRESHNESS_WINDOW_MS = 60_000;

function defaultDataPath() {
  if (process.env.AIWIDGETS_DATA) return process.env.AIWIDGETS_DATA;
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'aiwidgets', 'usage.json');
  return path.join(homedir(), '.config', 'aiwidgets', 'usage.json');
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isFresh(data) {
  const updatedAt = Date.parse(data?.updatedAt || '');
  return Number.isFinite(updatedAt) && Date.now() - updatedAt >= 0 && Date.now() - updatedAt < FRESHNESS_WINDOW_MS;
}

async function requestRefresh(dataFile, refreshLocally) {
  if (refreshLocally) {
    await refreshLocally();
    return;
  }
  const directory = path.dirname(dataFile);
  try {
    const runtime = JSON.parse(await readFile(path.join(directory, RUNTIME_FILE), 'utf8'));
    if (runtime?.active === false) throw new Error('AI Widgets is not running. Start the background collector first.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const id = randomUUID();
  const requestFile = path.join(directory, REFRESH_DIRECTORY, 'requests', `${id}.json`);
  const responseFile = path.join(directory, REFRESH_DIRECTORY, 'responses', `${id}.json`);
  await writeJson(requestFile, { id, requestedAt: new Date().toISOString() });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(await readFile(responseFile, 'utf8'));
      if (response.id === id) {
        await unlink(responseFile).catch(() => {});
        if (response.error) throw new Error(response.error);
        return;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await pause(250);
  }
  await unlink(requestFile).catch(() => {});
  throw new Error('AI Widgets did not respond within 45 seconds. Start AI Widgets and keep it running in the background, or use --no-refresh to read the saved snapshot.');
}

function usagePercent(usage) {
  const available = Number(usage?.available);
  return Number.isFinite(available) ? Math.max(0, Math.min(100, 100 - available)) : null;
}

function number(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
}

function ansi(text, code) {
  return useColor ? `\u001B[${code}m${text}\u001B[0m` : text;
}

function foreground(text, palette) {
  return ansi(text, `38;2;${palette.foreground.join(';')}`);
}

function card(text, palette) {
  return ansi(` ${text} `, `48;2;${palette.background.join(';')}`);
}

function progressBar(percent, palette, width = 28) {
  const filled = Math.round((percent / 100) * width);
  return `${foreground('━'.repeat(filled), palette)}${ansi('━'.repeat(width - filled), '38;2;78;82;92')}`;
}

function usageLines(title, usage, palette) {
  const percent = usagePercent(usage);
  if (percent === null) return [`  ${title.padEnd(18)} no data`];
  let allowance = '';
  if (Number.isFinite(Number(usage.used)) && Number.isFinite(Number(usage.included))) {
    allowance = ` · ${number(Number(usage.used))} / ${number(Number(usage.included))}${title === 'Actions minutes' ? ' min' : ''} used`;
  }
  return [
    `  ${title.padEnd(18)} ${foreground(`${number(percent)}% used`, palette)}${allowance}`,
    `  ${progressBar(percent, palette)} ${number(100 - percent)}% available${usage.resetLabel ? ` · ${usage.resetLabel}` : ''}`,
  ];
}

function providerLines(provider, palette) {
  if (provider.id === 'copilot') {
    return [
      ...usageLines(provider.monthly?.label || 'Premium requests', provider.monthly, palette),
      ...usageLines('Actions minutes', provider.actionsMinutes, palette),
      ...(Number.isFinite(Number(provider.actionsMinutes?.billedAmount))
        ? [`  Billed this month: $${number(Number(provider.actionsMinutes.billedAmount))}`]
        : []),
    ];
  }
  return [...usageLines('Session', provider.session, palette), ...usageLines('Weekly', provider.weekly, palette)];
}

export function usageHelp() {
  return `Usage: aiwidgets usage [--json] [--all] [--refresh] [--no-refresh]\n\nShows enabled usage. A snapshot less than one minute old is reused; older data is refreshed through the running AI Widgets collector.\n\nOptions:\n  --json        Print machine-readable JSON.\n  --all         Include disabled providers.\n  --refresh     Force an update even when the snapshot is fresh.\n  --no-refresh  Read the saved snapshot without requesting an update.\n  --help        Show this help.\n\nAI Widgets must be running in the background to refresh Claude and Codex.`;
}

export async function runUsageCli(args = process.argv.slice(2), options = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usageHelp());
    return 0;
  }

  const target = options.dataPath || defaultDataPath();
  let data;
  try {
    data = JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    console.error(`AI Widgets data could not be read at ${target}: ${error.code === 'ENOENT' ? 'run AI Widgets and connect a provider first.' : error.message}`);
    return 1;
  }
  const refreshNeeded = args.includes('--refresh') || (!args.includes('--no-refresh') && !isFresh(data));
  if (refreshNeeded) {
    try {
      await requestRefresh(target, options.refresh);
    } catch (error) {
      console.error(`AI Widgets could not refresh usage: ${error.message}`);
      return 1;
    }
    try {
      data = JSON.parse(await readFile(target, 'utf8'));
    } catch (error) {
      console.error(`AI Widgets data could not be read after refresh: ${error.message}`);
      return 1;
    }
  }

  const allProviders = Array.isArray(data.providers) ? data.providers : [];
  const enabled = Array.isArray(data.settings?.enabledProviders) ? data.settings.enabledProviders : [];
  const providers = args.includes('--all') ? allProviders : allProviders.filter((provider) => enabled.includes(provider.id));
  if (args.includes('--json')) {
    console.log(JSON.stringify({ updatedAt: data.updatedAt || null, providers }, null, 2));
    return 0;
  }

  console.log('AI Widgets usage');
  const sourceLabel = refreshNeeded ? 'refreshed now' : args.includes('--no-refresh') ? 'saved snapshot' : 'fresh snapshot';
  console.log(`Updated: ${data.updatedAt ? new Date(data.updatedAt).toLocaleString() : 'not updated yet'} · ${sourceLabel}`);
  if (!providers.length) {
    console.log('No providers are enabled. Open AI Widgets and choose them in Providers.');
    return 0;
  }
  for (const provider of providers) {
    const palette = palettes[provider.id] || palettes.copilot;
    console.log(`\n${card(` ${provider.name || providerNames[provider.id] || provider.id} `, palette)}`);
    for (const line of providerLines(provider, palette)) console.log(card(line, palette));
    if (provider.note) console.log(card(`  ${ansi(provider.note, '38;2;180;180;180')}`, palette));
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runUsageCli();
}
