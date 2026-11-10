# Smoke test transcript

All commands below were run against the compiled `dist/ocm` binary on Arch Linux.
The environment was a throwaway XDG sandbox; no real OpenCode configuration was touched:

```
XDG_CONFIG_HOME=/tmp/ocm-final/config
XDG_DATA_HOME=/tmp/ocm-final/data
XDG_STATE_HOME=/tmp/ocm-final/state
HOME=/tmp/ocm-final/home
```

The provider was a local mock `/v1/models` server. The keys shown are fake test
values (`sk-demo-env-…`, `sk-demo-auth-…`) and are masked in the output.
Timestamps and absolute sandbox paths are preserved.

---

# ocm smoke transcript

Sandbox: XDG_CONFIG_HOME=/tmp/ocm-final/config, XDG_DATA_HOME=/tmp/ocm-final/data, XDG_STATE_HOME=/tmp/ocm-final/state
Binary: dist/ocm (bun build --compile)

$ ocm --version
ocm/0.1.0 linux-x64 node-v26.3.0
[exit 0]

$ ocm list
! Config not found: /tmp/ocm-final/config/opencode/opencode.jsonc
• No auth file yet: /tmp/ocm-final/data/opencode/auth.json
• No providers configured. Try `ocm add openrouter` or `ocm add openai-compatible`.
[exit 0]

$ ocm add openrouter --key-mode env --env-var OPENROUTER_API_KEY --yes
• Config not found; creating /tmp/ocm-final/config/opencode/opencode.jsonc
✔ Wrote: /tmp/ocm-final/config/opencode/opencode.jsonc
✔ Added provider "openrouter" in /tmp/ocm-final/config/opencode/opencode.jsonc
✔ Key mode: env (OPENROUTER_API_KEY)
• Config now references {env:OPENROUTER_API_KEY}.
[exit 0]

$ ocm list
• No auth file yet: /tmp/ocm-final/data/opencode/auth.json
PROVIDER    MODE                      KEY       MODELS  STATE
──────────  ────────────────────────  ────────  ──────  ───────
openrouter  env (OPENROUTER_API_KEY)  sk-…abcd  0       enabled

default model: (not set)
small model:   (not set)
[exit 0]

$ ocm key openrouter --mode auth --key-file /tmp/ocm-final/demo.key --yes
✔ Backup: /tmp/ocm-final/state/ocm/backups/opencode.jsonc.20261027T194244.174Z
✔ Wrote: /tmp/ocm-final/data/opencode/auth.json
✔ Wrote: /tmp/ocm-final/config/opencode/opencode.jsonc
✔ Provider openrouter: key mode env -> auth
• Key: sk-…wxyz
[exit 0]

$ ocm list
PROVIDER    MODE  KEY       MODELS  STATE
──────────  ────  ────────  ──────  ───────
openrouter  auth  sk-…wxyz  0       enabled

default model: (not set)
small model:   (not set)
[exit 0]

$ ocm add openai-compatible --id mockprov --name Mock Provider --base-url http://127.0.0.1:34601/v1 --key-mode auth --key-file /tmp/ocm-final/demo.key --yes
✔ Backup: /tmp/ocm-final/state/ocm/backups/auth.json.20261027T194244.278Z
✔ Backup: /tmp/ocm-final/state/ocm/backups/opencode.jsonc.20261027T194244.278Z
✔ Wrote: /tmp/ocm-final/data/opencode/auth.json
✔ Wrote: /tmp/ocm-final/config/opencode/opencode.jsonc
✔ Added provider "mockprov" in /tmp/ocm-final/config/opencode/opencode.jsonc
✔ Key mode: auth (sk-…wxyz)
• Next: ocm models mockprov to add models.
[exit 0]

$ ocm models mockprov --models alpha-1,beta-2 --yes
• GET http://127.0.0.1:34601/v1/models
✔ Backup: /tmp/ocm-final/state/ocm/backups/opencode.jsonc.20261027T194244.332Z
✔ Wrote: /tmp/ocm-final/config/opencode/opencode.jsonc
✔ Added 2 models to mockprov.
[exit 0]

$ ocm default --model mockprov/alpha-1 --yes
✔ Backup: /tmp/ocm-final/state/ocm/backups/opencode.jsonc.20261027T194244.384Z
✔ Wrote: /tmp/ocm-final/config/opencode/opencode.jsonc
✔ model = mockprov/alpha-1
✔ small_model = mockprov/alpha-1
[exit 0]

$ ocm list
PROVIDER    MODE  KEY       MODELS  STATE
──────────  ────  ────────  ──────  ───────────────────────
mockprov    auth  sk-…wxyz  2       enabled, default, small
openrouter  auth  sk-…wxyz  0       enabled

default model: mockprov/alpha-1
small model:   mockprov/alpha-1
[exit 0]

$ ocm validate
✔ Config is valid against the cached OpenCode schema
! small_model is not a models.dev ID known to the bundled schema; OpenCode will still use it when the provider defines the model.
[exit 0]

$ ocm test mockprov --json
{
  "provider": "mockprov",
  "url": "http://127.0.0.1:34601/v1/models",
  "ok": true,
  "status": 200,
  "modelCount": 2
}
[exit 0]

$ ocm disable mockprov --yes
✔ Backup: /tmp/ocm-final/state/ocm/backups/opencode.jsonc.20261027T194244.774Z
✔ Wrote: /tmp/ocm-final/config/opencode/opencode.jsonc
✔ Disabled mockprov
[exit 0]

$ ocm list
PROVIDER    MODE  KEY       MODELS  STATE
──────────  ────  ────────  ──────  ────────────────────────
mockprov    auth  sk-…wxyz  2       disabled, default, small
openrouter  auth  sk-…wxyz  0       enabled

default model: mockprov/alpha-1
small model:   mockprov/alpha-1
[exit 0]

$ ocm enable mockprov --yes
✔ Backup: /tmp/ocm-final/state/ocm/backups/opencode.jsonc.20261027T194244.875Z
✔ Wrote: /tmp/ocm-final/config/opencode/opencode.jsonc
✔ Enabled mockprov
[exit 0]

$ ocm key openrouter --mode file --yes
• Key file: /tmp/ocm-final/config/opencode/secrets/openrouter.key
✔ Backup: /tmp/ocm-final/state/ocm/backups/opencode.jsonc.20261027T194244.929Z
✔ Backup: /tmp/ocm-final/state/ocm/backups/auth.json.20261027T194244.929Z
✔ Wrote: /tmp/ocm-final/config/opencode/secrets/openrouter.key
✔ Wrote: /tmp/ocm-final/config/opencode/opencode.jsonc
✔ Wrote: /tmp/ocm-final/data/opencode/auth.json
✔ Provider openrouter: key mode auth -> file
• Key: sk-…wxyz
[exit 0]

$ ocm list
PROVIDER    MODE                                                          KEY       MODELS  STATE
──────────  ────────────────────────────────────────────────────────────  ────────  ──────  ───────────────────────
mockprov    auth                                                          sk-…wxyz  2       enabled, default, small
openrouter  file (/tmp/ocm-final/config/opencode/secrets/openrouter.key)  sk-…wxyz  0       enabled

default model: mockprov/alpha-1
small model:   mockprov/alpha-1
[exit 0]

$ ocm key openrouter --mode auth --key-file /tmp/ocm-final/demo.key --yes
✔ Backup: /tmp/ocm-final/state/ocm/backups/auth.json.20261027T194245.033Z
✔ Backup: /tmp/ocm-final/state/ocm/backups/opencode.jsonc.20261027T194245.033Z
✔ Wrote: /tmp/ocm-final/data/opencode/auth.json
✔ Wrote: /tmp/ocm-final/config/opencode/opencode.jsonc
✔ Provider openrouter: key mode file -> auth
• Key: sk-…wxyz
[exit 0]

$ ocm backup --dry-run
would back up: /tmp/ocm-final/config/opencode/opencode.jsonc
would back up: /tmp/ocm-final/data/opencode/auth.json
[exit 0]

$ ocm backup --target config
✔ Backup: /tmp/ocm-final/state/ocm/backups/opencode.jsonc.20261027T194245.132Z
[exit 0]

$ ocm default --model mockprov/beta-2 --yes
✔ Backup: /tmp/ocm-final/state/ocm/backups/opencode.jsonc.20261027T194245.183Z
✔ Wrote: /tmp/ocm-final/config/opencode/opencode.jsonc
✔ model = mockprov/beta-2
✔ small_model = mockprov/beta-2
[exit 0]

$ ocm restore --target config --latest --yes
✔ Backup: /tmp/ocm-final/state/ocm/backups/opencode.jsonc.20261027T194245.235Z
✔ Wrote: /tmp/ocm-final/config/opencode/opencode.jsonc
✔ Restored /tmp/ocm-final/config/opencode/opencode.jsonc from opencode.jsonc.20261027T194245.183Z
[exit 0]

$ ocm list
PROVIDER    MODE  KEY       MODELS  STATE
──────────  ────  ────────  ──────  ───────────────────────
mockprov    auth  sk-…wxyz  2       enabled, default, small
openrouter  auth  sk-…wxyz  0       enabled

default model: mockprov/alpha-1
small model:   mockprov/alpha-1
[exit 0]

$ ocm backup --list
opencode.jsonc.20261027T194244.174Z  249 bytes  2026-10-27T19:42:44.173Z
auth.json.20261027T194244.278Z  86 bytes  2026-10-27T19:42:44.277Z
opencode.jsonc.20261027T194244.278Z  203 bytes  2026-10-27T19:42:44.278Z
opencode.jsonc.20261027T194244.332Z  375 bytes  2026-10-27T19:42:44.331Z
opencode.jsonc.20261027T194244.384Z  523 bytes  2026-10-27T19:42:44.383Z
opencode.jsonc.20261027T194244.774Z  591 bytes  2026-10-27T19:42:44.772Z
opencode.jsonc.20261027T194244.875Z  637 bytes  2026-10-27T19:42:44.874Z
opencode.jsonc.20261027T194244.929Z  619 bytes  2026-10-27T19:42:44.929Z
auth.json.20261027T194244.929Z  167 bytes  2026-10-27T19:42:44.929Z
auth.json.20261027T194245.033Z  84 bytes  2026-10-27T19:42:45.032Z
opencode.jsonc.20261027T194245.033Z  701 bytes  2026-10-27T19:42:45.033Z
opencode.jsonc.20261027T194245.132Z  619 bytes  2026-10-27T19:42:45.131Z
opencode.jsonc.20261027T194245.183Z  619 bytes  2026-10-27T19:42:45.182Z
opencode.jsonc.20261027T194245.235Z  617 bytes  2026-10-27T19:42:45.234Z
[exit 0]

## Remove a provider

$ ocm remove mockprov --dry-run --yes
! Cleared default model reference(s): mockprov/alpha-1
would write: /tmp/ocm-final/config/opencode/opencode.jsonc
--- /tmp/ocm-final/config/opencode/opencode.jsonc
+++ /tmp/ocm-final/config/opencode/opencode.jsonc
@@ -6,25 +6,8 @@
       "options": {
         "baseURL": "https://openrouter.ai/api/v1"
       }
-    },
-    "mockprov": {
-      "name": "Mock Provider",
-      "npm": "@ai-sdk/openai-compatible",
-      "options": {
-        "baseURL": "http://127.0.0.1:34601/v1"
-      },
-      "models": {
-        "alpha-1": {
-          "name": "Alpha One"
-        },
-        "beta-2": {
-          "name": "Beta Two"
-        }
-      }
     }
   },
-  "model": "mockprov/alpha-1",
-  "small_model": "mockprov/alpha-1",
   "disabled_providers": []
 }
 
would write: /tmp/ocm-final/data/opencode/auth.json
--- /tmp/ocm-final/data/opencode/auth.json
+++ /tmp/ocm-final/data/opencode/auth.json
@@ -1,8 +1,4 @@
 {
-  "mockprov": {
-    "type": "api",
-    "key": "sk-…wxyz"
-  },
   "openrouter": {
     "type": "api",
     "key": "sk-…wxyz"
[exit 0]

$ ocm remove mockprov --yes
! Cleared default model reference(s): mockprov/alpha-1
✔ Backup: /tmp/ocm-final/state/ocm/backups/opencode.jsonc.20261027T194245.443Z
✔ Backup: /tmp/ocm-final/state/ocm/backups/auth.json.20261027T194245.443Z
✔ Wrote: /tmp/ocm-final/config/opencode/opencode.jsonc
✔ Wrote: /tmp/ocm-final/data/opencode/auth.json
✔ Removed mockprov
[exit 0]

$ ocm list
PROVIDER    MODE  KEY       MODELS  STATE
──────────  ────  ────────  ──────  ───────
openrouter  auth  sk-…wxyz  0       enabled

default model: (not set)
small model:   (not set)
[exit 0]

$ ocm validate
✔ Config is valid against the cached OpenCode schema
[exit 0]

## Doctor

$ ocm doctor

ocm doctor
✔ Config parses: /tmp/ocm-final/config/opencode/opencode.jsonc (644)
✔ Config matches the cached OpenCode schema
✔ auth.json permissions are 600
✔ Backups directory is writable: /tmp/ocm-final/state/ocm/backups
✔ Latest auth backup permissions are 600
! Installed OpenCode is v2+, which imports auth.json into its database once. ocm edits auth.json for v1 compatibility; use /connect for v2-native credentials.

5 ok, 1 warning(s), 0 failure(s)
[exit 0]

$ ocm completion bash
# bash completion for ocm
_ocm() {
  local cur prev commands
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  commands="list add remove key models default disable enable test validate backup restore doctor completion help"

  case "$prev" in
    --config|--auth|--file|--key-file)
      COMPREPLY=( $(compgen -f -- "$cur") )
      return 0
      ;;
    --mode|--key-mode)
      COMPREPLY=( $(compgen -W "auth env file inline" -- "$cur") )
      return 0
      ;;
    --local)
      COMPREPLY=( $(compgen -W "ollama llama.cpp" -- "$cur") )
      return 0
      ;;
    --env-var)
      COMPREPLY=( $(compgen -W "OPENROUTER_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY" -- "$cur") )
      return 0
      ;;
  esac

  case "${COMP_WORDS[1]}" in
    add)
      COMPREPLY=( $(compgen -W "openrouter openai-compatible local" -- "$cur") )
      return 0
      ;;
    key|remove|models|test)
      local providers
      providers=$(ocm list --json 2>/dev/null | grep -o '"id": *"[^"]*"' | cut -d'"' -f4)
      COMPREPLY=( $(compgen -W "$providers" -- "$cur") )
      return 0
      ;;
    backup|restore)
      COMPREPLY=( $(compgen -W "--target --list --latest --file" -- "$cur") )
      return 0
      ;;
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "--config --auth --project --dry-run --yes --json --help --version" -- "$cur") )
    return 0
  fi
  COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
}
complete -F _ocm ocm

[exit 0]

## Project inline-key safety

$ ocm add openrouter --project --key-mode inline --key-file /tmp/ocm-final/demo.key --add-to-gitignore --yes
• Config not found; creating /tmp/ocm-final/repo/opencode.jsonc
! auth.json is shared across projects; this project operation changed it. Use env/file/inline mode if the project should not touch shared credentials.
! Inline API keys are stored as plaintext in the config file.
! Config is inside git repository /tmp/ocm-final/repo and is NOT gitignored.
• Added the config path to .gitignore.
✔ Backup: /tmp/ocm-final/state/ocm/backups/auth.json.20261027T194246.141Z
✔ Wrote: /tmp/ocm-final/repo/opencode.jsonc
✔ Wrote: /tmp/ocm-final/data/opencode/auth.json
✔ Wrote: /tmp/ocm-final/repo/.gitignore
✔ Added provider "openrouter" in /tmp/ocm-final/repo/opencode.jsonc
✔ Key mode: inline (sk-…wxyz)
[exit 0]

$ stat -c "%a %n" opencode.jsonc .gitignore
600 opencode.jsonc
644 .gitignore

$ cat .gitignore
# added by ocm: OpenCode config contains an inline API key
/opencode.jsonc

$ git check-ignore -v opencode.jsonc
.gitignore:2:/opencode.jsonc	opencode.jsonc

$ ocm doctor --project

ocm doctor
✔ Config parses: /tmp/ocm-final/repo/opencode.jsonc (600)
✔ Config matches the cached OpenCode schema
✔ auth.json permissions are 600
! openrouter: inline key is plaintext in the config
✔ Config with inline key is gitignored (/tmp/ocm-final/repo)
✔ Backups directory is writable: /tmp/ocm-final/state/ocm/backups
✔ Latest auth backup permissions are 600
! Installed OpenCode is v2+, which imports auth.json into its database once. ocm edits auth.json for v1 compatibility; use /connect for v2-native credentials.

6 ok, 2 warning(s), 0 failure(s)
[exit 0]

---

## Addendum: `ocm models` selection flags

A later build added `--select-all` / `--deselect-all`. This run used a fresh
sandbox and a separate mock server (`/tmp/ocm-smoke`):

```
XDG_CONFIG_HOME=/tmp/ocm-smoke/config2
XDG_DATA_HOME=/tmp/ocm-smoke/data2
XDG_STATE_HOME=/tmp/ocm-smoke/state2
HOME=/tmp/ocm-smoke/home2
```

The mock returned `alpha-1`, `beta-2`, `gamma-3` and required
`Authorization: Bearer sk-demo-select`.

$ ocm add openai-compatible --id mockprov --base-url http://127.0.0.1:43153/v1 --key-mode env --env-var MOCK_KEY --yes
• Config not found; creating /tmp/ocm-smoke/config2/opencode/opencode.jsonc
! Environment variable MOCK_KEY is not set in this shell.
! Set MOCK_KEY in your shell before starting OpenCode.
✔ Wrote: /tmp/ocm-smoke/config2/opencode/opencode.jsonc
✔ Added provider "mockprov" in /tmp/ocm-smoke/config2/opencode/opencode.jsonc
✔ Key mode: env (MOCK_KEY)
• Config now references {env:MOCK_KEY}.
• Next: ocm models mockprov to add models.
[exit 0]

$ ocm models mockprov --deselect-all --yes
• No models selected.
[exit 0]

`--deselect-all` is a pure no-op: it does not resolve a key, contact the
server, or rewrite the config.

$ ocm models mockprov --all --models alpha-1 --yes
✖ Use --models or --select-all/--deselect-all, not both.
[exit 1]

$ ocm models mockprov --all --yes   # without MOCK_KEY set
! No usable key (environment variable MOCK_KEY is not set); trying /models unauthenticated.
• GET http://127.0.0.1:43153/v1/models
✖ Model list failed for mockprov: HTTP 401
[exit 1]

$ export MOCK_KEY=sk-demo-select
$ ocm models mockprov --select-all --yes
• GET http://127.0.0.1:43153/v1/models
✔ Backup: /tmp/ocm-smoke/state2/ocm/backups/opencode.jsonc.20261030T184147.431Z
✔ Wrote: /tmp/ocm-smoke/config2/opencode/opencode.jsonc
✔ Added 3 models to mockprov.
[exit 0]

$ ocm list
• No auth file yet: /tmp/ocm-smoke/data2/opencode/auth.json
PROVIDER  MODE            KEY       MODELS  STATE
────────  ──────────────  ────────  ──────  ───────
mockprov  env (MOCK_KEY)  sk-...lect  3       enabled

default model: (not set)
small model:   (not set)
[exit 0]

Interactive `ocm models <provider>` now asks for an initial set
(`Keep current selection`, `Start with all selected`, `Start with none
selected`) before opening the picker. Inside the picker, `space` toggles the
focused model, `a` selects/deselects all, and `i` inverts the selection.

This was exercised in a PTY against a provider with no models configured:
accepting the default `Start with none selected`, pressing `a` in the picker,
and confirming printed `✔ Added 3 models to mockprov.` (`[exit 0]`).
