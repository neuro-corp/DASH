import hljs from "highlight.js";
import { useMemo } from "react";

export const syntaxColors = {
  Default: "#d4d4d4",
  Variables: "#9cdcfe",
  Keywords: "#c586c0",
  Numbers: "#b5cea8",
  Constants: "#4fc1ff",
  Functions: "#dcdcaa",
  Types: "#4ec9b0",
  Tags: "#569cd6",
  Strings: "#ce9178",
  Special: "#d16969",
  Meta: "#d7ba7d",
  Comments: "#6a9955",
};

export type TokenType = keyof typeof syntaxColors;

const SGR_PREFIX = "\x1b[";

function fgFormatter(hex: string): (codePart: string) => string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (codePart: string) => `\x1b[38;2;${r};${g};${b}m${codePart}\x1b[39m`;
}

// One theme for every highlight.js token type so all languages share the same palette.
const syntaxTokenColors: Record<string, string> = {
    keyword: syntaxColors.Keywords,
    built_in: syntaxColors.Functions,
    type: syntaxColors.Types,
    literal: syntaxColors.Constants,
    number: syntaxColors.Numbers,
    regexp: syntaxColors.Special,
    string: syntaxColors.Strings,
    subst: syntaxColors.Variables,
    symbol: syntaxColors.Constants,
    class: syntaxColors.Types,
    function: syntaxColors.Functions,
    title: syntaxColors.Functions,
    function_: syntaxColors.Functions,
    class_: syntaxColors.Types,
    params: syntaxColors.Variables,
    comment: syntaxColors.Comments,
    doctag: syntaxColors.Comments,
    meta: syntaxColors.Meta,
    "meta-keyword": syntaxColors.Keywords,
    "meta-string": syntaxColors.Strings,
    section: syntaxColors.Default,
    tag: syntaxColors.Tags,
    name: syntaxColors.Tags,
    "builtin-name": syntaxColors.Functions,
    attr: syntaxColors.Variables,
    attribute: syntaxColors.Variables,
    property: syntaxColors.Variables,
    variable: syntaxColors.Variables,
    "template-variable": syntaxColors.Special,
    "selector-tag": syntaxColors.Tags,
    "selector-id": syntaxColors.Tags,
    "selector-class": syntaxColors.Types,
    "selector-attr": syntaxColors.Meta,
    "selector-pseudo": syntaxColors.Meta,
    "template-tag": syntaxColors.Meta,
    addition: syntaxColors.Functions,
    deletion: syntaxColors.Special,
    link: syntaxColors.Tags,
    bullet: syntaxColors.Constants,
    emphasis: syntaxColors.Default,
    strong: syntaxColors.Default,
    code: syntaxColors.Strings,
    formula: syntaxColors.Constants,
    quote: syntaxColors.Comments,
    punctuation: syntaxColors.Default,
    operator: syntaxColors.Default,
};

export const syntaxHighlightTheme: Record<string, (codePart: string) => string> = Object.fromEntries(
  Object.entries(syntaxTokenColors).map(([token, color]) => [token, fgFormatter(color)]),
);

const extToLanguage: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript",
  py: "python", pyw: "python", rb: "ruby", go: "go", rs: "rust",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  php: "php", lua: "lua", pl: "perl", pm: "perl", scala: "scala", dart: "dart",
  json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", psd1: "powershell", psm1: "powershell",
  bat: "dos", cmd: "dos", sql: "sql", html: "html", htm: "html", xml: "xml",
  svg: "xml", vue: "xml", svelte: "xml",
  css: "css", scss: "scss", sass: "scss", less: "less", md: "markdown", mdx: "markdown",
  tex: "latex", r: "r", hs: "haskell", erl: "erlang", ex: "elixir", exs: "elixir",
  clj: "clojure", cljs: "clojure", groovy: "groovy",
  dockerfile: "dockerfile", graphql: "graphql", gql: "graphql", makefile: "makefile",
  vim: "vim", tf: "hcl", proto: "protobuf",
};

const stemToLanguage: Array<[RegExp, string]> = [
  [/^dockerfile/i, "dockerfile"],
  [/^makefile/i, "makefile"],
  [/^gemfile|^rakefile|^vagrantfile|^thorfile|^guardfile|^brewfile|^podfile/i, "ruby"],
  [/^justfile|^procfile/i, "bash"],
  [/^cmakelists\.txt$|\.cmake$/i, "makefile"],
];

export function languageFromPath(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  for (const [re, lang] of stemToLanguage) {
    if (re.test(base)) return lang;
  }
  const dot = base.lastIndexOf(".");
  if (dot === -1 || dot === base.length - 1) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  const lang = extToLanguage[ext];
  if (lang) return lang;
  try {
    if (hljs.getLanguage(ext)) return ext;
  } catch {
    /* ignore */
  }
  return undefined;
}

export interface AnsiChunk {
  text: string;
  fg?: string;
  bg?: string;
}

// Words that must never be treated as functions/classes/properties. Union of mainstream-language keywords.
const KEYWORD_STOP = new Set([
  "abstract", "any", "as", "assert", "async", "await", "begin", "boolean", "break", "byte",
  "case", "catch", "chan", "char", "class", "const", "constructor", "continue",
  "crate", "debugger", "declare", "default", "defer", "def", "del", "delete", "do", "done", "double",
  "elif", "else", "end", "enum", "esac", "except", "export", "extends", "extern", "fallthrough", "false",
  "fi", "final", "finally", "float", "fn", "for", "from", "func", "function", "global", "goto", "if",
  "impl", "implements", "import", "in", "infer", "instanceof", "int", "interface", "internal", "is",
  "keyof", "lambda", "let", "local", "loop", "macro_rules", "match", "mod", "module", "move", "mut",
  "my", "namespace", "native", "never", "new", "nil", "nonlocal", "not", "null", "nullptr", "number",
  "object", "of", "or", "and", "package", "params", "pass", "private", "protected", "pub", "public",
  "raise", "readonly", "record", "ref", "register", "repeat", "return", "satisfies", "select", "self",
  "set", "shift", "short", "signed", "sizeof", "static", "string", "struct", "sub", "super", "switch",
  "synchronized", "then", "this", "throw", "throws", "trait", "transient", "true", "try", "type",
  "typedef", "typeof", "union", "unsafe", "unsigned", "until", "use", "using", "undefined", "var",
  "virtual", "void", "with", "while", "iota", "volatile", "yield",
]);

const langLiteralWords: Record<string, Set<string>> = {
  python: new Set(["True", "False", "None"]),
  ruby: new Set(["nil"]),
  lua: new Set(["nil"]),
  rust: new Set(["None", "Some", "Ok", "Err"]),
  elixir: new Set(["nil", "true", "false"]),
};

// Primitive/builtin type names per language. hljs colors these as built_in, but they read better as constants.
const primitiveTypesByLang: Record<string, Set<string>> = {
  typescript: new Set(["number", "string", "boolean", "symbol", "bigint"]),
  javascript: new Set(["bigint"]),
  go: new Set(["string", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "float32", "float64", "byte", "rune", "complex64", "complex128", "error"]),
  python: new Set(["str", "int", "float", "bool", "bytes"]),
  rust: new Set(["u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize", "f32", "f64", "str"]),
  java: new Set(["int", "long", "double", "float", "boolean", "byte", "short", "char"]),
  c: new Set(["int", "char", "float", "double", "size_t"]),
  cpp: new Set(["int", "char", "short", "long", "float", "double", "size_t"]),
  csharp: new Set(["int", "long", "double", "decimal", "string", "float", "byte", "bool", "short", "ulong", "uint", "ushort"]),
  kotlin: new Set(["Int", "String", "Boolean", "Float", "Double", "Long", "Short", "Byte", "Char"]),
  swift: new Set(["Int", "String", "Bool", "Float", "Double", "Character"]),
  dart: new Set(["int", "double", "bool", "String"]),
  php: new Set(["string", "int", "float", "bool", "array"]),
  lua: new Set(["string", "number", "boolean"]),
};

/**
 * Second-pass enrichment: colors things highlight.js leaves plain — call sites
 * (functions/methods), dotted properties, classes/types, SCREAMING constants and decorators.
 * Only touches tokens that hljs left in the default color.
 */
export interface ColorRule {
  color: string;
  start: number;
  end: number;
  override?: boolean;
}

export interface ChunkReplacement {
  start: number;
  end: number;
  chunks: AnsiChunk[];
}

export function collectEnrichRules(code: string, chunks: AnsiChunk[], fallbackFg?: string, language?: string): ColorRule[] {
  const zones: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const c of chunks) {
    const start = offset;
    offset += c.text.length;
    if (!c.fg || c.fg === fallbackFg) zones.push({ start, end: offset });
  }
  if (zones.length === 0) return [];

  const rules: ColorRule[] = [];
  const overlaps = (start: number, end: number): boolean =>
    rules.some(r => r.start < end && start < r.end);

  const literals = (language && langLiteralWords[language]) || new Set<string>();
  const primitives = (language && primitiveTypesByLang[language]) || new Set<string>();

  // primitive types: override built_in (Functions) coloring wherever present in the whole text
  for (const m of code.matchAll(/\b[A-Za-z_][\w$]*\b/g)) {
    const w = m[0];
    if (!primitives.has(w)) continue;
    const start = m.index;
    rules.push({ start, end: start + w.length, color: syntaxColors.Constants, override: true });
  }

  // class-declaration connectors hljs mislabels as title(): restore keyword color
  for (const m of code.matchAll(/\b(?:implements|extends)\b/g)) {
    const start = m.index;
    rules.push({ start, end: start + m[0].length, color: syntaxColors.Keywords, override: true });
    // the mapped type/class names following the connector render better as types
    let j = start + m[0].length;
    for (;;) {
      while (j < code.length && /[\s,]/.test(code[j] as string)) j++;
      const word = /^[A-Za-z_$][\w$]*/.exec(code.slice(j));
      if (!word) break;
      rules.push({ start: j, end: j + word[0].length, color: syntaxColors.Types, override: true });
      j += word[0].length;
      const continueMark = /\s*[&<,]/.exec(code.slice(j));
      if (!continueMark || continueMark.index !== 0) break;
    }
  }

  for (const zone of zones) {
    const text = code.slice(zone.start, zone.end);
    // function / method call sites: `name(`
    for (const m of text.matchAll(/\b[A-Za-z_$][\w$]*(?=\s*\()/g)) {
      const w = m[0];
      const start = zone.start + m.index;
      const end = start + w.length;
      if (KEYWORD_STOP.has(w)) continue;
      if (literals.has(w)) continue;
      rules.push({ start, end, color: syntaxColors.Functions });
    }
    // dotted members that are NOT call sites -> property color
    for (const m of text.matchAll(/(?<=\.)[A-Za-z_$][\w$]*/g)) {
      const w = m[0];
      const start = zone.start + m.index;
      const end = start + w.length;
      const after = text.slice(m.index + w.length).replace(/^\s+/, "");
      if (KEYWORD_STOP.has(w) || after.startsWith("(")) continue;
      if (literals.has(w)) continue;
      rules.push({ start, end, color: syntaxColors.Variables });
    }
    // capitalized identifiers -> types/classes; SCREAMING_CASE -> constants
    for (const m of text.matchAll(/\b[A-Z][\w$]*\b/g)) {
      const w = m[0];
      const start = zone.start + m.index;
      const end = start + w.length;
      if (KEYWORD_STOP.has(w) || overlaps(start, end)) continue;
      if (literals.has(w)) {
        rules.push({ start, end, color: syntaxColors.Constants });
        continue;
      }
      const prevChar = start > 0 ? code[start - 1] : "";
      const isProperty = prevChar === ".";
      const isScreaming = /^[A-Z][A-Z0-9_]{1,}$/.test(w) && /[\d_]/.test(w.slice(1));
      if (isProperty) rules.push({ start, end, color: syntaxColors.Variables });
      else if (isScreaming) rules.push({ start, end, color: syntaxColors.Constants });
      else rules.push({ start, end, color: syntaxColors.Types });
    }
    // decorators: @word
    for (const m of text.matchAll(/@[\w$]+/g)) {
      const start = zone.start + m.index;
      rules.push({ start, end: start + m[0].length, color: syntaxColors.Meta });
    }
  }
  return rules;
}

/**
 * Generalized assembler: applies color rules and full-color chunk replacements on top of base chunks.
 * Replacements win over everything; override rules can also cut through used-to-be-`built_in` (Functions) chunks.
 */
export function assembleChunks(
  code: string,
  baseChunks: AnsiChunk[],
  rules: ColorRule[],
  recs: ChunkReplacement[],
  fallbackFg?: string,
): AnsiChunk[] {
  if (rules.length === 0 && recs.length === 0) return baseChunks;
  rules = [...rules].sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const sortedRecs = [...recs].sort((a, b) => a.start - b.start);

  interface Seg { start: number; end: number; chunk: AnsiChunk; }
  const segs: Seg[] = [];
  let acc = 0;
  for (const c of baseChunks) {
    segs.push({ start: acc, end: acc + c.text.length, chunk: c });
    acc += c.text.length;
  }

  const cut = new Set<number>([0, code.length]);
  for (const s of segs) {
    cut.add(s.start);
    cut.add(s.end);
  }
  for (const r of rules) {
    cut.add(r.start);
    cut.add(r.end);
  }
  for (const rec of sortedRecs) {
    cut.add(rec.start);
    cut.add(rec.end);
    let p = rec.start;
    for (const ic of rec.chunks) {
      p += ic.text.length;
      cut.add(p);
    }
  }

  const pts = [...cut].sort((a, b) => a - b);

  const emit = (text: string, fg: string | undefined, bg: string | undefined) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.fg === fg && last.bg === bg) {
      last.text += text;
      return;
    }
    out.push({ text, fg, bg });
  };

  const out: AnsiChunk[] = [];
  let segI = 0;
  let recI = 0;
  const coveringRecIdx = (s: number, e: number, from: number): number => {
    const rec = sortedRecs[from];
    if (rec && rec.start <= s && rec.end >= e) return from;
    for (let k = from + 1; k < sortedRecs.length; k++) {
      const r = sortedRecs[k] as ChunkReplacement;
      if (r.start >= e) return -1;
      if (r.start <= s && r.end >= e) return k;
    }
    return -1;
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i] as number;
    const e = pts[i + 1] as number;
    while (segI + 1 < segs.length && (segs[segI + 1] as Seg).start <= s) segI++;
    while (recI + 1 < sortedRecs.length && (sortedRecs[recI + 1] as ChunkReplacement).start <= s) recI++;

    const seg = segs[segI] as Seg | undefined;
    if (!seg) continue;
    const recIdx = coveringRecIdx(s, e, recI);
    const rec = recIdx >= 0 ? (sortedRecs[recIdx] as ChunkReplacement) : undefined;
    if (rec) {
      let ip = rec.start;
      for (const ic of rec.chunks) {
        const len = ic.text.length;
        if (s >= ip && s < ip + len || (s === ip && len === 0)) {
          emit(code.slice(s, e), ic.fg ?? fallbackFg, ic.bg ?? seg.chunk.bg);
          break;
        }
        ip += len;
      }
      continue;
    }
    const isPlain = !seg.chunk.fg || seg.chunk.fg === fallbackFg;
    const isBuiltIn = seg.chunk.fg === syntaxColors.Functions;
    const isKeyword = seg.chunk.fg === syntaxColors.Keywords;
    let color: string | undefined;
    for (const r of rules) {
      if (r.start > s || r.end < e) continue;
      const applies = r.override ? (isPlain || isBuiltIn || isKeyword) : isPlain;
      if (applies) {
        color = r.color;
        break;
      }
    }
    emit(code.slice(s, e), color ?? seg.chunk.fg, seg.chunk.bg);
  }
  return out;
}

export function enrichChunks(code: string, chunks: AnsiChunk[], fallbackFg?: string, language?: string): AnsiChunk[] {
  const rules = collectEnrichRules(code, chunks, fallbackFg, language);
  if (rules.length === 0) return chunks;
  return assembleChunks(code, chunks, rules, [], fallbackFg);
}


const ansi16Colors = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

function indexToHex256(n: number): string {
  if (n < 16) return ansi16Colors[Math.max(0, Math.min(15, n))] as string;
  if (n >= 232 && n <= 255) {
    const v = (n - 232) * 10 + 8;
    const hex = Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
    return `#${hex}${hex}${hex}`;
  }
  const steps = [0, 95, 135, 175, 215, 255];
  const cd = n - 16;
  const r = Math.floor(cd / 36);
  const g = Math.floor((cd % 36) / 6);
  const b = cd % 6;
  const to2 = (v: number) => (steps[Math.max(0, Math.min(5, v))] ?? 0).toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

const ANSI_SGR = /\x1b\[([0-9;]*)m/g;

export function parseAnsiChunks(code: string, defaultFg?: string, defaultBg?: string): AnsiChunk[] {
  const chunks: AnsiChunk[] = [];
  let fg = defaultFg;
  let bg = defaultBg;
  const pushChunk = (text: string) => {
    if (text) chunks.push({ text, fg, bg });
  };
  let i = 0;
  while (i < code.length) {
    const idx = code.indexOf(SGR_PREFIX, i);
    if (idx === -1) {
      pushChunk(code.slice(i));
      break;
    }
    pushChunk(code.slice(i, idx));
    ANSI_SGR.lastIndex = idx;
    const m = ANSI_SGR.exec(code);
    if (!m || m.index !== idx) {
      chunks.push({ text: code.slice(idx, idx + 1), fg, bg });
      i = idx + 1;
      continue;
    }
    i = idx + m[0].length;
    const params = (m[1] ?? "").split(";").filter(p => p !== "");
    if (params.length === 0) {
      fg = defaultFg;
      bg = defaultBg;
      continue;
    }
    let p = 0;
    while (p < params.length) {
      const num: number = Number(params[p]);
      if (num === 0) {
        fg = defaultFg;
        bg = defaultBg;
        p++;
        continue;
      }
      if (num >= 30 && num <= 37) {
        fg = ansi16Colors[num - 30];
        p++;
        continue;
      }
      if (num === 39) {
        fg = defaultFg;
        p++;
        continue;
      }
      if (num >= 40 && num <= 47) {
        bg = ansi16Colors[num - 40];
        p++;
        continue;
      }
      if (num === 49) {
        bg = defaultBg;
        p++;
        continue;
      }
      if (num >= 90 && num <= 97) {
        fg = ansi16Colors[num - 90 + 8];
        p++;
        continue;
      }
      if (num >= 100 && num <= 107) {
        bg = ansi16Colors[num - 100 + 8];
        p++;
        continue;
      }
      if ((num === 38 || num === 48) && p + 1 < params.length) {
        const mode = Number(params[p + 1]);
        if (mode === 5 && p + 2 < params.length) {
          const color = indexToHex256(Number(params[p + 2]));
          if (num === 38) fg = color;
          else bg = color;
          p += 3;
          continue;
        }
        if (mode === 2 && p + 4 < params.length) {
          const toHex2 = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
          const color = `#${toHex2(Number(params[p + 2]))}${toHex2(Number(params[p + 3]))}${toHex2(Number(params[p + 4]))}`;
          if (num === 38) fg = color;
          else bg = color;
          p += 5;
          continue;
        }
      }
      p++;
    }
  }
  return chunks;
}

function decodeHighlightedText(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, entity => {
    switch (entity) {
      case "&amp;": return "&";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&quot;": return '"';
      case "&#x27;":
      case "&#39;": return "'";
      default: return entity;
    }
  });
}

function chunksFromHighlightHtml(html: string, fallbackFg: string): AnsiChunk[] {
  const chunks: AnsiChunk[] = [];
  const colors: string[] = [fallbackFg];
  const tokenMarkup = /<span\b[^>]*>|<\/span>|&(?:amp|lt|gt|quot|#x27|#39);/g;
  let offset = 0;
  let match: RegExpExecArray | null;
  const push = (text: string, fg: string) => {
    if (!text) return;
    const last = chunks[chunks.length - 1];
    if (last?.fg === fg) last.text += text;
    else chunks.push({ text, fg });
  };

  while ((match = tokenMarkup.exec(html)) !== null) {
    if (match.index > offset) push(decodeHighlightedText(html.slice(offset, match.index)), colors[colors.length - 1] ?? fallbackFg);
    const token = match[0];
    if (token.startsWith("</")) {
      if (colors.length > 1) colors.pop();
    } else if (token.startsWith("<span")) {
      const className = /class=["']([^"']*)["']/.exec(token)?.[1] ?? "";
      const tokenNames = className.split(/\s+/).map(name => name.replace(/^hljs-/, ""));
      const colorToken = tokenNames.find(name => syntaxTokenColors[name] !== undefined);
      colors.push(colorToken ? syntaxTokenColors[colorToken] as string : colors[colors.length - 1] ?? fallbackFg);
    } else {
      push(decodeHighlightedText(token), colors[colors.length - 1] ?? fallbackFg);
    }
    offset = tokenMarkup.lastIndex;
  }
  if (offset < html.length) push(decodeHighlightedText(html.slice(offset)), colors[colors.length - 1] ?? fallbackFg);
  return chunks;
}

const highlightCache = new Map<string, AnsiChunk[]>();

// ---------------------------------------------------------------------------
// JSX / TSX enhancement
// ---------------------------------------------------------------------------

const JSX_NAME_RE = /^([A-Za-z_][\w:.!-]*)/;
const JSX_SOUP_RE = /^[\w\s.:/@=]+$/;
const MAX_TAG_WALK = 4000;

interface ScannedTag {
  name: string;
  nameStart: number;
  nameEnd: number;
  closeGt: number;
  selfClose: boolean;
  closing: boolean;
  attrBraceRanges: Array<{ start: number; end: number }>;
  attrNameRanges: Array<{ start: number; end: number }>;
}

interface ParsedTagResult {
  tag: ScannedTag | null;
  resumeAt: number;
}

function parseJsxTag(code: string, lt: number): ParsedTagResult {
  const len = code.length;
  let i = lt + 1;
  let closing = false;
  if (code[i] === "/") {
    closing = true;
    i++;
  }
  const nameMatch = JSX_NAME_RE.exec(code.slice(i, Math.min(len, i + 256)));
  if (!nameMatch) {
    return { tag: null, resumeAt: lt + 1 };
  }
  const name = nameMatch[1] as string;
  const nameStart = i;
  const nameEnd = i + name.length;
  i = nameEnd;

  let depth = 0;
  let inQuote: string | null = null;
  const attrBraceRanges: Array<{ start: number; end: number }> = [];
  const attrNameRanges: Array<{ start: number; end: number }> = [];
  let invalid = false;

  // walk attr-name soup and brace expressions between name end and '>'
  while (i < len && i - lt <= MAX_TAG_WALK) {
    const ch = code[i];
    if (inQuote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inQuote) inQuote = null;
      i++;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      if (ch === "{") {
        const endIdx = matchBalanced(code, i);
        if (endIdx < 0) {
          invalid = true;
          break;
        }
        attrBraceRanges.push({ start: i, end: endIdx + 1 });
        i = endIdx + 1;
        continue;
      }
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      if (depth === 0) {
        invalid = true;
        break;
      }
      depth--;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      i++;
      continue;
    }
    if (ch === ">") {
      if (depth !== 0) {
        invalid = true;
        break;
      }
      break;
    }
    if (ch === "<") {
      return { tag: null, resumeAt: i };
    }
    if (depth === 0 && (!ch || !JSX_SOUP_RE.test(ch))) {
      invalid = true;
      break;
    }
    i++;
  }
  if (invalid || i >= len || i - lt > MAX_TAG_WALK) {
    return { tag: null, resumeAt: lt + 1 };
  }
  if (code[i] !== ">") {
    return { tag: null, resumeAt: lt + 1 };
  }
  const selfClose = !closing && code[i - 1] === "/";

  // attribute names in the tag head (outside quotes and braces)
  const head = code.slice(nameEnd, selfClose ? i - 1 : i);
  for (const m of head.matchAll(/[A-Za-z_:@][\w:.\-]*/g)) {
    const idxInHead = m.index;
    const startPos = nameEnd + idxInHead;
    const prevChar = startPos > 0 ? code[startPos - 1] : " ";
    const nextChar = code[startPos + m[0].length];
    const prevOk = prevChar === " " || prevChar === "\t" || prevChar === "\n" || prevChar === "\r" || startPos === nameEnd;
    const nextOk =
      nextChar === "=" || nextChar === " " || nextChar === "\n" || nextChar === "\r" || nextChar === "\t" ||
      (selfClose && nextChar === "/") || nextChar === ">" || nextChar === undefined;
    if (prevOk && nextOk) {
      attrNameRanges.push({ start: startPos, end: startPos + m[0].length });
    }
  }

  return {
    tag: { name, nameStart, nameEnd, closeGt: i, selfClose, closing, attrBraceRanges, attrNameRanges },
    resumeAt: i + 1,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMatchingCloseTag(code: string, name: string, from: number): { open: number; end: number } | null {
  const re = new RegExp(`<\\s*(\\/?)\\s*(${escapeRegExp(name)})(?=[\\s/>])`, "g");
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const isClosing = m[1] === "/";
    const tagStart = m.index;
    if (isClosing) {
      depth--;
      if (depth === 0) {
        const gt = code.indexOf(">", tagStart);
        return { open: tagStart, end: gt >= 0 ? gt + 1 : tagStart + m[0].length };
      }
      continue;
    }
    // opening tag: skip if self-closing (<div ... />)
    let p = tagStart + (m[0] as string).length;
    while (p < code.length && p - tagStart < MAX_TAG_WALK) {
      const ch = code[p];
      if (ch === ">") break;
      if (ch === "'" || ch === '"') {
        const q = ch;
        p++;
        while (p < code.length && code[p] !== q) {
          if (code[p] === "\\") p++;
          p++;
        }
      }
      p++;
    }
    if (code[p - 1] === "/") continue;
    if (code[p] !== ">") continue;
    depth++;
  }
  return null;
}

function collectChildBraces(code: string, start: number, end: number): Array<{ start: number; end: number }> {
  const braces: Array<{ start: number; end: number }> = [];
  let i = start;
  let q: string | null = null;
  while (i < end) {
    const ch = code[i];
    if (q) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === q) q = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      i++;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      const endIdx = closeQuoteOrBraceAt(code, i);
      if (endIdx < 0) return braces;
      if (ch === "{") braces.push({ start: i, end: endIdx + 1 });
      i = endIdx + 1;
      continue;
    }
    i++;
  }
  return braces;
}

function matchBalanced(code: string, startIdx: number): number {
  const stack: string[] = [];
  let q: string | null = null;
  let j = startIdx;
  while (j < code.length) {
    const ch = code[j];
    if (q) {
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === q) q = null;
      j++;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      stack.push(ch);
      j++;
      continue;
    }
    if (ch === "}") {
      const open = stack.pop();
      if (open !== "{") return -1;
      if (stack.length === 0) return j;
      j++;
      continue;
    }
    if (ch === ")") {
      const open = stack.pop();
      if (open !== "(") return -1;
      if (stack.length === 0) return j;
      j++;
      continue;
    }
    if (ch === "]") {
      const open = stack.pop();
      if (open !== "[") return -1;
      if (stack.length === 0) return j;
      j++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      q = ch;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}

function closeQuoteOrBraceAt(code: string, startIdx: number): number {
  return matchBalanced(code, startIdx);
}

const anchorBeforeTag = new Set([
  "", " ", "\t", "\n", "\r", "(", ")", "[", "]", "{", "}", ",", ";", ":", "=",
  "+", "-", "*", "/", "%", "&", "|", "!", "?", "~", "^", ">", "@", '"', "'", "`",
]);

function scanJsxMarkup(
  code: string,
  start: number,
  end: number,
  language: string,
  recs: ChunkReplacement[],
  rules: ColorRule[],
  visited: Set<string>,
  depth: number,
): void {
  if (depth >= 8) return;
  let i = start;
  while (i < end) {
    const ch = code[i];
    if (ch !== "<") {
      i++;
      continue;
    }
    const anchor = i > 0 ? (code[i - 1] ?? "") : "";
    if (!anchorBeforeTag.has(anchor)) {
      i++;
      continue;
    }
    const parsed = parseJsxTag(code, i);
    if (!parsed.tag) {
      i = Math.max(i + 1, parsed.resumeAt);
      continue;
    }
    const tag = parsed.tag;
    if (tag.name) {
      rules.push({ start: tag.nameStart, end: tag.nameEnd, color: syntaxColors.Tags, override: true });
      for (const an of tag.attrNameRanges) {
        rules.push({ start: an.start, end: an.end, color: syntaxColors.Variables, override: true });
      }
    }
    // expressions inside tag attributes -> recursive re-highlight
    for (const br of tag.attrBraceRanges) {
      const key = `tag:${br.start}:${br.end}`;
      if (visited.has(key)) continue;
      visited.add(key);
      recs.push({
        start: br.start,
        end: br.end,
        chunks: highlightCore(code.slice(br.start, br.end), language, undefined, true, depth + 1),
      });
    }
    if (!tag.selfClose && !tag.closing) {
      const closeTag = findMatchingCloseTag(code, tag.name, tag.closeGt + 1);
      if (closeTag) {
        const childStart = tag.closeGt + 1;
        if (closeTag.open > childStart) {
          for (const br of collectChildBraces(code, childStart, closeTag.open)) {
            const key = `child:${br.start}:${br.end}`;
            if (visited.has(key)) continue;
            visited.add(key);
            recs.push({
              start: br.start,
              end: br.end,
              chunks: highlightCore(code.slice(br.start, br.end), language, undefined, true, depth + 1),
            });
          }
          scanJsxMarkup(code, childStart, closeTag.open, language, recs, rules, visited, depth + 1);
        }
        // color the closing tag name too
        const closeNameStart = closeTag.open + 2;
        if (code.startsWith("/", closeTag.open + 1)) {
          const cm = JSX_NAME_RE.exec(code.slice(closeNameStart, closeTag.end));
          if (cm) {
            rules.push({ start: closeNameStart, end: closeNameStart + (cm[1] ?? "").length, color: syntaxColors.Tags, override: true });
          }
        }
        i = closeTag.end;
        continue;
      }
    }
    i = tag.closeGt + 1;
  }
}

function scanMarkupTags(code: string, rules: ColorRule[]): void {
  let i = 0;
  while (i < code.length) {
    if (code[i] !== "<") {
      i++;
      continue;
    }
    const parsed = parseJsxTag(code, i);
    if (!parsed.tag) {
      i = Math.max(i + 1, parsed.resumeAt);
      continue;
    }
    rules.push({ start: parsed.tag.nameStart, end: parsed.tag.nameEnd, color: syntaxColors.Tags, override: true });
    for (const attr of parsed.tag.attrNameRanges) {
      rules.push({ start: attr.start, end: attr.end, color: syntaxColors.Variables, override: true });
    }
    i = parsed.resumeAt;
  }
}

function highlightCore(
  code: string,
  language: string | undefined,
  fallbackFg: string | undefined,
  markup: boolean,
  depth: number,
): AnsiChunk[] {
  const defaultFg = fallbackFg ?? syntaxColors.Default;
  let highlightedHtml: string | null = null;
  try {
    highlightedHtml = language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : hljs.highlightAuto(code).value;
  } catch {
    try {
      highlightedHtml = hljs.highlightAuto(code).value;
    } catch {
      highlightedHtml = null;
    }
  }
  const rough = highlightedHtml !== null
    ? chunksFromHighlightHtml(highlightedHtml, defaultFg)
    : [{ text: code, fg: defaultFg }];
  const rules = collectEnrichRules(code, rough, defaultFg, language);
  let replacements: ChunkReplacement[] = [];
  if (markup && depth < 8 && (language === "typescript" || language === "javascript")) {
    const jsxRules: ColorRule[] = [];
    replacements = [];
    scanJsxMarkup(code, 0, code.length, language, replacements, jsxRules, new Set(), 0);
    rules.push(...jsxRules);
  } else if (markup && (language === "html" || language === "xml")) {
    scanMarkupTags(code, rules);
  }
  return assembleChunks(code, rough, rules, replacements, defaultFg);
}

export function highlightToChunks(code: string, language?: string | undefined, fallbackFg?: string): AnsiChunk[] {
  const cacheKey = `plain\u0000${language ?? "\u0000auto"}\u0000${code}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) return cached;
  const chunks = highlightCore(code, language, fallbackFg, false, 0);
  if (chunks.length === 0) return chunks;
  if (highlightCache.size > 400) highlightCache.clear();
  highlightCache.set(cacheKey, chunks);
  return chunks;
}

/** Highlight code for a file path: enables JSX/TSX-aware markup scanning for .tsx/.jsx files. */
export function highlightCodeForFile(code: string, filePath: string | undefined, fallbackFg?: string): AnsiChunk[] {
  const base = (filePath ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = base && dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  const markup = ["tsx", "jsx", "html", "htm", "xml", "svg", "vue", "svelte"].includes(ext);
  const language = languageFromPath(filePath);
  const cacheKey = `file\u0000${markup ? "j" : "p"}\u0000${language ?? "\u0000auto"}\u0000${code}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) return cached;
  const chunks = highlightCore(code, language, fallbackFg, markup, 0);
  if (chunks.length === 0) return chunks;
  if (highlightCache.size > 400) highlightCache.clear();
  highlightCache.set(cacheKey, chunks);
  return chunks;
}

export function SyntaxView({ code, language, filePath, fallbackFg }: { code: string; language?: string; filePath?: string; fallbackFg?: string }) {
  const chunks = useMemo(
    () => filePath
      ? highlightCodeForFile(code, filePath, fallbackFg)
      : highlightToChunks(code, language ?? undefined, fallbackFg),
    [code, language, filePath, fallbackFg],
  );
  const fallback = fallbackFg ?? syntaxColors.Default;
  return (
    <text fg={fallback}>
      {chunks.map((chunk, index) => (
        <span key={index} fg={chunk.fg ?? fallback}>
          {chunk.text}
        </span>
      ))}
    </text>
  );
}
