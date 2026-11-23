import { describe, expect, it } from "bun:test";
import { highlightCodeForFile, languageFromPath, syntaxColors } from "./Syntax";

describe("syntax highlighting", () => {
  it("resolves common frontend and systems-language extensions", () => {
    expect(languageFromPath("src/App.tsx")).toBe("typescript");
    expect(languageFromPath("src/page.html")).toBe("html");
    expect(languageFromPath("src/main.py")).toBe("python");
    expect(languageFromPath("src/main.rs")).toBe("rust");
    expect(languageFromPath("src/main.cpp")).toBe("cpp");
    expect(languageFromPath("src/Program.cs")).toBe("csharp");
  });

  it("preserves source text and assigns semantic colors across languages", () => {
    const samples: Array<[string, string]> = [
      ["App.tsx", "const App = () => <div className=\"card\">Hello</div>;"],
      ["page.html", "<main class=\"card\">Hello</main>"],
      ["main.py", "def greet(name): # comment\n    return f\"Hi {name}\""],
      ["main.rs", "fn main() { println!(\"hello\"); }"],
      ["main.cpp", "int main() { return 1; }"],
      ["Program.cs", "public class App { public void Run() {} }"],
    ];

    for (const [filePath, source] of samples) {
      const chunks = highlightCodeForFile(source, filePath, syntaxColors.Default);
      expect(chunks.map(chunk => chunk.text).join("")).toBe(source);
      expect(chunks.some(chunk => chunk.fg !== undefined && chunk.fg !== syntaxColors.Default)).toBe(true);
    }

    const colorAt = (filePath: string, source: string, token: string): string | undefined => {
      const start = source.indexOf(token);
      const chunks = highlightCodeForFile(source, filePath, syntaxColors.Default);
      let offset = 0;
      for (const chunk of chunks) {
        if (start >= offset && start < offset + chunk.text.length) return chunk.fg;
        offset += chunk.text.length;
      }
      return undefined;
    };

    expect(colorAt("App.tsx", samples[0]![1], "div")).toBe(syntaxColors.Tags);
    expect(colorAt("App.tsx", samples[0]![1], "className")).toBe(syntaxColors.Variables);
    expect(colorAt("page.html", samples[1]![1], "main")).toBe(syntaxColors.Tags);
    expect(colorAt("main.py", samples[2]![1], "# comment")).toBe(syntaxColors.Comments);
    expect(colorAt("main.rs", samples[3]![1], "fn")).toBe(syntaxColors.Keywords);
    expect(colorAt("main.cpp", samples[4]![1], "int")).toBe(syntaxColors.Constants);
    expect(colorAt("Program.cs", samples[5]![1], "class")).toBe(syntaxColors.Keywords);
  });
});
