import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyConfigEdits,
  detectFormatting,
  minimalConfigText,
  parseConfigText,
  readConfig,
} from "../src/config";
import { redactSecrets, unifiedDiff, maskKey } from "../src/ui";
import {
  formatIssues,
  validateConfig,
  validateConfigData,
  validateModelReference,
} from "../src/validate";
import { resolvePaths, pickConfigFile } from "../src/paths";
import { makeSandbox } from "./helpers";

describe("jsonc editing", () => {
  test("preserves comments, tabs, trailing commas, and key order", () => {
    const before = `{
\t// keep the top comment
\t"$schema": "https://opencode.ai/config.json",
\t"provider": {
\t\t"openrouter": {
\t\t\t/* keep this block */
\t\t\t"options": {
\t\t\t\t"baseURL": "https://openrouter.ai/api/v1", // trailing comment
\t\t\t},
\t\t},
\t},
}
`;
    const after = applyConfigEdits(before, [
      { path: ["provider", "openrouter", "options", "apiKey"], value: "{env:OPENROUTER_API_KEY}" },
      { path: ["model"], value: "openrouter/some/model" },
    ]);
    expect(after).toContain("// keep the top comment");
    expect(after).toContain("/* keep this block */");
    expect(after).toContain("// trailing comment");
    expect(after.startsWith("{\n\t")).toBe(true);
    expect(after).toContain('\t\t\t\t"apiKey": "{env:OPENROUTER_API_KEY}"');
    expect(after).toContain('\t"model": "openrouter/some/model"');
    const parsed = parseConfigText(after);
    expect(parsed.errors).toEqual([]);
    expect((parsed.data.provider as never as Record<string, never>).openrouter).toBeTruthy();
  });

  test("detects CRLF and tab formatting", () => {
    expect(detectFormatting('{\r\n\t"a": 1\r\n}\r\n')).toEqual({
      insertSpaces: false,
      tabSize: 1,
      eol: "\r\n",
    });
    expect(detectFormatting('{\n    "a": 1\n}\n')).toEqual({
      insertSpaces: true,
      tabSize: 4,
      eol: "\n",
    });
  });

  test("creates a minimal config with $schema", () => {
    const text = applyConfigEdits("", [{ path: ["provider", "x"], value: { name: "X" } }]);
    expect(text).toContain('"$schema": "https://opencode.ai/config.json"');
    expect(parseConfigText(text).errors).toEqual([]);
    expect(minimalConfigText()).toContain("$schema");
  });

  test("refuses to produce invalid JSONC", () => {
    expect(() =>
      applyConfigEdits('{ "a": 1 }', [{ path: ["a"], value: undefined }]),
    ).not.toThrow();
    expect(() => applyConfigEdits('{ "a": }', [{ path: ["b"], value: 1 }])).toThrow();
  });
});

describe("paths", () => {
  test("uses XDG paths and prefers .jsonc over .json", () => {
    const sandbox = makeSandbox();
    const opencodeDir = join(sandbox.configHome, "opencode");
    mkdirSync(opencodeDir, { recursive: true });
    const json = join(opencodeDir, "opencode.json");
    const jsonc = join(opencodeDir, "opencode.jsonc");
    writeFileSync(json, "{}\n");
    writeFileSync(jsonc, '{ "$schema": "https://opencode.ai/config.json" }\n');

    expect(pickConfigFile(opencodeDir)).toEqual({ path: jsonc, alternate: json });
    const paths = resolvePaths({ env: sandbox.env, cwd: sandbox.cwd });
    expect(paths.config).toBe(jsonc);
    expect(paths.alternateConfig).toBe(json);
    expect(paths.auth).toBe(join(sandbox.dataHome, "opencode", "auth.json"));
    expect(paths.backups).toBe(join(sandbox.stateHome, "ocm", "backups"));
    expect(paths.configSource).toBe("global");
  });

  test("project mode and explicit overrides win", () => {
    const sandbox = makeSandbox();
    writeFileSync(join(sandbox.cwd, "opencode.json"), "{}\n");
    const project = resolvePaths({ env: sandbox.env, cwd: sandbox.cwd, project: true });
    expect(project.config).toBe(join(sandbox.cwd, "opencode.json"));
    expect(project.configIsProject).toBe(true);

    writeFileSync(join(sandbox.cwd, "opencode.jsonc"), "{}\n");
    const preferred = resolvePaths({ env: sandbox.env, cwd: sandbox.cwd, project: true });
    expect(preferred.config).toBe(join(sandbox.cwd, "opencode.jsonc"));
    expect(preferred.alternateConfig).toBe(join(sandbox.cwd, "opencode.json"));

    const override = resolvePaths({
      env: sandbox.env,
      cwd: sandbox.cwd,
      config: "custom/config.jsonc",
      auth: "custom/auth.json",
    });
    expect(override.config).toBe(join(sandbox.cwd, "custom/config.jsonc"));
    expect(override.auth).toBe(join(sandbox.cwd, "custom/auth.json"));
    expect(override.configSource).toBe("override");
  });
});

describe("validation", () => {
  test("accepts a typical config", () => {
    const data = {
      $schema: "https://opencode.ai/config.json",
      model: "openrouter/anthropic/claude-sonnet",
      provider: {
        openrouter: {
          options: { apiKey: "{env:OPENROUTER_API_KEY}", baseURL: "https://openrouter.ai/api/v1" },
          models: { "vendor/model": { name: "Model" } },
        },
      },
    };
    expect(validateConfigData(data)).toEqual([]);
    expect(validateConfig(data, JSON.stringify(data)).schemaErrors).toEqual([]);
  });

  test("reports invalid field types with paths", () => {
    const issues = validateConfigData({ model: 123 } as never);
    expect(issues.some((issue) => issue.path === "/model")).toBe(true);
    expect(formatIssues(issues)[0]).toContain("/model");
  });

  test("warns about missing $schema and custom small_model", () => {
    const data = {
      model: "custom/alpha",
      small_model: "custom/alpha",
      provider: { custom: { models: { alpha: { name: "Alpha" } } } },
    };
    const report = validateConfig(data, JSON.stringify(data));
    expect(report.schemaErrors).toEqual([]);
    expect(report.warnings.some((warning) => warning.includes("$schema"))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("small_model"))).toBe(true);
  });

  test("validates model references", () => {
    expect(validateModelReference("openrouter/some/model")).toBeUndefined();
    expect(validateModelReference("nomodel")).toBeTruthy();
    expect(validateModelReference("/leading")).toBeTruthy();
    expect(validateModelReference("a/")).toBeTruthy();
    expect(validateModelReference("a/b c")).toBeTruthy();
  });
});

describe("redaction", () => {
  test("masks api keys and leaves env/file refs readable", () => {
    expect(maskKey("sk-1234567890abcdef")).toBe("sk-…cdef");
    expect(maskKey("short")).toBe("…");
    const redacted = redactSecrets(
      '{"apiKey":"sk-secret-1234567890","key":"sk-another-1234567890","token":"tok-1234567890","apiKey2":"safe"}',
    );
    expect(redacted).not.toContain("sk-secret-1234567890");
    expect(redacted).not.toContain("sk-another-1234567890");
    expect(redacted).not.toContain("tok-1234567890");
    expect(redactSecrets('{"apiKey":"{env:MY_KEY}"}')).toContain("{env:MY_KEY}");
    expect(redactSecrets('{"apiKey":"{file:/tmp/key}"}')).toContain("{file:/tmp/key}");
  });

  test("diff output is redacted", () => {
    const diff = unifiedDiff(
      "auth.json",
      '{\n  "p": {\n    "type": "api",\n    "key": "sk-old-1234567890"\n  }\n}\n',
      '{\n  "p": {\n    "type": "api",\n    "key": "sk-new-9876543210"\n  }\n}\n',
    );
    expect(diff.text).not.toContain("sk-old-1234567890");
    expect(diff.text).not.toContain("sk-new-9876543210");
    expect(diff.text).toContain("@@");
  });
});
