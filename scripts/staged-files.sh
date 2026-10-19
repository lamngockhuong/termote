#!/bin/sh
# pre-commit helper (lefthook.yml): runs a command with the staged files (added, copied, modified
# or renamed) that match the given git pathspecs, relative to the current directory, as its last
# arguments, and runs nothing when there are none.
#   staged-files.sh --glob <pathspec> [--glob <pathspec>]... <command> [arg...]
# The names never pass through a shell: lefthook on Windows puts {staged_files} into one
# double-quoted `sh -c` command line, where the double quotes its quoting adds for a name holding
# a single quote end that line's quoting, and the rest of the name then runs as shell code. Each
# name starts with ./ so one starting with - is not taken for an option. The names go in batches
# of at most maxlen bytes (a longer single name alone), as lefthook splits its own (Windows limits a
# command line to 8191). On Windows (Git for Windows' sh, MSYS2, Cygwin) a name holding a character
# cmd.exe reads (& % ^ ! | < >) is refused too: pnpm exec and npx can run the command through a .cmd
# shim, and how its arguments are escaped for cmd.exe depends on the npm and cross-spawn versions.
set -f
nl='
'
maxlen=7000
usage() {
  echo "usage: staged-files.sh --glob <pathspec>... <command> [arg...]" >&2
  exit 2
}
specs=
while [ "$1" = --glob ]; do
  [ $# -ge 2 ] || usage
  specs="$specs$nl:(glob)$2"
  shift 2
done
[ -n "$specs" ] && [ $# -gt 0 ] || usage
case $(uname -s) in
  MINGW* | MSYS* | CYGWIN*) windows=1 ;;
  *) windows= ;;
esac
# git exports GIT_DIR to a hook in a linked worktree; with it set, git takes the current directory
# for the top of the work tree and --relative strips nothing. Find the repository from here instead
# (git then gives the hook an absolute GIT_INDEX_FILE, which still holds).
unset GIT_DIR GIT_WORK_TREE
IFS=$nl
# shellcheck disable=SC2086 # one pathspec per line, globbing off
files=$(git -c core.quotePath=false diff --cached --name-only --diff-filter=ACMR --relative -- $specs) || exit 1
unset IFS
status=0
batch=
len=0
# run <command> [arg...]: runs the command with the names gathered so far.
run() {
  [ -n "$batch" ] || return 0
  (
    IFS=$nl
    # shellcheck disable=SC2086 # one name per line, globbing off
    set -- "$@" $batch
    unset IFS
    "$@"
  ) || status=1
  batch=
  len=0
}
IFS=$nl
for f in $files; do
  unset IFS
  case $f in
    \"*)
      # git quotes a name holding a ", a \ or a control character: passed on, it would match no
      # file and the check would pass without reading it.
      echo "staged-files: cannot check $f (rename it, or commit with LEFTHOOK=0)" >&2
      exit 1
      ;;
    *[%'&|<>^!']*)
      if [ -n "$windows" ]; then
        echo "staged-files: cannot check $f on Windows, cmd.exe would read & % ^ ! | < > in it (rename it, or commit with LEFTHOOK=0)" >&2
        exit 1
      fi
      ;;
  esac
  # Bytes, not characters: bash counts characters in a UTF-8 locale.
  n=$(LC_ALL=C && echo $((${#f} + 3)))
  if [ -n "$batch" ] && [ $((len + n)) -gt $maxlen ]; then
    run "$@"
  fi
  batch="$batch$nl./$f"
  len=$((len + n))
  IFS=$nl
done
unset IFS
run "$@"
exit $status
