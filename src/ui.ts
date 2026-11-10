import {
  cancel,
  confirm,
  isCancel,
  multiselect,
  password,
  select,
  text,
} from "@clack/prompts";
import { basename } from "node:path";

export class UserCancelled extends Error {
  constructor(message = "Cancelled") {
    super(message);
    this.name = "UserCancelled";
  }
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function requireInteractive(): void {
  if (!isInteractive()) {
    throw new UserCancelled(
      "This step needs an interactive terminal. Pass the corresponding flags and --yes for scripting.",
    );
  }
}

async function checked<T>(result: T | symbol): Promise<T> {
  if (isCancel(result)) {
    cancel("Cancelled");
    throw new UserCancelled();
  }
  return result as unknown as T;
}

export async function askText(options: {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  initialValue?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string> {
  requireInteractive();
  return checked<string>(
    await text({
      message: options.message,
      placeholder: options.placeholder,
      defaultValue: options.defaultValue,
      initialValue: options.initialValue,
      validate: options.validate ? (value) => options.validate!(value ?? "") : undefined,
    }),
  );
}

export async function askPassword(message: string): Promise<string> {
  requireInteractive();
  return checked<string>(await password({ message }));
}

export async function askConfirm(message: string, initialValue = true): Promise<boolean> {
  requireInteractive();
  return checked<boolean>(await confirm({ message, initialValue }));
}

export async function askSelect<T extends string>(
  message: string,
  options: { value: T; label: string; hint?: string }[],
  initialValue?: T,
): Promise<T> {
  requireInteractive();
  return checked<T>(
    (await select({ message, options: options as never, initialValue })) as T | symbol,
  );
}

export async function askMultiSelect<T extends string>(
  message: string,
  options: { value: T; label: string; hint?: string }[],
  initialValues?: T[],
  required = false,
): Promise<T[]> {
  requireInteractive();
  return checked<T[]>(
    (await multiselect({
      message,
      options: options as never,
      initialValues,
      required,
    })) as T[] | symbol,
  );
}

export function maskKey(key: string | undefined): string {
  if (!key) return "(none)";
  if (key.length < 12) return "…";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

const SENSITIVE_JSON_KEY =
  /(\s*"(?:apiKey|key|token|access|refresh|secret|password|clientSecret)"\s*:\s*")((?:\\.|[^"\\])*)"/gi;

/**
 * Redact secret values from arbitrary text before it is printed.
 * Env/file references are not secrets and are left readable.
 */
export function redactSecrets(input: string): string {
  return input.replace(SENSITIVE_JSON_KEY, (whole, prefix: string, value: string) => {
    if (value.startsWith("{env:") || value.startsWith("{file:")) return whole;
    return `${prefix}${maskKey(value)}"`;
  });
}

export function print(message = ""): void {
  process.stdout.write(`${message}\n`);
}

export function info(message: string): void {
  print(`• ${message}`);
}

export function success(message: string): void {
  print(`✔ ${message}`);
}

export function warn(message: string): void {
  print(`! ${message}`);
}

export function fail(message: string): void {
  print(`✖ ${message}`);
}

export function heading(message: string): void {
  print(`\n${message}`);
}

export function codeBlock(message: string): void {
  print(message.replace(/\n$/, ""));
}

interface DiffOp {
  type: " " | "-" | "+";
  line: string;
  oldNo: number;
  newNo: number;
}

function diffOps(before: string[], after: string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;
  // Keep memory bounded for very large files.
  if (n * m > 25_000_000) {
    return [
      ...before.map((line, index) => ({ type: "-" as const, line, oldNo: index + 1, newNo: 0 })),
      ...after.map((line, index) => ({ type: "+" as const, line, oldNo: 0, newNo: index + 1 })),
    ];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ type: " ", line: before[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "-", line: before[i], oldNo: i + 1, newNo: 0 });
      i++;
    } else {
      ops.push({ type: "+", line: after[j], oldNo: 0, newNo: j + 1 });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "-", line: before[i], oldNo: i + 1, newNo: 0 });
    i++;
  }
  while (j < m) {
    ops.push({ type: "+", line: after[j], oldNo: 0, newNo: j + 1 });
    j++;
  }
  return ops;
}

export interface DiffResult {
  empty: boolean;
  text: string;
}

/** A compact unified diff with three lines of context. Secrets are redacted. */
export function unifiedDiff(path: string, before: string, after: string): DiffResult {
  const safeBefore = redactSecrets(before);
  const safeAfter = redactSecrets(after);
  if (safeBefore === safeAfter) return { empty: true, text: "" };

  const ops = diffOps(safeBefore.split("\n"), safeAfter.split("\n"));
  const changed = ops.map((op, index) => (op.type === " " ? -1 : index)).filter((i) => i >= 0);
  if (changed.length === 0) return { empty: true, text: "" };

  const context = 3;
  const keep = new Set<number>();
  for (const index of changed) {
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) {
      keep.add(k);
    }
  }

  const lines: string[] = [`--- ${path}`, `+++ ${path}`];
  let index = 0;
  while (index < ops.length) {
    if (!keep.has(index)) {
      index++;
      continue;
    }
    const start = index;
    let end = index;
    while (end + 1 < ops.length && keep.has(end + 1)) end++;

    const hunk = ops.slice(start, end + 1);
    const oldStart = hunk.find((op) => op.oldNo > 0)?.oldNo ?? 0;
    const newStart = hunk.find((op) => op.newNo > 0)?.newNo ?? 0;
    const oldCount = hunk.filter((op) => op.type !== "+").length;
    const newCount = hunk.filter((op) => op.type !== "-").length;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) lines.push(`${op.type}${op.line}`);
    index = end + 1;
  }
  return { empty: false, text: lines.join("\n") };
}

export function printDiff(path: string, before: string, after: string, label?: string): void {
  if (label) print(label);
  print(unifiedDiff(path, before, after).text || "(no changes)");
}

export function printBackupNotice(path: string): void {
  print(`  backup: ${basename(path)}`);
}

export function formatMode(mode: string): string {
  return mode === "none" ? "none" : mode;
}
