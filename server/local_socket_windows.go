package main

import (
	"net"
	"os"
	"strconv"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// localPipeName is the named pipe of the server on port, for the current
// user: \\.\pipe\termote-<SID>-<port>.
func localPipeName(port string) (string, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return `\\.\pipe\termote-` + u.User.Sid.String() + "-" + port, nil
}

// ensureSocketDir makes dir, where the CLI writes its sign-in link files,
// open to its owner only (not the Administrators %LOCALAPPDATA% lets in),
// like the saved config.
func ensureSocketDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return restrictToOwner(dir)
}

// openLocalSocket listens on the named pipe for port (dir is unused). The
// pipe is owned by the current user (named, not the default owner, which is
// the Administrators group for an elevated process) and its ACL lets only
// that user and SYSTEM open it; go-winio refuses remote clients
// (FILE_PIPE_REJECT_REMOTE_CLIENTS). The first instance is created
// exclusively, so a pipe of the same name already there (another server on
// the port, or one another user made first) fails it, and the CLI then
// refuses that pipe as untrusted or uses it for the server that owns it. A
// pipe goes away with its last handle: there is nothing to clean.
func openLocalSocket(_, port string) (net.Listener, func(), error) {
	name, err := localPipeName(port)
	if err != nil {
		return nil, nil, err
	}
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, nil, err
	}
	sid := u.User.Sid.String()
	sddl := "O:" + sid + "D:P(A;;GA;;;" + sid + ")(A;;GA;;;SY)"
	ln, err := winio.ListenPipe(name, &winio.PipeConfig{SecurityDescriptor: sddl})
	if err != nil {
		return nil, nil, err
	}
	return ln, func() {}, nil
}

// pipeOwner returns the owner of the pipe object behind handle h. Only an
// administrator can make another user, or SYSTEM, the owner of an object it
// creates. Tests replace it.
var pipeOwner = func(h windows.Handle) (*windows.SID, error) {
	sd, err := windows.GetSecurityInfo(h, windows.SE_KERNEL_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return nil, err
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		return nil, errLocalServerUntrusted
	}
	return owner.Copy()
}

// pipeServerTrusted reports whether the pipe behind handle h is owned by the
// current user or SYSTEM: the pipe object itself, not the process serving
// it, whose PID another process may hold by the time it is looked up.
func pipeServerTrusted(h windows.Handle) bool {
	owner, err := pipeOwner(h)
	if err != nil {
		return false
	}
	self, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return false
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return false
	}
	return windows.EqualSid(owner, self.User.Sid) || windows.EqualSid(owner, system)
}

// dialLocalServerOS connects to the named pipe for port (dir is unused) and
// checks the pipe is owned by the current user or SYSTEM: any user can
// create a pipe of any free name.
func dialLocalServerOS(_ string, port int) (net.Conn, error) {
	name, err := localPipeName(strconv.Itoa(port))
	if err != nil {
		return nil, err
	}
	timeout := localDialTimeout
	c, err := winio.DialPipe(name, &timeout)
	if err != nil {
		return nil, err
	}
	f, ok := c.(interface{ Fd() uintptr })
	if !ok || !pipeServerTrusted(windows.Handle(f.Fd())) {
		c.Close()
		return nil, errLocalServerUntrusted
	}
	return c, nil
}
