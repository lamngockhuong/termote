package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// registeredService is fakeService whose registration runs exe.
type registeredService struct {
	*fakeService
	exe string
}

func (r *registeredService) RegisteredExe() (string, bool) { return r.exe, r.exe != "" }

// A service registered from elsewhere (a checkout's dev shim) would keep
// running its own binary after the switch, and the update would roll back:
// it is refused before anything is downloaded or changed.
func TestUpdateRefusesAServiceRunningAnotherBinary(t *testing.T) {
	tc, _, svc := setupUpdate(t)
	tc.testSupervisors = []supervisor{&registeredService{fakeService: svc, exe: "/src/termote/server/termote-dev"}}
	if code := tc.main([]string{"update"}); code != 1 || !strings.Contains(tc.stderr.String(), "the service runs /src/termote/server/termote-dev, not this install") ||
		!strings.Contains(tc.stderr.String(), tc.currentExe()+" start") {
		t.Fatalf("code %d stderr %s", code, tc.stderr.String())
	}
	if fileExists(filepath.Join(tc.versionsDir(), "1.0.1")) || tc.currentVersion() != "1.0.0" || len(svc.calls) != 0 {
		t.Fatalf("the install changed (calls %v)", svc.calls)
	}
}

// A service that runs this install's current binary, under its own path or
// another path to the same file, updates.
func TestUpdateWithTheServiceOfThisInstall(t *testing.T) {
	for _, alias := range []bool{false, true} {
		tc, _, svc := setupUpdate(t)
		exe := tc.currentExe()
		if alias {
			if runtime.GOOS == "windows" {
				continue
			}
			link := filepath.Join(t.TempDir(), "data")
			if err := os.Symlink(tc.dataDir(), link); err != nil {
				t.Fatal(err)
			}
			rel, _ := filepath.Rel(tc.dataDir(), exe)
			exe = filepath.Join(link, rel)
		}
		tc.testSupervisors = []supervisor{&registeredService{fakeService: svc, exe: exe}}
		if code := tc.main([]string{"update"}); code != 0 || tc.currentVersion() != "1.0.1" {
			t.Fatalf("alias %v: code %d stderr %s", alias, code, tc.stderr.String())
		}
	}
}

func TestSystemdRegisteredExe(t *testing.T) {
	tc := newSystemdCLI(t)
	s := &systemdSupervisor{c: tc.cli}
	if _, ok := s.RegisteredExe(); ok {
		t.Fatal("no unit, yet an exe")
	}
	exe := `/home/u/a "b" $c %d\e/termote`
	writeFile(t, s.unitPath(), systemdUnitFile(exe, "/l.log", nil))
	if got, ok := s.RegisteredExe(); !ok || got != exe {
		t.Fatalf("got %q, %v", got, ok)
	}
	writeFile(t, s.unitPath(), "[Service]\nExecStart=/bin/true\n")
	if _, ok := s.RegisteredExe(); ok {
		t.Fatal("unquoted ExecStart taken")
	}
}

func TestLaunchdRegisteredExe(t *testing.T) {
	tc := newTestCLI(t, "darwin")
	l := &launchdSupervisor{c: tc.cli}
	if _, ok := l.RegisteredExe(); ok {
		t.Fatal("no plist, yet an exe")
	}
	exe := "/Users/u/a & <b>/termote"
	writeFile(t, l.plistPath(), launchdPlist(exe, "/l.log", map[string]string{"PATH": "/usr/bin"}))
	if got, ok := l.RegisteredExe(); !ok || got != exe {
		t.Fatalf("got %q, %v", got, ok)
	}
	for _, body := range []string{"<plist></plist>", "<key>ProgramArguments</key><array>", "<key>ProgramArguments</key><string>a &bad; b</string>"} {
		writeFile(t, l.plistPath(), body)
		if got, ok := l.RegisteredExe(); ok {
			t.Errorf("%q: got %q", body, got)
		}
	}
}
