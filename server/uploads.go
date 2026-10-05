package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Upload limits. An image goes from the PWA to the host so an agent can read
// it by path: the host clipboard is empty when the image sits on a phone.
const (
	uploadMaxFile = 10 << 20
	// uploadMaxTotal and uploadMaxAge bound the dir; files younger than
	// uploadMinAge are never evicted (a composer chip or an unsent terminal
	// line may still point at one), and a stale .part goes after it too.
	uploadMaxTotal = 200 << 20
	uploadMaxAge   = 7 * 24 * time.Hour
	uploadMinAge   = time.Hour
	// uploadConcurrency uploads run at once; the next one gets 429.
	uploadConcurrency = 2
)

// uploadReadTimeout replaces requestReadTimeout for an upload that passed
// auth and got a slot: 10MB in 5 minutes is about 270 kbit/s, a slow mobile
// link. A client without the password keeps the 60s every request gets.
var uploadReadTimeout = 5 * time.Minute

// uploadExts maps the accepted image types to the extension of the saved file.
var uploadExts = map[string]string{
	"image/png":  "png",
	"image/jpeg": "jpg",
	"image/gif":  "gif",
	"image/webp": "webp",
}

// uploadNameRe matches the store's own files, finished or still being
// written; nothing else in the dir is ever touched.
var (
	uploadIDRe   = regexp.MustCompile(`^[0-9a-f]{32}$`)
	uploadNameRe = regexp.MustCompile(`^[0-9a-f]{32}\.(png|jpg|gif|webp)(\.part)?$`)
)

// isUploadType reports whether a media type is one of the accepted images.
func isUploadType(mt string) bool {
	_, ok := uploadExts[mt]
	return ok
}

// uploadError is an upload failure the client is told about, by code.
type uploadError struct {
	code   string
	msg    string
	status int
}

func (e *uploadError) Error() string { return e.msg }

var (
	errUploadUnsupported = &uploadError{"unsupported_image", "only PNG, JPEG, GIF and WebP images are accepted", http.StatusUnsupportedMediaType}
	errUploadTooLarge    = &uploadError{"too_large", "image is larger than 10 MB", http.StatusRequestEntityTooLarge}
	errUploadStorageFull = &uploadError{"storage_full", "upload storage is full; try again later", http.StatusInsufficientStorage}
	errUploadBusy        = &uploadError{"busy", "too many uploads at once; try again", http.StatusTooManyRequests}
	errUploadUnavailable = &uploadError{"uploads_unavailable", "uploads are not available on this server", http.StatusServiceUnavailable}
)

// upload is what the client gets back: the id names the file in a Chat view
// message, insert is what goes into a terminal.
type upload struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	Insert string `json:"insert"`
}

// uploadStore owns the upload dir: naming, lookup, quota and retention.
type uploadStore struct {
	dir      string
	maxFile  int64
	maxTotal int64
	maxAge   time.Duration
	minAge   time.Duration
	sem      chan struct{}
	now      func() time.Time

	// mu covers reserved and every sweep or rename, never a copy.
	mu       sync.Mutex
	reserved int64
}

// uploadDir is where uploads go: the user's cache dir, so the OS may clear it
// and no config or project dir fills up. Empty when there is none.
func uploadDir() string {
	cache, err := os.UserCacheDir()
	if err != nil {
		log.Printf("uploads disabled: %v", err)
		return ""
	}
	return filepath.Join(cache, "termote", "uploads")
}

// newUploadStore creates dir (0700) and refuses one that is a symlink or, on
// Unix, belongs to another user, then sweeps it.
func newUploadStore(dir string) (*uploadStore, error) {
	if dir == "" {
		return nil, errors.New("no upload dir")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	// Lstat: a symlink to a dir is refused too.
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", dir)
	}
	if err := checkPrivateUploadDir(dir); err != nil {
		return nil, err
	}
	s := &uploadStore{
		dir:      dir,
		maxFile:  uploadMaxFile,
		maxTotal: uploadMaxTotal,
		maxAge:   uploadMaxAge,
		minAge:   uploadMinAge,
		sem:      make(chan struct{}, uploadConcurrency),
		now:      time.Now,
	}
	s.mu.Lock()
	s.sweepLocked(0)
	s.mu.Unlock()
	return s, nil
}

// sweepLocked deletes the store's files older than maxAge and stale .part
// files, then the oldest files (never one younger than minAge) until need
// more bytes fit under maxTotal. It returns the bytes the finished files
// still use; a .part of a running upload is covered by its reservation.
func (s *uploadStore) sweepLocked(need int64) int64 {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		log.Printf("uploads: read %s: %v", s.dir, err)
		return 0
	}
	type file struct {
		path string
		size int64
		mod  time.Time
	}
	var files []file
	var used int64
	now := s.now()
	for _, e := range entries {
		if !uploadNameRe.MatchString(e.Name()) {
			continue
		}
		// Info does not follow symlinks; only regular files are the store's.
		fi, err := e.Info()
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		p := filepath.Join(s.dir, e.Name())
		age := now.Sub(fi.ModTime())
		if strings.HasSuffix(e.Name(), ".part") {
			if age > s.minAge {
				s.remove(p)
			}
			continue
		}
		if age > s.maxAge {
			s.remove(p)
			continue
		}
		files = append(files, file{p, fi.Size(), fi.ModTime()})
		used += fi.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
	for _, f := range files {
		if used+need <= s.maxTotal || now.Sub(f.mod) < s.minAge {
			break
		}
		if s.remove(f.path) {
			used -= f.size
		}
	}
	return used
}

func (s *uploadStore) remove(p string) bool {
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("uploads: remove: %v", err)
		return false
	}
	return true
}

// reserve sets maxFile bytes aside for one upload, after a sweep; release
// gives them back once the upload ends.
func (s *uploadStore) reserve() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	need := s.reserved + s.maxFile
	if s.sweepLocked(need)+need > s.maxTotal {
		return errUploadStorageFull
	}
	s.reserved += s.maxFile
	return nil
}

func (s *uploadStore) release() {
	s.mu.Lock()
	s.reserved -= s.maxFile
	s.mu.Unlock()
}

// save checks that r holds an image of the declared type, by its first bytes,
// and writes it under a random name: to a .part first, renamed once complete.
// The client's file name is never read.
func (s *uploadStore) save(r io.Reader, declared string) (upload, error) {
	ext, ok := uploadExts[declared]
	if !ok {
		return upload{}, errUploadUnsupported
	}
	head := make([]byte, 512)
	n, err := io.ReadFull(r, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return upload{}, readUploadError(err)
	}
	head = head[:n]
	if mt, _ := imageTypeOf(head); n == 0 || mt != declared {
		return upload{}, errUploadUnsupported
	}
	if err := s.reserve(); err != nil {
		return upload{}, err
	}
	defer s.release()

	var id [16]byte
	rand.Read(id[:]) // never fails: crypto/rand crashes the program instead
	name := hex.EncodeToString(id[:]) + "." + ext
	final := filepath.Join(s.dir, name)
	part := final + ".part"
	f, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return upload{}, err
	}
	_, err = f.Write(head)
	if err == nil {
		_, err = io.Copy(f, r)
		err = readUploadError(err)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		s.mu.Lock()
		err = os.Rename(part, final)
		s.mu.Unlock()
	}
	if err != nil {
		os.Remove(part)
		return upload{}, err
	}
	return upload{ID: hex.EncodeToString(id[:]), Path: final, Insert: pasteablePath(final)}, nil
}

// readUploadError turns the body's size cap into errUploadTooLarge.
func readUploadError(err error) error {
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		return errUploadTooLarge
	}
	return err
}

// lookup returns the path of the finished upload id: a regular file (not a
// symlink) only the server user can read. Never built from anything but a
// 32-hex id.
func (s *uploadStore) lookup(id string) (string, bool) {
	if !uploadIDRe.MatchString(id) {
		return "", false
	}
	for _, ext := range uploadExts {
		p := filepath.Join(s.dir, id+"."+ext)
		if fi, err := os.Lstat(p); err == nil && fi.Mode().IsRegular() && privateUploadFile(fi) {
			return p, true
		}
	}
	return "", false
}

// pasteablePath is p as typed into an agent's input: double-quoted when it
// holds whitespace (a Windows user name with a space).
func pasteablePath(p string) string {
	if strings.ContainsAny(p, " \t") {
		return `"` + p + `"`
	}
	return p
}

// handleUpload serves POST /api/mux/uploads: a raw image body (never
// multipart), at most uploadConcurrency at a time. s is nil when the server
// has no usable upload dir.
func handleUpload(s *uploadStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
			return
		}
		if s == nil {
			writeUploadError(w, errUploadUnavailable)
			return
		}
		select {
		case s.sem <- struct{}{}:
			defer func() { <-s.sem }()
		default:
			writeUploadError(w, errUploadBusy)
			return
		}
		if r.ContentLength > s.maxFile {
			writeUploadError(w, errUploadTooLarge)
			return
		}
		// Fails only on a writer without a connection (tests).
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(uploadReadTimeout))
		mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		r.Body = http.MaxBytesReader(w, r.Body, s.maxFile)
		u, err := s.save(r.Body, mt)
		if err != nil {
			writeUploadError(w, err)
			return
		}
		jsonOK(w, u)
	}
}

// writeUploadError answers with the error's code, so the PWA tells the
// reasons apart; anything else is logged and answered generically.
func writeUploadError(w http.ResponseWriter, err error) {
	var ue *uploadError
	if !errors.As(err, &ue) {
		log.Printf("upload error: %v", err)
		ue = &uploadError{"upload_failed", "upload failed", http.StatusInternalServerError}
	}
	jsonErrorCode(w, ue.code, ue.msg, ue.status)
}

// jsonErrorCode is jsonError plus a machine-readable code.
func jsonErrorCode(w http.ResponseWriter, code, msg string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg, "code": code})
}
