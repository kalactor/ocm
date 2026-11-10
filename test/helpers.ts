import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseAuthText, type AuthFile } from "../src/auth";
import { parseConfigText, type ConfigFile } from "../src/config";

export const CLI = join(import.meta.dir, "..", "src", "cli.ts");

export interface Sandbox {
  root: string;
  configHome: string;
  dataHome: string;
  stateHome: string;
  home: string;
  cwd: string;
  configPath: string;
  authPath: string;
  backupsDir: string;
  env: Record<string, string>;
  run: (args: string[], options?: RunOptions) => RunResult;
  runAsync: (args: string[], options?: RunOptions) => Promise<RunResult>;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  env?: Record<string, string | undefined>;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  text: string;
}

export function makeSandbox(prefix = "ocm-test-"): Sandbox {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const configHome = join(root, "config");
  const dataHome = join(root, "data");
  const stateHome = join(root, "state");
  const home = join(root, "home");
  const cwd = join(root, "work");
  for (const dir of [configHome, dataHome, stateHome, home, cwd]) {
    mkdirSync(dir, { recursive: true });
  }
  const baseEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome,
    LANG: "C.UTF-8",
  };
  const sandbox: Sandbox = {
    root,
    configHome,
    dataHome,
    stateHome,
    home,
    cwd,
    configPath: join(configHome, "opencode", "opencode.jsonc"),
    authPath: join(dataHome, "opencode", "auth.json"),
    backupsDir: join(stateHome, "ocm", "backups"),
    env: baseEnv,
    run(args, options = {}) {
      const result = spawnSync(process.execPath, [CLI, ...args], {
        cwd: options.cwd ?? cwd,
        env: { ...baseEnv, ...options.env },
        input: options.input,
        encoding: "utf8",
        timeout: 30_000,
      });
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      return {
        status: result.status ?? 1,
        stdout,
        stderr,
        text: `${stdout}${stderr}`,
      };
    },
    async runAsync(args, options = {}) {
      const spawnOptions = {
        cwd: options.cwd ?? cwd,
        env: { ...baseEnv, ...options.env } as Record<string, string>,
        stdout: "pipe" as const,
        stderr: "pipe" as const,
      };
      const proc =
        options.input !== undefined
          ? Bun.spawn([process.execPath, CLI, ...args], {
              ...spawnOptions,
              stdin: new Blob([options.input]),
            })
          : Bun.spawn([process.execPath, CLI, ...args], {
              ...spawnOptions,
              stdin: "ignore",
            });
      const [stdout, stderr, status] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { status, stdout, stderr, text: `${stdout}${stderr}` };
    },
  };
  return sandbox;
}

export function writeConfig(sandbox: Sandbox, text: string, path = sandbox.configPath): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export function writeAuth(sandbox: Sandbox, text: string, path = sandbox.authPath): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function read(path: string): string {
  return readFileSync(path, "utf8");
}

export function asConfig(path: string, text: string): ConfigFile {
  const parsed = parseConfigText(text);
  return { path, exists: existsSync(path), text, data: parsed.data, errors: parsed.errors };
}

export function asAuth(path: string, text: string): AuthFile {
  const data = text.trim() ? parseAuthText(text) : {};
  return { path, exists: existsSync(path), text, data, errors: [] };
}

export function configWithOptions(options: Record<string, unknown>): string {
  return `${JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { test: { options } } }, null, 2)}\n`;
}

export interface ModelsServer {
  url: string;
  requests: { path: string; authorization?: string }[];
  stop: () => void;
}

export function startModelsServer(
  models: { id: string; name?: string }[] = [
    { id: "alpha-1", name: "Alpha One" },
    { id: "beta-2", name: "Beta Two" },
  ],
  options: { status?: number } = {},
): ModelsServer {
  const requests: ModelsServer["requests"] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        ...(request.headers.get("authorization")
          ? { authorization: request.headers.get("authorization") ?? undefined }
          : {}),
      });
      if (options.status && options.status !== 200) {
        return new Response("nope", { status: options.status });
      }
      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: models.map((model) => ({ id: model.id, name: model.name ?? model.id })),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}
