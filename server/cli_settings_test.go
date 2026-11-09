package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestSettingsUsage(t *testing.T) {
	tc := newTestCLI(t, "linux")
	for _, args := range [][]string{{}, {"nope"}, {"schema", "extra"}, {"schema", "--bad"}, {"propose"}, {"propose", "a", "b"}} {
		var ee *exitError
		if err := tc.dispatch("settings", args); !errors.As(err, &ee) || ee.code != 2 {
			t.Errorf("settings %v: %v", args, err)
		}
	}
}

func TestSettingsSchemaCommand(t *testing.T) {
	tc := newTestCLI(t, "linux")
	if err := tc.dispatch("settings", []string{"schema", "--json"}); err != nil {
		t.Fatal(err)
	}
	var s pwaSettingsSchema
	if err := json.Unmarshal(tc.stdout.Bytes(), &s); err != nil || len(s.Keys) != len(pwaSettings.Keys) {
		t.Fatalf("--json: %v %d", err, len(s.Keys))
	}
	tc.stdout.Reset()
	if err := tc.dispatch("settings", []string{"schema"}); err != nil {
		t.Fatal(err)
	}
	out := tc.stdout.String()
	for _, want := range []string{
		"KEY", "editorVim", "true, false", `"light", "dark", "system"`, "6-24", "text, up to 200 bytes",
		"list of folder names, up to 50", "{command: {key, inTerminal} | null}", `["node_modules",".ven...`,
		"Set on the device only, never proposed: welcomeSeenVersion", "notifyAgents", "termote settings propose",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("schema table lacks %q:\n%s", want, out)
		}
	}
}

// A proposal is checked before anything is sent: every bad key with its
// reason, exit 1.
func TestSettingsProposeRefusesBadValues(t *testing.T) {
	tc := newTestCLI(t, "linux")
	err := tc.dispatch("settings", []string{"propose", `{"editorFontSize":99,"zz":1}`})
	var ee *exitError
	if !errors.As(err, &ee) || ee.code != 1 {
		t.Fatalf("err = %v", err)
	}
	out := tc.stderr.String()
	if !strings.Contains(out, "editorFontSize: must be one of") || !strings.Contains(out, "zz: unknown setting") {
		t.Errorf("stderr: %s", out)
	}
	tc.stderr.Reset()
	tc.in = bufio.NewReader(strings.NewReader(`{"editorVim":` + strings.Repeat(" ", maxSettingsProposal) + `true}`))
	if err := tc.dispatch("settings", []string{"propose", "-"}); !errors.As(err, &ee) || ee.code != 1 || !strings.Contains(tc.stderr.String(), "larger than 32 KiB") {
		t.Errorf("stdin too large: %v %s", err, tc.stderr)
	}
	tc.in = bufio.NewReader(iotestErrReader{})
	if err := tc.dispatch("settings", []string{"propose", "-"}); err == nil || !strings.Contains(err.Error(), "reading the proposal") {
		t.Errorf("stdin error: %v", err)
	}
}

type iotestErrReader struct{}

func (iotestErrReader) Read([]byte) (int, error) { return 0, errors.New("broken pipe") }

// The container has no local socket, so it cannot take a proposal.
func TestSettingsProposeContainer(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.saveConfig(savedConfig{Password: "secret", Container: &containerConfig{Port: 7681}})
	err := tc.dispatch("settings", []string{"propose", `{"editorVim":true}`})
	if err == nil || !strings.Contains(err.Error(), "not supported in container mode") || !strings.Contains(err.Error(), "Export and Import") {
		t.Errorf("err = %v", err)
	}
}

func TestPlainText(t *testing.T) {
	if got := plainText("a\u202eb\x1bc\u200dd"); got != "abc\u200dd" {
		t.Errorf("plainText = %q", got)
	}
}
