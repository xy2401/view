#!/usr/bin/env bash
set -euo pipefail

# Resolve the executable in this extracted package, wherever the user put it.
case $0 in
  */*) script_dir=${0%/*} ;;
  *) script_dir=. ;;
esac
CDPATH= cd -P -- "${script_dir:-/}"
executable=$PWD/View
if [[ ! -f $executable || ! -x $executable ]]; then
  printf 'Cannot find the View executable alongside this installer.\n' >&2
  exit 1
fi

data_home=${XDG_DATA_HOME:-}
[[ $data_home == /* ]] || data_home=$HOME/.local/share
application_dir=$data_home/applications
mkdir -p -- "$application_dir"
entry=$(mktemp -- "$application_dir/.view-open-with-XXXXXXXX")
trap 'rm -f -- "$entry"' EXIT

# A quoted Exec argument is parsed twice: first as a desktop-entry string,
# then as an argument. %% represents a literal percent rather than a field code.
exec_arg=$executable
exec_arg=${exec_arg//\\/\\\\}
exec_arg=${exec_arg//\"/\\\"}
exec_arg=${exec_arg//\$/\\\$}
exec_arg=${exec_arg//\`/\\\`}
exec_arg=${exec_arg//%/%%}
exec_arg=${exec_arg//\\/\\\\}
exec_arg=${exec_arg//$'\n'/\\n}
exec_arg=${exec_arg//$'\r'/\\r}
exec_arg=${exec_arg//$'\t'/\\t}

{
  printf '[Desktop Entry]\nType=Application\nName=View\n'
  # GIO checks argv[0] before expanding %% escapes. Use a fixed executable
  # and pass the real package path and filename as literal positional arguments.
  printf '%s "%s" %%f\n' 'Exec=/bin/sh -c "exec \\"\\$@\\"" View' "$exec_arg"
  printf 'Icon=system-file-manager\nTerminal=false\nCategories=Graphics;Viewer;\n'
  printf 'MimeType=%s\n' 'image/jpeg;image/png;image/gif;image/webp;image/avif;image/bmp;image/svg+xml;audio/mpeg;audio/flac;audio/ogg;audio/mp4;audio/x-wav;video/mp4;video/webm;video/quicktime;application/pdf;text/plain;text/markdown;application/json;application/octet-stream;'
} > "$entry"
chmod 644 -- "$entry"
desktop_file=$application_dir/io.github.xy2401.view.desktop
mv -fT -- "$entry" "$desktop_file"
trap - EXIT
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$application_dir"
fi
printf 'Installed Open With entry at %s\n' "$desktop_file"
