import { readFileSync, statSync } from "node:fs";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { ConfigError, detectFormatting, formatParseErrors, isPlainObject, type JsonObject } from "./config";

export type AuthValue = JsonObject;

export interface AuthFile {
  path: string;
  exists: boolean;
  text: string;
  data: Record<string, AuthValue>;
  errors: ParseError[];
  mode?: number;
}

export class OAuthEntryError extends Error {
  constructor(providerId: string) {
    super(
      `Provider "${providerId}" has OAuth credentials in auth.json. ` +
        "Replace them with an API key only if you really want to log out (use --force).",
    );
    this.name = "OAuthEntryError";
  }
}

export function normalizeProviderId(id: string): string {
  return id.replace(/\/+$/, "");
}

export function parseAuthText(text: string): Record<string, AuthValue> {
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: false, disallowComments: false });
  if (errors.length > 0) throw new ConfigError(`Invalid auth.json:\n${formatParseErrors(errors)}`);
  if (!isPlainObject(parsed)) throw new ConfigError("auth.json root must be a JSON object");
  const result: Record<string, AuthValue> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (isPlainObject(value)) result[id] = value;
  }
  return result;
}

export function readAuth(path: string): AuthFile {
  let text = "";
  let exists = false;
  let mode: number | undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new ConfigError(`Auth path is not a file: ${path}`);
    text = readFileSync(path, "utf8");
    exists = true;
    mode = stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!exists) return { path, exists, text: "", data: {}, errors: [], mode };
  return { path, exists, text, data: parseAuthText(text), errors: [], mode };
}

export function emptyAuthText(eol = "\n"): string {
  return `{${eol}}${eol}`;
}

function authBaseText(text: string): string {
  return text.trim() === "" ? emptyAuthText() : text;
}

function authFormatting(text: string) {
  return detectFormatting(text);
}

/** All ids that normalize to the same provider id (e.g. "foo" and "foo/"). */
export function matchingAuthIds(data: Record<string, AuthValue>, providerId: string): string[] {
  const normalized = normalizeProviderId(providerId);
  return Object.keys(data).filter((id) => normalizeProviderId(id) === normalized);
}

export function getAuthEntry(
  data: Record<string, AuthValue>,
  providerId: string,
): { id: string; entry: AuthValue } | undefined {
  const normalized = normalizeProviderId(providerId);
  if (data[normalized]) return { id: normalized, entry: data[normalized] };
  for (const id of Object.keys(data)) {
    if (normalizeProviderId(id) === normalized) return { id, entry: data[id] };
  }
  return undefined;
}

export function getAuthApiKey(data: Record<string, AuthValue>, providerId: string): string | undefined {
  const found = getAuthEntry(data, providerId);
  if (!found || found.entry.type !== "api") return undefined;
  return typeof found.entry.key === "string" ? found.entry.key : undefined;
}

export function getAuthEntryType(data: Record<string, AuthValue>, providerId: string): string | undefined {
  const found = getAuthEntry(data, providerId);
  return typeof found?.entry.type === "string" ? found.entry.type : undefined;
}

/** Set an API key, removing normalized duplicates and preserving API metadata. */
export function setApiKeyInText(text: string, providerId: string, key: string, force = false): string {
  let current = authBaseText(text);
  const data = parseAuthText(current);
  const found = getAuthEntry(data, providerId);
  if (found && found.entry.type !== "api" && !force) throw new OAuthEntryError(providerId);

  const formatting = authFormatting(current);
  const normalized = normalizeProviderId(providerId);
  for (const id of matchingAuthIds(data, providerId)) {
    if (id !== normalized) {
      current = applyEdits(
        current,
        modify(current, [id], undefined, { formattingOptions: formatting }),
      );
    }
  }

  const previous = found?.entry.type === "api" ? found.entry : undefined;
  const value: AuthValue = { ...(previous ?? {}), type: "api", key };
  current = applyEdits(
    current,
    modify(current, [normalized], value, { formattingOptions: formatting, getInsertionIndex: (p) => p.length }),
  );
  parseAuthText(current);
  return current;
}

export interface RemoveAuthResult {
  text: string;
  removed: boolean;
  preservedType?: string;
}

/** Remove only API-key entries. OAuth/well-known entries are preserved. */
export function removeApiKeyFromText(text: string, providerId: string): RemoveAuthResult {
  let current = authBaseText(text);
  const data = parseAuthText(current);
  const found = getAuthEntry(data, providerId);
  if (!found) return { text: current, removed: false };
  if (found.entry.type !== "api") {
    return { text: current, removed: false, preservedType: String(found.entry.type) };
  }
  const formatting = authFormatting(current);
  for (const id of matchingAuthIds(data, providerId)) {
    current = applyEdits(
      current,
      modify(current, [id], undefined, { formattingOptions: formatting }),
    );
  }
  parseAuthText(current);
  return { text: current, removed: true };
}

export function removeAnyAuthEntryFromText(text: string, providerId: string): RemoveAuthResult {
  let current = authBaseText(text);
  const data = parseAuthText(current);
  const found = getAuthEntry(data, providerId);
  if (!found) return { text: current, removed: false };
  const formatting = authFormatting(current);
  for (const id of matchingAuthIds(data, providerId)) {
    current = applyEdits(
      current,
      modify(current, [id], undefined, { formattingOptions: formatting }),
    );
  }
  return { text: current, removed: true, preservedType: found.entry.type as string };
}

export function validateAuthData(data: Record<string, AuthValue>): string[] {
  const problems: string[] = [];
  for (const [id, entry] of Object.entries(data)) {
    if (typeof entry.type !== "string") {
      problems.push(`${id}: missing string "type"`);
      continue;
    }
    if (entry.type === "api") {
      if (typeof entry.key !== "string" || entry.key.length === 0) {
        problems.push(`${id}: api entry has no key`);
      }
    } else if (entry.type === "oauth") {
      for (const field of ["access", "refresh", "expires"]) {
        if (!(field in entry)) problems.push(`${id}: oauth entry is missing ${field}`);
      }
    }
  }
  return problems;
}
