import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAuth } from "../src/auth";
import { readConfig } from "../src/config";
import {
  defaultEnvVar,
  detectKeyMode,
  parseEnvRef,
  parseFileRef,
  planKeyMode,
  resolveSecretPath,
  type KeyMode,
} from "../src/keymodes";
import { applyChanges } from "../src/backup";
import { asAuth, asConfig, configWithOptions, makeSandbox, writeAuth, writeConfig } from "./helpers";

const KEY = "sk-source-1234567890abcd";
const MODES: KeyMode[] = ["auth", "env", "file", "inline"];

function mode(state: ReturnType<typeof detectKeyMode>): KeyMode {
  return state.mode;
}

function prepare(source: KeyMode) {
  const sandbox = makeSandbox();
  const secretsDir = join(sandbox.configHome, "opencode", "secrets");
  const keyFile = join(secretsDir, "test.key");
  const env: Record<string, string> = {
    ...sandbox.env,
    TEST_KEY: KEY,
    TEST_API_KEY: KEY,
  };

  if (source === "auth") {
    writeAuth(sandbox, JSON.stringify({ test: { type: "api", key: KEY } }, null, 2));
    writeConfig(sandbox, configWithOptions({ baseURL: "https://example.test/v1" }));
  } else if (source === "env") {
    writeAuth(sandbox, "{}\n");
    writeConfig(sandbox, configWithOptions({ baseURL: "https://example.test/v1", apiKey: "{env:TEST_KEY}" }));
  } else if (source === "file") {
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    writeAuth(sandbox, "{}\n");
    writeConfig(
      sandbox,
      configWithOptions({ baseURL: "https://example.test/v1", apiKey: `{file:${keyFile}}` }),
    );
  } else {
    writeAuth(sandbox, "{}\n");
    writeConfig(
      sandbox,
      configWithOptions({ baseURL: "https://example.test/v1", apiKey: KEY }),
    );
    chmodSync(sandbox.configPath, 0o600);
  }

  const configText = readFileSync(sandbox.configPath, "utf8");
  const authText = readFileSync(sandbox.authPath, "utf8");
  return {
    sandbox,
    secretsDir,
    keyFile,
    env,
    config: asConfig(sandbox.configPath, configText),
    auth: asAuth(sandbox.authPath, authText),
  };
}

describe("key mode detection", () => {
  test("detects auth, env, file, inline, none, and duplicates", () => {
    const base = { provider: { test: { options: { baseURL: "https://x" } } } };
    expect(mode(detectKeyMode(base, {}, "test"))).toBe("none");
    expect(mode(detectKeyMode(base, { test: { type: "api", key: "k" } }, "test"))).toBe("auth");
    expect(
      mode(detectKeyMode({ provider: { test: { options: { apiKey: "{env:KEY}" } } } }, {}, "test")),
    ).toBe("env");
    expect(
      mode(detectKeyMode({ provider: { test: { options: { apiKey: "{file:/x}" } } } }, {}, "test")),
    ).toBe("file");
    expect(
      mode(detectKeyMode({ provider: { test: { options: { apiKey: "plain" } } } }, {}, "test")),
    ).toBe("inline");
    expect(
      detectKeyMode(
        { provider: { test: { options: { apiKey: "plain" } } } },
        { test: { type: "api", key: "other" } },
        "test",
      ),
    ).toMatchObject({ mode: "inline", duplicate: true });
    expect(detectKeyMode(base, { test: { type: "oauth", access: "a" } }, "test")).toMatchObject({
      mode: "none",
      authType: "oauth",
    });
  });

  test("parses refs and derives env names", () => {
    expect(parseEnvRef("{env:MY_KEY}")).toBe("MY_KEY");
    expect(parseEnvRef("{file:/x}")).toBeUndefined();
    expect(parseFileRef("{file:/x/y}")).toBe("/x/y");
    expect(defaultEnvVar("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(defaultEnvVar("my-provider")).toBe("MY_PROVIDER_API_KEY");
    expect(resolveSecretPath("/cfg/opencode.jsonc", "./key", {})).toBe("/cfg/key");
  });
});

describe("all key-mode transitions", () => {
  for (const source of MODES) {
    for (const target of MODES) {
      test(`${source} -> ${target}`, () => {
        const setup = prepare(source);
        const plan = planKeyMode({
          config: setup.config,
          auth: setup.auth,
          providerId: "test",
          target,
          env: setup.env,
          secretsDir: setup.secretsDir,
        });
        if (source === target) {
          expect(plan.changes).toEqual([]);
        } else {
          expect(plan.changes.length).toBeGreaterThan(0);
        }
        applyChanges(plan.changes, { backupsDir: setup.sandbox.backupsDir, print: false });

        const config = readConfig(setup.sandbox.configPath);
        const auth = readAuth(setup.sandbox.authPath);
        const state = detectKeyMode(config.data as never, auth.data, "test");
        expect(state.mode).toBe(target);
        expect(state.duplicate).toBe(false);

        const options = (config.data.provider as never as Record<string, { options?: Record<string, unknown> }>)
          .test.options;
        if (target === "auth") {
          expect((auth.data.test as Record<string, unknown>).key).toBe(KEY);
          expect(options?.apiKey).toBeUndefined();
        } else if (target === "env") {
          const expected = source === "env" ? "{env:TEST_KEY}" : "{env:TEST_API_KEY}";
          expect(options?.apiKey).toBe(expected);
          expect(auth.data.test).toBeUndefined();
        } else if (target === "file") {
          const ref = String(options?.apiKey);
          expect(ref.startsWith("{file:")).toBe(true);
          expect(readFileSync(setup.keyFile, "utf8").trim()).toBe(KEY);
          expect(statSync(setup.keyFile).mode & 0o777).toBe(0o600);
          expect(auth.data.test).toBeUndefined();
        } else {
          expect(options?.apiKey).toBe(KEY);
          expect(auth.data.test).toBeUndefined();
          expect(statSync(setup.sandbox.configPath).mode & 0o777).toBe(0o600);
        }
        if (source === "file" && target !== "file") {
          expect(existsSync(setup.keyFile)).toBe(false);
        }
      });
    }
  }
});

describe("duplicates and special auth entries", () => {
  test("removes stale auth entries when switching to inline", () => {
    const setup = prepare("inline");
    writeAuth(setup.sandbox, JSON.stringify({ test: { type: "api", key: "older-key-123456" } }, null, 2));
    const config = readConfig(setup.sandbox.configPath);
    const auth = readAuth(setup.sandbox.authPath);
    const plan = planKeyMode({
      config,
      auth,
      providerId: "test",
      target: "inline",
      env: setup.env,
      secretsDir: setup.secretsDir,
    });
    expect(plan.changes.some((change) => change.kind === "auth")).toBe(true);
    applyChanges(plan.changes, { backupsDir: setup.sandbox.backupsDir, print: false });
    expect(readAuth(setup.sandbox.authPath).data.test).toBeUndefined();
    expect(readConfig(setup.sandbox.configPath).data.provider).toBeTruthy();
  });

  test("moves an inline key into auth and clears the config key", () => {
    const setup = prepare("inline");
    const plan = planKeyMode({
      config: setup.config,
      auth: setup.auth,
      providerId: "test",
      target: "auth",
      env: setup.env,
      secretsDir: setup.secretsDir,
    });
    applyChanges(plan.changes, { backupsDir: setup.sandbox.backupsDir, print: false });
    const config = readConfig(setup.sandbox.configPath);
    const auth = readAuth(setup.sandbox.authPath);
    expect((auth.data.test as Record<string, unknown>).key).toBe(KEY);
    expect(
      ((config.data.provider as never as Record<string, { options?: Record<string, unknown> }>).test
        .options ?? {}).apiKey,
    ).toBeUndefined();
  });

  test("preserves OAuth credentials when removing an API key", () => {
    const setup = prepare("inline");
    writeAuth(
      setup.sandbox,
      JSON.stringify({ test: { type: "oauth", access: "a", refresh: "r", expires: 1 } }, null, 2),
    );
    const config = readConfig(setup.sandbox.configPath);
    const auth = readAuth(setup.sandbox.authPath);
    const plan = planKeyMode({
      config,
      auth,
      providerId: "test",
      target: "env",
      env: setup.env,
      secretsDir: setup.secretsDir,
    });
    expect(plan.warnings.join("\n")).toContain("preserved");
    applyChanges(plan.changes, { backupsDir: setup.sandbox.backupsDir, print: false });
    expect(readAuth(setup.sandbox.authPath).data.test).toMatchObject({ type: "oauth" });
  });

  test("refuses to replace OAuth without force", () => {
    const setup = prepare("inline");
    writeAuth(
      setup.sandbox,
      JSON.stringify({ test: { type: "oauth", access: "a", refresh: "r", expires: 1 } }, null, 2),
    );
    const config = readConfig(setup.sandbox.configPath);
    const auth = readAuth(setup.sandbox.authPath);
    expect(() =>
      planKeyMode({
        config,
        auth,
        providerId: "test",
        target: "auth",
        env: setup.env,
        secretsDir: setup.secretsDir,
      }),
    ).toThrow(/OAuth/);
    const forced = planKeyMode({
      config,
      auth,
      providerId: "test",
      target: "auth",
      force: true,
      env: setup.env,
      secretsDir: setup.secretsDir,
    });
    expect(forced.changes.length).toBeGreaterThan(0);
  });

  test("leaves external key files alone and warns", () => {
    const sandbox = makeSandbox();
    const external = join(sandbox.root, "external.key");
    writeFileSync(external, `${KEY}\n`, { mode: 0o600 });
    writeConfig(
      sandbox,
      configWithOptions({ baseURL: "https://example.test/v1", apiKey: `{file:${external}}` }),
    );
    writeAuth(sandbox, "{}\n");
    const config = readConfig(sandbox.configPath);
    const auth = readAuth(sandbox.authPath);
    const plan = planKeyMode({
      config,
      auth,
      providerId: "test",
      target: "auth",
      env: sandbox.env,
      secretsDir: join(sandbox.configHome, "opencode", "secrets"),
    });
    expect(plan.warnings.join("\n")).toContain("Left external key file untouched");
    applyChanges(plan.changes, { backupsDir: sandbox.backupsDir, print: false });
    expect(existsSync(external)).toBe(true);
    expect(readAuth(sandbox.authPath).data.test).toMatchObject({ type: "api", key: KEY });
  });

  test("errors when the current key file is missing", () => {
    const sandbox = makeSandbox();
    const missing = join(sandbox.root, "missing.key");
    writeConfig(
      sandbox,
      configWithOptions({ baseURL: "https://example.test/v1", apiKey: `{file:${missing}}` }),
    );
    writeAuth(sandbox, "{}\n");
    const config = readConfig(sandbox.configPath);
    const auth = readAuth(sandbox.authPath);
    expect(() =>
      planKeyMode({
        config,
        auth,
        providerId: "test",
        target: "file",
        env: sandbox.env,
        secretsDir: join(sandbox.configHome, "opencode", "secrets"),
      }),
    ).toThrow(/cannot read key file|cannot read/i);
  });

  test("rejects an invalid env var name and missing key", () => {
    const setup = prepare("auth");
    expect(() =>
      planKeyMode({
        config: setup.config,
        auth: setup.auth,
        providerId: "test",
        target: "env",
        envVar: "not a name",
        env: setup.env,
        secretsDir: setup.secretsDir,
      }),
    ).toThrow(/Invalid environment variable/);

    const sandbox = makeSandbox();
    writeConfig(sandbox, configWithOptions({ baseURL: "https://example.test/v1" }));
    writeAuth(sandbox, "{}\n");
    expect(() =>
      planKeyMode({
        config: readConfig(sandbox.configPath),
        auth: readAuth(sandbox.authPath),
        providerId: "test",
        target: "inline",
        env: sandbox.env,
        secretsDir: join(sandbox.configHome, "opencode", "secrets"),
      }),
    ).toThrow(/no API key|non-empty API key/i);
  });
});
