package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// errRemoteLink: a link on the way leads off a local drive.
var errRemoteLink = errors.New("a link leads off a local drive")

// maxLinkHops bounds the links followed for one path, as Windows does.
const maxLinkHops = 63

// evalSymlinks is filepath.EvalSymlinks once every link on the way, and in
// the links it leads to, is known to stay on a drive letter or on the volume
// the path itself is on: following one to \\host\share (a symbolic link a
// repository or an archive can hold) would make Windows open an SMB
// connection and send that host the user's NTLM hash. A path the user named
// on a share (a Place) is theirs to open. Each step is read with Lstat and
// Readlink, which open the link itself, never its target.
func evalSymlinks(p string) (string, error) {
	if err := checkLocalLinks(p); err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(p)
}

func checkLocalLinks(p string) error {
	p, err := filepath.Abs(p)
	if err != nil {
		return err
	}
	start := filepath.VolumeName(p)
	hops := 0
next:
	for {
		vol := filepath.VolumeName(p)
		if hops > 0 && !driveVolume(vol) && !strings.EqualFold(vol, start) {
			return errRemoteLink
		}
		cur := vol + `\`
		rest := strings.Split(strings.Trim(p[len(vol):], `\`), `\`)
		for i, c := range rest {
			if c == "" {
				continue
			}
			at := filepath.Join(cur, c)
			fi, err := os.Lstat(at)
			if err != nil {
				return nil // gone: EvalSymlinks stops here too
			}
			if fi.Mode()&fs.ModeSymlink == 0 {
				cur = at
				continue
			}
			if hops++; hops > maxLinkHops {
				return errRemoteLink
			}
			t, err := os.Readlink(at)
			if err != nil {
				return err
			}
			switch {
			case filepath.VolumeName(t) != "":
			case strings.HasPrefix(t, `\`) || strings.HasPrefix(t, "/"):
				t = vol + t // rooted on the link's own drive
			default:
				t = filepath.Join(cur, t)
			}
			p = filepath.Join(append([]string{t}, rest[i+1:]...)...)
			continue next
		}
		return nil
	}
}

// driveVolume reports whether v (filepath.VolumeName) is a drive letter,
// written plain or in the \\?\ form; a UNC share, \\?\UNC\ or a device
// path is not.
func driveVolume(v string) bool {
	v = strings.TrimPrefix(v, `\\?\`)
	if len(v) != 2 || v[1] != ':' {
		return false
	}
	c := v[0] | 0x20
	return c >= 'a' && c <= 'z'
}
