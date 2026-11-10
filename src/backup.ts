import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { unifiedDiff, warn } from "./ui";

export const BACKUP_KEEP = 20;

export type ChangeKind = "config" | "auth" | "secret" | "gitignore";

export interface FileChange {
  path: string;
  /** null means the file did not exist (or is being deleted when after is null). */
  before: string | null;
  after: string | null;
  kind: ChangeKind;
  /** Requested permission mode. auth is always forced to 600. */
  mode?: number;
  label?: string;
}

export interface ApplyOptions {
  backupsDir: string;
  dryRun?: boolean;
  print?: boolean;
}

export interface ApplyResult {
  changes: FileChange[];
  backups: string[];
  written: string[];
}

export interface BackupInfo {
  name: string;
  path: string;
  size: number;
  mtime: number;
}

export function utcStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "T");
}

export function ensureDir(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode });
}

function existingMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

/** Write through a temp file in the same directory, fsync, then rename. */
export function atomicWriteFile(path: string, content: string, mode?: number): void {
  ensureDir(dirname(path), 0o700);
  const targetMode = mode ?? existingMode(path) ?? 0o644;
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", targetMode);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temp, targetMode);
    renameSync(temp, path);
    chmodSync(path, targetMode);
    // Best effort directory durability.
    try {
      const dirFd = openSync(dirname(path), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Not supported on every filesystem.
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // ignore
    }
    throw error;
  }
}

export function backupFile(
  path: string,
  backupsDir: string,
  options: { mode?: number; keep?: number } = {},
): string | undefined {
  if (!existsSync(path)) return undefined;
  ensureDir(backupsDir, 0o700);
  // Keep the backup directory private even if it already existed with looser mode.
  try {
    chmodSync(backupsDir, 0o700);
  } catch {
    // best effort
  }
  const stamp = utcStamp();
  const base = `${basename(path)}.${stamp}`;
  let name = base;
  let counter = 1;
  while (existsSync(join(backupsDir, name))) {
    name = `${base}-${String(counter).padStart(2, "0")}`;
    counter++;
  }
  const dest = join(backupsDir, name);
  // Create the backup with 600 from the start: backups may contain auth.json or
  // inline keys, and a copy-then-chmod sequence briefly exposes them.
  writeFileSync(dest, readFileSync(path), { mode: 0o600, flag: "wx" });
  chmodSync(dest, options.mode ?? 0o600);
  pruneBackups(backupsDir, basename(path), options.keep ?? BACKUP_KEEP);
  return dest;
}

export function pruneBackups(backupsDir: string, baseName: string, keep = BACKUP_KEEP): string[] {
  if (!existsSync(backupsDir)) return [];
  const prefix = `${baseName}.`;
  const entries = readdirSync(backupsDir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      try {
        return { name, mtime: statSync(join(backupsDir, name)).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is { name: string; mtime: number } => entry !== undefined)
    .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name))
    .map((entry) => entry.name);
  const remove = entries.slice(0, Math.max(0, entries.length - keep));
  for (const name of remove) {
    try {
      unlinkSync(join(backupsDir, name));
    } catch {
      // ignore
    }
  }
  return remove;
}

export function listBackups(backupsDir: string, baseName?: string): BackupInfo[] {
  if (!existsSync(backupsDir)) return [];
  const prefix = baseName ? `${baseName}.` : "";
  return readdirSync(backupsDir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const path = join(backupsDir, name);
      try {
        const stat = statSync(path);
        if (!stat.isFile()) return undefined;
        return { name, path, size: stat.size, mtime: stat.mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((item): item is BackupInfo => item !== undefined)
    .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
}

export function readBackup(backupsDir: string, name: string): string {
  if (name !== basename(name)) throw new Error(`Invalid backup name: ${name}`);
  return readFileSync(join(backupsDir, name), "utf8");
}

function effectiveMode(change: FileChange): number | undefined {
  if (change.kind === "auth" || change.kind === "secret") return 0o600;
  if (change.mode !== undefined) return change.mode;
  return existingMode(change.path);
}

export function applyChanges(changes: FileChange[], options: ApplyOptions): ApplyResult {
  const result: ApplyResult = { changes: [], backups: [], written: [] };
  const changesToApply = changes.filter(
    (change) =>
      change.before !== change.after ||
      (change.after !== null && effectiveMode(change) !== existingMode(change.path)),
  );

  for (const change of changesToApply) {
    const targetMode = effectiveMode(change);
    if (options.dryRun) {
      result.changes.push(change);
      if (change.after === null) {
        if (options.print !== false) {
          console.log(`would delete: ${change.path}`);
        }
      } else {
        if (options.print !== false) {
          console.log(`would write: ${change.path}`);
          const diff = unifiedDiff(change.path, change.before ?? "", change.after);
          if (!diff.empty) console.log(diff.text);
          if (change.before === change.after) {
            console.log(`  (permissions only: ${targetMode?.toString(8) ?? "unchanged"})`);
          }
        }
      }
      continue;
    }

    ensureDir(change.kind === "secret" ? dirname(change.path) : options.backupsDir, 0o700);
    if (
      change.after !== null &&
      change.before !== null &&
      change.before !== change.after &&
      (change.kind === "config" || change.kind === "auth")
    ) {
      const backup = backupFile(change.path, options.backupsDir, { mode: 0o600 });
      if (backup) result.backups.push(backup);
    }

    if (change.after === null) {
      try {
        unlinkSync(change.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else if (change.before !== change.after) {
      atomicWriteFile(change.path, change.after, targetMode);
    } else if (targetMode !== undefined && targetMode !== existingMode(change.path)) {
      chmodSync(change.path, targetMode);
    }
    result.changes.push(change);
    if (change.after !== null) result.written.push(change.path);
  }
  return result;
}

/** Chmod a config to 600 when it contains an inline key. */
export function chmodConfigForInlineKey(path: string, dryRun: boolean): boolean {
  const current = existingMode(path);
  if (current === undefined || current === 0o600) return false;
  if (!dryRun) chmodSync(path, 0o600);
  return true;
}

/** Force a sensitive file to mode 600. Returns true when the mode changed. */
export function ensureFileMode(path: string, mode: number, dryRun = false): boolean {
  const current = existingMode(path);
  if (current === undefined || current === mode) return false;
  if (!dryRun) chmodSync(path, mode);
  return true;
}

export function checkPermissions(path: string): { exists: boolean; mode?: number; worldReadable: boolean } {
  const mode = existingMode(path);
  if (mode === undefined) return { exists: false, worldReadable: false };
  return { exists: true, mode, worldReadable: (mode & 0o077) !== 0 };
}

export function warnIfWritableByOthers(path: string): void {
  const perms = checkPermissions(path);
  if (perms.exists && perms.worldReadable) {
    warn(`${path} is accessible by group/others (${perms.mode?.toString(8)}).`);
  }
}
