#!/bin/sh
# Runs `termote <args>` for the Herdr plugin on Linux and macOS.
#
# Herdr starts plugin commands with its server's PATH, which often lacks
# ~/.local/bin (where `termote link` puts the command), so the install's own
# paths are tried too. When termote is missing, too old for the plugin, or a
# command fails in the popup, the message stays on screen until a key is
# pressed instead of the popup closing at once.
#
# `open-panel` opens the plugin's popup (Herdr key bindings can only run
# actions, not open panes).

# hold keeps a popup open on its message; an action has no terminal.
hold() {
	if [ -t 0 ] && [ -t 1 ]; then
		printf '\nPress Enter to close'
		read -r _ || true
	fi
}

if [ "$1" = open-panel ]; then
	exec "${HERDR_BIN_PATH:-herdr}" plugin pane open --plugin "${HERDR_PLUGIN_ID:-lamngockhuong.termote}" --entrypoint panel
fi

# candidates lists every termote found, PATH first. The first one that has
# the plugin's commands runs, so an old copy on PATH does not hide a current
# install.
candidates() {
	command -v termote 2>/dev/null
	for p in "$HOME/.local/bin/termote" "${XDG_DATA_HOME:-$HOME/.local/share}/termote/current/bin/termote"; do
		if [ -x "$p" ]; then
			echo "$p"
		fi
	done
}

bin=
old=
broken=
# One path per line, so a path with spaces stays whole.
nl='
'
IFS=$nl
for c in $(candidates); do
	if ! help=$("$c" help 2>&1); then
		# A checkout's dev shim fails here when it cannot build.
		broken="$c: $help"
		continue
	fi
	case "$help" in
	*"
  panel "*)
		bin=$c
		break
		;;
	esac
	old="$("$c" version 2>/dev/null || echo "$c")"
done
unset IFS

if [ -z "$bin" ]; then
	if [ -n "$broken" ]; then
		printf 'termote failed to run:\n%s\n' "$broken" >&2
	elif [ -n "$old" ]; then
		echo "$old is too old for the Herdr plugin (it needs 1.5.0 or later)." >&2
		echo "Update it: termote update" >&2
	else
		echo "termote was not found (looked on PATH, in ~/.local/bin and in the install)." >&2
		echo "Install it: curl -fsSL https://termote.ohnice.app/install.sh | sh" >&2
		hold
		exit 127
	fi
	hold
	exit 1
fi

"$bin" "$@"
rc=$?
if [ "$rc" -ne 0 ]; then
	hold
fi
exit "$rc"
