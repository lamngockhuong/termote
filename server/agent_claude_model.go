package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sync"
)

// Claude Code writes the model it runs into the transcript as an attachment
// row when the session starts and again on each /model switch:
// {"type":"attachment","attachment":{"type":"model","identity":{"modelId":
// "claude-opus-5[1m]",...}}} (seen from 2.1.270). The last one names the
// model the next request goes to, and its [1m] the 1M context, which argv
// does not show when the model comes from the account's default or /model.

const (
	// claudeModelRowMax is the read buffer of the scan: a model row is
	// under 1 KiB, a longer line is skipped without being decoded.
	claudeModelRowMax = 64 * 1024
	// claudeModelFilesMax bounds the transcripts claudeModels remembers;
	// past it, every scan starts over once.
	claudeModelFilesMax = 512
)

// claudeModels keeps, for each Claude transcript, how far it was scanned for
// model rows and the last model found, so each read only scans what was
// appended since.
type claudeModels struct {
	mu    sync.Mutex
	files map[string]*claudeModelScan
}

type claudeModelScan struct {
	mu    sync.Mutex
	id    string // the file's identity; another one starts the scan over
	off   int64  // where the next scan starts, always a line start
	model string
}

// errClaudeModelBusy: another read is scanning the transcript; this one
// does without, rather than wait on a first scan of a large file.
var errClaudeModelBusy = errors.New("claude model scan busy")

func newClaudeModels() *claudeModels {
	return &claudeModels{files: map[string]*claudeModelScan{}}
}

// model is the model id the last model row of the transcript at path names,
// "" when there is none.
func (cm *claudeModels) model(path string) (string, error) {
	cm.mu.Lock()
	sc, ok := cm.files[path]
	if !ok {
		if len(cm.files) >= claudeModelFilesMax {
			clear(cm.files)
		}
		sc = &claudeModelScan{}
		cm.files[path] = sc
	}
	cm.mu.Unlock()

	if !sc.mu.TryLock() {
		return "", errClaudeModelBusy
	}
	defer sc.mu.Unlock()
	f, err := os.OpenFile(path, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return "", err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return "", err
	}
	id := fileIdentity(fi)
	if id == "" {
		id = path
	}
	if id != sc.id || fi.Size() < sc.off {
		// Another file, or this one cut short: read it again.
		sc.id, sc.off, sc.model = id, 0, ""
	}
	sc.scan(io.NewSectionReader(f, sc.off, fi.Size()-sc.off))
	return sc.model, nil
}

// scan reads r's complete lines, keeping the model of the last model row
// and moving off past them; a last line without its newline is left for the
// next scan, as Claude Code may still be writing it.
func (sc *claudeModelScan) scan(r io.Reader) {
	br := bufio.NewReaderSize(r, claudeModelRowMax)
	var read int64 // bytes of the line read so far
	long := false
	for {
		line, err := br.ReadSlice('\n')
		read += int64(len(line))
		if errors.Is(err, bufio.ErrBufferFull) {
			long = true
			continue
		}
		if err != nil {
			return
		}
		if !long {
			if m := claudeModelOf(line); m != "" {
				sc.model = m
			}
		}
		sc.off += read
		read, long = 0, false
	}
}

// claudeModelOf is the model id of a model row, "" for any other line.
func claudeModelOf(line []byte) string {
	if !bytes.Contains(line, []byte(`"identity"`)) {
		return ""
	}
	var row struct {
		Type       string `json:"type"`
		Attachment struct {
			Type     string `json:"type"`
			Identity struct {
				ModelID string `json:"modelId"`
			} `json:"identity"`
		} `json:"attachment"`
	}
	if json.Unmarshal(line, &row) != nil || row.Type != "attachment" || row.Attachment.Type != "model" {
		return ""
	}
	return row.Attachment.Identity.ModelID
}
