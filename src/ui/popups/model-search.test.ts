import { describe, expect, it } from 'bun:test';
import { buildVisibleModelGroups, flattenModelGroups, isProviderHeaderRow, providerNameAtModelIndex, providerQualifiedModelId } from './model-search';

describe('models popup search', () => {
  const models = [
    'NVIDIA',
    'nvidia/nemotron-3.5-lightning-30b-a3b',
    'meta/muse-glimmer-30b',
    'OpenAI',
    'gpt-4o',
    'DASH',
    'dash-model-a',
  ];
  const displayNames = {
    'dash-model-a': 'Friendly Dash Model',
    'nvidia/nemotron-3.5-lightning-30b-a3b': 'Nemotron-3.5-Lightning-30B',
  };

  it('puts DASH first and keeps the provider header with its models', () => {
    const groups = buildVisibleModelGroups(models, '', displayNames);

    expect(groups.map(group => group.provider)).toEqual(['DASH', 'NVIDIA', 'OPENAI']);
    expect(groups[0]?.models).toEqual(['dash-model-a']);
    expect(flattenModelGroups(groups)).toEqual([
      'DASH',
      'dash-model-a',
      'NVIDIA',
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'meta/muse-glimmer-30b',
      'OPENAI',
      'gpt-4o',
    ]);
  });

  it('filters by model id and friendly display name', () => {
    const groups = buildVisibleModelGroups(models, 'lightning', displayNames);
    expect(groups).toEqual([
      { provider: 'NVIDIA', models: ['nvidia/nemotron-3.5-lightning-30b-a3b'] },
    ]);

    const friendly = buildVisibleModelGroups(models, 'friendly', displayNames);
    expect(friendly).toEqual([
      { provider: 'DASH', models: ['dash-model-a'] },
    ]);
  });

  it('matches a provider name and keeps all of its models', () => {
    const groups = buildVisibleModelGroups(models, 'nvidia', displayNames);
    expect(groups).toEqual([
      {
        provider: 'NVIDIA',
        models: ['nvidia/nemotron-3.5-lightning-30b-a3b', 'meta/muse-glimmer-30b'],
      },
    ]);
  });

  it('omits providers with no matches and treats headers case-insensitively', () => {
    expect(buildVisibleModelGroups(models, 'gpt', displayNames)).toEqual([
      { provider: 'OPENAI', models: ['gpt-4o'] },
    ]);
    expect(isProviderHeaderRow('OpenAI')).toBe(true);
    expect(isProviderHeaderRow('DASH')).toBe(true);
    expect(isProviderHeaderRow('dash-model-a')).toBe(false);
  });

  it('groups models without a provider header under OTHER', () => {
    const groups = buildVisibleModelGroups(['orphan-model'], '', {});
    expect(groups).toEqual([{ provider: 'OTHER', models: ['orphan-model'] }]);
  });

  it('resolves provider by section when model IDs overlap', () => {
    const rows = flattenModelGroups([
      { provider: 'DASH', models: ['nvidia/shared-model'] },
      { provider: 'NVIDIA', models: ['nvidia/shared-model'] },
    ]);

    expect(providerNameAtModelIndex(rows, 1)).toBe('DASH');
    expect(providerNameAtModelIndex(rows, 3)).toBe('NVIDIA');
    expect(providerNameAtModelIndex(rows, 0)).toBeUndefined();
  });

  it('gives the same upstream model different identities by provider', () => {
    expect(providerQualifiedModelId('DASH', 'nvidia/nemotron-3.5-lightning-30b-a3b'))
      .toBe('DASH/nvidia/nemotron-3.5-lightning-30b-a3b');
    expect(providerQualifiedModelId('NVIDIA', 'nvidia/nemotron-3.5-lightning-30b-a3b'))
      .toBe('NVIDIA/nvidia/nemotron-3.5-lightning-30b-a3b');
    expect(providerQualifiedModelId('DASH', 'nvidia/nemotron-3.5-lightning-30b-a3b'))
      .not.toBe(providerQualifiedModelId('NVIDIA', 'nvidia/nemotron-3.5-lightning-30b-a3b'));
  });
});
