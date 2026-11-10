import { readFileSync, statSync } from "node:fs";
import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from "jsonc-parser";

export const SCHEMA_URL = "https://opencode.ai/config.json";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type ConfigPath = (string | number)[];

export interface ConfigFile {
  path: string;
  exists: boolean;
  text: string;
  data: JsonObject;
  errors: ParseError[];
  mode?: number;
}

export interface ConfigEdit {
  path: ConfigPath;
  value: JsonValue | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function detectFormatting(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const firstIndented = text.split(/\r?\n/).find((line) => /^[ \t]+"/.test(line));
  if (firstIndented?.startsWith("\t")) {
    return { insertSpaces: false, tabSize: 1, eol };
  }
  const spaces = firstIndented?.match(/^( +)"/)?.[1].length;
  return { insertSpaces: true, tabSize: spaces && spaces > 0 ? spaces : 2, eol };
}

export function parseConfigText(text: string): { data: JsonObject; errors: ParseError[] } {
  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    return { data: isPlainObject(data) ? data : {}, errors };
  }
  if (!isPlainObject(data)) {
    throw new ConfigError("Config root must be a JSON object");
  }
  return { data, errors };
}

export function formatParseErrors(errors: ParseError[]): string {
  return errors
    .map((error) => {
      const line = error.offset >= 0 ? ` at byte ${error.offset}` : "";
      return `${parseErrorName(error.error)}${line}`;
    })
    .join("\n");
}

function parseErrorName(code: number): string {
  const names: Record<number, string> = {
    1: "Invalid symbol",
    2: "Invalid number format",
    3: "Property name expected",
    4: "Value expected",
    5: "Colon expected",
    6: "Comma expected",
    7: "Closing brace expected",
    8: "Closing bracket expected",
    9: "End of file expected",
    10: "Invalid comment token",
    11: "Invalid character escape",
    12: "Invalid unicode escape",
    13: "Invalid character",
  };
  return names[code] ?? `JSON parse error ${code}`;
}

export function readConfig(path: string): ConfigFile {
  let text = "";
  let exists = false;
  let mode: number | undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new ConfigError(`Config path is not a file: ${path}`);
    text = readFileSync(path, "utf8");
    exists = true;
    mode = stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (!exists) {
    return { path, exists, text: "", data: {}, errors: [], mode };
  }

  const { data, errors } = parseConfigText(text);
  return { path, exists, text, data, errors, mode };
}

export function minimalConfigText(eol = "\n"): string {
  return `{${eol}  "$schema": "${SCHEMA_URL}"${eol}}${eol}`;
}

/** Apply edits with jsonc-parser's modify()/applyEdits, never JSON.parse+stringify. */
export function applyConfigEdits(text: string, edits: ConfigEdit[]): string {
  let next = text;
  if (next.trim() === "") next = minimalConfigText();
  const formatting = detectFormatting(next);
  for (const edit of edits) {
    next = applyEdits(
      next,
      modify(next, edit.path, edit.value, {
        formattingOptions: formatting,
        getInsertionIndex: (properties) => properties.length,
      }),
    );
  }
  const { errors } = parseConfigText(next);
  if (errors.length > 0) {
    throw new ConfigError(`Refusing to write invalid JSONC:\n${formatParseErrors(errors)}`);
  }
  return next;
}

/** Apply raw jsonc-parser edits (used when an operation needs multiple paths). */
export function applyRawEdits(text: string, edits: ReturnType<typeof modify>[]): string {
  let next = text;
  for (const edit of edits) next = applyEdits(next, edit);
  return next;
}

export function getAtPath(data: JsonObject, path: ConfigPath): JsonValue | undefined {
  let current: JsonValue | undefined = data;
  for (const part of path) {
    if (Array.isArray(current)) {
      if (typeof part !== "number") return undefined;
      current = current[part];
    } else if (isPlainObject(current)) {
      current = current[String(part)];
    } else {
      return undefined;
    }
  }
  return current;
}

export function ensureObjectAt(data: JsonObject, path: ConfigPath): JsonObject | undefined {
  const value = getAtPath(data, path);
  return isPlainObject(value) ? value : undefined;
}

export function configHasInlineKey(data: JsonObject, providerId: string): boolean {
  const provider = ensureObjectAt(data, ["provider", providerId]);
  const options = provider && ensureObjectAt(provider, ["options"]);
  const key = options?.apiKey;
  return typeof key === "string" && !key.startsWith("{env:") && !key.startsWith("{file:");
}
