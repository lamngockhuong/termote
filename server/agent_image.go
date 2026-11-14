package main

import (
	"bufio"
	"crypto/hmac"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// An image an agent's transcript holds (one the user pasted into Claude Code)
// is sent as a part with only a signed reference; GET agent/image?src=<ref>
// serves its bytes, so the Chat view can show it again.

// agentImageLineMax is the longest transcript line agent/image reads: a
// Claude Code row with several pasted images, each at most about 5 MB of
// base64. A longer line is not served.
const agentImageLineMax = 32 << 20

// agentImageConcurrency image reads run at once (each may hold a line of
// agentImageLineMax and its decoded image); the next one gets 429 busy.
const agentImageConcurrency = 2

var agentImageSlots = make(chan struct{}, agentImageConcurrency)

var (
	errAgentImageNotFound = &codedError{"not_found", "image not found", http.StatusNotFound}
	errAgentImageBusy     = &codedError{"busy", "too many image reads at once; try again", http.StatusTooManyRequests}
)

// journalImageReader is a journal adapter whose rows carry their images: the
// media type and bytes of the nth image of a row, ok false when the row has
// no such image or it is not one of the accepted types.
type journalImageReader interface {
	Image(line []byte, n int) (mediaType string, data []byte, ok bool)
}

// agentImageRef names one image: the session and file it was read from, the
// offset of its row and its place among the row's images. It is signed like
// a cursor, under its own domain, so a client can only send back an image
// the server listed, and a cursor never passes for one.
type agentImageRef struct {
	Session string `json:"s"`
	File    string `json:"f"`
	Offset  int64  `json:"o"`
	N       int    `json:"n"`
}

const agentImageDomain = "image\x00"

func encodeImageRef(ref agentImageRef) string {
	payload, _ := json.Marshal(ref)
	enc := base64.RawURLEncoding
	return enc.EncodeToString(payload) + "." + enc.EncodeToString(cursorMAC(append([]byte(agentImageDomain), payload...)))
}

func decodeImageRef(s string) (agentImageRef, bool) {
	var ref agentImageRef
	p, sig, ok := strings.Cut(s, ".")
	if !ok {
		return ref, false
	}
	enc := base64.RawURLEncoding
	payload, err1 := enc.DecodeString(p)
	mac, err2 := enc.DecodeString(sig)
	if err1 != nil || err2 != nil || !hmac.Equal(mac, cursorMAC(append([]byte(agentImageDomain), payload...))) {
		return ref, false
	}
	if json.Unmarshal(payload, &ref) != nil || ref.Offset < 0 || ref.N < 0 || ref.Session == "" {
		return ref, false
	}
	return ref, true
}

// addImageRefs gives every image part of entries, read from the file with
// identity file of session, its reference.
func addImageRefs(entries []TranscriptEntry, session, file string) {
	for i := range entries {
		for j := range entries[i].Parts {
			p := &entries[i].Parts[j]
			if p.Kind == "image" {
				p.Image = encodeImageRef(agentImageRef{Session: session, File: file, Offset: entries[i].off, N: p.imageN})
			}
		}
	}
}

func (a *agentAPI) handleImage(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	// Loaded by an <img> or opened in a tab of the PWA: both same-origin.
	if msg := crossSiteRejection(a.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return
	}
	if !requireAgentRead(w, r) {
		return
	}
	ref, ok := decodeImageRef(r.URL.Query().Get("src"))
	if !ok {
		writeCoded(w, errAgentImageNotFound)
		return
	}
	s, err := a.session(r.PathValue("id"))
	if err != nil {
		a.agentError(w, "agent session", err)
		return
	}
	if ref.Session != s.ID {
		writeCoded(w, errAgentImageNotFound)
		return
	}
	select {
	case agentImageSlots <- struct{}{}:
		defer func() { <-agentImageSlots }()
	default:
		writeCoded(w, errAgentImageBusy)
		return
	}
	mt, data, err := readAgentImage(s, ref)
	if err != nil {
		if errors.Is(err, errAgentImageMissing) {
			writeCoded(w, errAgentImageNotFound)
			return
		}
		a.agentError(w, "agent image", err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", mt)
	h.Set("Content-Length", strconv.Itoa(len(data)))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	h.Set("Content-Disposition", `inline; filename="image-`+strconv.Itoa(ref.N+1)+"."+uploadExts[mt]+`"`)
	// A row of a transcript never changes once written, but the reference
	// lives only as long as the process: kept for an hour, never shared.
	h.Set("Cache-Control", "private, max-age=3600")
	_, _ = w.Write(data)
}

var errAgentImageMissing = errors.New("agent image missing")

// readAgentImage reads the image ref names from s's transcript: the same file
// (by identity), a row that starts at the offset, at most agentImageLineMax
// long, and an image of an accepted type whose bytes are what it claims.
func readAgentImage(s AgentSession, ref agentImageRef) (string, []byte, error) {
	adapter, ok := journalAdapters[s.Agent]
	if !ok {
		return "", nil, errAgentImageMissing
	}
	images, ok := adapter.(journalImageReader)
	if !ok {
		return "", nil, errAgentImageMissing
	}
	path, err := adapter.Locate(s)
	if errors.Is(err, errTranscriptNotWritten) || errors.Is(err, errNoTranscript) {
		return "", nil, errAgentImageMissing
	}
	if err != nil {
		return "", nil, err
	}
	f, size, id, err := openJournal(s, path)
	if errors.Is(err, errNoTranscript) {
		return "", nil, errAgentImageMissing
	}
	if err != nil {
		return "", nil, err
	}
	defer f.Close()
	if id != ref.File || ref.Offset >= size || !atLineStart(f, ref.Offset) {
		return "", nil, errAgentImageMissing
	}
	br := bufio.NewReaderSize(io.NewSectionReader(f, ref.Offset, min(size-ref.Offset, agentImageLineMax)), 64<<10)
	var line []byte
	for {
		chunk, err := br.ReadSlice('\n')
		line = append(line, chunk...)
		if err == nil {
			break
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return "", nil, errAgentImageMissing // no complete row within the limit
		}
	}
	mt, data, ok := images.Image(line, ref.N)
	if !ok {
		return "", nil, errAgentImageMissing
	}
	return mt, data, nil
}

// Image returns the nth image block of a Claude Code row's message: base64
// data of an accepted type (PNG, JPEG, GIF, WebP) whose bytes sniff as that
// type, so nothing else is served under an image's name.
func (claudeJournal) Image(line []byte, n int) (string, []byte, bool) {
	var row struct {
		Message *struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &row) != nil || row.Message == nil {
		return "", nil, false
	}
	var blocks []json.RawMessage
	if json.Unmarshal(row.Message.Content, &blocks) != nil {
		return "", nil, false // a string message carries no image
	}
	k := 0
	for _, raw := range blocks {
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &head) != nil || head.Type != "image" {
			continue
		}
		if k++; k <= n {
			continue
		}
		var b struct {
			Source struct {
				Type      string `json:"type"`
				MediaType string `json:"media_type"`
				Data      string `json:"data"`
			} `json:"source"`
		}
		if json.Unmarshal(raw, &b) != nil || b.Source.Type != "base64" {
			return "", nil, false
		}
		data, err := base64.StdEncoding.DecodeString(b.Source.Data)
		if err != nil || len(data) == 0 {
			return "", nil, false
		}
		mt := http.DetectContentType(data)
		if !isUploadType(mt) || (b.Source.MediaType != "" && b.Source.MediaType != mt) {
			return "", nil, false
		}
		return mt, data, true
	}
	return "", nil, false
}
