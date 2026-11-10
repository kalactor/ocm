# ocm — OpenCode config manager

`ocm` is a small CLI for managing an [OpenCode](https://opencode.ai) setup without
hand-editing `opencode.jsonc` and `auth.json`. It manages providers, API-key
storage, models, defaults, backups, and the health of the whole setup.

It is deliberately conservative:

- JSONC edits go through `jsonc-parser`'s `modify()` and `applyEdits()`, so
  comments, tab/space indentation, trailing commas, and line order survive.
- Every write is atomic (temporary file + `rename`) and preceded by a backup.
- API keys are never accepted on the command line, are never printed
  unmasked, and are read from stdin, a file, or a hidden prompt.
- `auth.json`, key files, inline-key configs, and backups are mode `600`.

`ocm` targets OpenCode v1.x configuration semantics. See
[OpenCode v2 compatibility](#opencode-v2-compatibility).

## Installation (Arch Linux)

`ocm` is a single compiled executable. A `PKGBUILD` is included.

1. Edit `PKGBUILD` and replace `yourname` in `url` with the repository owner,
   and replace the zero `sha256sums` value with the checksum of the release
   tarball.
2. Build and install:

```bash
makepkg -si
```

This installs:

- `/usr/bin/ocm`
- `/usr/share/bash-completion/completions/ocm`
- `/usr/share/zsh/site-functions/_ocm`
- `/usr/share/doc/ocm/README.md`

Build dependencies are `bun` and `base-devel`. The compiled binary depends on
`glibc`, `gcc-libs`, and `icu` (the same runtime libraries Bun itself needs).

### From a checkout

```bash
bun install
bun run build          # dist/ocm
./dist/ocm --help
```

The test suite only uses temporary XDG directories:

```bash
bun test
bunx tsc --noEmit
```

A full manual run against the compiled binary, using a local mock provider and a
throwaway XDG sandbox, is captured in [`SMOKE.md`](SMOKE.md).

## Quick start

```bash
# Interactive menu when run with no arguments
ocm

# OpenRouter, key in auth.json
ocm add openrouter --key-mode auth --key-stdin < ~/.keys/openrouter

# OpenRouter, key in an environment variable
ocm add openrouter --key-mode env --env-var OPENROUTER_API_KEY --yes

# Any OpenAI-compatible endpoint
ocm add openai-compatible \
  --id local-llm --name "Local LLM" \
  --base-url http://127.0.0.1:11434/v1 \
  --key-mode none --yes

# Fetch models from the provider's /models endpoint
ocm models local-llm --all --yes

# Set defaults
ocm default --model local-llm/llama3.3 --yes

# Inspect, validate, and test
ocm list
ocm validate
ocm test local-llm
ocm doctor
```

Every command works without a TTY by passing flags. Destructive commands
(`remove`, `restore`, changing an existing key mode, updating an existing
provider) require `--yes`.

## Commands

| Command | Purpose |
| --- | --- |
| `ocm` | Interactive menu (when stdin/stdout are TTYs) |
| `ocm list [--json]` | Providers, key modes, masked keys, model counts, defaults |
| `ocm add <preset>` | Add `openrouter`, `openai-compatible`, or `local` |
| `ocm remove <provider...> [--yes]` | Remove provider config, auth entry, managed key file, and stale defaults |
| `ocm key <provider> --mode <mode>` | Switch a provider between `auth`, `env`, `file`, `inline` |
| `ocm models <provider> [--all\|--select-all\|--deselect-all\|--models a,b]` | GET `/models` and add models to the config |
| `ocm default [--model p/m] [--small-model p/m]` | Set `model` / `small_model` |
| `ocm disable <provider...>` | Add to `disabled_providers` |
| `ocm enable <provider...>` | Remove from `disabled_providers` |
| `ocm test <provider> [--json]` | GET `/models` and report status/model count |
| `ocm validate [--json]` | Validate against the bundled OpenCode schema |
| `ocm backup [--target config\|auth] [--list]` | Create or list backups |
| `ocm restore [name] --target config\|auth [--latest] [--yes]` | Restore a backup |
| `ocm doctor [--json]` | Paths, permissions, schema, duplicates, key files, git safety |
| `ocm completion [bash\|zsh]` | Print shell completion |

Common options:

- `--config <path>` — override the config path.
- `--auth <path>` — override `auth.json`.
- `--project` — use `./opencode.jsonc` or `./opencode.json` instead of the
  global config.
- `--dry-run` — print a redacted unified diff and write nothing.
- `-y, --yes` — skip confirmation prompts.
- `--json` — machine-readable output where supported.

`ocm add` presets:

- `openrouter` — built-in OpenRouter provider.
- `openai-compatible` — requires `--id` and `--base-url`; uses
  `@ai-sdk/openai-compatible`.
- `local` — Ollama by default, or `--local llama.cpp`; no key is expected.
  This can be combined with an explicit `--key-mode` if the local server is
  protected.

`ocm models` selection:

- `--models a,b` — add exactly those ids.
- `--all` or `--select-all` — add every model returned by `/models`.
- `--deselect-all` — select none (useful in scripts as an explicit no-op).
- Interactive — first choose an initial set (`Keep current selection`,
  `Start with all selected`, or `Start with none selected`), then refine it in
  the picker. In the picker, `space` toggles the focused model, `a`
  selects/deselects everything, and `i` inverts the selection.

## Paths

| Item | Default |
| --- | --- |
| Global config | `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.jsonc` |
| Global config fallback | `opencode.json` is used if `opencode.jsonc` is absent |
| Project config | `./opencode.jsonc`, then `./opencode.json` with `--project` |
| Auth | `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json` |
| Backups | `${XDG_STATE_HOME:-~/.local/state}/ocm/backups` |
| Managed file-mode keys | `${XDG_CONFIG_HOME:-~/.config}/opencode/secrets/<provider>.key` |

`--config` and `--auth` override the corresponding path. All directory
creation is private (`700`); file-mode keys and `auth.json` are always `600`.

## Key storage modes

Exactly one key location is used for a provider. Switching modes removes the
old location so OpenCode cannot silently use a stale key.

| Mode | Config value | Key lives in | Recommended |
| --- | --- | --- | --- |
| `auth` | no `options.apiKey` | `auth.json` (`{"type":"api","key":...}`) | yes |
| `env` | `{env:VAR}` | environment variable `VAR` | yes |
| `file` | `{file:/absolute/path}` | a file readable by OpenCode | yes |
| `inline` | plaintext key | the config file itself | no |

Examples:

```bash
# auth.json (hidden prompt if --key-stdin/--key-file are omitted)
ocm key openrouter --mode auth

# environment variable
ocm key openrouter --mode env --env-var OPENROUTER_API_KEY --yes

# external key file; ocm only deletes its own managed secrets on later switches
ocm key openrouter --mode file --file ~/.secrets/openrouter.key --yes

# plaintext in config (warns, chmods 600, checks git)
ocm key openrouter --mode inline --yes
```

Putting a key in a custom OpenAI-compatible provider is done with
`options.apiKey` (the `env`, `file`, and `inline` modes). For built-in
providers, `auth` writes `auth.json` instead.

### API-key precedence: `options.apiKey` wins over `auth.json`

This was verified empirically against OpenCode **v1.18.34** using a local mock
server, not just inferred from documentation:

- built-in provider `openai`, model `openai/test-model`
- custom provider `myprov` with `npm: "@ai-sdk/openai-compatible"`, model
  `myprov/m1`
- `auth.json` contained `AUTHKEY`
- `provider.<id>.options.apiKey` contained `CONFIGKEY`

Requests arrived with `Authorization: Bearer CONFIGKEY`. After removing the
config key, requests arrived with `Authorization: Bearer AUTHKEY`. The same
result held for both built-in and custom providers in OpenCode v1.18.34.

Implications:

- `auth` and config-based modes are mutually exclusive; `ocm` removes stale
  duplicates when switching.
- A config file containing an inline key can override a key in `auth.json`.
  That is why inline mode is warned about and chmodded.
- A few special built-ins use custom auth loaders that can read `auth.json`
  directly, so `options.apiKey` may not override them. `ocm list`, `ocm key`,
  and `ocm doctor` warn for: `gitlab`, `cloudflare-ai-gateway`,
  `cloudflare-workers-ai`, `amazon-bedrock`, `sap-ai-core`, and
  `snowflake-cortex`.

## Safety and secrets

- Keys are only accepted via `--key-stdin`, `--key-file`, or a hidden prompt.
  There is deliberately no `--api-key` flag, so keys do not end up in shell
  history or `ps`.
- `ocm list` and diffs only show masked keys such as `sk-…cdEF`. Short keys
  are reduced to `…`.
- `auth.json` writes are forced to mode `600`.
- File-mode key files created by `ocm` are mode `600`. When leaving `file`
  mode, only files inside the managed secrets directory are deleted; external
  files are left alone and reported.
- Inline mode is plaintext. `ocm` warns, defaults the config to `600`, and
  prompts before changing an existing config's permissions. Use
  `--no-chmod-config` to opt out explicitly.
- Before writing a config with an inline key inside a git repository, `ocm`
  checks whether the config is ignored. It warns, and can append the file to
  `.gitignore` (`--add-to-gitignore` in non-interactive mode). It also warns
  when the file is already tracked, because a `.gitignore` entry will not
  untrack it.
- Automatic backups are mode `600` and contain the same secrets as the source
  file. The state directory is created private.
- Backups are kept per base filename, newest 20.
- Existing `auth.json` OAuth credentials are preserved when moving an API key
  out. Replacing OAuth with an API key requires `--force` (or confirmation).

## Project configs

```bash
cd ~/src/my-project
ocm add openrouter --project --key-mode auth --key-stdin < ~/.keys/openrouter
ocm list --project
```

For inline keys in a project, `ocm` offers `.gitignore` handling as described
above. `--project` changes only the config path; `auth.json` remains global
unless `--auth` is supplied. Key-mode operations on a project config can
therefore add or remove entries in the shared `auth.json`; `ocm` warns when
this happens. Use `env`, `file`, or `inline` mode for a project that should not
modify shared credentials. For the same reason, `remove --project` does not
delete a globally managed key file.

## Backups and restore

```bash
# Back up both config and auth
ocm backup

# Back up only one target
ocm backup --target config
ocm backup --target auth

# List
ocm backup --list

# Restore newest config backup
ocm restore --target config --latest --yes

# Restore an exact backup
ocm restore opencode.jsonc.20260101T120000.000Z --target config --yes
```

The files are named `<basename>.<UTC timestamp>` under
`${XDG_STATE_HOME:-~/.local/state}/ocm/backups`. Every write performed by
`ocm` first creates a backup; new-file creation has nothing to back up.
`--dry-run` never creates a backup or writes a file.

Note: backups are keyed by the config/auth basename. A global config and a
`--project` config both use `opencode.jsonc`, so they share a backup
namespace. Use `ocm backup --list` and the timestamp/contents when restoring
across contexts.

## Validation and doctor

`ocm validate` uses a bundled copy of the OpenCode config schema and the
models.dev schema (no network access required). It reports schema errors and
warnings such as a missing `$schema`.

`ocm doctor` checks:

- config JSONC syntax, schema, and `$schema`
- auth.json syntax, entry shape, and mode `600`
- duplicate keys in config + auth
- env/file key availability
- inline plaintext and config permissions
- git tracking/ignore state for inline project configs
- backup directory writability and latest auth backup mode
- `opencode` v2 detection

One schema quirk: the bundled schema restricts `small_model` to models.dev
IDs. OpenCode itself accepts models defined by custom providers, so `ocm`
reports that single case as a warning rather than a validation failure.

## OpenCode v2 compatibility

`ocm` follows the requested v1 `auth.json` model. OpenCode **v2.x** imports
`auth.json` into its database (`opencode.db`) during migration and then uses
the database. On a v2 installation:

- `ocm doctor` warns when it finds OpenCode v2.
- Config-side modes (`env`, `file`, `inline`) are still represented in
  `opencode.jsonc` and remain useful.
- `auth` mode writes legacy `auth.json`; it may not affect an already
  migrated v2 database until OpenCode imports it again. Prefer v1 semantics
  for `auth` mode, or use v2's `/connect` flow for v2-native credentials.

The precedence result above was verified with v1.18.34, not with the v2
database migration path.

## Design decisions and deviations

- **No `--api-key`.** Secrets only come from stdin, a key file, or a hidden
  prompt. This is stricter than the minimum requirement and avoids process
  argv leaks.
- **`backup`/`restore` use `--target config|auth`.** The global `--config`
  and `--auth` flags are path overrides; a boolean `--config`/`--auth` on
  backup/restore would collide with them.
- **Managed file-mode location.** The default key file is under
  `$XDG_CONFIG_HOME/opencode/secrets/`. Only managed files are deleted on a
  mode switch; external paths are left and warned about.
- **Secret files are not backed up.** Backing up a key file would duplicate
  secrets for little benefit. `auth.json` and configs are backed up (mode
  `600`).
- **`remove` deletes managed key files.** If the provider used a `{file:...}`
  inside ocm's secrets directory and no surviving provider shares it, the key
  file is deleted. External key files are left in place and reported. A
  project-mode remove does not delete the globally shared managed file.
- **Inline mode defaults to `chmod 600`.** `--no-chmod-config` is the explicit
  opt-out, with a warning.
- **Default model also sets `small_model`.** When `--small-model` is omitted,
  `ocm default --model x` sets both. This is convenient and matches the
  common case; pass an explicit `--small-model` to choose another model.
- **`remove` clears dangling `model`/`small_model`.** If the removed provider
  was the default, `ocm` drops those references rather than leaving OpenCode
  pointing at a missing provider.
- **`disable`/`enable` use `disabled_providers`.** `enabled_providers` is
  checked and warned about, but not rewritten, so an existing allowlist is
  never broadened silently.
- **Local preset has no key by default.** Ollama and llama.cpp are normally
  unauthenticated; an explicit `--key-mode` can still add one.
- **OAuth is distinct from API keys.** Moving modes removes only `type: "api"`
  entries; OAuth/well-known entries are preserved and reported. `--force` is
  required to replace OAuth.
- **Special auth providers are warned about.** The precedence experiment does
  not cover loaders that read `auth.json` in custom code.
- **Backups keyed by basename.** This satisfies the requested
  `<name>.<timestamp>` layout but means global and project configs share a
  namespace, documented above.

## Development

```bash
bun install
bun test
bunx tsc --noEmit
bun run build
```

The tests set `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and
`HOME` to temporary directories and never touch a real OpenCode setup. A fake
`/models` endpoint is provided by `Bun.serve`.

The implementation is split into:

- `src/paths.ts` — XDG/project/override path resolution
- `src/config.ts` — JSONC parsing and comment-preserving edits
- `src/auth.ts` — auth.json model, API/OAuth handling, mode `600` writes
- `src/keymodes.ts` — mode detection and transition planning
- `src/providers.ts` — presets, provider edits, `/models` fetching
- `src/backup.ts` — atomic writes, backups, retention, permissions
- `src/validate.ts` — bundled-schema validation
- `src/ui.ts` — prompts, masking, redacted unified diffs
- `src/cli.ts` — command wiring and interactive menu

## License

MIT. See `LICENSE`.
