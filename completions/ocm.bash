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
      if [[ "$cur" == -* ]]; then
        case "${COMP_WORDS[1]}" in
          models)
            COMPREPLY=( $(compgen -W "--models --all --select-all --deselect-all --force --timeout" -- "$cur") )
            ;;
          key)
            COMPREPLY=( $(compgen -W "--mode --env-var --file --key-stdin --key-file --force --add-to-gitignore --no-chmod-config" -- "$cur") )
            ;;
          test)
            COMPREPLY=( $(compgen -W "--timeout" -- "$cur") )
            ;;
        esac
        return 0
      fi
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
