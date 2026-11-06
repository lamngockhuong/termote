package main

import (
	"fmt"
	"io"
	"path/filepath"
)

// cmdBridge joins stdin and stdout to the machine bridge of the server
// running here. It is the forced command of the key another termote
// installed (`termote machine add`), never typed by hand: it reads no
// SSH_ORIGINAL_COMMAND and runs nothing else. --socket-dir is fixed in that
// command, since sshd's environment may not give the XDG_STATE_HOME the
// service runs with. Before any HTTP byte it writes the greeting line, so the
// other end can tell it from a shell that answered instead.
func (c *cli) cmdBridge(args []string) error {
	var socketDir string
	fs := c.newFlagSet("bridge")
	fs.StringVar(&socketDir, "socket-dir", "", "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) > 0 {
		return usageError("bridge takes no arguments but --socket-dir")
	}
	dir := c.localSocketDir()
	if socketDir != "" {
		if !filepath.IsAbs(socketDir) {
			return usageError("--socket-dir must be an absolute path")
		}
		dir = socketDir
	}
	saved, err := c.loadConfig()
	if err != nil {
		return err
	}
	if saved == nil {
		return fmt.Errorf("no native termote here: run 'termote start' on this machine first")
	}
	conn, err := dialBridgeServer(dir, c.savedPort(saved))
	if err != nil {
		return fmt.Errorf("the termote server is not running here: %v", err)
	}
	defer conn.Close()
	if _, err := fmt.Fprintf(c.out, "%s%s\n", bridgeGreeting, c.version); err != nil {
		return err
	}
	// Whichever side ends first ends the bridge: the server closing an
	// idle connection, or the other termote closing its SSH session.
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(conn, c.in)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(c.out, conn)
		done <- struct{}{}
	}()
	<-done
	return nil
}
