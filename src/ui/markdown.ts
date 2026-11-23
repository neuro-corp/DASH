const markdownHeadings = new Set([
  'key concepts',
  'minimal example',
  "what it does (and doesn't do)",
  'what it does (and doesn’t do)',
  'what it does (and does not do)',
]);

function formatInlineHtmlTags(text: string): string {
  return text.replace(
    /<\/?[a-z][a-z0-9-]*(?:\s+[^<>\n]*?)?\s*\/?>|<\/?[a-z][a-z0-9-]*(?=\s|[,.;:!?)]|$)/gi,
    tag => `\`${tag}\``,
  );
}

function formatInlineCodeHints(text: string): string {
  const path = String.raw`(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]+(?:#L\d+(?:-L\d+)?|:\d+(?:-\d+)?)?`;
  const hintPattern = new RegExp(`${path}|\\bhead=\\d+\\b|\\bL\\d+(?:-L\\d+)?\\b`, 'gi');
  return text
    .split(/(`[^`]*`|\[[^\]]+\]\([^)]+\))/g)
    .map(part => part.startsWith('`') || /^\[[^\]]+\]\([^)]+\)$/.test(part)
      ? part
      : part.replace(hintPattern, hint => `\`${hint}\``))
    .join('');
}

export function normalizeAssistantMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  let fence: '```' | '~~~' | null = null;
  const normalized = lines.map((line, index) => {
    const fenceMatch = line.match(/^\s*(```|~~~)/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1] as '```' | '~~~';
      else if (fenceMatch[1] === fence) fence = null;
      return line;
    }
    if (fence) return line;

    const heading = line.trim().toLowerCase();
    const nextLine = lines[index + 1]?.trim() ?? '';
    const formattedLine = markdownHeadings.has(heading) && line.trim() === line && nextLine === ''
      ? `### ${line}`
      : line;
    return formatInlineCodeHints(formatInlineHtmlTags(formattedLine));
  }).join('\n');

  return fence ? `${normalized}\n${fence}` : normalized;
}