package main

import (
	"encoding/binary"
	"fmt"
	"io"
)

// herdr-core's framed mode (schema/README.md, "Framed mode"; wire.rs @5a9de29):
// every frame is [channel u32 LE][kind u8][len u32 LE][payload].
const (
	hcFrameHeader     = 9
	hcFrameMaxPayload = 16 << 20

	hcKindData   = 0 // channel 0: one JSON-RPC message; others: stream bytes
	hcKindCredit = 1 // u32 LE: bytes the receiver consumed
	hcKindClose  = 2 // the channel is over; from the core, a JSON reason
	hcKindResize = 3 // u16 LE cols, u16 LE rows
	hcKindFocus  = 4 // viewer → core: 1 gained focus, 0 lost it
	hcKindFacts  = 5 // viewer → core: JSON display facts

	// hcWindow is the credit a stream starts with: the core sends no more
	// than this many bytes on a channel before the client credits them.
	hcWindow = 256 * 1024
)

// hcFrame is one frame of a framed connection.
type hcFrame struct {
	channel uint32
	kind    byte
	payload []byte
}

// encodeHcFrame returns the bytes of one frame. The caller keeps payload
// within hcFrameMaxPayload.
func encodeHcFrame(channel uint32, kind byte, payload []byte) []byte {
	out := make([]byte, hcFrameHeader+len(payload))
	binary.LittleEndian.PutUint32(out[0:4], channel)
	out[4] = kind
	binary.LittleEndian.PutUint32(out[5:9], uint32(len(payload)))
	copy(out[hcFrameHeader:], payload)
	return out
}

// readHcFrame reads one frame. A payload over hcFrameMaxPayload is an error:
// the connection can no longer be trusted to stay in step and must close.
func readHcFrame(r io.Reader) (hcFrame, error) {
	var h [hcFrameHeader]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return hcFrame{}, err
	}
	n := binary.LittleEndian.Uint32(h[5:9])
	if n > hcFrameMaxPayload {
		return hcFrame{}, fmt.Errorf("hc frame of %d bytes exceeds %d", n, hcFrameMaxPayload)
	}
	f := hcFrame{channel: binary.LittleEndian.Uint32(h[0:4]), kind: h[4], payload: make([]byte, n)}
	if _, err := io.ReadFull(r, f.payload); err != nil {
		if err == io.EOF {
			err = io.ErrUnexpectedEOF
		}
		return hcFrame{}, err
	}
	return f, nil
}

// hcU32 is the payload of a CREDIT frame.
func hcU32(n uint32) []byte {
	return binary.LittleEndian.AppendUint32(nil, n)
}

// hcSizePayload is the payload of a RESIZE frame.
func hcSizePayload(cols, rows int) []byte {
	b := binary.LittleEndian.AppendUint16(nil, uint16(clampU16(cols)))
	return binary.LittleEndian.AppendUint16(b, uint16(clampU16(rows)))
}

// parseHcSize reads a RESIZE payload.
func parseHcSize(p []byte) (cols, rows int, ok bool) {
	if len(p) != 4 {
		return 0, 0, false
	}
	return int(binary.LittleEndian.Uint16(p[0:2])), int(binary.LittleEndian.Uint16(p[2:4])), true
}

func clampU16(n int) int { return min(max(n, 0), 0xffff) }
