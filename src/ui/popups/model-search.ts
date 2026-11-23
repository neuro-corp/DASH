export type ModelGroup = {
  provider: string;
  models: string[];
};

export const MODELS_VISIBLE_ROWS = 10;

const PROVIDER_ORDER = ['DASH', 'NVIDIA', 'OPENAI', 'GOOGLE', 'ANTHROPIC', 'XAI'] as const;
const PROVIDER_ALIASES: Record<string, string> = {
  dash: 'DASH',
  nvidia: 'NVIDIA',
  openai: 'OPENAI',
  google: 'GOOGLE',
  anthropic: 'ANTHROPIC',
  claude: 'ANTHROPIC',
  xai: 'XAI',
  x: 'XAI',
  grok: 'XAI',
  other: 'OTHER',
};

export function normalizeProviderName(name: string): string {
  return PROVIDER_ALIASES[name.toLowerCase()] ?? name.toUpperCase();
}

/** A model's identity is its provider and upstream model ID together. */
export function providerQualifiedModelId(provider: string, model: string): string {
  return `${normalizeProviderName(provider)}/${model}`;
}

export function isProviderHeaderRow(name: string): boolean {
  return name === '(no models)'
    || name.startsWith('===')
    || Object.prototype.hasOwnProperty.call(PROVIDER_ALIASES, name.toLowerCase());
}

function providerRank(provider: string): number {
  const index = (PROVIDER_ORDER as readonly string[]).indexOf(provider);
  return index === -1 ? PROVIDER_ORDER.length : index;
}

export function groupModelList(models: string[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  let current: ModelGroup | undefined;

  for (const entry of models) {
    if (!entry || entry === '(no models)') continue;

    if (isProviderHeaderRow(entry)) {
      if (entry.startsWith('===')) continue;
      const provider = normalizeProviderName(entry);
      current = groups.find(group => group.provider === provider);
      if (!current) {
        current = { provider, models: [] };
        groups.push(current);
      }
      continue;
    }

    if (!current) {
      current = { provider: 'OTHER', models: [] };
      groups.push(current);
    }
    current.models.push(entry);
  }

  return groups;
}

/**
 * Build the provider groups shown in the models popup. Groups with no models
 * are omitted, and a non-empty query filters model ids and display names.
 * DASH always comes first, regardless of the order the list arrived in.
 */
export function buildVisibleModelGroups(
  models: string[],
  query = '',
  displayNames: Record<string, string> = {},
): ModelGroup[] {
  const needle = query.trim().toLowerCase();
  const filtered = groupModelList(models).map(group => {
    if (!needle) return group;

    const providerMatches = group.provider.toLowerCase().includes(needle);
    const matchingModels = providerMatches
      ? group.models
      : group.models.filter(model => (
          model.toLowerCase().includes(needle)
          || (displayNames[model] ?? '').toLowerCase().includes(needle)
        ));

    return { ...group, models: matchingModels };
  }).filter(group => group.models.length > 0);

  return filtered.sort((a, b) => providerRank(a.provider) - providerRank(b.provider));
}

export function flattenModelGroups(groups: ModelGroup[]): string[] {
  return groups.flatMap(group => [group.provider, ...group.models]);
}

/** Resolve a model row from its visible section, not from its model ID.
 * Different providers can expose the same model ID. */
export function providerNameAtModelIndex(rows: string[], modelIndex: number): string | undefined {
  if (!Number.isInteger(modelIndex) || modelIndex < 0 || modelIndex >= rows.length) return undefined;
  if (isProviderHeaderRow(rows[modelIndex] ?? '')) return undefined;
  for (let index = modelIndex; index >= 0; index--) {
    const row = rows[index];
    if (row && isProviderHeaderRow(row)) return normalizeProviderName(row);
  }
  return undefined;
}
