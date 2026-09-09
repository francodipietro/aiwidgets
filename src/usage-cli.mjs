import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

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

function defaultDataPath() {
  if (process.env.AIWIDGETS_DATA) return process.env.AIWIDGETS_DATA;
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'aiwidgets', 'usage.json');
  return path.join(homedir(), '.config', 'aiwidgets', 'usage.json');
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
  return `Usage: aiwidgets usage [--json] [--all]\n\nShows the locally synchronized usage of enabled AI Widgets providers.\n\nOptions:\n  --json  Print machine-readable JSON.\n  --all   Include disabled providers.\n  --help  Show this help.\n\nThe command reads local data only; it does not open a browser or contact providers.`;
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

  const allProviders = Array.isArray(data.providers) ? data.providers : [];
  const enabled = Array.isArray(data.settings?.enabledProviders) ? data.settings.enabledProviders : [];
  const providers = args.includes('--all') ? allProviders : allProviders.filter((provider) => enabled.includes(provider.id));
  if (args.includes('--json')) {
    console.log(JSON.stringify({ updatedAt: data.updatedAt || null, providers }, null, 2));
    return 0;
  }

  console.log('AI Widgets usage');
  console.log(`Updated: ${data.updatedAt ? new Date(data.updatedAt).toLocaleString() : 'not updated yet'}`);
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
