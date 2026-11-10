import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeSandbox, startModelsServer } from "./helpers";

const KEY = "sk-test-1234567890abcdEF";
const servers: { stop: () => void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

function serve(...args: Parameters<typeof startModelsServer>) {
  const server = startModelsServer(...args);
  servers.push(server);
  return server;
}

function authKey(sandbox: ReturnType<typeof makeSandbox>): string | undefined {
  const text = readFileSync(sandbox.authPath, "utf8");
  const data = JSON.parse(text) as Record<string, { key?: string }>;
  return data.openrouter?.key ?? data.mockprov?.key;
}

describe("basic CLI", () => {
  test("list works with no config and does not create files", () => {
    const sandbox = makeSandbox();
    const result = sandbox.run(["list"]);
    expect(result.status).toBe(0);
    expect(result.text).toContain("No providers configured");
    expect(existsSync(sandbox.configPath)).toBe(false);
  });

  test("add creates a minimal config with $schema and an env reference", () => {
    const sandbox = makeSandbox();
    const result = sandbox.run([
      "add",
      "openrouter",
      "--key-mode",
      "env",
      "--env-var",
      "OPENROUTER_API_KEY",
      "--yes",
    ]);
    expect(result.status).toBe(0);
    const config = readFileSync(sandbox.configPath, "utf8");
    expect(config).toContain('"$schema": "https://opencode.ai/config.json"');
    expect(config).toContain('"apiKey": "{env:OPENROUTER_API_KEY}"');
    expect(config).toContain('"name": "OpenRouter"');
    expect(result.text).toContain("Key mode: env (OPENROUTER_API_KEY)");
    expect(result.text).not.toContain("resolved from env");
  });

  test("add auth reads a key from stdin, sets 600, and masks it", () => {
    const sandbox = makeSandbox();
    const result = sandbox.run(["add", "openrouter", "--key-mode", "auth", "--key-stdin", "--yes"], {
      input: `${KEY}\n`,
    });
    expect(result.status).toBe(0);
    expect(authKey(sandbox)).toBe(KEY);
    expect(statSync(sandbox.authPath).mode & 0o777).toBe(0o600);
    expect(result.text).not.toContain(KEY);
    expect(result.text).toContain("sk-…cdEF");

    const list = sandbox.run(["list"]);
    expect(list.status).toBe(0);
    expect(list.text).not.toContain(KEY);
    expect(list.text).toContain("sk-…cdEF");
    expect(list.text).toContain("openrouter");

    const json = sandbox.run(["list", "--json"]);
    const parsed = JSON.parse(json.stdout) as { providers: { key: string }[] };
    expect(parsed.providers[0].key).not.toContain(KEY);
    expect(parsed.providers[0].key).toContain("…");
  });

  test("dry-run prints a redacted diff and writes nothing", () => {
    const sandbox = makeSandbox();
    const result = sandbox.run(
      ["add", "openrouter", "--key-mode", "inline", "--key-stdin", "--dry-run", "--yes"],
      { input: `${KEY}\n` },
    );
    expect(result.status).toBe(0);
    expect(result.text).toContain("would write");
    expect(result.text).toContain("@@");
    expect(result.text).not.toContain(KEY);
    expect(existsSync(sandbox.configPath)).toBe(false);
    expect(existsSync(sandbox.backupsDir)).toBe(false);
  });

  test("missing config is not created without --yes", () => {
    const sandbox = makeSandbox();
    const result = sandbox.run(["add", "openrouter", "--key-mode", "env", "--env-var", "X_KEY"]);
    expect(result.status).toBe(1);
    expect(result.text).toContain("Pass --yes");
    expect(existsSync(sandbox.configPath)).toBe(false);
  });

  test("honors --config and --auth overrides", () => {
    const sandbox = makeSandbox();
    const config = join(sandbox.root, "custom", "my-opencode.jsonc");
    const auth = join(sandbox.root, "custom", "my-auth.json");
    const result = sandbox.run(
      [
        "--config",
        config,
        "--auth",
        auth,
        "add",
        "openrouter",
        "--key-mode",
        "auth",
        "--key-stdin",
        "--yes",
      ],
      { input: `${KEY}\n` },
    );
    expect(result.status).toBe(0);
    expect(existsSync(config)).toBe(true);
    expect(existsSync(auth)).toBe(true);
    expect(statSync(auth).mode & 0o777).toBe(0o600);
    expect(readFileSync(auth, "utf8")).toContain(KEY);
    expect(existsSync(sandbox.configPath)).toBe(false);
    expect(existsSync(sandbox.authPath)).toBe(false);
  });

  test("unknown commands fail and help prints once", () => {
    const sandbox = makeSandbox();
    const unknown = sandbox.run(["bogus"]);
    expect(unknown.status).toBe(1);
    expect(unknown.text).toContain("Unknown command: bogus");
    const help = sandbox.run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.text.match(/^Usage:/gm)?.length).toBe(1);
    const noArgs = sandbox.run([]);
    expect(noArgs.status).toBe(0);
    expect(noArgs.text).toContain("Usage:");
  });

  test("re-adding an existing provider requires --yes and updates it with --yes", () => {
    const sandbox = makeSandbox();
    sandbox.run(["add", "openrouter", "--key-mode", "env", "--env-var", "OPENROUTER_API_KEY", "--yes"]);
    const refused = sandbox.run([
      "add",
      "openrouter",
      "--name",
      "Renamed",
      "--key-mode",
      "env",
      "--env-var",
      "OPENROUTER_API_KEY",
    ]);
    expect(refused.status).toBe(1);
    expect(refused.text).toContain("already exists");

    const updated = sandbox.run([
      "add",
      "openrouter",
      "--name",
      "Renamed",
      "--key-mode",
      "env",
      "--env-var",
      "OPENROUTER_API_KEY",
      "--yes",
    ]);
    expect(updated.status).toBe(0);
    expect(readFileSync(sandbox.configPath, "utf8")).toContain('"name": "Renamed"');
  });
});

describe("key modes through the CLI", () => {
  test("cycles auth -> env -> file -> inline -> auth and cleans up", () => {
    const sandbox = makeSandbox();
    sandbox.run(["add", "openrouter", "--key-mode", "auth", "--key-stdin", "--yes"], {
      input: `${KEY}\n`,
    });
    expect(authKey(sandbox)).toBe(KEY);

    let result = sandbox.run(["key", "openrouter", "--mode", "env", "--env-var", "OR_KEY", "--yes"], {
      env: { OR_KEY: KEY },
    });
    expect(result.status).toBe(0);
    expect(readFileSync(sandbox.configPath, "utf8")).toContain('"apiKey": "{env:OR_KEY}"');
    expect(existsSync(sandbox.authPath) ? authKey(sandbox) : undefined).toBeUndefined();

    result = sandbox.run(["key", "openrouter", "--mode", "file", "--yes"], {
      env: { OR_KEY: KEY },
    });
    expect(result.status).toBe(0);
    const secretFile = join(sandbox.configHome, "opencode", "secrets", "openrouter.key");
    expect(readFileSync(sandbox.configPath, "utf8")).toContain(`{file:${secretFile}}`);
    expect(readFileSync(secretFile, "utf8").trim()).toBe(KEY);
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);

    result = sandbox.run(["key", "openrouter", "--mode", "inline", "--yes"]);
    expect(result.status).toBe(0);
    expect(readFileSync(sandbox.configPath, "utf8")).toContain(KEY);
    expect(statSync(sandbox.configPath).mode & 0o777).toBe(0o600);
    expect(existsSync(secretFile)).toBe(false);

    result = sandbox.run(["key", "openrouter", "--mode", "auth", "--key-stdin", "--yes"], {
      input: `${KEY}\n`,
    });
    expect(result.status).toBe(0);
    expect(authKey(sandbox)).toBe(KEY);
    expect(statSync(sandbox.authPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(sandbox.configPath, "utf8")).not.toContain(KEY);
    expect(sandbox.run(["list"]).text).not.toContain(KEY);
  });

  test("key switches require --yes in non-interactive mode", () => {
    const sandbox = makeSandbox();
    sandbox.run(["add", "openrouter", "--key-mode", "auth", "--key-stdin", "--yes"], {
      input: `${KEY}\n`,
    });
    const result = sandbox.run(["key", "openrouter", "--mode", "env"]);
    expect(result.status).toBe(1);
    expect(result.text).toContain("Pass --yes");
    expect(authKey(sandbox)).toBe(KEY);
  });

  test("key switch dry-run preserves both files and redacts secrets", () => {
    const sandbox = makeSandbox();
    sandbox.run(["add", "openrouter", "--key-mode", "auth", "--key-stdin", "--yes"], {
      input: `${KEY}\n`,
    });
    const before = readFileSync(sandbox.authPath, "utf8");
    const result = sandbox.run(["key", "openrouter", "--mode", "env", "--dry-run", "--yes"]);
    expect(result.status).toBe(0);
    expect(result.text).toContain("would write");
    expect(result.text).not.toContain(KEY);
    expect(readFileSync(sandbox.authPath, "utf8")).toBe(before);
    expect(readFileSync(sandbox.configPath, "utf8")).not.toContain("{env:");
  });
});

describe("models, test, default, validate", () => {
  test("fetches models with a bearer token, sets defaults, validates, and tests", async () => {
    const sandbox = makeSandbox();
    const server = serve();
    const add = sandbox.run(
      [
        "add",
        "openai-compatible",
        "--id",
        "mockprov",
        "--name",
        "Mock Provider",
        "--base-url",
        server.url,
        "--key-mode",
        "auth",
        "--key-stdin",
        "--yes",
      ],
      { input: `${KEY}\n` },
    );
    expect(add.status).toBe(0);

    const models = await sandbox.runAsync(["models", "mockprov", "--models", "alpha-1,beta-2", "--yes"]);
    expect(models.status).toBe(0);
    expect(models.text).toContain("Added 2 models");
    expect(server.requests.some((request) => request.authorization === `Bearer ${KEY}`)).toBe(true);
    const config = readFileSync(sandbox.configPath, "utf8");
    expect(config).toContain('"alpha-1"');
    expect(config).toContain('"name": "Alpha One"');

    const defaults = sandbox.run(["default", "--model", "mockprov/alpha-1", "--yes"]);
    expect(defaults.status).toBe(0);
    const withDefaults = readFileSync(sandbox.configPath, "utf8");
    expect(withDefaults).toContain('"model": "mockprov/alpha-1"');
    expect(withDefaults).toContain('"small_model": "mockprov/alpha-1"');

    const validate = sandbox.run(["validate"]);
    expect(validate.status).toBe(0);
    expect(validate.text).toContain("Config is valid");
    expect(validate.text).toContain("small_model");

    const testResult = await sandbox.runAsync(["test", "mockprov", "--json"]);
    expect(testResult.status).toBe(0);
    const report = JSON.parse(testResult.stdout) as { ok: boolean; modelCount: number };
    expect(report).toMatchObject({ ok: true, modelCount: 2 });

    const list = sandbox.run(["list"]);
    expect(list.text).toContain("default");
    expect(list.text).toContain("small");
  });

  test("--select-all and --deselect-all control the model selection", async () => {
    const sandbox = makeSandbox();
    const server = serve();
    const add = sandbox.run(
      [
        "add",
        "openai-compatible",
        "--id",
        "mockprov",
        "--base-url",
        server.url,
        "--key-mode",
        "env",
        "--env-var",
        "MOCK_KEY",
        "--yes",
      ],
    );
    expect(add.status).toBe(0);

    const all = await sandbox.runAsync(["models", "mockprov", "--select-all", "--yes"]);
    expect(all.status).toBe(0);
    expect(all.text).toContain("Added 2 models");

    const none = await sandbox.runAsync(["models", "mockprov", "--deselect-all", "--yes"]);
    expect(none.status).toBe(0);
    expect(none.text).toContain("No models selected");
    expect(none.text).not.toContain("GET ");
    expect(readFileSync(sandbox.configPath, "utf8")).toContain('"alpha-1"');

    const conflict = await sandbox.runAsync([
      "models",
      "mockprov",
      "--select-all",
      "--models",
      "alpha-1",
      "--yes",
    ]);
    expect(conflict.status).toBe(1);
    expect(conflict.text).toContain("not both");
  });

  test("sets a built-in default without requiring configured models", () => {
    const sandbox = makeSandbox();
    const add = sandbox.run([
      "add",
      "openrouter",
      "--key-mode",
      "env",
      "--env-var",
      "OPENROUTER_API_KEY",
      "--yes",
    ]);
    expect(add.status).toBe(0);
    const result = sandbox.run([
      "default",
      "--model",
      "openrouter/anthropic/claude-sonnet-4",
      "--yes",
    ]);
    expect(result.status).toBe(0);
    const config = readFileSync(sandbox.configPath, "utf8");
    expect(config).toContain('"model": "openrouter/anthropic/claude-sonnet-4"');
    expect(config).toContain('"small_model": "openrouter/anthropic/claude-sonnet-4"');
  });

  test("test reports failures with exit 1", async () => {
    const sandbox = makeSandbox();
    const server = serve([{ id: "x" }], { status: 500 });
    sandbox.run(
      [
        "add",
        "openai-compatible",
        "--id",
        "broken",
        "--base-url",
        server.url,
        "--key-mode",
        "env",
        "--yes",
      ],
    );
    const result = await sandbox.runAsync(["test", "broken"]);
    expect(result.status).toBe(1);
    expect(result.text).toContain("FAIL");
  });

  test("validate rejects schema errors and malformed JSONC", () => {
    const sandbox = makeSandbox();
    mkdirSync(join(sandbox.configPath, ".."), { recursive: true });
    writeFileSync(sandbox.configPath, '{ "model": 123 }\n');
    const schema = sandbox.run(["validate"]);
    expect(schema.status).toBe(1);
    expect(schema.text).toContain("/model");

    writeFileSync(sandbox.configPath, '{ "model": \n');
    const malformed = sandbox.run(["validate"]);
    expect(malformed.status).toBe(1);
    expect(malformed.text).toContain("not valid JSONC");
  });
});

describe("backup, restore, disable, remove, doctor", () => {
  test("backup dry-run writes nothing; restore restores config; auth backups are 600", () => {
    const sandbox = makeSandbox();
    sandbox.run(["add", "openrouter", "--key-mode", "env", "--env-var", "OPENROUTER_API_KEY", "--yes"]);
    const original = readFileSync(sandbox.configPath, "utf8");
    rmSync(sandbox.backupsDir, { recursive: true, force: true });

    const dry = sandbox.run(["backup", "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.text).toContain("would back up");
    expect(existsSync(sandbox.backupsDir)).toBe(false);

    const created = sandbox.run(["backup", "--target", "config"]);
    expect(created.status).toBe(0);
    expect(created.text).toContain("Backup:");

    writeFileSync(sandbox.configPath, '{\n  "model": "changed/model"\n}\n');
    const restored = sandbox.run(["restore", "--target", "config", "--latest", "--yes"]);
    expect(restored.status).toBe(0);
    expect(readFileSync(sandbox.configPath, "utf8")).toBe(original);

    sandbox.run(["key", "openrouter", "--mode", "auth", "--key-stdin", "--yes"], {
      input: `${KEY}\n`,
    });
    const authBackup = sandbox.run(["backup", "--target", "auth"]);
    expect(authBackup.status).toBe(0);
    const backups = sandbox.run(["backup", "--list"]);
    expect(backups.text).toContain("auth.json.");
    for (const line of backups.stdout.split("\n").filter((entry) => entry.startsWith("auth.json."))) {
      const name = line.split(/\s+/)[0];
      expect(statSync(join(sandbox.backupsDir, name)).mode & 0o777).toBe(0o600);
    }
  });

  test("disable and enable manage disabled_providers", () => {
    const sandbox = makeSandbox();
    sandbox.run(["add", "openrouter", "--key-mode", "env", "--env-var", "OPENROUTER_API_KEY", "--yes"]);
    const disabled = sandbox.run(["disable", "openrouter", "--yes"]);
    expect(disabled.status).toBe(0);
    expect(readFileSync(sandbox.configPath, "utf8")).toContain('"disabled_providers"');
    expect(sandbox.run(["list"]).text).toContain("disabled");

    const enabled = sandbox.run(["enable", "openrouter", "--yes"]);
    expect(enabled.status).toBe(0);
    const list = sandbox.run(["list"]);
    expect(list.text).not.toContain("disabled");
  });

  test("remove cleans config, auth, and dangling defaults", async () => {
    const sandbox = makeSandbox();
    const server = serve();
    sandbox.run(
      [
        "add",
        "openai-compatible",
        "--id",
        "mockprov",
        "--base-url",
        server.url,
        "--key-mode",
        "auth",
        "--key-stdin",
        "--yes",
      ],
      { input: `${KEY}\n` },
    );
    const models = await sandbox.runAsync(["models", "mockprov", "--all", "--yes"]);
    expect(models.status).toBe(0);
    sandbox.run(["default", "--model", "mockprov/alpha-1", "--yes"]);
    expect(readFileSync(sandbox.configPath, "utf8")).toContain("mockprov/alpha-1");

    const removed = sandbox.run(["remove", "mockprov", "--yes"]);
    expect(removed.status).toBe(0);
    const config = readFileSync(sandbox.configPath, "utf8");
    expect(config).not.toContain("mockprov");
    expect(config).not.toContain('"model"');
    expect(config).not.toContain('"small_model"');
    expect(JSON.parse(readFileSync(sandbox.authPath, "utf8"))).toEqual({});
    expect(existsSync(sandbox.backupsDir)).toBe(true);
  });

  test("remove deletes managed file-mode keys but leaves external keys", () => {
    const sandbox = makeSandbox();
    sandbox.run(["add", "openrouter", "--key-mode", "file", "--key-stdin", "--yes"], {
      input: `${KEY}\n`,
    });
    const managed = join(sandbox.configHome, "opencode", "secrets", "openrouter.key");
    expect(existsSync(managed)).toBe(true);
    const removed = sandbox.run(["remove", "openrouter", "--yes"]);
    expect(removed.status).toBe(0);
    expect(existsSync(managed)).toBe(false);

    const external = join(sandbox.root, "external.key");
    writeFileSync(external, `${KEY}\n`, { mode: 0o600 });
    chmodSync(external, 0o600);
    const added = sandbox.run(
      [
        "add",
        "openai-compatible",
        "--id",
        "external",
        "--base-url",
        "http://127.0.0.1:1/v1",
        "--key-mode",
        "file",
        "--file",
        external,
        "--key-stdin",
        "--yes",
      ],
      { input: `${KEY}\n` },
    );
    expect(added.status).toBe(0);
    const removedExternal = sandbox.run(["remove", "external", "--yes"]);
    expect(removedExternal.status).toBe(0);
    expect(removedExternal.text).toContain("Left external key file untouched");
    expect(existsSync(external)).toBe(true);
  });

  test("remove keeps a managed key file shared with another provider", () => {
    const sandbox = makeSandbox();
    const shared = join(sandbox.configHome, "opencode", "secrets", "shared.key");
    for (const id of ["one", "two"]) {
      const result = sandbox.run(
        [
          "add",
          "openai-compatible",
          "--id",
          id,
          "--base-url",
          "http://127.0.0.1:1/v1",
          "--key-mode",
          "file",
          "--file",
          shared,
          "--key-stdin",
          "--yes",
        ],
        { input: `${KEY}\n` },
      );
      expect(result.status).toBe(0);
    }
    const removed = sandbox.run(["remove", "one", "--yes"]);
    expect(removed.status).toBe(0);
    expect(removed.text).toContain("shared with another provider");
    expect(existsSync(shared)).toBe(true);
  });

  test("doctor succeeds on a healthy setup and fails on auth permissions", () => {
    const sandbox = makeSandbox();
    sandbox.run(["add", "openrouter", "--key-mode", "auth", "--key-stdin", "--yes"], {
      input: `${KEY}\n`,
    });
    const healthy = sandbox.run(["doctor"]);
    expect(healthy.status).toBe(0);
    expect(healthy.text).toContain("0 failure");

    chmodSync(sandbox.authPath, 0o644);
    const bad = sandbox.run(["doctor"]);
    expect(bad.status).toBe(1);
    expect(bad.text).toContain("accessible by group/others");
  });
});

describe("project inline-key safety", () => {
  test("offers/adds the config to .gitignore and chmods 600", () => {
    const sandbox = makeSandbox();
    const repo = join(sandbox.root, "repo");
    mkdirSync(repo, { recursive: true });
    expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
    const result = sandbox.run(
      [
        "add",
        "openrouter",
        "--project",
        "--key-mode",
        "inline",
        "--key-stdin",
        "--add-to-gitignore",
        "--yes",
      ],
      { cwd: repo, input: `${KEY}\n` },
    );
    expect(result.status).toBe(0);
    const configPath = join(repo, "opencode.jsonc");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toContain("opencode.jsonc");
    const ignored = spawnSync("git", ["check-ignore", "-q", "opencode.jsonc"], { cwd: repo });
    expect(ignored.status).toBe(0);
    expect(result.text).toContain("gitignored");
    expect(result.text).toContain(".gitignore");
  });

  test("warns but does not add .gitignore without the flag", () => {
    const sandbox = makeSandbox();
    const repo = join(sandbox.root, "repo2");
    mkdirSync(repo, { recursive: true });
    expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
    const result = sandbox.run(
      ["add", "openrouter", "--project", "--key-mode", "inline", "--key-stdin", "--yes"],
      { cwd: repo, input: `${KEY}\n` },
    );
    expect(result.status).toBe(0);
    expect(result.text).toContain("NOT gitignored");
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
  });
});
