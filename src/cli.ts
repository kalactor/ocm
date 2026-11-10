import { cac } from "cac";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ConfigError,
  applyConfigEdits,
  formatParseErrors,
  isPlainObject,
  minimalConfigText,
  parseConfigText,
  readConfig,
  type ConfigFile,
} from "./config";
import {
  OAuthEntryError,
  getAuthApiKey,
  getAuthEntry,
  parseAuthText,
  readAuth,
  removeAnyAuthEntryFromText,
  type AuthFile,
} from "./auth";
import {
  applyChanges,
  backupFile,
  checkPermissions,
  chmodConfigForInlineKey,
  ensureFileMode,
  listBackups,
  readBackup,
  type FileChange,
} from "./backup";
import {
  defaultEnvVar,
  detectKeyMode,
  parseFileRef,
  planKeyMode,
  resolveSecret,
  resolveSecretPath,
  type KeyMode,
  type KeyModePlan,
} from "./keymodes";
import {
  DEFAULT_BASE_URLS,
  LOCAL_PRESETS,
  PRESETS,
  addModelsToConfig,
  addProviderToConfig,
  allConfiguredModels,
  apiKeyOverrideWarning,
  configuredModels,
  configuredProviderIds,
  fetchProviderModels,
  isDisabled,
  providerKeyDetail,
  providerRows,
  removeProviderFromConfig,
  resolveBaseURL,
  setDefaultModels,
  setDisabledProvider,
  validateProviderId,
  type ProviderRow,
  type ProviderSpec,
} from "./providers";
import { managedSecretsDir, resolvePaths, resolveUserPath, type Env, type OcmPaths } from "./paths";
import {
  askConfirm,
  askMultiSelect,
  askPassword,
  askSelect,
  askText,
  fail,
  heading,
  info,
  isInteractive,
  maskKey,
  print,
  success,
  warn,
  UserCancelled,
} from "./ui";
import { formatIssues, validateConfig, validateConfigData, validateModelReference } from "./validate";
import bashCompletion from "../completions/ocm.bash" with { type: "text" };
import zshCompletion from "../completions/_ocm" with { type: "text" };

const VERSION = "0.1.0";
const MODES: KeyMode[] = ["auth", "env", "file", "inline"];

interface Ctx {
  paths: OcmPaths;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  env: Env;
}

type Opts = Record<string, unknown>;

function makeCtx(options: Opts = {}): Ctx {
  const env = process.env;
  const paths = resolvePaths({
    ...(typeof options.config === "string" ? { config: options.config } : {}),
    ...(typeof options.auth === "string" ? { auth: options.auth } : {}),
    project: Boolean(options.project),
    cwd: process.cwd(),
    env,
  });
  return {
    paths,
    dryRun: Boolean(options.dryRun),
    yes: Boolean(options.yes),
    json: Boolean(options.json),
    env,
  };
}

async function guard(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof UserCancelled) return;
    fail(error instanceof Error ? error.message : String(error));
    if (process.env.OCM_DEBUG && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  }
}

function loadConfigOrThrow(path: string): ConfigFile {
  const config = readConfig(path);
  if (config.errors.length > 0) {
    throw new ConfigError(`Invalid config (${path}):\n${formatParseErrors(config.errors)}`);
  }
  return config;
}

function loadAuthOrThrow(path: string): AuthFile {
  return readAuth(path);
}

function readPair(ctx: Ctx): { config: ConfigFile; auth: AuthFile } {
  return {
    config: loadConfigOrThrow(ctx.paths.config),
    auth: loadAuthOrThrow(ctx.paths.auth),
  };
}

function withConfigText(config: ConfigFile, text: string): ConfigFile {
  const parsed = parseConfigText(text);
  return { ...config, exists: true, text, data: parsed.data, errors: [] };
}

async function allowConfigCreation(ctx: Ctx, config: ConfigFile): Promise<void> {
  if (config.exists) return;
  if (ctx.dryRun || ctx.yes) {
    info(`Config not found; ${ctx.dryRun ? "would create" : "creating"} ${ctx.paths.config}`);
    return;
  }
  if (!isInteractive()) {
    throw new Error(`Config not found: ${ctx.paths.config}\nPass --yes to create a minimal config.`);
  }
  const ok = await askConfirm(`Config not found at ${ctx.paths.config}. Create a minimal one?`, true);
  if (!ok) throw new UserCancelled("No changes made.");
}

function configChange(config: ConfigFile, after: string | null, mode?: number): FileChange | undefined {
  const before = config.exists ? config.text : null;
  if (before === after && mode === undefined) return undefined;
  return { path: config.path, before, after, kind: "config", ...(mode ? { mode } : {}), label: "config" };
}

function authChange(auth: AuthFile, after: string | null): FileChange | undefined {
  const before = auth.exists ? auth.text : null;
  if (before === after) return undefined;
  return { path: auth.path, before, after, kind: "auth", label: "auth" };
}

function apply(ctx: Ctx, changes: FileChange[]): void {
  const filtered = changes.filter((change): change is FileChange => change !== undefined);
  if (filtered.length === 0) {
    info("No changes.");
    return;
  }
  const result = applyChanges(filtered, {
    backupsDir: ctx.paths.backups,
    dryRun: ctx.dryRun,
    print: true,
  });
  if (!ctx.dryRun) {
    for (const backup of result.backups) success(`Backup: ${backup}`);
    for (const path of result.written) success(`Wrote: ${path}`);
  }
}

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) warn(warning);
}

function printNotes(notes: string[]): void {
  for (const note of notes) info(note);
}

function warnSharedAuth(ctx: Ctx, plan: KeyModePlan): void {
  if (ctx.paths.configIsProject && plan.auth.before !== plan.auth.after) {
    warn(
      "auth.json is shared across projects; this project operation changed it. " +
        "Use env/file/inline mode if the project should not touch shared credentials.",
    );
  }
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => normalizeList(item));
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizeArgs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => String(item).split(",")).map((s) => s.trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function isMode(value: unknown): value is KeyMode {
  return typeof value === "string" && MODES.includes(value as KeyMode);
}

function readKeyFromOptions(options: Opts): string | undefined {
  const wantStdin = Boolean(options.keyStdin);
  const keyFile = typeof options.keyFile === "string" ? options.keyFile : undefined;
  if (wantStdin && keyFile) throw new Error("Use only one of --key-stdin and --key-file.");
  if (wantStdin) {
    if (process.stdin.isTTY) {
      throw new Error("--key-stdin expects piped input. Omit it to be prompted, or use --key-file.");
    }
    const value = readFileSync(0, "utf8").trim();
    if (!value) throw new Error("No key received on stdin.");
    return value;
  }
  if (keyFile) {
    const path = resolveUserPath(keyFile, process.cwd(), process.env);
    const value = readFileSync(path, "utf8").trim();
    if (!value) throw new Error(`Key file is empty: ${path}`);
    return value;
  }
  return undefined;
}

function needsKey(target: KeyMode): boolean {
  return target === "auth" || target === "inline" || target === "file";
}

function noKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no API key|not set|does not exist|is empty|A non-empty API key|cannot read key file/i.test(message);
}

async function buildKeyPlan(
  ctx: Ctx,
  config: ConfigFile,
  auth: AuthFile,
  providerId: string,
  target: KeyMode,
  options: Opts,
  configBeforeText?: string | null,
): Promise<KeyModePlan> {
  const provided = readKeyFromOptions(options);
  const filePath =
    typeof options.file === "string"
      ? resolveUserPath(options.file, process.cwd(), ctx.env)
      : undefined;
  let force = Boolean(options.force);
  const attempt = (key: string | undefined, forceValue: boolean) =>
    planKeyMode({
      config,
      auth,
      providerId,
      target,
      ...(key !== undefined ? { key } : {}),
      ...(typeof options.envVar === "string" ? { envVar: options.envVar } : {}),
      ...(filePath ? { filePath } : {}),
      force: forceValue,
      env: ctx.env,
      ...(configBeforeText !== undefined ? { configBeforeText } : {}),
    });

  try {
    return attempt(provided, force);
  } catch (error) {
    if (error instanceof OAuthEntryError && isInteractive() && !force) {
      const replace = await askConfirm("Replace existing OAuth credentials for this provider?", false);
      if (!replace) throw new UserCancelled("Kept OAuth credentials.");
      force = true;
      return attempt(provided, force);
    }
    if (isInteractive() && provided === undefined && needsKey(target) && noKeyError(error)) {
      const prompted = (await askPassword(`API key for ${providerId} (hidden)`)).trim();
      if (!prompted) throw new Error("A non-empty API key is required.");
      return attempt(prompted, force);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Git safety for inline keys
// ---------------------------------------------------------------------------

function git(dir: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: (result.stdout ?? "").trim() };
}

function findGitRepo(dir: string): string | undefined {
  const result = git(dir, ["rev-parse", "--show-toplevel"]);
  return result.status === 0 && result.stdout ? result.stdout : undefined;
}

function isGitIgnored(repo: string, path: string): boolean {
  return git(repo, ["check-ignore", "-q", "--", path]).status === 0;
}

function isGitTracked(repo: string, path: string): boolean {
  return git(repo, ["ls-files", "--error-unmatch", "--", path]).status === 0;
}

function appendGitignore(repo: string, configPath: string): FileChange | undefined {
  const rel = relative(repo, configPath);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) return undefined;
  const gitignore = join(repo, ".gitignore");
  const before = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : null;
  const pattern = `/${rel.split(sep).join("/")}`;
  const lines = (before ?? "").split(/\r?\n/);
  if (lines.includes(pattern) || lines.includes(rel.split(sep).join("/"))) return undefined;
  const eol = before?.includes("\r\n") ? "\r\n" : "\n";
  const prefix = before && before.length > 0 && !before.endsWith("\n") ? eol : "";
  const after = `${before ?? ""}${prefix}# added by ocm: OpenCode config contains an inline API key${eol}${pattern}${eol}`;
  return { path: gitignore, before, after, kind: "gitignore", label: "gitignore" };
}

async function inlineSafety(
  ctx: Ctx,
  plan: KeyModePlan,
  options: Opts,
): Promise<FileChange[]> {
  if (!plan.inlineValue) return [];
  const extra: FileChange[] = [];
  const configChange = plan.changes.find((change) => change.kind === "config");
  const perms = checkPermissions(ctx.paths.config);
  warn("Inline API keys are stored as plaintext in the config file.");

  if (options.chmodConfig === false) {
    warn("Leaving config permissions unchanged (--no-chmod-config).");
    if (configChange) configChange.mode = undefined;
  } else {
    let chmod = true;
    if (perms.exists && (perms.mode ?? 0) !== 0o600) {
      if (isInteractive() && options.chmodConfig === undefined) {
        chmod = await askConfirm(`Restrict ${ctx.paths.config} to mode 600?`, true);
      }
      if (!chmod) {
        warn("Config remains readable by other users; run chmod 600 when convenient.");
      }
    }
    if (chmod) {
      if (configChange) configChange.mode = 0o600;
      if (!ctx.dryRun && !configChange) {
        const changed = chmodConfigForInlineKey(ctx.paths.config, false);
        if (changed) info(`chmod 600 ${ctx.paths.config}`);
      }
    } else if (configChange) {
      configChange.mode = undefined;
    }
  }

  const repo = findGitRepo(dirname(ctx.paths.config));
  if (!repo) return extra;
  if (isGitIgnored(repo, ctx.paths.config)) return extra;
  warn(`Config is inside git repository ${repo} and is NOT gitignored.`);
  if (isGitTracked(repo, ctx.paths.config)) {
    warn("The config is already tracked by git. A .gitignore entry will not untrack it; use `git rm --cached`.");
  }
  let add = options.addToGitignore === true;
  if (!add && options.addToGitignore === undefined && isInteractive()) {
    add = await askConfirm("Append the config path to .gitignore?", true);
  }
  if (add) {
    const change = appendGitignore(repo, ctx.paths.config);
    if (change) {
      extra.push(change);
      info("Added the config path to .gitignore.");
    }
  } else {
    warn("Not added to .gitignore. Use --add-to-gitignore or add it manually.");
  }
  return extra;
}

function checkOverrideWarning(providerId: string, mode: KeyMode): void {
  const reason = apiKeyOverrideWarning(providerId);
  if (reason && mode !== "auth" && mode !== "none") {
    warn(`OpenCode may ignore options.apiKey for "${providerId}": ${reason}.`);
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function modeCell(row: ProviderRow): string {
  const detail = providerKeyDetail(row);
  if (row.mode === "env" && row.detail) return `env (${row.detail})`;
  if (row.mode === "file" && row.detail) return `file (${row.detail})`;
  if (row.mode === "auth" && row.authType && row.authType !== "api") return `auth (${row.authType})`;
  if (row.mode === "none" && row.authType) return `none (${row.authType})`;
  return detail;
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, index) => (cell ?? "").padEnd(widths[index])).join("  ").trimEnd();
  print(line(headers));
  print(widths.map((width) => "─".repeat(width)).join("  "));
  for (const row of rows) print(line(row));
}

async function cmdList(options: Opts): Promise<void> {
  const ctx = makeCtx(options);
  const config = loadConfigOrThrow(ctx.paths.config);
  const auth = loadAuthOrThrow(ctx.paths.auth);
  const model = typeof config.data.model === "string" ? config.data.model : undefined;
  const smallModel = typeof config.data.small_model === "string" ? config.data.small_model : undefined;
  const rows = providerRows(config.data, auth, ctx.env, {
    ...(model ? { model } : {}),
    ...(smallModel ? { smallModel } : {}),
    configPath: ctx.paths.config,
  });

  if (ctx.json) {
    print(
      JSON.stringify(
        {
          config: ctx.paths.config,
          auth: ctx.paths.auth,
          configExists: config.exists,
          defaultModel: model ?? null,
          smallModel: smallModel ?? null,
          providers: rows.map((row) => ({
            id: row.id,
            mode: row.mode,
            key: row.maskedKey,
            detail: row.detail ?? null,
            modelCount: row.modelCount,
            defaultModel: row.defaultModel ?? null,
            smallModel: row.smallModel ?? null,
            disabled: row.disabled,
            duplicateKey: row.duplicate,
            overrideWarning: row.overrideWarning ?? null,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!config.exists) warn(`Config not found: ${ctx.paths.config}`);
  if (!auth.exists) info(`No auth file yet: ${ctx.paths.auth}`);
  if (rows.length === 0) {
    info("No providers configured. Try `ocm add openrouter` or `ocm add openai-compatible`.");
    return;
  }
  printTable(
    ["PROVIDER", "MODE", "KEY", "MODELS", "STATE"],
    rows.map((row) => [
      row.id,
      modeCell(row),
      row.maskedKey,
      String(row.modelCount),
      [
        row.disabled ? "disabled" : "enabled",
        row.defaultModel ? "default" : "",
        row.smallModel ? "small" : "",
        row.duplicate ? "DUPLICATE KEY" : "",
      ]
        .filter(Boolean)
        .join(", "),
    ]),
  );
  print("");
  print(`default model: ${model ?? "(not set)"}`);
  print(`small model:   ${smallModel ?? "(not set)"}`);
  for (const row of rows) {
    if (row.duplicate) fail(`${row.id}: an API key exists in both auth.json and config`);
    if (row.overrideWarning) warn(`${row.id}: ${row.overrideWarning}`);
  }
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

async function promptProviderFromRows(message: string): Promise<string | undefined> {
  const ctx = makeCtx({});
  const config = loadConfigOrThrow(ctx.paths.config);
  const auth = loadAuthOrThrow(ctx.paths.auth);
  const rows = providerRows(config.data, auth, ctx.env, { configPath: ctx.paths.config });
  if (rows.length === 0) return undefined;
  return askSelect(
    message,
    rows.map((row) => ({ value: row.id, label: row.id, hint: modeCell(row) })),
  );
}

async function cmdAdd(presetArg: string | undefined, options: Opts): Promise<void> {
  const ctx = makeCtx(options);
  let presetName = presetArg;
  if (!presetName) {
    if (!isInteractive()) {
      throw new Error("Preset required in non-interactive mode: openrouter, openai-compatible, or local.");
    }
    presetName = await askSelect("Provider preset", [
      { value: "openrouter", label: "OpenRouter", hint: "built-in provider" },
      { value: "openai-compatible", label: "OpenAI-compatible (custom)", hint: "name + base URL" },
      { value: "local", label: "Local (Ollama / llama.cpp)", hint: "no key" },
    ]);
  }
  if (!(presetName in PRESETS)) {
    throw new Error(`Unknown preset "${presetName}". Use openrouter, openai-compatible, or local.`);
  }

  let spec: ProviderSpec;
  let defaultMode: KeyMode;
  if (presetName === "openrouter") {
    const preset = PRESETS.openrouter;
    spec = {
      id: typeof options.id === "string" ? options.id : preset.id,
      name: typeof options.name === "string" ? options.name : preset.name,
      baseURL:
        typeof options.baseUrl === "string"
          ? options.baseUrl
          : preset.baseURL,
    };
    defaultMode = "auth";
  } else if (presetName === "local") {
    let kind = typeof options.local === "string" ? options.local : undefined;
    if (!kind) {
      if (isInteractive()) {
        kind = await askSelect("Local server", [
          { value: "ollama", label: "Ollama", hint: "http://127.0.0.1:11434/v1" },
          { value: "llama.cpp", label: "llama.cpp / llama-server", hint: "http://127.0.0.1:8080/v1" },
        ]);
      } else {
        kind = "ollama";
      }
    }
    const preset = LOCAL_PRESETS[kind];
    if (!preset) throw new Error(`Unknown local kind "${kind}". Use ollama or llama.cpp.`);
    spec = {
      id: typeof options.id === "string" ? options.id : preset.id,
      name: typeof options.name === "string" ? options.name : preset.name,
      npm: preset.npm,
      baseURL:
        typeof options.baseUrl === "string"
          ? options.baseUrl
          : preset.baseURL,
    };
    defaultMode = "none";
  } else {
    let id = typeof options.id === "string" ? options.id : undefined;
    let name = typeof options.name === "string" ? options.name : undefined;
    let baseURL = typeof options.baseUrl === "string" ? options.baseUrl : undefined;
    if (!id) {
      if (!isInteractive()) throw new Error("--id is required for openai-compatible.");
      id = await askText({ message: "Provider id (e.g. myprovider)", placeholder: "myprovider" });
    }
    if (!name) {
      if (isInteractive()) {
        name = await askText({ message: "Display name", defaultValue: id });
      } else {
        name = id;
      }
    }
    if (!baseURL) {
      if (!isInteractive()) throw new Error("--base-url is required for openai-compatible.");
      baseURL = await askText({
        message: "Base URL (OpenAI-compatible endpoint)",
        placeholder: "https://api.example.com/v1",
      });
    }
    spec = { id, name, baseURL, npm: "@ai-sdk/openai-compatible" };
    defaultMode = "auth";
  }

  const idIssue = validateProviderId(spec.id);
  if (idIssue) throw new Error(`Invalid provider id: ${idIssue}`);
  if (spec.baseURL) {
    try {
      const url = new URL(spec.baseURL);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      throw new Error(`Invalid --base-url: ${spec.baseURL}`);
    }
    spec.baseURL = spec.baseURL.replace(/\/+$/, "");
  }

  let target: KeyMode;
  if (isMode(options.keyMode)) {
    target = options.keyMode;
  } else if (options.keyMode !== undefined) {
    throw new Error(`Invalid --key-mode. Use ${MODES.join(", ")}.`);
  } else if (defaultMode === "none") {
    target = "none";
  } else if (isInteractive()) {
    target = await askSelect("Where should the API key live?", [
      { value: "auth", label: "auth.json", hint: "recommended" },
      { value: "env", label: "environment variable", hint: "config stores {env:VAR}" },
      { value: "file", label: "key file", hint: "config stores {file:/path}" },
      { value: "inline", label: "inline in config", hint: "plaintext, less safe" },
    ]);
  } else {
    throw new Error("--key-mode is required in non-interactive mode (auth, env, file, inline).");
  }

  const config = loadConfigOrThrow(ctx.paths.config);
  const auth = loadAuthOrThrow(ctx.paths.auth);
  await allowConfigCreation(ctx, config);

  const existing = configuredProviderIds(config.data).includes(spec.id);
  if (existing && !ctx.yes) {
    if (!isInteractive()) {
      throw new Error(`Provider "${spec.id}" already exists. Pass --yes to update it.`);
    }
    const ok = await askConfirm(`Provider "${spec.id}" already exists. Update it?`, true);
    if (!ok) throw new UserCancelled("No changes.");
  }

  const added = addProviderToConfig(config, spec);
  const updatedConfig = withConfigText(config, added.text);
  const before = config.exists ? config.text : null;

  let changes: FileChange[] = [];
  let plan: KeyModePlan | undefined;
  if (target === "none") {
    const change = configChange(config, added.text);
    if (change) changes.push(change);
    if (target === "none" && options.keyMode === undefined) {
      // local provider: no key is expected
    }
  } else {
    plan = await buildKeyPlan(ctx, updatedConfig, auth, spec.id, target, options, before);
    changes = [...plan.changes];
    printWarnings(plan.warnings);
    warnSharedAuth(ctx, plan);
    printNotes(plan.notes);
    checkOverrideWarning(spec.id, target);
    changes.push(...(await inlineSafety(ctx, plan, options)));
  }

  if (!ctx.dryRun && target === "env") {
    const envVar = typeof options.envVar === "string" ? options.envVar : defaultEnvVar(spec.id);
    if (!ctx.env[envVar]) {
      warn(`Set ${envVar} in your shell before starting OpenCode.`);
    }
  }

  apply(ctx, changes);
  if (!ctx.dryRun) {
    success(`${added.created ? "Added" : "Updated"} provider "${spec.id}" in ${ctx.paths.config}`);
    const envVar = typeof options.envVar === "string" ? options.envVar : defaultEnvVar(spec.id);
    if (target === "env") {
      success(`Key mode: env (${envVar})`);
      info(`Config now references {env:${envVar}}.`);
    } else if (target !== "none") {
      success(`Key mode: ${target}${plan?.sourceMask && !plan.sourceMask.startsWith("(none") ? ` (${plan.sourceMask})` : ""}`);
    }
    if (spec.npm) info(`Next: ocm models ${spec.id} to add models.`);
  }
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

/** Delete only key files ocm manages and that no surviving provider still uses. */
function managedKeyFileChanges(
  config: ConfigFile,
  removedIds: string[],
  ctx: Ctx,
  warnings: string[],
): FileChange[] {
  // Project configs share the global auth/secret area; leave files alone there.
  if (ctx.paths.configIsProject) return [];
  const providersData = config.data.provider;
  if (!isPlainObject(providersData)) return [];
  const removed = new Set(removedIds);
  const refFor = (id: string): string | undefined => {
    const entry = providersData[id];
    if (!isPlainObject(entry) || !isPlainObject(entry.options)) return undefined;
    const apiKey = entry.options.apiKey;
    return typeof apiKey === "string" ? parseFileRef(apiKey) : undefined;
  };

  const keep = new Set<string>();
  for (const id of Object.keys(providersData)) {
    if (removed.has(id)) continue;
    const ref = refFor(id);
    if (ref) keep.add(resolveSecretPath(config.path, ref, ctx.env));
  }

  const managedDir = managedSecretsDir(ctx.env);
  const changes: FileChange[] = [];
  const seen = new Set<string>();
  for (const id of removed) {
    const ref = refFor(id);
    if (!ref) continue;
    const path = resolveSecretPath(config.path, ref, ctx.env);
    if (seen.has(path)) continue;
    seen.add(path);
    const rel = relative(managedDir, path);
    const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    if (!inside) {
      warnings.push(`Left external key file untouched: ${path}`);
      continue;
    }
    if (keep.has(path)) {
      warnings.push(`Left key file shared with another provider: ${path}`);
      continue;
    }
    if (!existsSync(path)) continue;
    try {
      changes.push({
        path,
        before: readFileSync(path, "utf8"),
        after: null,
        kind: "secret",
        label: "key file",
      });
    } catch (error) {
      warnings.push(
        `Could not read key file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return changes;
}

async function cmdRemove(providersArg: unknown, options: Opts): Promise<void> {
  const ctx = makeCtx(options);
  let providers = normalizeArgs(providersArg);
  const config = loadConfigOrThrow(ctx.paths.config);
  const auth = loadAuthOrThrow(ctx.paths.auth);
  if (providers.length === 0) {
    if (!isInteractive()) throw new Error("Provider id required.");
    const ids = new Set([
      ...configuredProviderIds(config.data),
      ...Object.keys(auth.data).map((id) => id.replace(/\/+$/, "")),
    ]);
    if (ids.size === 0) throw new Error("No providers to remove.");
    providers = await askMultiSelect(
      "Remove providers",
      [...ids].sort().map((id) => ({ value: id, label: id })),
      undefined,
      true,
    );
  }
  if (!ctx.yes) {
    if (!isInteractive()) throw new Error("Pass --yes to remove providers in non-interactive mode.");
    const ok = await askConfirm(`Remove ${providers.join(", ")}? This deletes their config and auth entries.`, false);
    if (!ok) throw new UserCancelled("No changes.");
  }

  let configText = config.text;
  let authText = auth.text;
  let configChanged = false;
  let authChanged = false;
  const removed: string[] = [];
  const removedFromConfig = new Set<string>();
  const warnings: string[] = [];
  for (const id of providers) {
    let current = withConfigText(config, configText);
    if (config.exists) {
      const result = removeProviderFromConfig(current, id);
      if (result.text !== configText) {
        configText = result.text;
        configChanged = true;
      }
      if (result.removedProvider || result.removedDisabled) removed.push(id);
      if (result.removedProvider) removedFromConfig.add(id);
    }
    current = withConfigText(config, configText);
    if (auth.exists) {
      const result = removeAnyAuthEntryFromText(authText, id);
      if (result.text !== authText) {
        authText = result.text;
        authChanged = true;
      }
      if (result.removed) removed.push(id);
      if (result.preservedType && result.preservedType !== "api") {
        warnings.push(`Removed OAuth credentials for ${id}.`);
      }
    }
  }

  if (removedFromConfig.size > 0) {
    const parsed = parseConfigText(configText);
    const cleared: string[] = [];
    const edits: { path: (string | number)[]; value: undefined }[] = [];
    for (const field of ["model", "small_model"] as const) {
      const value = parsed.data[field];
      if (typeof value !== "string") continue;
      const provider = value.slice(0, value.indexOf("/"));
      if (removedFromConfig.has(provider)) {
        edits.push({ path: [field], value: undefined });
        cleared.push(value);
      }
    }
    if (edits.length > 0) {
      configText = applyConfigEdits(configText, edits);
      configChanged = true;
      warnings.push(`Cleared default model reference(s): ${[...new Set(cleared)].join(", ")}`);
    }
  }

  const changes: FileChange[] = [];
  if (configChanged) {
    const change = configChange(config, configText);
    if (change) changes.push(change);
  }
  if (authChanged) changes.push(authChange(auth, authText) as FileChange);
  changes.push(...managedKeyFileChanges(config, providers, ctx, warnings));
  printWarnings(warnings);
  if (ctx.paths.configIsProject && authChanged) {
    warn("auth.json is shared across projects; this remove changed it.");
  }
  if (changes.length === 0) {
    info(`Provider${providers.length > 1 ? "s" : ""} not found: ${providers.join(", ")}`);
    return;
  }
  apply(ctx, changes);
  if (!ctx.dryRun) success(`Removed ${[...new Set(removed)].join(", ")}`);
}

// ---------------------------------------------------------------------------
// key
// ---------------------------------------------------------------------------

async function cmdKey(providerArg: string | undefined, options: Opts): Promise<void> {
  const ctx = makeCtx(options);
  let providerId = providerArg;
  if (!providerId) {
    if (!isInteractive()) throw new Error("Provider id required.");
    providerId = await promptProviderFromRows("Provider");
    if (!providerId) throw new Error("No providers configured.");
  }
  providerId = providerId.trim().replace(/\/+$/, "");
  const config = loadConfigOrThrow(ctx.paths.config);
  const auth = loadAuthOrThrow(ctx.paths.auth);
  const known =
    configuredProviderIds(config.data).includes(providerId) ||
    Boolean(getAuthEntry(auth.data, providerId)) ||
    providerId in DEFAULT_BASE_URLS ||
    providerId in PRESETS ||
    providerId in LOCAL_PRESETS;
  if (!known) {
    throw new Error(`Unknown provider "${providerId}". Add it first with ocm add.`);
  }

  let target: KeyMode;
  if (isMode(options.mode)) target = options.mode;
  else if (options.mode !== undefined) throw new Error(`Invalid --mode. Use ${MODES.join(", ")}.`);
  else if (isInteractive()) {
    const state = detectKeyMode(config.data as never, auth.data, providerId);
    target = await askSelect(
      "Key storage mode",
      [
        { value: "auth", label: "auth", hint: "auth.json (recommended)" },
        { value: "env", label: "env", hint: "config stores {env:VAR}" },
        { value: "file", label: "file", hint: "config stores {file:/path}" },
        { value: "inline", label: "inline", hint: "plaintext in config" },
      ],
      state.mode === "none" ? "auth" : (state.mode as "auth" | "env" | "file" | "inline"),
    );
  } else {
    throw new Error("--mode is required in non-interactive mode.");
  }

  if (target !== "auth") await allowConfigCreation(ctx, config);
  const state = detectKeyMode(config.data as never, auth.data, providerId);
  const plan = await buildKeyPlan(ctx, config, auth, providerId, target, options);
  if (!ctx.dryRun && !ctx.yes && plan.changes.length > 0 && !isInteractive()) {
    throw new Error("Pass --yes to change a provider's key storage mode in non-interactive mode.");
  }
  printWarnings(plan.warnings);
  warnSharedAuth(ctx, plan);
  printNotes(plan.notes);
  checkOverrideWarning(providerId, target);
  const extra = await inlineSafety(ctx, plan, options);
  const changes = [...plan.changes, ...extra];
  apply(ctx, changes);
  if (!ctx.dryRun) {
    if (target === "auth" && plan.changes.length === 0) {
      ensureFileMode(ctx.paths.auth, 0o600);
    }
    if (plan.changes.length === 0 && target === "inline") {
      if (options.chmodConfig !== false) chmodConfigForInlineKey(ctx.paths.config, false);
      success(`Provider ${providerId} already uses inline mode.`);
    } else {
      success(`Provider ${providerId}: key mode ${state.mode} -> ${target}`);
    }
    if (plan.sourceMask !== "(none)" && plan.sourceMask !== "(none — resolved from env)") {
      info(`Key: ${plan.sourceMask}`);
    }
  }
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

async function resolveProviderKey(
  ctx: Ctx,
  config: ConfigFile,
  auth: AuthFile,
  providerId: string,
): Promise<{ key?: string; error?: string }> {
  const state = detectKeyMode(config.data as never, auth.data, providerId);
  const resolved = resolveSecret({
    configPath: ctx.paths.config,
    providerId,
    state,
    auth,
    env: ctx.env,
  });
  if (resolved.key) return { key: resolved.key };
  const entry = getAuthEntry(auth.data, providerId);
  if (entry?.entry.type === "oauth" && typeof entry.entry.access === "string") {
    return { key: entry.entry.access };
  }
  return { error: resolved.error ?? "no key available" };
}

async function cmdModels(providerArg: string | undefined, options: Opts): Promise<void> {
  const ctx = makeCtx(options);
  const config = loadConfigOrThrow(ctx.paths.config);
  const auth = loadAuthOrThrow(ctx.paths.auth);
  if (!config.exists) throw new Error(`Config not found: ${ctx.paths.config}`);
  let providerId = providerArg;
  if (!providerId) {
    if (!isInteractive()) throw new Error("Provider id required.");
    const rows = providerRows(config.data, auth, ctx.env, { configPath: ctx.paths.config });
    if (rows.length === 0) throw new Error("No providers configured.");
    providerId = await askSelect(
      "Fetch models for",
      rows.map((row) => ({ value: row.id, label: row.id, hint: modeCell(row) })),
    );
  }
  providerId = providerId.trim().replace(/\/+$/, "");
  if (!configuredProviderIds(config.data).includes(providerId)) {
    throw new Error(`Provider "${providerId}" is not configured. Run ocm add first.`);
  }
  const baseURL = resolveBaseURL(config.data, providerId);
  if (!baseURL) {
    throw new Error(`No baseURL for "${providerId}". Add options.baseURL to the config first.`);
  }
  const selectedRaw = normalizeList(options.models);
  const selectAll = Boolean(options.all || options.selectAll);
  const deselectAll = Boolean(options.deselectAll);
  if (selectAll && deselectAll) {
    throw new Error("Use only one of --select-all/--all and --deselect-all.");
  }
  if ((selectAll || deselectAll) && selectedRaw.length > 0) {
    throw new Error("Use --models or --select-all/--deselect-all, not both.");
  }
  if (deselectAll) {
    info("No models selected.");
    return;
  }

  const key = await resolveProviderKey(ctx, config, auth, providerId);
  if (key.error) warn(`No usable key (${key.error}); trying /models unauthenticated.`);
  info(`GET ${baseURL}/models`);
  const result = await fetchProviderModels({
    baseURL,
    providerId,
    ...(key.key ? { apiKey: key.key } : {}),
    timeoutMs: typeof options.timeout === "string" ? Number(options.timeout) : undefined,
  });
  if (!result.ok) {
    throw new Error(`Model list failed for ${providerId}: ${result.error ?? `HTTP ${result.status}`}`);
  }
  if (result.models.length === 0) throw new Error("The server returned no models.");

  const allIds = result.models.map((model) => model.id);

  let selected: string[];
  if (selectAll) {
    selected = allIds;
  } else if (selectedRaw.length > 0) {
    selected = selectedRaw;
    const available = new Set(allIds);
    const unknown = selected.filter((id) => !available.has(id));
    if (unknown.length) warn(`Not returned by /models: ${unknown.join(", ")}`);
  } else if (isInteractive()) {
    const existing = new Set(configuredModels(config.data, providerId));
    const existingIds = result.models.filter((model) => existing.has(model.id)).map((model) => model.id);
    const preset = await askSelect(
      "Model selection",
      [
        { value: "current", label: "Keep current selection", hint: `${existingIds.length} configured` },
        { value: "all", label: `Start with all selected`, hint: `${allIds.length} models` },
        { value: "none", label: "Start with none selected" },
      ],
      existingIds.length > 0 ? "current" : "none",
    );
    const initial = preset === "all" ? allIds : preset === "none" ? [] : existingIds;
    info("In the picker: space toggles, a selects/deselects all, i inverts.");
    selected = await askMultiSelect(
      `Models to add from ${providerId}`,
      result.models.map((model) => ({
        value: model.id,
        label: model.id,
        ...(model.name ? { hint: model.name } : {}),
      })),
      initial,
      false,
    );
  } else {
    throw new Error("Pass --models id1,id2, --select-all, or --deselect-all in non-interactive mode.");
  }
  if (selected.length === 0) {
    info("No models selected.");
    return;
  }
  const chosen = result.models.filter((model) => selected.includes(model.id));
  for (const id of selected) {
    if (!chosen.some((model) => model.id === id)) chosen.push({ id, name: id });
  }
  const updated = addModelsToConfig(config, providerId, chosen, { force: Boolean(options.force) });
  if (updated.added.length === 0) {
    info(`No new models (already configured: ${updated.skipped.join(", ")}).`);
    return;
  }
  apply(ctx, [configChange(config, updated.text) as FileChange]);
  if (!ctx.dryRun) {
    success(`Added ${updated.added.length} model${updated.added.length === 1 ? "" : "s"} to ${providerId}.`);
    if (updated.skipped.length) info(`Skipped existing: ${updated.skipped.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// default
// ---------------------------------------------------------------------------

async function cmdDefault(options: Opts): Promise<void> {
  const ctx = makeCtx(options);
  const config = loadConfigOrThrow(ctx.paths.config);
  if (!config.exists) throw new Error(`Config not found: ${ctx.paths.config}`);
  const models = allConfiguredModels(config.data);
  const current = typeof config.data.model === "string" ? config.data.model : undefined;
  const currentSmall = typeof config.data.small_model === "string" ? config.data.small_model : undefined;

  let model = typeof options.model === "string" ? options.model : undefined;
  let smallModel = typeof options.smallModel === "string" ? options.smallModel : undefined;
  if (model === undefined && smallModel === undefined) {
    if (!isInteractive()) throw new Error("Pass --model and/or --small-model.");
    if (models.length === 0) {
      throw new Error("No models configured. Run `ocm models <provider>` first.");
    }
    model = await askSelect(
      "Default model",
      models.map((entry) => ({ value: `${entry.provider}/${entry.model}`, label: entry.label })),
      current && models.some((entry) => `${entry.provider}/${entry.model}` === current) ? current : undefined,
    );
    const same = "__same__";
    const choice = await askSelect(
      "Small model",
      [
        { value: same, label: `Same as model (${model})` },
        ...models.map((entry) => ({ value: `${entry.provider}/${entry.model}`, label: entry.label })),
      ],
      currentSmall && models.some((entry) => `${entry.provider}/${entry.model}` === currentSmall)
        ? currentSmall
        : same,
    );
    smallModel = choice === same ? model : choice;
  } else if (model !== undefined && smallModel === undefined) {
    smallModel = model;
  }

  for (const [label, value] of [
    ["model", model],
    ["small_model", smallModel],
  ] as const) {
    if (value === undefined) continue;
    const issue = validateModelReference(value);
    if (issue) throw new Error(`${label}: ${issue}`);
    const provider = value.slice(0, value.indexOf("/"));
    const known =
      configuredProviderIds(config.data).includes(provider) ||
      provider in DEFAULT_BASE_URLS ||
      provider in PRESETS;
    if (!known) throw new Error(`${label}: provider "${provider}" is not configured`);
  }

  const updated = setDefaultModels(config, {
    ...(model !== undefined ? { model } : {}),
    ...(smallModel !== undefined ? { smallModel } : {}),
  });
  apply(ctx, [configChange(config, updated.text) as FileChange]);
  if (!ctx.dryRun) {
    if (model) success(`model = ${model}`);
    if (smallModel) success(`small_model = ${smallModel}`);
  }
}

// ---------------------------------------------------------------------------
// disable / enable
// ---------------------------------------------------------------------------

async function cmdDisableEnable(providersArg: unknown, options: Opts, disabled: boolean): Promise<void> {
  const ctx = makeCtx(options);
  let providers = normalizeArgs(providersArg);
  const config = loadConfigOrThrow(ctx.paths.config);
  if (!config.exists) throw new Error(`Config not found: ${ctx.paths.config}`);
  if (providers.length === 0) {
    if (!isInteractive()) throw new Error(`Provider id required.`);
    const current = new Set(
      Array.isArray(config.data.disabled_providers)
        ? config.data.disabled_providers.filter((id): id is string => typeof id === "string")
        : [],
    );
    const ids = disabled
      ? configuredProviderIds(config.data).filter((id) => !current.has(id))
      : [...current];
    if (ids.length === 0) {
      info(disabled ? "No enabled providers to disable." : "No disabled providers.");
      return;
    }
    providers = await askMultiSelect(
      disabled ? "Disable providers" : "Enable providers",
      ids.sort().map((id) => ({ value: id, label: id })),
      undefined,
      true,
    );
  }
  let text = config.text;
  const changed: string[] = [];
  for (const id of providers) {
    const current = withConfigText(config, text);
    const result = setDisabledProvider(current, id, disabled);
    if (result.changed) {
      text = result.text;
      changed.push(id);
    }
  }
  if (changed.length === 0) {
    info(`No changes; ${providers.join(", ")} already ${disabled ? "disabled" : "enabled"}.`);
    return;
  }
  apply(ctx, [configChange(config, text) as FileChange]);
  if (!ctx.dryRun) {
    success(`${disabled ? "Disabled" : "Enabled"} ${changed.join(", ")}`);
    if (!disabled) {
      const enabled = config.data.enabled_providers;
      if (Array.isArray(enabled)) {
        for (const id of changed) {
          if (!enabled.includes(id)) warn(`enabled_providers is set and does not include ${id}; it may stay hidden.`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

async function cmdTest(providerArg: string | undefined, options: Opts): Promise<void> {
  const ctx = makeCtx(options);
  const config = loadConfigOrThrow(ctx.paths.config);
  const auth = loadAuthOrThrow(ctx.paths.auth);
  let providerId = providerArg;
  if (!providerId) {
    if (!isInteractive()) throw new Error("Provider id required.");
    providerId = await promptProviderFromRows("Test provider");
    if (!providerId) throw new Error("No providers configured.");
  }
  providerId = providerId.trim().replace(/\/+$/, "");
  const baseURL = resolveBaseURL(config.data, providerId);
  if (!baseURL) throw new Error(`No baseURL for "${providerId}" and no known default.`);
  const key = await resolveProviderKey(ctx, config, auth, providerId);
  if (key.error) warn(`No usable key (${key.error}); request will be unauthenticated.`);
  const result = await fetchProviderModels({
    baseURL,
    providerId,
    ...(key.key ? { apiKey: key.key } : {}),
    timeoutMs: typeof options.timeout === "string" ? Number(options.timeout) : undefined,
  });
  if (ctx.json) {
    print(
      JSON.stringify(
        {
          provider: providerId,
          url: `${baseURL}/models`,
          ok: result.ok,
          status: result.status,
          modelCount: result.models.length,
          ...(result.error && !result.ok ? { error: result.error } : {}),
        },
        null,
        2,
      ),
    );
  } else if (result.ok) {
    success(`OK ${result.status} — ${providerId}: ${result.models.length} model${result.models.length === 1 ? "" : "s"}`);
  } else {
    fail(`FAIL ${result.error ?? "request failed"} — ${providerId}`);
  }
  if (!result.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// validate / doctor
// ---------------------------------------------------------------------------

async function cmdValidate(options: Opts): Promise<void> {
  const ctx = makeCtx(options);
  const config = readConfig(ctx.paths.config);
  if (!config.exists) {
    fail(`Config not found: ${ctx.paths.config}`);
    process.exitCode = 1;
    return;
  }
  if (config.errors.length > 0) {
    fail("Config is not valid JSONC:");
    for (const line of formatParseErrors(config.errors).split("\n")) print(`  ${line}`);
    process.exitCode = 1;
    return;
  }
  const report = validateConfig(config.data, config.text);
  if (ctx.json) {
    print(
      JSON.stringify(
        {
          config: ctx.paths.config,
          valid: report.schemaErrors.length === 0,
          errors: report.schemaErrors,
          warnings: report.warnings,
        },
        null,
        2,
      ),
    );
  } else if (report.schemaErrors.length === 0) {
    success(`Config is valid against ${configSchemaLabel()}`);
    for (const warning of report.warnings) warn(warning);
  } else {
    fail(`Schema validation failed: ${report.schemaErrors.length} error(s)`);
    for (const line of formatIssues(report.schemaErrors)) print(`  ${line}`);
    for (const warning of report.warnings) warn(warning);
  }
  if (report.schemaErrors.length > 0) process.exitCode = 1;
}

function configSchemaLabel(): string {
  return "the cached OpenCode schema";
}

interface DoctorCheck {
  level: "ok" | "warn" | "fail";
  message: string;
}

function nearestExisting(path: string): string | undefined {
  let current = path;
  while (true) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function opencodeMajor(): number | undefined {
  try {
    const result = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 3000 });
    if (result.status !== 0) return undefined;
    const match = /(?:^|\s)v?(\d+)\.\d+\.\d+/.exec((result.stdout ?? "").trim());
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

async function cmdDoctor(options: Opts): Promise<void> {
  const ctx = makeCtx(options);
  const checks: DoctorCheck[] = [];
  const add = (level: DoctorCheck["level"], message: string) => checks.push({ level, message });

  const config = readConfig(ctx.paths.config);
  if (!config.exists) {
    add("warn", `Config not found: ${ctx.paths.config} (ocm will offer to create it on add/key)`);
  } else {
    if (config.errors.length > 0) {
      add("fail", `Config is not valid JSONC: ${formatParseErrors(config.errors)}`);
    } else {
      add("ok", `Config parses: ${ctx.paths.config}${config.mode !== undefined ? ` (${config.mode.toString(8)})` : ""}`);
      const report = validateConfig(config.data, config.text);
      if (report.schemaErrors.length > 0) {
        for (const issue of report.schemaErrors) {
          add("fail", `Schema: ${issue.path}: ${issue.message} [${issue.keyword}]`);
        }
      } else {
        add("ok", "Config matches the cached OpenCode schema");
      }
      for (const warning of report.warnings) add("warn", warning);
    }
    if (ctx.paths.alternateConfig) {
      add("warn", `Both .jsonc and .json exist; OpenCode/ocm prefer ${ctx.paths.config}`);
    }
  }

  const auth = (() => {
    try {
      return { ok: true as const, value: readAuth(ctx.paths.auth) };
    } catch (error) {
      add("fail", `auth.json: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false as const };
    }
  })();
  if (auth.ok) {
    if (!auth.value.exists) {
      add("warn", `auth.json not found: ${ctx.paths.auth} (fine if you use env/file/inline keys)`);
    } else {
      const perms = checkPermissions(ctx.paths.auth);
      if (perms.mode === 0o600) add("ok", `auth.json permissions are 600`);
      else if (perms.worldReadable) add("fail", `auth.json is accessible by group/others (${perms.mode?.toString(8)}); run chmod 600`);
      else add("warn", `auth.json mode is ${perms.mode?.toString(8)}, expected 600`);
      const issues = await import("./auth").then((m) => m.validateAuthData(auth.value.data));
      for (const issue of issues) add("fail", `auth.json: ${issue}`);
    }
  }

  if (config.exists && auth.ok) {
    const rows = providerRows(config.data, auth.value, ctx.env, {
      configPath: ctx.paths.config,
      ...(typeof config.data.model === "string" ? { model: config.data.model } : {}),
      ...(typeof config.data.small_model === "string" ? { smallModel: config.data.small_model } : {}),
    });
    for (const row of rows) {
      if (row.duplicate) add("fail", `${row.id}: API key exists in both auth.json and config`);
      if (row.overrideWarning && row.mode !== "auth" && row.mode !== "none") {
        add("warn", `${row.id}: ${row.overrideWarning}`);
      }
      if (row.mode === "env") {
        const name = row.detail ?? defaultEnvVar(row.id);
        if (!ctx.env[name]) add("warn", `${row.id}: {env:${name}} is not set in this shell`);
      }
      if (row.mode === "file" && row.detail) {
        const path = resolveSecretPath(ctx.paths.config, row.detail, ctx.env);
        if (!existsSync(path)) add("fail", `${row.id}: key file does not exist: ${path}`);
        else {
          const perms = checkPermissions(path);
          if (perms.worldReadable) add("warn", `${row.id}: key file is readable by others: ${path}`);
          else add("ok", `${row.id}: key file exists: ${path}`);
        }
      }
      if (row.mode === "inline") {
        add("warn", `${row.id}: inline key is plaintext in the config`);
        const perms = checkPermissions(ctx.paths.config);
        if (perms.mode !== 0o600) {
          add("warn", `${row.id}: config with an inline key is mode ${perms.mode?.toString(8)}, expected 600`);
        }
      }
    }

    const inlineRows = rows.filter((row) => row.mode === "inline");
    if (inlineRows.length > 0 && config.exists) {
      const repo = findGitRepo(dirname(ctx.paths.config));
      if (repo) {
        const ignored = isGitIgnored(repo, ctx.paths.config);
        if (!ignored) {
          add(
            "fail",
            `Inline key in a config inside git repo ${repo} that is not gitignored (add with: ocm key ${inlineRows[0].id} --mode inline --add-to-gitignore)`,
          );
        } else {
          add("ok", `Config with inline key is gitignored (${repo})`);
        }
        if (isGitTracked(repo, ctx.paths.config)) {
          add("fail", "Config with inline key is tracked by git; remove it from the index with git rm --cached");
        }
      }
    }
  }

  const backupsParent = nearestExisting(ctx.paths.backups);
  if (existsSync(ctx.paths.backups)) {
    try {
      accessSync(ctx.paths.backups, constants.W_OK);
      add("ok", `Backups directory is writable: ${ctx.paths.backups}`);
    } catch {
      add("fail", `Backups directory is not writable: ${ctx.paths.backups}`);
    }
  } else if (backupsParent) {
    try {
      accessSync(backupsParent, constants.W_OK);
      add("ok", `Backups directory will be created under ${backupsParent}`);
    } catch {
      add("fail", `Cannot create backups directory under ${backupsParent}`);
    }
  } else {
    add("warn", `Backups directory does not exist yet: ${ctx.paths.backups}`);
  }

  if (auth.ok && auth.value.exists) {
    const authBackups = listBackups(ctx.paths.backups, basename(ctx.paths.auth));
    const latest = authBackups.at(-1);
    if (latest) {
      const perms = checkPermissions(latest.path);
      if (perms.worldReadable) add("fail", `Latest auth backup is readable by others: ${latest.path}`);
      else add("ok", `Latest auth backup permissions are 600`);
    }
  }

  const major = opencodeMajor();
  if (major !== undefined && major >= 2 && auth.ok && auth.value.exists) {
    add(
      "warn",
      "Installed OpenCode is v2+, which imports auth.json into its database once. ocm edits auth.json for v1 compatibility; use /connect for v2-native credentials.",
    );
  }

  if (ctx.json) {
    print(JSON.stringify({ config: ctx.paths.config, auth: ctx.paths.auth, checks }, null, 2));
  } else {
    heading("ocm doctor");
    for (const check of checks) {
      const symbol = check.level === "ok" ? "✔" : check.level === "warn" ? "!" : "✖";
      print(`${symbol} ${check.message}`);
    }
    const failures = checks.filter((check) => check.level === "fail").length;
    const warnings = checks.filter((check) => check.level === "warn").length;
    print("");
    print(`${checks.length - failures - warnings} ok, ${warnings} warning(s), ${failures} failure(s)`);
  }
  if (checks.some((check) => check.level === "fail")) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// backup / restore
// ---------------------------------------------------------------------------

function hasAnyInlineKey(config: ConfigFile): boolean {
  const provider = config.data.provider;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return false;
  for (const value of Object.values(provider)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const options = (value as Record<string, unknown>).options;
    if (!options || typeof options !== "object" || Array.isArray(options)) continue;
    const key = (options as Record<string, unknown>).apiKey;
    if (typeof key === "string" && !key.startsWith("{env:") && !key.startsWith("{file:")) return true;
  }
  return false;
}

function backupTargets(options: Opts): { config: boolean; auth: boolean } {
  const target = options.target;
  if (target === undefined) return { config: true, auth: true };
  if (target === "config") return { config: true, auth: false };
  if (target === "auth") return { config: false, auth: true };
  throw new Error(`Invalid --target. Use config or auth.`);
}

async function cmdBackup(options: Opts): Promise<void> {
  const ctx = makeCtx(options);
  if (options.list) {
    const targets = backupTargets(options);
    const all = [
      ...(targets.config ? listBackups(ctx.paths.backups, basename(ctx.paths.config)) : []),
      ...(targets.auth ? listBackups(ctx.paths.backups, basename(ctx.paths.auth)) : []),
    ].sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    if (all.length === 0) {
      info("No backups.");
      return;
    }
    for (const backup of all) {
      print(`${backup.name}  ${backup.size} bytes  ${new Date(backup.mtime).toISOString()}`);
    }
    return;
  }
  const targets = backupTargets(options);
  const config = targets.config ? loadConfigOrThrow(ctx.paths.config) : undefined;
  const auth = targets.auth ? loadAuthOrThrow(ctx.paths.auth) : undefined;
  if (ctx.dryRun) {
    let planned = 0;
    if (targets.config && config?.exists) {
      print(`would back up: ${ctx.paths.config}`);
      planned++;
    }
    if (targets.auth && auth?.exists) {
      print(`would back up: ${ctx.paths.auth}`);
      planned++;
    }
    if (planned === 0) info("Nothing to back up.");
    return;
  }
  const created: string[] = [];
  if (targets.config && config?.exists) {
    const path = backupFile(ctx.paths.config, ctx.paths.backups, {
      ...(hasAnyInlineKey(config) ? { mode: 0o600 } : {}),
    });
    if (path) created.push(path);
  }
  if (targets.auth && auth?.exists) {
    const path = backupFile(ctx.paths.auth, ctx.paths.backups, { mode: 0o600 });
    if (path) created.push(path);
  }
  if (created.length === 0) {
    info("Nothing to back up.");
    return;
  }
  for (const path of created) success(`Backup: ${path}`);
}

async function cmdRestore(nameArg: string | undefined, options: Opts): Promise<void> {
  const ctx = makeCtx(options);
  const targetOption = options.target;
  if (targetOption !== undefined && targetOption !== "config" && targetOption !== "auth") {
    throw new Error("Invalid --target. Use config or auth.");
  }
  let target: "config" | "auth" | undefined = targetOption;
  let name = nameArg ?? (typeof options.file === "string" ? options.file : undefined);

  const configName = basename(ctx.paths.config);
  const authName = basename(ctx.paths.auth);
  if (!target && name) {
    if (name.startsWith(`${configName}.`)) target = "config";
    else if (name.startsWith(`${authName}.`)) target = "auth";
  }
  if (!target) {
    if (!isInteractive()) {
      throw new Error("Pass --target config|auth (and optionally --latest) in non-interactive mode.");
    }
    target = await askSelect<"config" | "auth">("Restore which file?", [
      { value: "config", label: `config (${configName})` },
      { value: "auth", label: `auth (${authName})` },
    ]);
  }
  const baseName = target === "config" ? configName : authName;
  const targetPath = target === "config" ? ctx.paths.config : ctx.paths.auth;
  const backups = listBackups(ctx.paths.backups, baseName);
  if (backups.length === 0) throw new Error(`No backups for ${baseName}.`);
  let chosen = name ? backups.find((backup) => backup.name === name) : undefined;
  if (!chosen) {
    if (name && name !== "latest" && name !== baseName) {
      throw new Error(`Backup not found: ${name}`);
    }
    if (!name && !options.latest && isInteractive()) {
      const selected = await askSelect(
        "Backup to restore",
        backups
          .slice()
          .reverse()
          .map((backup) => ({
            value: backup.name,
            label: backup.name,
            hint: new Date(backup.mtime).toISOString(),
          })),
      );
      chosen = backups.find((backup) => backup.name === selected);
    } else {
      chosen = backups.at(-1);
    }
  }
  if (!chosen) throw new Error("No backup selected.");

  const content = readBackup(ctx.paths.backups, chosen.name);
  if (target === "config") {
    const parsed = parseConfigText(content);
    if (parsed.errors.length > 0) throw new Error(`Refusing invalid backup: ${formatParseErrors(parsed.errors)}`);
  } else {
    parseAuthText(content);
  }
  if (!ctx.yes && !ctx.dryRun) {
    if (!isInteractive()) throw new Error("Pass --yes to restore in non-interactive mode.");
    const ok = await askConfirm(`Restore ${chosen.name} to ${targetPath}?`, false);
    if (!ok) throw new UserCancelled("No changes.");
  }

  const current = target === "config" ? readConfig(targetPath) : readAuth(targetPath);
  const change: FileChange = {
    path: targetPath,
    before: current.exists ? current.text : null,
    after: content,
    kind: target,
    ...(target === "auth" || (target === "config" && hasAnyInlineKey({ ...current, data: parseConfigText(content).data }))
      ? { mode: 0o600 }
      : {}),
    label: target,
  };
  apply(ctx, [change]);
  if (!ctx.dryRun) success(`Restored ${targetPath} from ${chosen.name}`);
}

// ---------------------------------------------------------------------------
// interactive menu / completion
// ---------------------------------------------------------------------------

async function cmdCompletion(shellArg: string | undefined): Promise<void> {
  let shell = shellArg?.toLowerCase();
  if (!shell) {
    shell = basename(process.env.SHELL ?? "bash").toLowerCase();
  }
  if (shell === "bash") {
    print(bashCompletion);
    return;
  }
  if (shell === "zsh") {
    print(zshCompletion);
    return;
  }
  throw new Error(`Unsupported shell "${shell}". Use bash or zsh.`);
}

async function cmdInteractive(options: Opts): Promise<void> {
  const ctx = makeCtx(options);
  if (!isInteractive()) {
    print("ocm — OpenCode config manager");
    print("Run `ocm --help` for commands, or use a command directly.");
    return;
  }
  const { intro, outro } = await import("@clack/prompts");
  intro(`ocm ${VERSION} — OpenCode config manager`);
  while (true) {
    let action: string;
    try {
      action = await askSelect("What do you want to do?", [
        { value: "list", label: "List providers" },
        { value: "add", label: "Add provider" },
        { value: "key", label: "Change key storage mode" },
        { value: "models", label: "Fetch and add models" },
        { value: "default", label: "Set default models" },
        { value: "remove", label: "Remove provider" },
        { value: "disable", label: "Disable provider" },
        { value: "enable", label: "Enable provider" },
        { value: "test", label: "Test connection" },
        { value: "validate", label: "Validate config" },
        { value: "backup", label: "Create backup / list backups" },
        { value: "restore", label: "Restore backup" },
        { value: "doctor", label: "Doctor" },
        { value: "quit", label: "Quit" },
      ]);
    } catch (error) {
      if (error instanceof UserCancelled) break;
      throw error;
    }
    if (action === "quit") break;
    try {
      switch (action) {
        case "list":
          await cmdList({ ...options });
          break;
        case "add":
          await cmdAdd(undefined, { ...options });
          break;
        case "key":
          await cmdKey(undefined, { ...options });
          break;
        case "models":
          await cmdModels(undefined, { ...options });
          break;
        case "default":
          await cmdDefault({ ...options });
          break;
        case "remove":
          await cmdRemove([], { ...options });
          break;
        case "disable":
          await cmdDisableEnable([], { ...options }, true);
          break;
        case "enable":
          await cmdDisableEnable([], { ...options }, false);
          break;
        case "test": {
          const provider = await promptProviderFromRows("Test provider");
          if (provider) await cmdTest(provider, { ...options });
          break;
        }
        case "validate":
          await cmdValidate({ ...options });
          break;
        case "backup": {
          const choice = await askSelect("Backups", [
            { value: "create", label: "Create a backup" },
            { value: "list", label: "List backups" },
          ]);
          await cmdBackup({ ...options, ...(choice === "list" ? { list: true } : {}) });
          break;
        }
        case "restore":
          await cmdRestore(undefined, { ...options });
          break;
        case "doctor":
          await cmdDoctor({ ...options });
          break;
      }
    } catch (error) {
      if (error instanceof UserCancelled) {
        info("Cancelled.");
        continue;
      }
      fail(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    print("");
  }
  outro(`Config: ${ctx.paths.config}`);
}

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

function common(command: ReturnType<typeof cac>["command"] extends (...args: never[]) => infer R ? R : never) {
  return command
    .option("--config <path>", "Use a specific config file")
    .option("--auth <path>", "Use a specific auth.json")
    .option("--project", "Use ./opencode.jsonc or ./opencode.json")
    .option("--dry-run", "Print a diff and write nothing")
    .option("-y, --yes", "Skip confirmation prompts")
    .option("--json", "Machine-readable output");
}

export async function main(argv = process.argv): Promise<void> {
  const cli = cac("ocm");
  cli.version(VERSION).help();
  cli.usage("[command] [options]");

  common(cli.command("list", "List providers, key modes, models, and defaults")).action((options) =>
    guard(() => cmdList(options)),
  );

  common(
    cli
      .command("add [preset]", "Add a provider (openrouter, openai-compatible, local)")
      .option("--id <id>", "Provider id (custom/local)")
      .option("--name <name>", "Display name")
      .option("--base-url <url>", "OpenAI-compatible base URL")
      .option("--local <kind>", "Local kind: ollama or llama.cpp")
      .option("--key-mode <mode>", "auth, env, file, or inline")
      .option("--env-var <name>", "Environment variable for env mode")
      .option("--file <path>", "Key file path for file mode")
      .option("--key-stdin", "Read the API key from stdin")
      .option("--key-file <path>", "Read the API key from this file")
      .option("--add-to-gitignore", "Add a project config with inline key to .gitignore")
      .option("--no-chmod-config", "Do not chmod 600 an inline-key config"),
  ).action((preset, options) => guard(() => cmdAdd(preset, options)));

  common(
    cli.command("remove <providers...>", "Remove provider config and credentials"),
  ).action((providers, options) => guard(() => cmdRemove(providers, options)));

  common(
    cli
      .command("key <provider>", "Set or switch a provider's API-key storage mode")
      .option("--mode <mode>", "auth, env, file, or inline")
      .option("--env-var <name>", "Environment variable for env mode")
      .option("--file <path>", "Key file path for file mode")
      .option("--key-stdin", "Read the API key from stdin")
      .option("--key-file <path>", "Read the API key from this file")
      .option("--force", "Replace existing OAuth credentials")
      .option("--add-to-gitignore", "Add a project config with inline key to .gitignore")
      .option("--no-chmod-config", "Do not chmod 600 an inline-key config"),
  ).action((provider, options) => guard(() => cmdKey(provider, options)));

  common(
    cli
      .command("models <provider>", "Fetch /models and add selected models to the config")
      .option("--models <ids>", "Comma-separated model ids")
      .option("--all", "Add every model returned by /models")
      .option("--select-all", "Select every model returned by /models")
      .option("--deselect-all", "Select no models")
      .option("--force", "Update names of already configured models")
      .option("--timeout <ms>", "Request timeout in milliseconds"),
  ).action((provider, options) => guard(() => cmdModels(provider, options)));

  common(
    cli
      .command("default", "Set model and small_model")
      .option("--model <ref>", "Default model (provider/model)")
      .option("--small-model <ref>", "Small model (provider/model)"),
  ).action((options) => guard(() => cmdDefault(options)));

  common(cli.command("disable <providers...>", "Add providers to disabled_providers")).action(
    (providers, options) => guard(() => cmdDisableEnable(providers, options, true)),
  );
  common(cli.command("enable <providers...>", "Remove providers from disabled_providers")).action(
    (providers, options) => guard(() => cmdDisableEnable(providers, options, false)),
  );

  common(
    cli
      .command("test <provider>", "GET /models and report the HTTP status")
      .option("--timeout <ms>", "Request timeout in milliseconds"),
  ).action((provider, options) => guard(() => cmdTest(provider, options)));

  common(cli.command("validate", "Validate the config against the cached schema")).action((options) =>
    guard(() => cmdValidate(options)),
  );

  common(
    cli
      .command("backup", "Back up config/auth (or list backups)")
      .option("--target <file>", "Only config or auth")
      .option("--list", "List existing backups"),
  ).action((options) => guard(() => cmdBackup(options)));

  common(
    cli
      .command("restore [name]", "Restore a config/auth backup")
      .option("--target <file>", "Restore config or auth")
      .option("--file <name>", "Exact backup filename")
      .option("--latest", "Restore the newest backup"),
  ).action((name, options) => guard(() => cmdRestore(name, options)));

  common(cli.command("doctor", "Check paths, permissions, schema, duplicates, and git safety")).action((options) =>
    guard(() => cmdDoctor(options)),
  );

  cli.command("completion [shell]", "Print bash or zsh completion").action((shell) =>
    guard(() => cmdCompletion(shell)),
  );

  cli.example("  ocm add openrouter --key-mode env --env-var OPENROUTER_API_KEY --yes");
  cli.example("  ocm key openai --mode file --file ~/.secrets/openai.key --yes");
  cli.example("  ocm models ollama --all --yes");
  cli.example("  ocm default --model openrouter/anthropic/claude-sonnet --yes");

  const args = argv.slice(2);
  if (args.length === 0) {
    if (isInteractive()) await cmdInteractive({});
    else cli.outputHelp();
    return;
  }
  const wantsHelp = args.includes("--help") || args.includes("-h");
  const wantsVersion = args.includes("--version") || args.includes("-v");
  cli.parse(argv, { run: false });
  const matched = (cli as unknown as { matchedCommand?: unknown }).matchedCommand;
  if (!matched) {
    if (!wantsHelp && !wantsVersion) {
      cli.outputHelp();
      const unknown = args.find((arg) => !arg.startsWith("-"));
      if (unknown) fail(`Unknown command: ${unknown}`);
      process.exitCode = 1;
    }
    return;
  }
  await cli.runMatchedCommand();
}

if (import.meta.main) {
  main().catch((error) => {
    if (error instanceof UserCancelled) return;
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
