package main

import (
	"context"
	"errors"
	"io"
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
	errWSLName        = &codedError{"windows_name", "Windows would read this path as another; not opened", http.StatusBadRequest}
	errWSLRuns        = &codedError{"runs_program", "Windows runs this file as a program; run to open it", http.StatusForbidden}
	errWSLReaches     = &codedError{"folder_reaches", "the folder holds or sits beside entries Windows may follow to another computer; not opened", http.StatusForbidden}
)

// windowsViews: the extensions, lowercase, of a file Windows opens to show
// it (text, code, a PDF or a picture) with the program installed for it. Any other extension may run: a deny list kept missing
// types Windows or a common program runs on open (.sh with Git for Windows,
// .py with the py launcher, .wsb, a theme, a disk image), so an extension
// not listed here asks first. Left out too: a type whose program acts on
// what the file says as it opens it (Office and RTF fetch a remote template
// or picture, Excel opens a .csv, an .xml names the Office program to open
// it with, a browser opens .html, .svg and .epub, an interpreter may be the
// default program for .lua or .jl, Photoshop and ExtendScript run a .jsx,
// WinGHCi a .hs, and a media player such as VLC reads a sound or a video
// by its content, a playlist naming another computer's share among them;
// .ts and .mts are MPEG transport streams as well as TypeScript),
// and .zip, which Explorer shows as a folder without the folder check.
var windowsViews = map[string]bool{}

func init() {
	for _, ext := range strings.Fields(`
		.txt .text .md .markdown .rst .adoc .log .json .jsonc .json5 .ndjson .yaml .yml .toml
		.css .scss .less .diff .patch .sql .graphql .proto .tex .bib
		.c .h .cc .cpp .cxx .hpp .hh .cs .go .rs .java .kt .kts .scala .swift .m .mm .dart .zig .nim
		.tsx .cts .mjs .cjs .vue .svelte .astro .ex .exs .erl .ml .clj .r
		.png .jpg .jpeg .gif .webp .bmp .ico .tif .tiff .heic .heif .avif
		.pdf`) {
		windowsViews[ext] = true
	}
}

// windowsMayRun: Windows may run the file name when it opens it, unless its
// extension is one it opens to show (windowsViews). An extension holding a
// letter beyond ASCII may run too, whatever it looks like: Windows folds
// case its own way (U+017F, a long s, is an S to it, not to strings.ToLower).
// A name with no extension makes Windows ask which program to open it with.
func windowsMayRun(name string) bool {
	ext := filepath.Ext(name)
	if ext == "" {
		return false
	}
	for i := 0; i < len(ext); i++ {
		if ext[i] >= 0x80 {
			return true
		}
	}
	return !windowsViews[strings.ToLower(ext)]
}

// windowsFolderMayRun: a folder named like x.{CLSID} is a shell object to
// Explorer, not a folder.
func windowsFolderMayRun(name string) bool {
	return strings.HasPrefix(filepath.Ext(name), ".{")
}

// shellFoldersOnWay lists, as absolute paths from the top down, the folders
// on the way to rel under root that are shell objects, whose handler
// Explorer runs to reach what is below them: the root and the folders above
// it included (a pane root can sit in an unpacked archive), rel itself not.
func shellFoldersOnWay(root, rel string) []string {
	var shells []string
	for dir := filepath.Join(root, filepath.Dir(rel)); ; dir = filepath.Dir(dir) {
		if windowsFolderMayRun(filepath.Base(dir)) {
			shells = append([]string{dir}, shells...)
		}
		if filepath.Dir(dir) == dir {
			return shells
		}
	}
}

// shellsOnWayReach reports whether a shell object on the way to rel holds
// an entry windowsReaches names (a Folder Shortcut's target.lnk), or whether
// there are two: run or not, the handler follows it. One under root is read through rt; one above
// it, which only the server's own path names, is opened as a root of its own.
func shellsOnWayReach(rt *os.Root, root, rel string) (bool, error) {
	shells := shellFoldersOnWay(root, rel)
	// Two shell objects on the way, nested at any depth: the inner one's
	// handler runs through the outer one's, which run did not name.
	if len(shells) > 1 {
		return true, nil
	}
	for _, dir := range shells {
		var reaches bool
		var err error
		if under, rerr := filepath.Rel(root, dir); rerr == nil && under != ".." && !strings.HasPrefix(under, ".."+string(filepath.Separator)) {
			reaches, err = folderReaches(rt, under)
		} else {
			var above *os.Root
			if above, err = os.OpenRoot(dir); err == nil {
				reaches, err = folderReaches(above, ".")
				above.Close()
			}
		}
		if reaches || err != nil {
			return reaches, err
		}
	}
	return false, nil
}

// windowsReaches: names of files that make Explorer reach a location they
// name (another computer's share among them) while it only shows the folder
// holding them: their icon, their thumbnail (a theme's wallpaper) or the
// folder's settings come from there. An extension holding a byte beyond
// ASCII counts as one, as for windowsMayRun: `.ſcf` is a .scf to Windows.
func windowsReaches(name string) bool {
	ext := filepath.Ext(name)
	for i := 0; i < len(ext); i++ {
		if ext[i] >= 0x80 {
			return true
		}
	}
	switch strings.ToLower(ext) {
	case ".url", ".lnk", ".scf", ".library-ms", ".searchconnector-ms", ".search-ms", ".website",
		".theme", ".themepack", ".deskthemepack", ".pif", ".settingcontent-ms":
		return true
	}
	return windowsNamesDesktopINI(name)
}

// windowsNamesDesktopINI: Windows may read name as desktop.ini, in any case;
// a letter beyond ASCII stands for any letter, since Windows folds case its
// own way (`desktop.ıni` with a dotless i).
func windowsNamesDesktopINI(name string) bool {
	const want = "desktop.ini"
	i := 0
	for _, r := range name {
		if i == len(want) {
			return false
		}
		if r < 0x80 && !strings.EqualFold(string(r), want[i:i+1]) || r >= 0x80 && want[i] == '.' {
			return false
		}
		i++
	}
	return i == len(want)
}

// windowsFolderEntriesMost bounds the entries read to look for one that
// windowsReaches: a folder holding more, its subfolders' entries counted
// too, is refused, as if it held one.
const windowsFolderEntriesMost = 10000

// folderReaches reports whether the folder dir (under rt) directly holds an
// entry windowsReaches names, or a subfolder holding a desktop.ini (Explorer
// reads a subfolder's own settings and icon to show it), or more entries
// than can be looked at. A shortcut deeper down is not shown, so not read.
func folderReaches(rt *os.Root, dir string) (bool, error) {
	seen := 0
	return folderShows(rt, dir, "", &seen, windowsReaches)
}

// ancestorsReach reports whether a folder Explorer's navigation pane shows
// on the way to the folder rel (under rt) reaches: expanded to it, the pane
// shows each folder from the root down and the folders beside each, and
// reads their desktop.ini to draw them. Folders above the root are the
// user's own, not a repository's.
func ancestorsReach(rt *os.Root, rel string) (bool, error) {
	seen := 0
	for way, dir := rel, filepath.Dir(rel); ; way, dir = dir, filepath.Dir(dir) {
		if reaches, err := folderShows(rt, dir, filepath.Base(way), &seen, windowsNamesDesktopINI); reaches || err != nil {
			return reaches, err
		}
		if dir == "." {
			return false, nil
		}
	}
}

// folderShows reports whether dir directly holds an entry match names, a
// shell object (x.{CLSID}, whose handler Explorer runs to show it), or a
// subfolder holding a desktop.ini, or more entries than can be looked at.
// A shell object named way, the one on the way to the folder opened, is
// left to the question checkOpenWindows asks (run).
// A link to a folder counts as a subfolder, since Windows may follow it. A
// link that cannot be followed inside the root refuses dir, one to nothing
// included (an NT link to another computer's share under /mnt/c may show
// so to Linux), and so does an entry neither a file nor a folder.
func folderShows(rt *os.Root, dir, way string, seen *int, match func(string) bool) (bool, error) {
	var subdirs []string
	reaches, err := readFolderNames(rt, dir, seen, func(e fs.DirEntry) bool {
		if match(e.Name()) || e.Name() != way && windowsFolderMayRun(e.Name()) {
			return true
		}
		switch {
		case e.IsDir():
			subdirs = append(subdirs, e.Name())
		case e.Type()&fs.ModeSymlink != 0:
			fi, err := rt.Stat(filepath.Join(dir, e.Name()))
			if err != nil {
				return true
			}
			if fi.IsDir() {
				subdirs = append(subdirs, e.Name())
			} else if !fi.Mode().IsRegular() {
				return true
			}
		case !e.Type().IsRegular():
			return true
		}
		return false
	})
	if reaches || err != nil {
		return reaches, err
	}
	for _, sub := range subdirs {
		reaches, err := readFolderNames(rt, filepath.Join(dir, sub), seen, func(e fs.DirEntry) bool {
			return windowsNamesDesktopINI(e.Name())
		})
		if reaches || err != nil {
			return reaches, err
		}
	}
	return false, nil
}

// readFolderNames calls match on each entry of dir until it answers true,
// counting the entries in seen; past windowsFolderEntriesMost it answers
// true as well.
func readFolderNames(rt *os.Root, dir string, seen *int, match func(fs.DirEntry) bool) (bool, error) {
	d, err := rt.Open(dir)
	if err != nil {
		return false, err
	}
	defer d.Close()
	for {
		entries, err := d.ReadDir(256)
		for _, e := range entries {
			if match(e) {
				return true, nil
			}
		}
		*seen += len(entries)
		if *seen > windowsFolderEntriesMost {
			return true, nil
		}
		if errors.Is(err, io.EOF) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
	}
}

// windowsReadsAsIs: Windows names the Linux path p as the same file. A `\`
// in a Linux name is a separator to Windows (`..\x` climbs out of the
// root), explorer.exe splits its argument at a comma, `:` names a stream, a
// component ending in a dot or a space loses it (`a.cmd.` is `a.cmd`), and
// `* ? " < > |` and control characters are not allowed in a Windows name.
func windowsReadsAsIs(p string) bool {
	if strings.ContainsAny(p, `\:*?"<>|,`) {
		return false
	}
	for _, r := range p {
		// U+F000 to U+F0FF: WSL shows a Linux name holding one of the
		// characters above to Windows with that character moved there, and
		// moves it back on access, so `d\uF03A` opens the Linux `d:`.
		if r < 0x20 || r >= 0xf000 && r <= 0xf0ff {
			return false
		}
	}
	for _, c := range strings.Split(p, "/") {
		if strings.HasSuffix(c, ".") || strings.HasSuffix(c, " ") {
			return false
		}
	}
	return true
}

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
	// Run: the user confirmed that Windows runs this file as a program
	Run bool `json:"run"`
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
	if in.Run {
		auditf("open-windows", "path", filepath.ToSlash(rel), "run", true, "by", by, "via", via)
	} else {
		auditf("open-windows", "path", filepath.ToSlash(rel), "by", by, "via", via)
	}
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
// a sensitive name only with reveal, a file Windows runs only with run, and
// a path Windows reads as this one. It answers the Windows path to open.
func (f *filesAPI) checkOpenWindows(root filesRoot, in openWindowsRequest) (string, string, error) {
	rel, err := cleanRelPath(in.Path)
	if err != nil {
		return "", "", err
	}
	abs := filepath.ToSlash(filepath.Join(root.Root, rel))
	if !windowsReadsAsIs(abs) {
		return "", "", errWSLName
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
		shells := shellFoldersOnWay(root.Root, rel)
		if !in.Run && (len(shells) > 0 || fi.Mode().IsRegular() && windowsMayRun(rel) || fi.IsDir() && windowsFolderMayRun(rel)) {
			return "", "", errWSLRuns
		}
		// walkParents closed rt; links are followed within the pane root.
		up, err := os.OpenRoot(root.Root)
		if err != nil {
			return "", "", err
		}
		defer up.Close()
		if err := checkReaches(shellsOnWayReach(up, root.Root, rel)); err != nil {
			return "", "", err
		}
		if fi.IsDir() {
			if err := checkReaches(folderReaches(up, rel)); err != nil {
				return "", "", err
			}
			if err := checkReaches(ancestorsReach(up, rel)); err != nil {
				return "", "", err
			}
		}
	} else {
		rt, err := os.OpenRoot(root.Root)
		if err != nil {
			return "", "", err
		}
		defer rt.Close()
		if !in.Run && len(shellFoldersOnWay(root.Root, ".")) > 0 {
			return "", "", errWSLRuns
		}
		if err := checkReaches(shellsOnWayReach(rt, root.Root, ".")); err != nil {
			return "", "", err
		}
		if err := checkReaches(folderReaches(rt, ".")); err != nil {
			return "", "", err
		}
	}
	winPath := f.wsl.windowsPath(abs)
	// Never a switch of explorer.exe, nor a line break in its command line
	if winPath == "" || strings.HasPrefix(winPath, "/") || strings.ContainsAny(winPath, "\x00\r\n\"") {
		return "", "", errWSLNotFile
	}
	return rel, winPath, nil
}

// checkReaches refuses a folder Explorer would reach out of while it shows
// it (folderReaches, ancestorsReach); an error reading it refuses it too.
func checkReaches(reaches bool, err error) error {
	if err != nil {
		log.Printf("files open-windows: %v", err)
		return errWSLReaches
	}
	if reaches {
		return errWSLReaches
	}
	return nil
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
