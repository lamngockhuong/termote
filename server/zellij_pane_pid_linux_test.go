package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// unixDiagMsg builds one sock_diag reply: a socket inode bound to the file
// (vfsIno, vfsDev).
func unixDiagMsg(inode, vfsIno, vfsDev uint32) []byte {
	m := make([]byte, nlmsgHdrLen+unixDiagMsgLen+12)
	binary.NativeEndian.PutUint32(m[0:], uint32(len(m)))
	binary.NativeEndian.PutUint16(m[4:], unix.SOCK_DIAG_BY_FAMILY)
	p := m[nlmsgHdrLen:]
	p[0] = unix.AF_UNIX
	binary.NativeEndian.PutUint32(p[4:], inode)
	a := p[unixDiagMsgLen:]
	binary.NativeEndian.PutUint16(a[0:], 12)
	binary.NativeEndian.PutUint16(a[2:], unixDiagVFS)
	binary.NativeEndian.PutUint32(a[4:], vfsIno)
	binary.NativeEndian.PutUint32(a[8:], vfsDev)
	return m
}

func TestParseUnixDiagDump(t *testing.T) {
	done := make([]byte, nlmsgHdrLen)
	binary.NativeEndian.PutUint32(done[0:], nlmsgHdrLen)
	binary.NativeEndian.PutUint16(done[4:], unix.NLMSG_DONE)
	var buf []byte
	buf = append(buf, unixDiagMsg(111, 5, 9)...)
	buf = append(buf, unixDiagMsg(222, 7, 9)...)
	buf = append(buf, unixDiagMsg(333, 7, 8)...)
	var found []uint32
	end, err := parseUnixDiagDump(buf, 7, 9, &found)
	if err != nil || end || len(found) != 1 || found[0] != 222 {
		t.Fatalf("found %v, end %v, err %v", found, end, err)
	}
	if end, err := parseUnixDiagDump(done, 7, 9, &found); err != nil || !end {
		t.Fatalf("NLMSG_DONE: end %v err %v", end, err)
	}
	if _, err := parseUnixDiagDump(buf[:nlmsgHdrLen+3], 7, 9, &found); err == nil {
		t.Fatal("a cut message was taken")
	}
}

// TestZellijRealPaneShellAndChat: the pane's shell is found under the server
// listening on the session's socket, also after a rename; a stand-in Claude
// Code in a pane gets the Chat view and a message pasted through a Termote
// client.
func TestZellijRealPaneShellAndChat(t *testing.T) {
	m := realZellij(t)
	ctx := t.Context()
	snap, err := m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	g := zellijGroupNamed(t, snap, "main")
	pid, ok := zellijPaneShell("main", 0, true)
	if !ok {
		t.Fatal("pane 0's shell not found")
	}
	if env, _ := procNULFields(pid, "environ"); zellijEnvValue(env, "ZELLIJ_PANE_ID") != "0" {
		t.Fatalf("pid %d is not pane 0's shell", pid)
	}

	fixture, err := filepath.Abs(filepath.Join("..", "tests", "fixtures", "fake-claude.sh"))
	if err != nil {
		t.Fatal(err)
	}
	claudeDir := filepath.Join(t.TempDir(), "claude")
	before, _ := zellijPanes(ctx, "main")
	out, _ := zellijAction(ctx, "main", "new-pane", "--no-focus", "--", "env", "CLAUDE_CONFIG_DIR="+claudeDir, "bash", fixture)
	n, err := strconv.Atoi(strings.TrimPrefix(strings.TrimSpace(string(out)), "terminal_"))
	if err != nil {
		// Zellij lost the output: the new terminal pane is the one not
		// listed before.
		after, _ := zellijPanes(ctx, "main")
		for _, p := range after {
			if !p.IsPlugin && !slices.ContainsFunc(before, func(b zellijPaneInfo) bool { return !b.IsPlugin && b.ID == p.ID }) {
				n, err = p.ID, nil
			}
		}
		if err != nil {
			t.Fatalf("new-pane printed %q", out)
		}
	}
	paneID := zellijPaneID("main", n)
	var agent *AgentInfo
	zellijWaitFor(t, "the agent in the snapshot", func() bool {
		snap, err := m.Snapshot(ctx)
		if err != nil {
			return false
		}
		for _, tab := range zellijGroupNamed(t, snap, "main").Tabs {
			for _, p := range tab.Panes {
				if p.ID == paneID && p.Agent != nil {
					agent = p.Agent
					return true
				}
			}
		}
		return false
	})
	if agent.Name != "claude" {
		t.Fatalf("agent = %+v", agent)
	}
	s, ok, err := m.AgentSessionNow(ctx, paneID)
	if err != nil || !ok || s.Agent != "claude" || s.Target != paneID {
		t.Fatalf("AgentSessionNow = %+v %v %v", s, ok, err)
	}
	if err := m.Paste(ctx, paneID, "hello from termote"); err != nil {
		t.Fatal(err)
	}
	if err := m.SendKeySequence(ctx, paneID, []string{"Enter"}); err != nil {
		t.Fatal(err)
	}
	zellijWaitFor(t, "the message in the transcript", func() bool {
		files, _ := filepath.Glob(filepath.Join(claudeDir, "projects", "*", "*.jsonl"))
		for _, f := range files {
			if b, _ := os.ReadFile(f); strings.Contains(string(b), "hello from termote") {
				return true
			}
		}
		return false
	})

	// A rename keeps the server and its panes: still found.
	if err := m.RenameGroup(ctx, zellijGroupID("main"), "x"); err == nil {
		t.Fatal("main renamed")
	}
	other, err := m.NewGroup(ctx, "before", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	beforePID, ok := zellijPaneShell("before", 0, true)
	if !ok {
		t.Fatal("new session's shell not found")
	}
	if err := m.RenameGroup(ctx, other, "after"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if got, ok := zellijPaneShell("after", 0, true); !ok || got != beforePID {
		t.Fatalf("after a rename: %d %v, want %d", got, ok, beforePID)
	}
	_ = g
}
