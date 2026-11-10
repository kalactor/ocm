import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  BACKUP_KEEP,
  applyChanges,
  atomicWriteFile,
  backupFile,
  checkPermissions,
  listBackups,
  pruneBackups,
  readBackup,
} from "../src/backup";
import { makeSandbox } from "./helpers";

function age(path: string, secondsAgo: number): void {
  const time = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, time, time);
}

describe("atomic writes and permissions", () => {
  test("creates parent directories and preserves a requested mode", () => {
    const sandbox = makeSandbox();
    const path = join(sandbox.root, "nested", "secret.key");
    atomicWriteFile(path, "secret\n", 0o600);
    expect(readFileSync(path, "utf8")).toBe("secret\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(checkPermissions(path)).toMatchObject({ exists: true, worldReadable: false });
  });

  test("does not inherit a permissive mode when writing an existing file", () => {
    const sandbox = makeSandbox();
    const path = join(sandbox.root, "config.json");
    writeFileSync(path, "{}\n", { mode: 0o644 });
    chmodSync(path, 0o644);
    atomicWriteFile(path, '{"a":1}\n');
    expect(statSync(path).mode & 0o777).toBe(0o644);
    atomicWriteFile(path, '{"a":2}\n', 0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("backups", () => {
  test("names backups with the base name and a timestamp and forces 600", () => {
    const sandbox = makeSandbox();
    const path = join(sandbox.root, "auth.json");
    writeFileSync(path, '{"secret":true}\n', { mode: 0o644 });
    chmodSync(path, 0o644);
    const backup = backupFile(path, sandbox.backupsDir);
    expect(backup).toBeTruthy();
    expect(backup!.startsWith(join(sandbox.backupsDir, "auth.json."))).toBe(true);
    expect(statSync(backup!).mode & 0o777).toBe(0o600);
    expect(statSync(sandbox.backupsDir).mode & 0o777).toBe(0o700);
    expect(readBackup(sandbox.backupsDir, basename(backup!))).toContain("secret");
  });

  test("retains only the newest 20 per base name", () => {
    const sandbox = makeSandbox();
    const path = join(sandbox.root, "config.json");
    for (let index = 0; index < BACKUP_KEEP + 5; index++) {
      writeFileSync(path, `{"index":${index}}\n`);
      backupFile(path, sandbox.backupsDir);
    }
    const backups = listBackups(sandbox.backupsDir, "config.json");
    expect(backups.length).toBe(BACKUP_KEEP);
    expect(backups[backups.length - 1].size).toBeGreaterThan(0);
    expect(pruneBackups(sandbox.backupsDir, "config.json")).toEqual([]);
  });

  test("sorts by modification time, not by collision suffix", () => {
    const sandbox = makeSandbox();
    mkdirSync(sandbox.backupsDir, { recursive: true });
    const older = join(sandbox.backupsDir, "x.json.20260101T000000.000Z-01");
    const newer = join(sandbox.backupsDir, "x.json.20260102T000000.000Z");
    writeFileSync(older, "old");
    writeFileSync(newer, "new");
    age(older, 60);
    age(newer, 1);
    expect(listBackups(sandbox.backupsDir, "x.json").map((entry) => entry.name)).toEqual([
      "x.json.20260101T000000.000Z-01",
      "x.json.20260102T000000.000Z",
    ]);
  });

  test("applyChanges backs up before writing and obeys dry-run", () => {
    const sandbox = makeSandbox();
    const config = join(sandbox.root, "opencode.jsonc");
    writeFileSync(config, '{\n  "a": 1\n}\n', { mode: 0o644 });

    const dry = applyChanges(
      [{ path: config, before: readFileSync(config, "utf8"), after: '{\n  "a": 2\n}\n', kind: "config" }],
      { backupsDir: sandbox.backupsDir, dryRun: true, print: false },
    );
    expect(dry.backups).toEqual([]);
    expect(readFileSync(config, "utf8")).toContain('"a": 1');
    expect(existsSync(sandbox.backupsDir)).toBe(false);

    const real = applyChanges(
      [{ path: config, before: readFileSync(config, "utf8"), after: '{\n  "a": 2\n}\n', kind: "config" }],
      { backupsDir: sandbox.backupsDir, print: false },
    );
    expect(real.backups.length).toBe(1);
    expect(statSync(real.backups[0]).mode & 0o777).toBe(0o600);
    expect(readFileSync(config, "utf8")).toContain('"a": 2');
  });

  test("auth writes are forced to 600 and deletions are applied", () => {
    const sandbox = makeSandbox();
    const auth = join(sandbox.root, "auth.json");
    writeFileSync(auth, '{"p":{"type":"api","key":"k"}}\n', { mode: 0o644 });
    chmodSync(auth, 0o644);
    applyChanges(
      [
        {
          path: auth,
          before: readFileSync(auth, "utf8"),
          after: '{"p":{"type":"api","key":"new"}}\n',
          kind: "auth",
        },
      ],
      { backupsDir: sandbox.backupsDir, print: false },
    );
    expect(statSync(auth).mode & 0o777).toBe(0o600);

    applyChanges(
      [{ path: auth, before: readFileSync(auth, "utf8"), after: null, kind: "auth" }],
      { backupsDir: sandbox.backupsDir, print: false },
    );
    expect(existsSync(auth)).toBe(false);
  });
});
