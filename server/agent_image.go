package main

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// An image an agent's transcript holds (one the user pasted into Claude Code
// or Codex) is sent as a part with only a signed reference; GET
// agent/image?src=<ref> serves its bytes, so the Chat view can show it again.

// agentImageLineMax is the longest transcript line agent/image reads: a
// Claude Code row (or the Codex input row) with several pasted images, each
// at most about 5 MB of base64. A longer line is not served.
const agentImageLineMax = 32 << 20

// agentImageConcurrency image reads run at once (each may hold a line of
// agentImageLineMax and its decoded image); the next one gets 429 busy.
const agentImageConcurrency = 2

var agentImageSlots = make(chan struct{}, agentImageConcurrency)

var (
	errAgentImageNotFound = &codedError{"not_found", "image not found", http.StatusNotFound}
	errAgentImageBusy     = &codedError{"busy", "too many image reads at once; try again", http.StatusTooManyRequests}
)

// journalImageReader is a journal adapter whose transcript keeps the images
// of its entries: the media type and bytes of the nth image of the entry
// whose row starts at off in f (size bytes long), ok false when it has no
// such image or it is not one of the accepted types.
type journalImageReader interface {
	Image(f io.ReaderAt, off, size int64, n int) (mediaType string, data []byte, ok bool)
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
				off := entries[i].off
				if p.imageOff != 0 {
					off = p.imageOff
				}
				p.Image = encodeImageRef(agentImageRef{Session: session, File: file, Offset: off, N: p.imageN})
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
// (by identity), an entry whose row starts at the offset, and an image of an
// accepted type whose bytes are what it claims.
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
	mt, data, ok := images.Image(f, ref.Offset, size, ref.N)
	if !ok {
		return "", nil, errAgentImageMissing
	}
	return mt, data, nil
}

// rowAt is the whole row that starts at off ('\n' included), at most
// agentImageLineMax long; ok false when no complete row ends within that.
func rowAt(f io.ReaderAt, off, size int64) ([]byte, bool) {
	if off < 0 || off >= size {
		return nil, false
	}
	br := bufio.NewReaderSize(io.NewSectionReader(f, off, min(size-off, agentImageLineMax)), 64<<10)
	var line []byte
	for {
		chunk, err := br.ReadSlice('\n')
		line = append(line, chunk...)
		if err == nil {
			return line, true
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, false
		}
	}
}

// rowBefore is the whole row that ends right before off, which starts a line
// ('\n' included), at most agentImageLineMax long; ok false at the start of
// the file or for a longer row.
func rowBefore(f io.ReaderAt, off int64) ([]byte, bool) {
	if off <= 0 {
		return nil, false
	}
	start := off - 1 // the '\n' that ends the row
	buf := make([]byte, 64<<10)
	for start > 0 {
		if off-start > agentImageLineMax {
			return nil, false
		}
		n := min(int64(len(buf)), start)
		if _, err := f.ReadAt(buf[:n], start-n); err != nil {
			return nil, false
		}
		if i := bytes.LastIndexByte(buf[:n], '\n'); i >= 0 {
			start -= n - int64(i) - 1
			break
		}
		start -= n
	}
	if off-start > agentImageLineMax {
		return nil, false
	}
	line := make([]byte, off-start)
	if _, err := f.ReadAt(line, start); err != nil {
		return nil, false
	}
	return line, true
}

// sniffImage is the type data sniffs as (http.DetectContentType) when it is
// an accepted one (PNG, JPEG, GIF, WebP) and the declared type, when given,
// is the same, so nothing else is served under an image's name.
func sniffImage(data []byte, declared string) (string, bool) {
	mt := http.DetectContentType(data)
	if len(data) == 0 || !isUploadType(mt) || (declared != "" && declared != mt) {
		return "", false
	}
	return mt, true
}

// Image returns the nth image block of a Claude Code row's message.
func (claudeJournal) Image(f io.ReaderAt, off, size int64, n int) (string, []byte, bool) {
	line, ok := rowAt(f, off, size)
	if !ok {
		return "", nil, false
	}
	return claudeImage(line, n)
}

// claudeImage returns the nth image block of a Claude Code row's message:
// base64 data whose bytes sniff as an accepted type, and as its media_type
// when given.
func claudeImage(line []byte, n int) (string, []byte, bool) {
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
		if err != nil {
			return "", nil, false
		}
		mt, ok := sniffImage(data, b.Source.MediaType)
		return mt, data, ok
	}
	return "", nil, false
}

// isCodexImage reports a Codex user input item that is an image: a URL
// (image) or a file the user attached by path (local_image).
func isCodexImage(itemType string) bool {
	return strings.EqualFold(itemType, "image") || strings.EqualFold(itemType, "local_image")
}

// codexInputRow is the row Codex writes just before a UserMessage item: the
// user message of the model's input (response_item), where every image of
// the item is an input_image with its bytes in a data: URL.
type codexInputRow struct {
	Type    string `json:"type"`
	Payload struct {
		Type    string `json:"type"`
		Role    string `json:"role"`
		Content []struct {
			Type     string `json:"type"`
			ImageURL string `json:"image_url"`
		} `json:"content"`
	} `json:"payload"`
}

// Image returns the nth image of a Codex UserMessage item. The item keeps
// only a pasted file's path (local_image) or the URL it was given (image);
// the bytes Codex sent are in the row it wrote just before, the model's
// input, which must be a user message with as many images as the item, so
// a file Codex could not read shifts no image onto another's chip. The file
// a path names is never read: only the rollout's own copy is served.
func (codexJournal) Image(f io.ReaderAt, off, size int64, n int) (string, []byte, bool) {
	line, ok := rowAt(f, off, size)
	if !ok {
		return "", nil, false
	}
	var row codexRow
	if json.Unmarshal(line, &row) != nil || row.Type != "event_msg" || row.Payload.Type != "item_completed" ||
		row.Payload.Item == nil || row.Payload.Item.Type != "UserMessage" {
		return "", nil, false
	}
	images := 0
	for _, c := range row.Payload.Item.Content {
		if isCodexImage(c.Type) {
			images++
		}
	}
	if n >= images {
		return "", nil, false
	}
	prev, ok := rowBefore(f, off)
	if !ok {
		return "", nil, false
	}
	var input codexInputRow
	if json.Unmarshal(prev, &input) != nil || input.Type != "response_item" ||
		input.Payload.Type != "message" || input.Payload.Role != "user" {
		return "", nil, false
	}
	var urls []string
	for _, c := range input.Payload.Content {
		if c.Type == "input_image" {
			urls = append(urls, c.ImageURL)
		}
	}
	if len(urls) != images {
		return "", nil, false
	}
	return dataURLImage(urls[n])
}

// dataURLImage decodes a base64 data: URL whose bytes sniff as an accepted
// image type and as the type it declares; any other URL is refused.
func dataURLImage(u string) (string, []byte, bool) {
	rest, ok1 := strings.CutPrefix(u, "data:")
	head, b64, ok2 := strings.Cut(rest, ",")
	declared, ok3 := strings.CutSuffix(head, ";base64")
	if !ok1 || !ok2 || !ok3 || declared == "" {
		return "", nil, false
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", nil, false
	}
	mt, ok := sniffImage(data, strings.ToLower(declared))
	return mt, data, ok
}
