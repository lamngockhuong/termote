#!/bin/sh
# pre-commit check (lefthook.yml): lists the given Go files gofmt would change and fails when
# there are any (gofmt -l itself exits 0). A file here and not inline in lefthook.yml because
# lefthook on Windows passes `run` to sh without escaping double quotes.
out=$(gofmt -l "$@") || exit 1
[ -z "$out" ] || { echo "$out"; echo "gofmt: run gofmt -w on the files above (under server/)"; exit 1; }
