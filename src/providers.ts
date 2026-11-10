import {
  applyConfigEdits,
  getAtPath,
  isPlainObject,
  type ConfigEdit,
  type ConfigFile,
  type JsonObject,
  type JsonValue,
} from "./config";
import type { AuthFile } from "./auth";
import { getAuthEntry, getAuthEntryType } from "./auth";
import { defaultEnvVar, detectKeyMode, resolveSecret, type KeyMode } from "./keymodes";
import { maskKey } from "./ui";

export const SCHEMA_URL = "https://opencode.ai/config.json";

export interface Preset {
  id: string;
  name: string;
  npm?: string;
  baseURL?: string;
  envVar: string;
  kind: "builtin" | "custom" | "local";
}

export const PRESETS: Record<string, Preset> = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    envVar: "OPENROUTER_API_KEY",
    kind: "builtin",
  },
  "openai-compatible": {
    id: "",
    name: "",
    npm: "@ai-sdk/openai-compatible",
    envVar: "",
    kind: "custom",
  },
  local: {
    id: "ollama",
    name: "Ollama (local)",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "http://127.0.0.1:11434/v1",
    envVar: "",
    kind: "local",
  },
};

export const LOCAL_PRESETS: Record<string, Preset> = {
  ollama: {
    id: "ollama",
    name: "Ollama (local)",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "http://127.0.0.1:11434/v1",
    envVar: "",
    kind: "local",
  },
  "llama.cpp": {
    id: "llama.cpp",
    name: "llama-server (local)",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "http://127.0.0.1:8080/v1",
    envVar: "",
    kind: "local",
  },
};

export const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  cerebras: "https://api.cerebras.ai/v1",
  "google-vertex": "https://aiplatform.googleapis.com",
  ollama: "http://127.0.0.1:11434/v1",
  "llama.cpp": "http://127.0.0.1:8080/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
};

/**
 * These built-ins have a custom auth loader in OpenCode that can read auth.json
 * directly, so options.apiKey is not guaranteed to override it. Verified against
 * OpenCode v1.18.34 source (packages/opencode/src/provider/provider.ts).
 */
export const SPECIAL_AUTH_PROVIDERS: Record<string, string> = {
  gitlab: "GitLab Duo reads its token from auth.json before provider options",
  "cloudflare-ai-gateway": "Cloudflare's loader reads auth.json credentials directly",
  "cloudflare-workers-ai": "Cloudflare's loader reads auth.json credentials directly",
  "amazon-bedrock": "Bedrock's bearer-token flow reads auth.json directly",
  "sap-ai-core": "SAP AI Core's loader reads auth.json directly",
  "snowflake-cortex": "Snowflake Cortex prefers auth.json over options.apiKey",
};

export function apiKeyOverrideWarning(providerId: string): string | undefined {
  return SPECIAL_AUTH_PROVIDERS[providerId];
}

export interface ProviderRow {
  id: string;
  mode: KeyMode;
  maskedKey: string;
  detail?: string;
  authType?: string;
  modelCount: number;
  defaultModel?: string;
  smallModel?: string;
  disabled: boolean;
  duplicate: boolean;
  overrideWarning?: string;
}

export function configuredProviderIds(data: JsonObject): string[] {
  const provider = data.provider;
  return isPlainObject(provider) ? Object.keys(provider) : [];
}

export function configuredModels(data: JsonObject, providerId: string): string[] {
  const models = getAtPath(data, ["provider", providerId, "models"]);
  return isPlainObject(models) ? Object.keys(models) : [];
}

export function allConfiguredModels(data: JsonObject): { provider: string; model: string; label: string }[] {
  const provider = data.provider;
  if (!isPlainObject(provider)) return [];
  const result: { provider: string; model: string; label: string }[] = [];
  for (const [providerId, value] of Object.entries(provider)) {
    if (!isPlainObject(value) || !isPlainObject(value.models)) continue;
    for (const [modelId, model] of Object.entries(value.models)) {
      const name = isPlainObject(model) && typeof model.name === "string" ? model.name : modelId;
      result.push({ provider: providerId, model: modelId, label: `${providerId}/${modelId} — ${name}` });
    }
  }
  return result;
}

export function isDisabled(data: JsonObject, providerId: string): boolean {
  const disabled = data.disabled_providers;
  return Array.isArray(disabled) && disabled.includes(providerId);
}

export function providerRows(
  data: JsonObject,
  auth: AuthFile,
  env: Record<string, string | undefined>,
  defaults: { model?: string; smallModel?: string; configPath?: string } = {},
): ProviderRow[] {
  const ids = new Set<string>([
    ...configuredProviderIds(data),
    ...Object.keys(auth.data).map((id) => id.replace(/\/+$/, "")),
  ]);
  const rows: ProviderRow[] = [];
  for (const id of [...ids].sort()) {
    const state = detectKeyMode(data as never, auth.data, id);
    const resolved = resolveSecret({
      configPath: defaults.configPath ?? "",
      providerId: id,
      state,
      auth,
      env,
    });
    let detail: string | undefined;
    let maskedKey = "(none)";
    if (state.mode === "env") {
      detail = state.envVar ?? defaultEnvVar(id);
      maskedKey = env[detail] ? maskKey(env[detail]) : "(unset)";
    } else if (state.mode === "file") {
      detail = state.filePath;
      maskedKey = resolved.key ? maskKey(resolved.key) : "(unreadable)";
    } else if (state.mode === "inline") {
      maskedKey = maskKey(state.rawRef);
    } else if (state.mode === "auth") {
      maskedKey = maskKey(resolved.key);
    } else if (state.authType) {
      detail = state.authType;
    }
    const modelCount = configuredModels(data, id).length;
    const defaultModel = defaults.model?.startsWith(`${id}/`) ? defaults.model : undefined;
    const smallModel = defaults.smallModel?.startsWith(`${id}/`) ? defaults.smallModel : undefined;
    rows.push({
      id,
      mode: state.mode,
      maskedKey,
      ...(detail ? { detail } : {}),
      ...(state.authType ? { authType: state.authType } : {}),
      modelCount,
      ...(defaultModel ? { defaultModel } : {}),
      ...(smallModel ? { smallModel } : {}),
      disabled: isDisabled(data, id),
      duplicate: state.duplicate,
      ...(apiKeyOverrideWarning(id) ? { overrideWarning: apiKeyOverrideWarning(id) } : {}),
    });
  }
  return rows;
}

export function resolveBaseURL(data: JsonObject, providerId: string): string | undefined {
  const options = getAtPath(data, ["provider", providerId, "options"]);
  if (isPlainObject(options) && typeof options.baseURL === "string" && options.baseURL.length > 0) {
    return options.baseURL.replace(/\/+$/, "");
  }
  return DEFAULT_BASE_URLS[providerId]?.replace(/\/+$/, "");
}

export interface ProviderSpec {
  id: string;
  name: string;
  npm?: string;
  baseURL?: string;
  models?: Record<string, { name: string }>;
}

export function validateProviderId(id: string): string | undefined {
  if (!id.trim()) return "Provider id is required";
  if (/\s/.test(id)) return "Provider id must not contain whitespace";
  if (id.startsWith(".") || id.includes("..")) return "Provider id must not start with a dot or contain ..";
  if (!/^[A-Za-z0-9._/-]+$/.test(id)) return "Use letters, digits, dots, dashes, underscores, or slashes";
  return undefined;
}

/** Add a provider without replacing existing models/options. */
export function addProviderToConfig(config: ConfigFile, spec: ProviderSpec): { text: string; created: boolean } {
  const provider = getAtPath(config.data, ["provider", spec.id]);
  const exists = isPlainObject(provider);
  if (!exists) {
    const object: JsonObject = { name: spec.name };
    if (spec.npm) object.npm = spec.npm;
    if (spec.baseURL) object.options = { baseURL: spec.baseURL };
    if (spec.models && Object.keys(spec.models).length > 0) {
      object.models = Object.fromEntries(
        Object.entries(spec.models).map(([id, model]) => [id, { name: model.name } as JsonObject]),
      );
    }
    return {
      text: applyConfigEdits(config.text, [{ path: ["provider", spec.id], value: object }]),
      created: true,
    };
  }

  const edits = [
    { path: ["provider", spec.id, "name"], value: spec.name },
    ...(spec.npm ? [{ path: ["provider", spec.id, "npm"], value: spec.npm }] : []),
    ...(spec.baseURL
      ? [{ path: ["provider", spec.id, "options", "baseURL"], value: spec.baseURL }]
      : []),
  ];
  return { text: applyConfigEdits(config.text, edits), created: false };
}

export function removeProviderFromConfig(
  config: ConfigFile,
  providerId: string,
): { text: string; removedProvider: boolean; removedDisabled: boolean } {
  const edits: ConfigEdit[] = [{ path: ["provider", providerId], value: undefined }];
  const disabled = Array.isArray(config.data.disabled_providers)
    ? (config.data.disabled_providers.filter((id) => id !== providerId) as JsonValue[])
    : undefined;
  const removedDisabled = Array.isArray(config.data.disabled_providers) && disabled !== undefined &&
    disabled.length !== config.data.disabled_providers.length;
  if (removedDisabled && disabled) edits.push({ path: ["disabled_providers"], value: disabled });
  const enabledValue = config.data.enabled_providers;
  if (Array.isArray(enabledValue) && enabledValue.includes(providerId)) {
    edits.push({ path: ["enabled_providers"], value: enabledValue.filter((id) => id !== providerId) as JsonValue[] });
  }
  return {
    text: applyConfigEdits(config.text, edits),
    removedProvider: isPlainObject(getAtPath(config.data, ["provider", providerId])),
    removedDisabled,
  };
}

export function setDisabledProvider(
  config: ConfigFile,
  providerId: string,
  disabled: boolean,
): { text: string; changed: boolean } {
  const currentRaw = config.data.disabled_providers;
  const current = Array.isArray(currentRaw) ? currentRaw.filter((id): id is string => typeof id === "string") : [];
  const has = current.includes(providerId);
  if (disabled === has) return { text: config.text, changed: false };
  const next = disabled ? [...current, providerId] : current.filter((id) => id !== providerId);
  return {
    text: applyConfigEdits(config.text, [{ path: ["disabled_providers"], value: next }]),
    changed: true,
  };
}

export function addModelsToConfig(
  config: ConfigFile,
  providerId: string,
  models: { id: string; name?: string }[],
  options: { force?: boolean } = {},
): { text: string; added: string[]; skipped: string[] } {
  const provider = getAtPath(config.data, ["provider", providerId]);
  if (!isPlainObject(provider)) throw new Error(`Provider "${providerId}" is not configured. Run ocm add first.`);
  const existing = isPlainObject(provider.models) ? provider.models : {};
  const added: string[] = [];
  const skipped: string[] = [];
  let text = config.text;
  for (const model of models) {
    if (isPlainObject(existing[model.id]) && !options.force) {
      skipped.push(model.id);
      continue;
    }
    text = applyConfigEdits(text, [
      {
        path: ["provider", providerId, "models", model.id],
        value: { name: model.name?.trim() || model.id },
      },
    ]);
    added.push(model.id);
  }
  return { text, added, skipped };
}

export function setDefaultModels(
  config: ConfigFile,
  defaults: { model?: string; smallModel?: string },
): { text: string; changed: boolean } {
  const edits: { path: (string | number)[]; value: JsonObject | string }[] = [];
  if (defaults.model !== undefined) edits.push({ path: ["model"], value: defaults.model });
  if (defaults.smallModel !== undefined) edits.push({ path: ["small_model"], value: defaults.smallModel });
  if (edits.length === 0) return { text: config.text, changed: false };
  return { text: applyConfigEdits(config.text, edits), changed: true };
}

export interface PublicModel {
  id: string;
  name?: string;
}

export function parseModelsResponse(body: unknown): PublicModel[] {
  const entries = isPlainObject(body) && Array.isArray(body.data)
    ? body.data
    : isPlainObject(body) && Array.isArray(body.models)
      ? body.models
      : Array.isArray(body)
        ? body
        : [];
  const seen = new Set<string>();
  const result: PublicModel[] = [];
  for (const entry of entries) {
    let id: string | undefined;
    let name: string | undefined;
    if (typeof entry === "string") {
      id = entry;
    } else if (isPlainObject(entry)) {
      if (typeof entry.id === "string") id = entry.id;
      else if (typeof entry.name === "string") id = entry.name;
      if (typeof entry.name === "string" && entry.name !== id) name = entry.name;
      else if (typeof entry.display_name === "string") name = entry.display_name;
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, ...(name ? { name } : {}) });
  }
  return result;
}

export interface FetchModelsOptions {
  baseURL: string;
  apiKey?: string;
  providerId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface FetchModelsResult {
  ok: boolean;
  status: number;
  models: PublicModel[];
  error?: string;
}

export async function fetchProviderModels(options: FetchModelsOptions): Promise<FetchModelsResult> {
  const url = `${options.baseURL.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.apiKey) {
    if (options.providerId === "anthropic") {
      headers["x-api-key"] = options.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.authorization = `Bearer ${options.apiKey}`;
    }
  }
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) {
      return { ok: false, status: response.status, models: [], error: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as unknown;
    return { ok: true, status: response.status, models: parseModelsResponse(body) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, models: [], error: message };
  }
}

export function providerKeyDetail(row: ProviderRow): string {
  if (row.mode === "env") return row.detail ? `env:${row.detail}` : "env";
  if (row.mode === "file") return row.detail ? `file:${row.detail}` : "file";
  if (row.mode === "auth" && row.authType && row.authType !== "api") return `auth (${row.authType})`;
  if (row.mode === "none" && row.authType) return `auth (${row.authType})`;
  return row.mode;
}

export function authEntrySummary(auth: AuthFile, providerId: string): string {
  const entry = getAuthEntry(auth.data, providerId);
  const type = getAuthEntryType(auth.data, providerId);
  if (!entry) return "none";
  return type ?? "unknown";
}
