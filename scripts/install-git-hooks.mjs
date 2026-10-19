// Installs the git hooks from the root `prepare` script. Mirrors lefthook's own
// postinstall: never in CI unless LEFTHOOK is set, never with LEFTHOOK=0, never outside a git
// worktree (a tarball, an extracted archive), and it never makes `pnpm install` fail.
//
// The hooks are written here rather than by `lefthook install`: each runs lefthook only while
// the files that decide what it runs match the trusted branch, origin/HEAD or else main: the
// lefthook config, scripts/check-gofmt.sh and scripts/staged-files.sh, the dprint config (its
// plugins can be programs), the npm and pnpm config and package.json files `pnpm exec` and `npx`
// read, and any tracked file under node_modules (git replaces an ignored file with a branch's
// tracked one, so a branch could bring its own node_modules/.bin/lefthook). On a branch that
// changed one of them, the hook says which and skips, so a contributor's branch does not run its
// own hook code on a maintainer's machine at the next commit or push. With core.hooksPath set
// (often one dir shared by every repository) nothing is installed.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const enabled = (value) => Boolean(value) && value !== "0" && value !== "false";
const { CI, LEFTHOOK } = process.env;
if (LEFTHOOK === "0" || LEFTHOOK === "false" || (enabled(CI) && !enabled(LEFTHOOK))) {
  process.exit(0);
}

const git = (...args) => spawnSync("git", args, { encoding: "utf8" });
const inside = git("rev-parse", "--is-inside-work-tree");
if (inside.status !== 0 || inside.stdout.trim() !== "true") {
  process.exit(0);
}

// The hooks lefthook.yml defines
const HOOKS = ["pre-commit", "pre-push"];

const hooksPath = git("config", "core.hooksPath").stdout.trim();
if (hooksPath) {
  console.warn(`[WARN] core.hooksPath is set (${hooksPath}); git hooks not installed.`);
  process.exit(0);
}

const hookScript = (hook) => `#!/bin/sh
# termote: installed by scripts/install-git-hooks.mjs (pnpm install); edit that file, not this one.
# Runs lefthook only while the files that decide what it runs match the trusted branch.
if [ "$LEFTHOOK" = "0" ] || [ "$LEFTHOOK" = "false" ]; then
  exit 0
fi
top=$(git rev-parse --show-toplevel) || exit 0
ref=
for r in refs/remotes/origin/HEAD refs/heads/main; do
  if git rev-parse -q --verify "$r^{commit}" >/dev/null; then
    ref=$r
    break
  fi
done
if [ -z "$ref" ]; then
  echo "git hooks: ${hook} skipped: no origin/HEAD or main to compare the hook files with" >&2
  exit 0
fi
changed=$(git -C "$top" diff --name-only "$ref" -- ':(glob)lefthook*' ':(glob).lefthook*' \\
  ':(glob).config/lefthook*' scripts/check-gofmt.sh scripts/staged-files.sh ':(glob)**/dprint.json*' \\
  ':(glob)**/.dprint.json*' ':(glob)**/.npmrc' ':(glob)**/pnpm-workspace.yaml' ':(glob)**/.pnpmfile.*' package.json \\
  pwa/package.json ':(glob)**/node_modules' ':(glob)**/node_modules/**') || {
  echo "git hooks: ${hook} skipped: cannot compare the hook files with \${ref#refs/*/}" >&2
  exit 0
}
if [ -n "$changed" ]; then
  echo "git hooks: ${hook} skipped: these files differ from \${ref#refs/*/}:" >&2
  echo "$changed" | sed 's/^/  /' >&2
  echo "Read their diff, then run the checks with: pnpm exec lefthook run ${hook}" >&2
  exit 0
fi
bin="$top/node_modules/.bin/lefthook"
if [ ! -x "$bin" ]; then
  echo "git hooks: ${hook} skipped: lefthook is not installed here (run pnpm install)" >&2
  exit 0
fi
LEFTHOOK_CONFIG="$top/lefthook.yml" exec "$bin" run --no-auto-install ${hook} "$@"
`;

try {
  let dir = git("rev-parse", "--git-path", "hooks").stdout.trim();
  if (!isAbsolute(dir)) dir = join(process.cwd(), dir);
  mkdirSync(dir, { recursive: true });
  for (const hook of HOOKS) {
    const path = join(dir, hook);
    if (existsSync(path)) {
      const old = readFileSync(path, "utf8");
      // Every hook lefthook or this script writes names lefthook; any other is the user's own
      if (!/lefthook/i.test(old)) {
        console.warn(`[WARN] ${path} is not a lefthook hook; left as it is.`);
        continue;
      }
    }
    writeFileSync(path, hookScript(hook));
    chmodSync(path, 0o755);
  }
} catch (err) {
  console.warn(`[WARN] git hooks not installed: ${err.message}`);
}
