import { describe, expect, it } from "bun:test";
import { extractOldNewCode, getLanguageFromPath } from "./DiffView";

describe("terminal diff output parsing", () => {
  it("extracts file mutation diffs from structured tool output", () => {
    const result = extractOldNewCode(JSON.stringify({
      diff: ["@@ -1,2 +1,2 @@", " unchanged", "-oldValue", "+newValue"].join("\n"),
    }));

    expect(result.oldCode).toBe("unchanged\noldValue");
    expect(result.newCode).toBe("unchanged\nnewValue");
  });

  it("extracts source content from a structured newly-created file", () => {
    const source = "export function hello() {\n  return 'world';\n}";
    const result = extractOldNewCode(JSON.stringify({
      operation: "create",
      path: "src/hello.ts",
      message: "File created.",
      content: source,
      diff: "",
    }));

    expect(result.oldCode).toBe("");
    expect(result.newCode).toBe(source);
  });

  it("keeps rendering metadata independent of file extension", () => {
    expect(getLanguageFromPath("src/App.tsx")).toBe("typescript");
    expect(getLanguageFromPath("src/Program.cs")).toBe("csharp");
    expect(getLanguageFromPath("src/main.cpp")).toBe("cpp");
    expect(getLanguageFromPath("README")).toBeUndefined();
  });
});
