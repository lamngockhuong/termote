package main

import (
	"context"
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"strings"
)

// An image pasted into OpenCode is kept in its user message (a file whose
// source is "inline", its bytes as base64; checked on OpenCode 2.3.0). The
// Chat view's reference names the session, the message and the file's place
// in it; agent/image reads that one message again through the service
// (session.message.get), never a file of OpenCode's data directory.

// opencodeImageRefFile starts the File of an OpenCode image reference: the
// message id follows. A journal's file identity never starts with it.
const opencodeImageRefFile = "ocm:"

// opencodeImageRef reports whether ref names an OpenCode image, and its
// message.
func opencodeImageRef(ref agentImageRef) (string, bool) {
	msg, ok := strings.CutPrefix(ref.File, opencodeImageRefFile)
	return msg, ok && isOpencodeSessionID(ref.Session) && opencodeMessageIDRe.MatchString(msg)
}

// handleOpencodeImage serves an OpenCode image reference: one of the pane's
// own session, or of a session the history of the pane's directory lists
// (an old one read in the history sheet), with the history's own checks.
func (a *agentAPI) handleOpencodeImage(w http.ResponseWriter, r *http.Request, ref agentImageRef, msg string) {
	s, err := a.session(r.PathValue("id"))
	if err != nil || s.Agent != "opencode" || s.ID != ref.Session {
		if a.history == nil || a.files == nil {
			writeCoded(w, errAgentImageNotFound)
			return
		}
		root, ok := a.historyRoot(w, r)
		if !ok {
			return
		}
		if _, ok := a.findHistorySession(root.Root, "opencode", ref.Session); !ok {
			writeCoded(w, errAgentImageNotFound)
			return
		}
	}
	select {
	case agentImageSlots <- struct{}{}:
		defer func() { <-agentImageSlots }()
	default:
		writeCoded(w, errAgentImageBusy)
		return
	}
	mt, data, err := readOpencodeImage(r.Context(), ref.Session, msg, ref.N)
	if err != nil {
		if !errors.Is(err, errAgentImageMissing) {
			log.Printf("agent image: %v", err)
		}
		writeCoded(w, errAgentImageNotFound)
		return
	}
	serveAgentImage(w, mt, data, ref.N)
}

// readOpencodeImage reads file n of message msg of session id: an image
// pasted inline, at most opencodeImageMax bytes, whose bytes sniff as an
// accepted type and as the type the message gives it. The service's words
// never reach the client.
func readOpencodeImage(ctx context.Context, id, msg string, n int) (string, []byte, error) {
	c, err := opencodeConnect()
	if err != nil {
		return "", nil, errAgentImageMissing
	}
	ctx, cancel := context.WithTimeout(ctx, opencodeReadTimeout)
	defer cancel()
	files, err := c.messageFiles(ctx, id, msg)
	if errors.Is(err, errOpencodeNotFound) || errors.Is(err, errOpencodeUnavailable) {
		return "", nil, errAgentImageMissing
	}
	if err != nil {
		return "", nil, err
	}
	if n < 0 || n >= len(files) {
		return "", nil, errAgentImageMissing
	}
	f := files[n]
	if f.Source.Type != "inline" || !strings.HasPrefix(f.Mime, "image/") ||
		base64.StdEncoding.DecodedLen(len(f.Data)) > opencodeImageMax+2 {
		return "", nil, errAgentImageMissing
	}
	data, err := base64.StdEncoding.DecodeString(f.Data)
	if err != nil || len(data) > opencodeImageMax {
		return "", nil, errAgentImageMissing
	}
	mt, ok := sniffImage(data, strings.ToLower(f.Mime))
	if !ok {
		return "", nil, errAgentImageMissing
	}
	return mt, data, nil
}
