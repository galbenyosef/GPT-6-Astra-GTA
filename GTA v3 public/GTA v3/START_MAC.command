#!/bin/bash
# Start from this file's directory, including folders with spaces.
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  printf '\nNode.js не найден.\nУстановите LTS-версию с https://nodejs.org/en/download\nВыберите установщик для macOS (.pkg), затем откройте START_MAC.command ещё раз.\n\n'
  read -r -p 'Нажмите Enter, чтобы закрыть окно… ' _answer
  exit 1
fi

if ! node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)"; then
  printf '\nНужен Node.js 22.12 или новее.\nУстановите LTS-версию с https://nodejs.org/en/download и повторите запуск.\n\n'
  read -r -p 'Нажмите Enter, чтобы закрыть окно… ' _answer
  exit 1
fi

node ./serve.mjs --open "$@"
game_status=$?
if [ "$game_status" -ne 0 ] && [ "$game_status" -ne 130 ]; then
  printf '\nИгра не запустилась. Прочитайте сообщение выше и файл ЗАПУСК.md.\n'
  read -r -p 'Нажмите Enter, чтобы закрыть окно… ' _answer
fi
exit "$game_status"
