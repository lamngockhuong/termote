package main

import (
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// A command that lists untracked files (status, ls-files -o) has git look
// into every untracked folder for a nested repository: it reads a .git file
// there and looks at the git dir it names, a share included, and nothing in
// git turns that off. So on Windows, before such a command, the work tree
// is walked for nested repositories, each checked as the repository itself
// is (checkGitDir).

// repoTreeMaxDirs bounds the folders walked for nested repositories; a work
// tree with more is refused rather than handed to git unchecked.
const repoTreeMaxDirs = 20000

// errRepoTreeTooLarge: the work tree has more folders than repoTreeMaxDirs.
var errRepoTreeTooLarge = errors.New("work tree has too many folders to check for nested repositories")

// checkRepoTree is errDirNotAvailable when, on Windows, the work tree of
// root holds a nested repository that must not be handed to git
// (nestedRepoRefused). Kept as checkRepoRoot's answer is, and forgotten with
// it.
func (rr *rootResolver) checkRepoTree(root string) error {
	if !rr.windows {
		return nil
	}
	_, err := rr.repoChecks.do(root+"\x00tree", func() (struct{}, error) {
		abs, err := filepath.Abs(root)
		if err == nil {
			abs, err = evalSymlinks(abs)
		}
		if err == nil {
			err = rr.nestedRepoRefused(abs)
		}
		if err != nil {
			log.Printf("files: the work tree of %s is not handed to git: %v", root, err)
			return struct{}{}, errDirNotAvailable
		}
		return struct{}{}, nil
	})
	return err
}

// nestedRepoRefused walks the work tree dir is in (from its top: status
// looks at the whole of it) and reports why a nested repository there must
// not be handed to git, or nil. Like git, it never follows a link to a
// folder and never looks inside a .git entry (any case); it walks ignored
// folders too, which git skips, so it refuses no less than git would read.
// dir has been through evalSymlinks.
func (rr *rootResolver) nestedRepoRefused(dir string) error {
	top, err := rr.workTreeTop(dir)
	if err != nil || top == "" {
		return err
	}
	queue, seen := []string{top}, 0
	for len(queue) > 0 {
		d := queue[0]
		queue = queue[1:]
		if seen++; seen > repoTreeMaxDirs {
			return errRepoTreeTooLarge
		}
		entries, err := os.ReadDir(d)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrPermission) {
				continue // git skips a folder it cannot read too
			}
			return err
		}
		for _, e := range entries {
			if strings.EqualFold(e.Name(), ".git") {
				if d != top {
					if err := rr.checkNested(d); err != nil {
						return err
					}
				}
				continue
			}
			if e.IsDir() {
				queue = append(queue, filepath.Join(d, e.Name()))
			}
		}
	}
	return nil
}

// checkNested checks the repository git may find at d, a folder of the work
// tree holding a .git entry.
func (rr *rootResolver) checkNested(d string) error {
	gitDir, err := rr.gitDirAt(d)
	if err != nil || gitDir == "" {
		return err
	}
	_, err = rr.checkGitDir(gitDir, d)
	return err
}

// workTreeTop is the top of the work tree dir is in: the nearest folder,
// dir or above, with a .git entry; "" when there is none.
func (rr *rootResolver) workTreeTop(dir string) (string, error) {
	for d := dir; ; {
		if _, err := os.Lstat(filepath.Join(d, ".git")); err == nil {
			return d, nil
		} else if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(d)
		if parent == d {
			return "", nil
		}
		d = parent
	}
}
