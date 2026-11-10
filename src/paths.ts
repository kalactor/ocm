import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type Env = Record<string, string | undefined>;

export interface PathOptions {
  /** Explicit --config path. */
  config?: string;
  /** Explicit --auth path. */
  auth?: string;
  /** Use the project config in cwd instead of the XDG global config. */
  project?: boolean;
  cwd?: string;
  env?: Env;
}

export type ConfigSource = "override" | "project" | "global";

export interface OcmPaths {
  config: string;
  auth: string;
  backups: string;
  configSource: ConfigSource;
  configIsProject: boolean;
  /** The other config filename that exists in the same directory, if both exist. */
  alternateConfig?: string;
  configExists: boolean;
  authExists: boolean;
  xdgConfigHome: string;
  xdgDataHome: string;
  xdgStateHome: string;
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

export function xdgConfigHome(env: Env = process.env): string {
  return nonEmpty(env.XDG_CONFIG_HOME) && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : join(env.HOME || homedir(), ".config");
}

export function xdgDataHome(env: Env = process.env): string {
  return nonEmpty(env.XDG_DATA_HOME) && isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : join(env.HOME || homedir(), ".local", "share");
}

export function xdgStateHome(env: Env = process.env): string {
  return nonEmpty(env.XDG_STATE_HOME) && isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : join(env.HOME || homedir(), ".local", "state");
}

export function expandHome(input: string, env: Env = process.env): string {
  if (input === "~") return env.HOME || homedir();
  if (input.startsWith("~/")) return join(env.HOME || homedir(), input.slice(2));
  return input;
}

export function resolveUserPath(input: string, cwd: string, env: Env = process.env): string {
  const expanded = expandHome(input, env);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/** OpenCode accepts both; .jsonc wins when both are present. */
export function pickConfigFile(dir: string): { path: string; alternate?: string } {
  const jsonc = join(dir, "opencode.jsonc");
  const json = join(dir, "opencode.json");
  if (existsSync(jsonc)) return { path: jsonc, ...(existsSync(json) ? { alternate: json } : {}) };
  if (existsSync(json)) return { path: json };
  return { path: jsonc };
}

export function globalConfigPath(env: Env = process.env): string {
  return pickConfigFile(join(xdgConfigHome(env), "opencode")).path;
}

export function projectConfigPath(cwd = process.cwd()): string {
  return pickConfigFile(cwd).path;
}

export function resolvePaths(options: PathOptions = {}): OcmPaths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const xdgConfig = xdgConfigHome(env);
  const xdgData = xdgDataHome(env);
  const xdgState = xdgStateHome(env);

  let config: string;
  let configSource: ConfigSource;
  let alternateConfig: string | undefined;

  if (options.config) {
    config = resolveUserPath(options.config, cwd, env);
    configSource = "override";
  } else if (options.project) {
    const picked = pickConfigFile(cwd);
    config = picked.path;
    alternateConfig = picked.alternate;
    configSource = "project";
  } else {
    const picked = pickConfigFile(join(xdgConfig, "opencode"));
    config = picked.path;
    alternateConfig = picked.alternate;
    configSource = "global";
  }

  const auth = options.auth
    ? resolveUserPath(options.auth, cwd, env)
    : join(xdgData, "opencode", "auth.json");

  return {
    config,
    auth,
    backups: join(xdgState, "ocm", "backups"),
    configSource,
    configIsProject: configSource === "project",
    alternateConfig,
    configExists: existsSync(config),
    authExists: existsSync(auth),
    xdgConfigHome: xdgConfig,
    xdgDataHome: xdgData,
    xdgStateHome: xdgState,
  };
}

export function configDir(paths: OcmPaths): string {
  return resolve(paths.config, "..");
}

/** Default absolute location for file-mode secrets. Kept out of project checkouts. */
export function managedSecretsDir(env: Env = process.env): string {
  return join(xdgConfigHome(env), "opencode", "secrets");
}

export function managedSecretFile(providerId: string, env: Env = process.env): string {
  return join(managedSecretsDir(env), `${providerId}.key`);
}
