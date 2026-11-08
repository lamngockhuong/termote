# Security Policy

## Supported Versions

| Version               | Supported                                           |
| --------------------- | --------------------------------------------------- |
| Latest stable release | Yes; fixes ship in a new release (`termote update`) |
| 0.x                   | Security and critical fixes only                    |

## Reporting a Vulnerability

Report it privately through
[GitHub Security Advisories](https://github.com/lamngockhuong/termote/security/advisories/new), never in a public
issue, pull request or discussion. Include the version (`termote version`), the platform, the mode (native or
container, and the terminal backend) and the steps that show the problem.

## Scope

Termote is a remote shell by design: whoever signs in with full access can do what the OS user running the server
can. The [security model](https://termote.ohnice.app/usage/security/) says what it protects and what it cannot. A
report is in scope when it gets past one of the boundaries Termote does enforce:

- Reaching a terminal, a file or any API without signing in, or keeping access after signing out, a revoked device
  or a new password.
- Getting past the Host allowlist, the Origin and same-site checks on writes, the terminal stream's token, or the
  sign-in rate limit.
- A view-only device that can type, change anything, or read what view-only hides.
- Reading or writing a path outside the pane's directory or a Place, or one on the deny lists (Termote's own config
  and state, `.git`, `/proc`, `/sys`, `/dev`), or a file marked sensitive without the confirmation.
- Another OS user of the same machine reaching your Termote (native Linux and Windows) without
  `--allow-local-user`.
- The password ending up in a command line, a service file, a log or a response.
- Text from the browser reaching a shell through tmux, Herdr, Zellij, herdr-core or git.
- The installer or `termote update` installing a release whose checksum or signature does not verify.

Out of scope, because Termote does not promise it:

- What a client signed in with full access does: run commands, read or change files, change the configuration.
- Setups the docs warn against: `--no-auth`, or Termote open to the Internet without HTTPS or Cloudflare Access.
- Attacks that need your OS account or root on the machine.
- A secret in a file whose name looks ordinary: the sensitive-file warning goes by names.
- Another service on the same host name receiving Termote's cookie: give Termote a host name of its own.
- Missing headers on termote.ohnice.app or its demo with no shown impact, and denial of service by volume.
