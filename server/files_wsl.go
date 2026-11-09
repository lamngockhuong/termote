package main

import (
	"context"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// wslTimeout bounds each wslpath call at startup and each explorer.exe run.
const wslTimeout = 10 * time.Second

var (
	errWSLUnavailable = &codedError{"unavailable", "Windows cannot be reached from here", http.StatusNotImplemented}
	errWSLSensitive   = &codedError{"sensitive", "sensitive file; reveal to open it", http.StatusForbidden}
	errWSLNotFile     = &codedError{"not_file", "not a file or folder", http.StatusBadRequest}
	errWSLBusy        = &codedError{"busy", "too many files at once; try again", http.StatusTooManyRequests}
)

// wslWindows is how Windows names this WSL distribution's files, read once
// at startup; the zero value (not WSL, or a container under it) names none.
type wslWindows struct {
	// distro is the share of the distribution's root, without its trailing
	// backslash: `\\wsl.localhost\Ubuntu` (`\\wsl$\Ubuntu` on older WSL).
	distro string
	// mounts is where the Windows drives are mounted, with its trailing
	// slash ("/mnt/"): /mnt/c/x is C:\x, not the distribution's share.
	mounts string
	// explorer is explorer.exe as Linux reaches it, "" when Windows
	// programs cannot run here (interop off).
	explorer string
}

// Test hooks: wslRun runs wslpath (and explorer.exe, without output);
// wslInteropFiles say whether Windows programs may run.
var (
	wslRun = func(ctx context.Context, name string, args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, name, args...)
		// Not under a share: a Windows program would start in its own dir
		cmd.Dir = "/"
		out, err := cmd.Output()
		return string(out), err
	}
	wslInteropFiles = []string{"/proc/sys/fs/binfmt_misc/WSLInterop", "/proc/sys/fs/binfmt_misc/WSLInterop-late"}
)

// detectWSLWindows reads how Windows names this distribution's files: only
// under WSL and outside a container (systemScope), never from the
// environment (WSL_DISTRO_NAME is not set for a systemd service).
func detectWSLWindows(scope string) wslWindows {
	if scope != scopeWSL {
		return wslWindows{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), wslTimeout)
	defer cancel()
	root, err := wslRun(ctx, "wslpath", "-w", "/")
	root = strings.TrimRight(strings.TrimSpace(root), `\`)
	if err != nil || !strings.HasPrefix(root, `\\`) || strings.ContainsAny(root, "\r\n") {
		log.Printf("wsl: no Windows path for this distribution")
		return wslWindows{}
	}
	out := wslWindows{distro: root}
	// C:\ is mounted at <mounts>c/, /mnt/ unless wsl.conf moved it
	if c, err := wslRun(ctx, "wslpath", "-u", `C:\`); err == nil {
		c = strings.TrimSpace(c)
		if m, ok := strings.CutSuffix(strings.TrimSuffix(c, "/"), "/c"); ok && strings.HasPrefix(m, "/") {
			out.mounts = strings.TrimSuffix(m, "/") + "/"
		}
	}
	if out.mounts != "" && wslInteropOn() {
		exe := out.mounts + "c/Windows/explorer.exe"
		if fi, err := os.Stat(exe); err == nil && fi.Mode().IsRegular() {
			out.explorer = exe
		}
	}
	return out
}

// wslInteropOn: a binfmt entry for Windows programs is registered and on.
func wslInteropOn() bool {
	for _, p := range wslInteropFiles {
		if b, err := os.ReadFile(p); err == nil && strings.HasPrefix(string(b), "enabled") {
			return true
		}
	}
	return false
}

// windowsPath is how Windows names the absolute Linux path p: a drive path
// for one under the drives' mount (/mnt/c/x → C:\x), else one under the
// distribution's share. "" when this server names none.
func (w wslWindows) windowsPath(p string) string {
	if w.distro == "" || !strings.HasPrefix(p, "/") {
		return ""
	}
	if w.mounts != "" {
		if rest, ok := strings.CutPrefix(p, w.mounts); ok && len(rest) >= 1 {
			d := rest[0]
			if ((d >= 'a' && d <= 'z') || (d >= 'A' && d <= 'Z')) && (len(rest) == 1 || rest[1] == '/') {
				return strings.ToUpper(string(d)) + `:\` + strings.ReplaceAll(strings.TrimPrefix(rest[1:], "/"), "/", `\`)
			}
		}
	}
	if p == "/" {
		return w.distro + `\`
	}
	return w.distro + strings.ReplaceAll(p, "/", `\`)
}

type openWindowsRequest struct {
	Path   string `json:"path"`
	Reveal bool   `json:"reveal"`
}

// handleOpenWindows serves POST files/open-windows?root=: Windows opens a
// file or folder under the root with its default program (a page in the
// browser, a folder in Explorer), on the machine the server runs on: never
// for another termote over the machine bridge, whose user sits elsewhere.
// writeGuard has refused a cross-site or non-JSON POST already.
func (f *filesAPI) handleOpenWindows(w http.ResponseWriter, r *http.Request) {
	var in openWindowsRequest
	req, cancel, ok := f.startJSONWrite(w, r, "files open-windows", &in)
	if !ok {
		return
	}
	defer cancel()
	if f.wsl.explorer == "" || isBridge(r.Context()) {
		f.error(w, "files open-windows", errWSLUnavailable)
		return
	}
	select {
	case f.rawSlots <- struct{}{}:
		defer func() { <-f.rawSlots }()
	default:
		f.error(w, "files open-windows", errWSLBusy)
		return
	}
	rel, winPath, err := f.checkOpenWindows(req.root, in)
	if err != nil {
		f.error(w, "files open-windows", err)
		return
	}
	by, via := auditWho(r)
	auditf("open-windows", "path", filepath.ToSlash(rel), "by", by, "via", via)
	ctx, stop := context.WithTimeout(context.Background(), wslTimeout)
	defer stop()
	// explorer.exe exits 1 when it handed the file on, as when it did not:
	// only a program that never ran is an error.
	if _, err := wslRun(ctx, f.wsl.explorer, winPath); err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			f.error(w, "files open-windows", err)
			return
		}
	}
	jsonOK(w, map[string]string{"path": filepath.ToSlash(rel)})
}

// checkOpenWindows checks rel under root as a download does, a folder
// allowed too: not denied, no symlink or junction on the way or at the end,
// a sensitive name only with reveal. It answers the Windows path to open.
func (f *filesAPI) checkOpenWindows(root filesRoot, in openWindowsRequest) (string, string, error) {
	rel, err := cleanRelPath(in.Path)
	if err != nil {
		return "", "", err
	}
	if f.createDenied(root, rel) {
		return "", "", errCreateNotAllowed
	}
	if rel != "." {
		rt, err := os.OpenRoot(root.Root)
		if err != nil {
			return "", "", err
		}
		defer rt.Close()
		parent, err := f.walkParents(rt, root, filepath.Dir(rel), false)
		if err != nil {
			return "", "", deleteError(err)
		}
		defer parent.Close()
		fi, err := parent.Lstat(filepath.Base(rel))
		if err != nil {
			return "", "", deleteError(err)
		}
		if fi.Mode()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
			return "", "", errCreateSymlink
		}
		if !fi.Mode().IsRegular() && !fi.IsDir() {
			return "", "", errWSLNotFile
		}
		if sensitivePath(root.Root, rel) && !in.Reveal {
			return "", "", errWSLSensitive
		}
	}
	winPath := f.wsl.windowsPath(filepath.ToSlash(filepath.Join(root.Root, rel)))
	// Never a switch of explorer.exe, nor a line break in its command line
	if winPath == "" || strings.HasPrefix(winPath, "/") || strings.ContainsAny(winPath, "\x00\r\n\"") {
		return "", "", errWSLNotFile
	}
	return rel, winPath, nil
}

// wslTreeFields fills what the tree answer says about Windows: the root as
// Windows names it, and whether this client may open a file there. Nothing
// for another termote over the machine bridge: the path names a file of
// this machine, not of the device its user holds.
func (f *filesAPI) wslTreeFields(res *treeResponse, root string, viewOnly, bridged bool) {
	if bridged {
		return
	}
	res.WindowsRoot = f.wsl.windowsPath(filepath.ToSlash(root))
	res.WindowsOpen = res.WindowsRoot != "" && f.wsl.explorer != "" && !viewOnly
}
