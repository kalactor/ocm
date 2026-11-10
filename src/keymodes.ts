import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { applyConfigEdits, getAtPath, isPlainObject, type ConfigFile } from "./config";
import {
  getAuthApiKey,
  getAuthEntryType,
  removeApiKeyFromText,
  setApiKeyInText,
  type AuthFile,
} from "./auth";
import { managedSecretsDir } from "./paths";
import type { FileChange } from "./backup";
import { expandHome } from "./paths";
import { maskKey } from "./ui";

export type KeyMode = "auth" | "env" | "file" | "inline" | "none";

export interface KeyState {
  mode: KeyMode;
  /** Env var name for env mode. */
  envVar?: string;
  /** File path as written in config for file mode. */
  filePath?: string;
  /** Non-API auth entry (oauth/wellknown) is present. */
  authType?: string;
  /** Both config and auth hold an API key. */
  duplicate: boolean;
  /** Config field as written (never the resolved secret). */
  rawRef?: string;
}

export interface ResolvedSecret {
  key?: string;
  mode: KeyMode;
  error?: string;
}

export function defaultEnvVar(providerId: string): string {
  const safe = providerId.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return `${safe || "PROVIDER"}_API_KEY`;
}

export function parseEnvRef(value: string): string | undefined {
  const match = /^\{env:([^}]+)\}$/.exec(value);
  return match?.[1];
}

export function parseFileRef(value: string): string | undefined {
  const match = /^\{file:([^}]+)\}$/.exec(value);
  return match?.[1];
}

export function detectKeyMode(
  configData: Record<string, unknown> | undefined,
  authData: Record<string, Record<string, unknown>>,
  providerId: string,
): KeyState {
  const provider =
    configData && isPlainObject(configData.provider) && isPlainObject(configData.provider[providerId])
      ? configData.provider[providerId]
      : undefined;
  const options = provider && isPlainObject(provider.options) ? provider.options : undefined;
  const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
  const authType = getAuthEntryType(authData as never, providerId);
  const authKey = getAuthApiKey(authData as never, providerId);
  const duplicate = Boolean(apiKey) && authKey !== undefined;

  if (apiKey !== undefined) {
    const envVar = parseEnvRef(apiKey);
    if (envVar) return { mode: "env", envVar, duplicate, rawRef: apiKey };
    const filePath = parseFileRef(apiKey);
    if (filePath) return { mode: "file", filePath, duplicate, rawRef: apiKey };
    return { mode: "inline", duplicate, rawRef: apiKey, ...(authType && authType !== "api" ? { authType } : {}) };
  }
  if (authKey !== undefined) return { mode: "auth", duplicate, ...(authType ? { authType } : {}) };
  if (authType) return { mode: "none", duplicate, authType };
  return { mode: "none", duplicate };
}

export function resolveSecretPath(configPath: string, fileRef: string, env: Record<string, string | undefined>): string {
  const expanded = expandHome(fileRef, env);
  return isAbsolute(expanded) ? expanded : resolve(dirname(configPath), expanded);
}

export function resolveSecret(input: {
  configPath: string;
  providerId: string;
  state: KeyState;
  auth: AuthFile;
  env?: Record<string, string | undefined>;
}): ResolvedSecret {
  const env = input.env ?? process.env;
  if (input.state.mode === "inline") {
    const value = input.state.rawRef ?? "";
    return value ? { key: value, mode: "inline" } : { mode: "inline", error: "inline apiKey is empty" };
  }
  if (input.state.mode === "env") {
    const name = input.state.envVar ?? defaultEnvVar(input.providerId);
    const value = env[name];
    if (!value) return { mode: "env", error: `environment variable ${name} is not set` };
    return { key: value, mode: "env" };
  }
  if (input.state.mode === "file") {
    const path = resolveSecretPath(input.configPath, input.state.filePath ?? "", env);
    try {
      const value = readFileSync(path, "utf8").trim();
      if (!value) return { mode: "file", error: `key file is empty: ${path}` };
      return { key: value, mode: "file" };
    } catch {
      return { mode: "file", error: `cannot read key file: ${path}` };
    }
  }
  if (input.state.mode === "auth") {
    const value = getAuthApiKey(input.auth.data, input.providerId);
    if (!value) return { mode: "auth", error: "auth.json has no API key" };
    return { key: value, mode: "auth" };
  }
  return { mode: "none", error: "no API key is configured" };
}

export interface KeyModePlan {
  config: { path: string; before: string | null; after: string | null };
  auth: { path: string; before: string | null; after: string | null };
  keyFile?: { path: string; before: string | null; after: string | null };
  cleanupFile?: { path: string; before: string };
  changes: FileChange[];
  warnings: string[];
  notes: string[];
  inlineValue: boolean;
  sourceMask: string;
  target: KeyMode;
}

export interface PlanKeyModeInput {
  config: ConfigFile;
  auth: AuthFile;
  providerId: string;
  target: KeyMode;
  key?: string;
  envVar?: string;
  filePath?: string;
  force?: boolean;
  env?: Record<string, string | undefined>;
  /** Defaults to the managed secrets directory. */
  secretsDir?: string;
  /** Original on-disk config text, when the caller has already applied prior edits. */
  configBeforeText?: string | null;
}

function cleanKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isInside(parent: string, child: string): boolean {
  const rel = normalize(child).startsWith(normalize(parent) + sep);
  return rel || normalize(child) === normalize(parent);
}

function configModeRef(config: ConfigFile, providerId: string): string | undefined {
  const value = getAtPath(config.data, ["provider", providerId, "options", "apiKey"]);
  return typeof value === "string" ? value : undefined;
}

export function planKeyMode(input: PlanKeyModeInput): KeyModePlan {
  const env = input.env ?? process.env;
  const providerId = input.providerId.trim().replace(/\/+$/, "");
  if (!providerId) throw new Error("Provider id is required");
  const state = detectKeyMode(input.config.data as never, input.auth.data, providerId);
  const warnings: string[] = [];
  const notes: string[] = [];

  if (
    state.mode === input.target &&
    !state.duplicate &&
    input.key === undefined &&
    input.envVar === undefined &&
    input.filePath === undefined
  ) {
    const resolved = resolveSecret({
      configPath: input.config.path,
      providerId,
      state,
      auth: input.auth,
      env,
    });
    if (resolved.error && input.target !== "env") {
      throw new Error(
        `${resolved.error}. Pass --key-stdin, or switch to a mode where the key is available.`,
      );
    }
    return {
      config: {
        path: input.config.path,
        before: input.configBeforeText !== undefined
          ? input.configBeforeText
          : input.config.exists
            ? input.config.text
            : null,
        after: input.config.exists ? input.config.text : null,
      },
      auth: { path: input.auth.path, before: input.auth.exists ? input.auth.text : null, after: input.auth.exists ? input.auth.text : null },
      changes:
        input.config.exists &&
        input.configBeforeText !== undefined &&
        input.configBeforeText !== input.config.text
          ? [
              {
                path: input.config.path,
                before: input.configBeforeText,
                after: input.config.text,
                kind: "config",
                ...(input.target === "inline" ? { mode: 0o600 } : {}),
                label: "config",
              },
            ]
          : [],
      warnings: resolved.error ? [resolved.error] : [],
      notes: [`Already using ${input.target} mode.`],
      inlineValue: input.target === "inline",
      sourceMask: maskKey(resolved.key),
      target: input.target,
    };
  }

  let key = cleanKey(input.key);
  let sourceMask = "(none)";
  if (!key && input.target !== "env") {
    const resolved = resolveSecret({
      configPath: input.config.path,
      providerId,
      state,
      auth: input.auth,
      env,
    });
    if (resolved.error) {
      throw new Error(
        `${resolved.error}. Pass --key-stdin, or switch to a mode where the key is available.`,
      );
    }
    key = resolved.key;
    sourceMask = maskKey(resolved.key);
  } else if (key) {
    sourceMask = maskKey(key);
  }

  let envVar = input.envVar ?? (state.mode === "env" ? state.envVar : undefined) ?? defaultEnvVar(providerId);
  if (input.target === "env") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) {
      throw new Error(`Invalid environment variable name: ${envVar}`);
    }
    if (input.key !== undefined) {
      notes.push("env mode does not store the key; the provided value was ignored.");
    }
    if (!env[envVar]) warnings.push(`Environment variable ${envVar} is not set in this shell.`);
    if (sourceMask === "(none)") sourceMask = "(none — resolved from env)";
  }

  let keyFilePath: string | undefined;
  let keyFileBefore: string | null = null;
  let keyFileAfter: string | null = null;
  if (input.target === "file") {
    const secretsDir = input.secretsDir ?? managedSecretsDir(env);
    const requested = input.filePath?.trim();
    keyFilePath = requested
      ? isAbsolute(expandHome(requested, env))
        ? expandHome(requested, env)
        : resolve(process.cwd(), expandHome(requested, env))
      : join(secretsDir, `${providerId.replace(/[^A-Za-z0-9._-]+/g, "_")}.key`);
    try {
      keyFileBefore = readFileSync(keyFilePath, "utf8");
    } catch {
      keyFileBefore = null;
    }
    if (!key) {
      if (keyFileBefore === null) throw new Error(`Key file does not exist: ${keyFilePath}. Pass --key-stdin.`);
      key = cleanKey(keyFileBefore);
      if (!key) throw new Error(`Key file is empty: ${keyFilePath}`);
      sourceMask = maskKey(key);
    }
    keyFileAfter = `${key}\n`;
    if (keyFileBefore === keyFileAfter) keyFileAfter = keyFileBefore;
  }

  if ((input.target === "auth" || input.target === "inline") && !key) {
    throw new Error("A non-empty API key is required for this mode.");
  }

  // Config side.
  let configAfter: string | null = input.config.exists ? input.config.text : null;
  let configBefore: string | null =
    input.configBeforeText !== undefined
      ? input.configBeforeText
      : input.config.exists
        ? input.config.text
        : null;
  const existingRef = configModeRef(input.config, providerId);
  if (input.target === "auth") {
    if (existingRef !== undefined) {
      configAfter = applyConfigEdits(input.config.text, [
        { path: ["provider", providerId, "options", "apiKey"], value: undefined },
      ]);
    }
  } else {
    const value =
      input.target === "env" ? `{env:${envVar}}` : input.target === "file" ? `{file:${keyFilePath}}` : (key as string);
    if (!input.config.exists) {
      notes.push("Created a minimal OpenCode config.");
    }
    const provider = input.config.data.provider;
    if (!isPlainObject(provider) || !isPlainObject(provider[providerId])) {
      notes.push(
        `provider.${providerId} was not configured; a minimal config entry was created. If this is a custom provider, run ocm add first.`,
      );
    }
    configAfter = applyConfigEdits(input.config.text, [
      { path: ["provider", providerId, "options", "apiKey"], value },
    ]);
  }

  // Auth side.
  let authAfter: string | null = input.auth.exists ? input.auth.text : null;
  if (input.target === "auth") {
    const next = setApiKeyInText(input.auth.text, providerId, key as string, input.force);
    authAfter = next;
  } else {
    const result = removeApiKeyFromText(input.auth.text, providerId);
    if (result.preservedType) {
      warnings.push(
        `auth.json still has a ${result.preservedType} credential for ${providerId}; it was preserved because it is not an API key.`,
      );
    }
    if (result.removed || input.auth.exists) authAfter = result.text;
  }

  // Old managed file cleanup when moving away from file mode.
  let cleanupFile: { path: string; before: string } | undefined;
  if (state.mode === "file" && input.target !== "file" && state.filePath) {
    const oldPath = resolveSecretPath(input.config.path, state.filePath, env);
    if (keyFilePath && normalize(oldPath) === normalize(keyFilePath)) {
      // Rewriting the same file; keep it.
    } else if (isInside(input.secretsDir ?? managedSecretsDir(env), oldPath) && existsSync(oldPath)) {
      try {
        cleanupFile = { path: oldPath, before: readFileSync(oldPath, "utf8") };
      } catch {
        // ignore
      }
    } else if (existsSync(oldPath)) {
      warnings.push(`Left external key file untouched: ${oldPath}`);
    }
  }
  if (
    keyFilePath &&
    cleanupFile &&
    normalize(keyFilePath) === normalize(cleanupFile.path)
  ) {
    cleanupFile = undefined;
  }

  if (input.target === "inline") {
    // The caller prints the detailed plaintext/permission/git warning.
  }
  if (input.target === "file" && keyFilePath) {
    notes.push(`Key file: ${keyFilePath}`);
  }

  const changes: FileChange[] = [];
  const pushConfig = () => {
    if (configAfter !== configBefore) {
      changes.push({
        path: input.config.path,
        before: configBefore,
        after: configAfter,
        kind: "config",
        mode: input.target === "inline" ? 0o600 : undefined,
        label: "config",
      });
    }
  };
  const pushAuth = () => {
    if (authAfter !== (input.auth.exists ? input.auth.text : null)) {
      changes.push({
        path: input.auth.path,
        before: input.auth.exists ? input.auth.text : null,
        after: authAfter,
        kind: "auth",
        label: "auth",
      });
    }
  };

  if (input.target === "auth") {
    pushAuth();
    pushConfig();
  } else {
    if (keyFilePath && keyFileAfter !== keyFileBefore) {
      changes.push({
        path: keyFilePath,
        before: keyFileBefore,
        after: keyFileAfter,
        kind: "secret",
        mode: 0o600,
      });
    }
    pushConfig();
    pushAuth();
  }
  if (cleanupFile) {
    changes.push({
      path: cleanupFile.path,
      before: cleanupFile.before,
      after: null,
      kind: "secret",
      mode: 0o600,
    });
  }

  return {
    config: { path: input.config.path, before: configBefore, after: configAfter },
    auth: { path: input.auth.path, before: input.auth.exists ? input.auth.text : null, after: authAfter },
    ...(keyFilePath ? { keyFile: { path: keyFilePath, before: keyFileBefore, after: keyFileAfter } } : {}),
    ...(cleanupFile ? { cleanupFile } : {}),
    changes,
    warnings,
    notes,
    inlineValue: input.target === "inline",
    sourceMask,
    target: input.target,
  };
}
