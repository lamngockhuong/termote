// Installs the lefthook git hooks from the root `prepare` script. Mirrors lefthook's own
// postinstall: never in CI unless LEFTHOOK is set, never with LEFTHOOK=0, never outside a git
// worktree (a tarball, an extracted archive), and it never makes `pnpm install` fail.
import { spawnSync } from "node:child_process";

const enabled = (value) => Boolean(value) && value !== "0" && value !== "false";
const { CI, LEFTHOOK } = process.env;
if (LEFTHOOK === "0" || LEFTHOOK === "false" || (enabled(CI) && !enabled(LEFTHOOK))) {
  process.exit(0);
}

const git = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
if (git.status !== 0 || git.stdout.trim() !== "true") {
  process.exit(0);
}

// One command string through a shell: pnpm is pnpm.cmd on Windows, and an args array with
// `shell: true` is deprecated (DEP0190)
const install = spawnSync("pnpm exec lefthook install", { stdio: "inherit", shell: true });
if (install.status !== 0) {
  console.warn("[WARN] lefthook install failed; run `pnpm exec lefthook install` by hand.");
}
