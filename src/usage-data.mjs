export const PROVIDER_IDS = ['claude', 'codex', 'copilot'];

export const DEFAULT_DATA = {
  // Existing data files are considered set up unless they explicitly retain
  // the first-run flag. createFirstRunData() sets it to false only for a new
  // installation, so no provider is selected by assumption.
  settings: { refreshMinutes: 1, enabledProviders: [], onboardingComplete: true },
  providers: [
    { id: 'claude', name: 'Claude', accent: '#f2ae93', session: null, weekly: null, note: 'Not connected yet.' },
    { id: 'codex', name: 'Codex', accent: '#c9ddff', session: null, weekly: null, note: 'Not connected yet.' },
    { id: 'copilot', name: 'GitHub Copilot', accent: '#b8c0cc', monthly: null, actionsMinutes: null, note: 'Not connected yet.' },
  ],
};

export function createFirstRunData() {
  return {
    ...DEFAULT_DATA,
    settings: { ...DEFAULT_DATA.settings, onboardingComplete: false },
    providers: DEFAULT_DATA.providers.map((provider) => ({ ...provider })),
  };
}

export function normaliseUsageData(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const rawProviders = Array.isArray(input.providers) ? input.providers : [];
  const providers = DEFAULT_DATA.providers.map((fallback) => {
    const storedProvider = rawProviders.find((item) => item?.id === fallback.id) || fallback;
    // Model names are not consistently available from subscription usage pages.
    // Ignore legacy values rather than presenting an unreliable label.
    const { model: _legacyModel, ...provider } = storedProvider;
    const usage = (value) => {
      if (!value || typeof value !== 'object') return null;
      const available = Number(value.available);
      if (!Number.isFinite(available)) return null;
      const used = Number(value.used);
      const included = Number(value.included);
      const billedAmount = Number(value.billedAmount);
      return {
        available: Math.max(0, Math.min(100, available)),
        resetsAt: value.resetsAt || null,
        resetLabel: value.resetLabel || null,
        ...(Number.isFinite(used) ? { used } : {}),
        ...(Number.isFinite(included) ? { included } : {}),
        ...(Number.isFinite(billedAmount) ? { billedAmount } : {}),
        ...(typeof value.label === 'string' ? { label: value.label } : {}),
      };
    };
    const weekly = usage(provider.weekly);
    const placeholder = provider.note === 'No data yet.' && !provider.session && weekly?.available === 100;
    return {
      ...fallback,
      ...provider,
      accent: fallback.accent,
      session: usage(provider.session),
      weekly: placeholder ? null : weekly,
      monthly: usage(provider.monthly),
      actionsMinutes: usage(provider.actionsMinutes),
      note: String(provider.note || ''),
    };
  });
  const requested = input.settings?.enabledProviders;
  const enabledProviders = Array.isArray(requested)
    ? requested.filter((id) => PROVIDER_IDS.includes(id))
    : DEFAULT_DATA.settings.enabledProviders;
  // Refresh cadence is deliberately fixed at one minute. Older local files
  // may still contain five minutes, so do not let them retain that delay.
  return {
    settings: {
      ...DEFAULT_DATA.settings,
      ...(input.settings || {}),
      refreshMinutes: 1,
      enabledProviders,
      // Data created before the onboarding feature already belongs to a user
      // who has configured the app; only explicit false starts the setup.
      onboardingComplete: input.settings?.onboardingComplete !== false,
    },
    providers,
    updatedAt: input.updatedAt || null,
  };
}
