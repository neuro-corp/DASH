import { formatCapabilityOverview, type CapabilityRegistry } from './capabilities';

interface PromptSection {
  heading: string;
  bullets: string[];
}

interface PromptConfig {
  instructions?: {
    role?: unknown;
    skills?: unknown;
    sections?: unknown;
    technical_guidelines?: unknown;
    efficiency_rules?: unknown;
  };
}

export interface AgentPromptOptions {
  /** Short role-specific guidance for the selected agent mode. */
  modeInstructions?: string;
  /** Lightweight skill names and descriptions, loaded on demand. */
  skillCatalog?: string;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function configuredSkills(config: unknown): string[] {
  const parsed = config as PromptConfig | undefined;
  return stringList(parsed?.instructions?.skills);
}

function configuredRole(config: unknown): string {
  const parsed = config as PromptConfig | undefined;
  const role = parsed?.instructions?.role;
  return typeof role === 'string' && role.trim()
    ? role.trim()
    : 'You are Dash, an AI coding agent and development assistant working inside a software workspace.';
}

function configuredSections(config: unknown): PromptSection[] {
  const raw = (config as PromptConfig | undefined)?.instructions?.sections;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(entry => {
      if (!entry || typeof entry !== 'object') return undefined;
      const candidate = entry as Record<string, unknown>;
      const heading = typeof candidate.heading === 'string' ? candidate.heading.trim() : '';
      if (!heading) return undefined;
      return { heading, bullets: stringList(candidate.bullets) };
    })
    .filter((section): section is PromptSection => Boolean(section));
}

function customInstructions(config: unknown, registry: CapabilityRegistry): string {
  return configuredSkills(config)
    .filter(skill => {
      const name = skill.split(':', 1)[0]?.trim();
      return name && !registry.byName.has(name);
    })
    .map(skill => skill.slice(skill.indexOf(':') + 1).trim())
    .filter(Boolean)
    .slice(0, 12)
    .join(' ');
}

function guidelines(config: unknown): string {
  const value = (config as PromptConfig | undefined)?.instructions?.technical_guidelines;
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const lines: string[] = [];
  const never = stringList(record.never);
  const always = stringList(record.always);
  const occasionally = stringList(record.occasionally);
  if (never.length) {
    lines.push('Never:');
    lines.push(...never.slice(0, 20).map(rule => `- Never ${rule}`));
  }
  if (always.length) {
    lines.push('Always:');
    lines.push(...always.slice(0, 20).map(rule => `- Always ${rule}`));
  }
  if (occasionally.length) {
    lines.push('Occasionally:');
    lines.push(...occasionally.slice(0, 6).map(rule => `- Occasionally ${rule}`));
  }
  return lines.join('\n');
}

function efficiencyRules(config: unknown): string {
  const value = (config as PromptConfig | undefined)?.instructions?.efficiency_rules;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0);
  if (entries.length === 0) return '';
  return [`Efficiency rules:`, ...entries.map(([key, rule]) => `- ${key}: ${rule.trim()}`)].join('\n');
}

/**
 * Build the one provider-independent system message used by every adapter.
 *
 * The prompt stays compact: tool details live in the tool schemas and in
 * `get_agent_knowledge`; the prompt only carries the capability overview,
 * durable behavioral rules, mode guidance, and lightweight skill metadata.
 */
export function createAgentSystemMessage(
  config: unknown,
  registry: CapabilityRegistry,
  options: AgentPromptOptions = {},
): string {
  const role = configuredRole(config);
  const sections = configuredSections(config);
  const parts: string[] = [];

  const identityIndex = sections.findIndex(section => section.heading.toLowerCase() === 'identity');
  if (identityIndex >= 0) {
    const identity = sections[identityIndex]!;
    parts.push([`# ${identity.heading}`, role, ...identity.bullets.map(bullet => `- ${bullet}`)].join('\n'));
  } else {
    parts.push(`# Identity\n${role}`);
  }
  for (let index = 0; index < sections.length; index++) {
    if (index === identityIndex) continue;
    const section = sections[index]!;
    parts.push([`# ${section.heading}`, ...section.bullets.map(bullet => `- ${bullet}`)].join('\n'));
  }

  const overview = formatCapabilityOverview(registry);
  parts.push([
    '# Tools',
    overview,
    'Only call tools listed above; if one is unavailable, use an available equivalent or explain the blocker.',
    'Before editing, inspect the target content and use an available edit tool in its required format.',
    'Use guidance tools when selection or recovery is unclear; refresh stale index data only when needed.',
  ].join('\n'));

  const custom = customInstructions(config, registry);
  if (custom) parts.push(`# Custom instructions\n${custom}`);

  if (options.modeInstructions?.trim()) {
    parts.push(`# Mode\n${options.modeInstructions.trim()}`);
  }

  if (options.skillCatalog?.trim()) {
    parts.push([
      '# Skills',
      'Available skills (load the full instructions with skill_loader when relevant):',
      options.skillCatalog.trim(),
    ].join('\n'));
  }

  const technical = guidelines(config);
  if (technical) parts.push(`# Technical guidelines\n${technical}`);

  const efficiency = efficiencyRules(config);
  if (efficiency) parts.push(efficiency);

  return parts.filter(Boolean).join('\n\n');
}
