package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func testMachine(id, label, alias string) machineRecord {
	return machineRecord{ID: id, Label: label, Alias: alias, RemoteExe: "/home/u/.local/share/termote/current/bin/termote",
		SocketDir: "/home/u/.local/state/termote/run", RemoteOS: "linux", AddedAt: time.Unix(0, 0).UTC()}
}

func TestMachineStoreRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cfg", "machines.json")
	if list, err := loadMachines(path); err != nil || list != nil {
		t.Fatalf("missing store: %v %v", list, err)
	}
	want := []machineRecord{testMachine("0123456789abcdef", "Box", "box"), testMachine("fedcba9876543210", "Pi", "pi.lan")}
	if err := saveMachines(path, want); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
			t.Errorf("store mode %v", fi.Mode().Perm())
		}
	}
	got, err := loadMachines(path)
	if err != nil || len(got) != 2 || got[1] != want[1] {
		t.Fatalf("round trip: %+v %v", got, err)
	}
	if findMachine(got, "Pi") != 1 || findMachine(got, "0123456789abcdef") != 0 || findMachine(got, "nope") != -1 {
		t.Error("findMachine by label or id")
	}
	// A label that is another machine's id never stands for that machine.
	clash := []machineRecord{testMachine("0123456789abcdef", "fedcba9876543210", "box"), testMachine("fedcba9876543210", "Pi", "pi.lan")}
	if i := findMachine(clash, "fedcba9876543210"); i != 1 {
		t.Errorf("findMachine by an id another machine has as its label = %d, want 1", i)
	}
	if err := saveMachines(path, nil); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(path); !strings.Contains(string(data), `"machines": []`) {
		t.Errorf("empty store: %s", data)
	}
}

// A store a hand edit broke is refused whole, so nothing it holds reaches
// ssh's argv.
func TestMachineStoreRefusesBadRecords(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]string{
		"json":      `{`,
		"id":        `{"machines":[{"id":"x","label":"a","alias":"a","remoteExe":"/t"}]}`,
		"alias":     `{"machines":[{"id":"0123456789abcdef","label":"a","alias":"-oProxyCommand=x","remoteExe":"/t"}]}`,
		"label":     `{"machines":[{"id":"0123456789abcdef","label":"a\u0007","alias":"a","remoteExe":"/t"}]}`,
		"exe":       `{"machines":[{"id":"0123456789abcdef","label":"a","alias":"a","remoteExe":"/t'x"}]}`,
		"socketDir": `{"machines":[{"id":"0123456789abcdef","label":"a","alias":"a","remoteExe":"/t","socketDir":"rel"}]}`,
		"duplicate": `{"machines":[{"id":"0123456789abcdef","label":"a","alias":"a","remoteExe":"/t"},{"id":"1123456789abcdef","label":"b","alias":"a","remoteExe":"/t"}]}`,
	}
	for name, body := range cases {
		path := filepath.Join(dir, name+".json")
		os.WriteFile(path, []byte(body), 0o600)
		if _, err := loadMachines(path); err == nil {
			t.Errorf("%s: a bad store was read", name)
		}
	}
	many := make([]machineRecord, maxMachines+1)
	if err := saveMachines(filepath.Join(dir, "many.json"), many); err == nil {
		t.Error("more than maxMachines were saved")
	}
	var b strings.Builder
	b.WriteString(`{"machines":[`)
	for i := 0; i <= maxMachines; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{}`)
	}
	b.WriteString(`]}`)
	os.WriteFile(filepath.Join(dir, "toomany.json"), []byte(b.String()), 0o600)
	if _, err := loadMachines(filepath.Join(dir, "toomany.json")); err == nil {
		t.Error("a store over maxMachines was read")
	}
	if _, err := loadMachines(dir); err == nil {
		t.Error("a directory was read as the store")
	}
}

func TestMachineValidation(t *testing.T) {
	for a, ok := range map[string]bool{"box": true, "pi.lan": true, "a_b-c": true, "-o": false, "a b": false, "u@h": false, "h:22": false, "": false, strings.Repeat("a", 65): false} {
		if (validAlias(a) == nil) != ok {
			t.Errorf("validAlias(%q) ok=%v", a, !ok)
		}
	}
	for l, ok := range map[string]bool{"Box": true, "Máy nhà": true, "": false, " x": false, "a\tb": false, strings.Repeat("a", 65): false} {
		if (validLabel(l) == nil) != ok {
			t.Errorf("validLabel(%q) ok=%v", l, !ok)
		}
	}
	id, err := newMachineID()
	if err != nil || !machineIDRe.MatchString(id) {
		t.Errorf("newMachineID = %q %v", id, err)
	}
}

func TestSaveMachinesUnwritableDir(t *testing.T) {
	file := filepath.Join(t.TempDir(), "file")
	os.WriteFile(file, []byte("x"), 0o600)
	if err := saveMachines(filepath.Join(file, "machines.json"), nil); err == nil {
		t.Error("a store under a regular file was saved")
	}
}
