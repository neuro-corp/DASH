import { describe, expect, it } from 'bun:test';
import { normalizeAssistantMarkdown } from './markdown';

describe('assistant Markdown normalization', () => {
  it('formats common unmarked headings and displays HTML tags as inline code', () => {
    const result = normalizeAssistantMarkdown('Key Concepts\n\nTags like <h1> and <p>, plus a truncated <div.');
    expect(result).toContain('### Key Concepts');
    expect(result).toContain('`<h1>`');
    expect(result).toContain('`<p>`');
    expect(result).toContain('`<div`');
  });

  it('preserves HTML examples inside code fences and closes incomplete streamed fences', () => {
    const result = normalizeAssistantMarkdown('Example\n\n```html\n<h1>Hello</h1>');
    expect(result).toContain('```html\n<h1>Hello</h1>\n```');
    expect(result).not.toContain('`<h1>`');
  });

  it('marks plain file paths and line hints as inline code without changing fenced code or links', () => {
    const result = normalizeAssistantMarkdown(
      'See src/app.ts#L10 and backend\\src\\server.js:12, with head=10. [src/ui/App.tsx](src/ui/App.tsx#L20)\n\n```text\nsrc/raw.ts head=4\n```',
    );

    expect(result).toContain('`src/app.ts#L10`');
    expect(result).toContain('`backend\\src\\server.js:12`');
    expect(result).toContain('`head=10`');
    expect(result).toContain('[src/ui/App.tsx](src/ui/App.tsx#L20)');
    expect(result).toContain('```text\nsrc/raw.ts head=4\n```');
  });
});
