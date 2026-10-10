# Security model

What Termote protects, what it does not, and what to do when a device is lost. The technical detail
behind each point is in [`system-architecture.md`](system-architecture.md).

## Termote is a remote shell, by design

Whoever signs in with full access has the rights of the OS user that runs the server: they run commands,
read and change files, read the saved password (`termote show-password`), change the configuration
(`termote start --no-auth`) and pair more devices, from the interface or by typing `termote pair` in a
terminal. A device paired from a terminal shows as "Not paired by a device", like one paired with the
password.

No setting turns a full-access client into something less. The real boundary is the OS user: to limit
what Termote can reach, run it as another user with less access.

## Who can do what

| Signed in as             | Can                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| The password             | Everything (full).                                                                                                                                    |
| A full device            | Everything the password can, except pairing another full device: it pairs view-only devices only.                                                     |
| A view-only device       | Watch the terminal, read the Chat view and Files/Changes inside a git repository. It types nothing and changes nothing, but reads everything printed. |
| Anyone, with `--no-auth` | Everything, as soon as they reach the port.                                                                                                           |

## What the server enforces

- It listens on `127.0.0.1` unless started with `--lan`.
- Requests naming an unknown host are refused; writes and the terminal stream must come from the
  Termote page itself, and the stream needs a single-use token.
- Failed sign-ins and wrong pairing codes are rate limited.
- A view-only device is refused every write on the server, not only hidden buttons in the interface.
- A Content-Security-Policy keeps the page from loading or running code from elsewhere.
- A paired device can carry a time limit (30 days by default when pairing): past it, the device is
  refused and its open terminals close. A device paired by one with a limit never outlasts it.
- Revoking a device also revokes every device it paired. Logging out on a device revokes only that
  device.
- Only the password (a password sign-in, or `termote pair` on the server) pairs a full device.
- Pairing, revoking, a device reaching its limit and signing in on the sign-in form each leave an
  `audit:` line in the server log.

## What it cannot prevent

- **A full device used on purpose.** It has a shell: it can read the password, pair devices from a
  terminal, edit the devices file or turn sign-in off. The limits above stop mistakes and clicks in the
  interface, not someone who means it.
- **Secrets printed in a terminal.** A view-only device reads whatever an agent or a command printed.
- **Other services on the same host name.** A cookie is not bound to a port: every service on that name
  receives Termote's cookies. Give Termote a host name of its own.
- **Programs of the same OS user.** Anything else running as that user reads the same files Termote does.
- **Plain HTTP.** Without HTTPS (Tailscale, or a proxy with a certificate), the password and cookies cross
  the network in clear text.
- **The audit lines are not proof.** `termote logs clean`, or any full device, deletes them. Behind a
  proxy (`tailscale serve`) the address they name is the proxy's, loopback.
- **Two servers on one state dir** (the service and a `termote serve` started by hand). A revoke in one
  does not close the terminals open in the other; the other refuses the device from its next request.

## Recommendations

- Use HTTPS: `termote start --tailscale <host>`, or a proxy with a certificate.
- Give Termote a host name no other service uses.
- Pair a device view-only unless it must type.
- Keep the default 30-day limit; choose Never only for your own computers.
- Look at `termote devices` from time to time, and revoke what you no longer use.
- Read the `audit:` lines with `termote logs` (native) or `termote container logs` (container).

## If a device is lost

- **View-only:** revoke it in Settings > Devices or with `termote devices revoke <id>`.
- **Full:** revoke it, then run `termote start --fresh`: it sets a new password, which signs out every
  device and every session. A full device had a shell, so also check what it could have left behind:
  `~/.ssh/authorized_keys`, `crontab -l`, and the service units and login scripts of your user.

## Reporting a vulnerability

Report it privately through [GitHub Security Advisories](https://github.com/lamngockhuong/termote/security/advisories/new),
not in a public issue.
