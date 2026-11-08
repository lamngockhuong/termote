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
can. What it protects, what it cannot, and the recommended setup are in the
[security model](https://termote.ohnice.app/usage/security/). A report that shows a way around sign-in, the Host
allowlist, the Origin checks, the view-only role or the file deny lists is in scope; one that needs a full-access
session to begin with usually is not.
