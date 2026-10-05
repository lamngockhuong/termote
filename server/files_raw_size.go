package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
)

// gifPixels returns the largest pixel area a GIF asks a decoder for: its
// logical screen, or a frame (with its offset) reaching further. The screen
// alone is what image/gif's DecodeConfig reports, and a frame is not bound
// by it. The walk stops at the trailer or at the end of the data, so a
// truncated GIF is checked up to where a browser stops too.
func gifPixels(r io.Reader) (int64, error) {
	br := bufio.NewReader(r)
	var hdr [13]byte // signature, version, logical screen descriptor
	if _, err := io.ReadFull(br, hdr[:]); err != nil {
		return 0, err
	}
	largest := int64(binary.LittleEndian.Uint16(hdr[6:])) * int64(binary.LittleEndian.Uint16(hdr[8:]))
	if err := skipColorTable(br, hdr[10]); err != nil {
		return 0, err
	}
	for {
		kind, err := br.ReadByte()
		if err != nil {
			return largest, nil
		}
		switch kind {
		case 0x3b: // trailer
			return largest, nil
		case 0x21: // extension: a label, then sub-blocks
			if _, err := br.ReadByte(); err != nil {
				return largest, nil
			}
		case 0x2c: // image descriptor
			var d [9]byte
			if _, err := io.ReadFull(br, d[:]); err != nil {
				return largest, nil
			}
			left, top := int64(binary.LittleEndian.Uint16(d[0:])), int64(binary.LittleEndian.Uint16(d[2:]))
			w, h := int64(binary.LittleEndian.Uint16(d[4:])), int64(binary.LittleEndian.Uint16(d[6:]))
			largest = max(largest, (left+w)*(top+h))
			if err := skipColorTable(br, d[8]); err != nil {
				return largest, nil
			}
			if _, err := br.ReadByte(); err != nil { // LZW minimum code size
				return largest, nil
			}
		default:
			return 0, errors.New("gif: unknown block")
		}
		if err := skipSubBlocks(br); err != nil {
			return largest, nil
		}
	}
}

// skipColorTable skips the color table a GIF packed-fields byte announces.
func skipColorTable(br *bufio.Reader, flags byte) error {
	if flags&0x80 == 0 {
		return nil
	}
	_, err := br.Discard(3 << (flags&7 + 1))
	return err
}

// skipSubBlocks skips GIF data sub-blocks up to their zero-length end.
func skipSubBlocks(br *bufio.Reader) error {
	for {
		n, err := br.ReadByte()
		if err != nil {
			return err
		}
		if n == 0 {
			return nil
		}
		if _, err := br.Discard(int(n)); err != nil {
			return err
		}
	}
}

// webpPixels returns a WebP's pixel area, read from the header of its first
// chunk: VP8 (lossy), VP8L (lossless) or VP8X (extended, the canvas every
// frame must fit in). head is the start of the file, already known to be
// RIFF/WEBP.
func webpPixels(head []byte) (int64, error) {
	if len(head) < 20 {
		return 0, errors.New("webp: short header")
	}
	data := head[20:]
	switch string(head[12:16]) {
	case "VP8 ":
		// Frame tag (3 bytes), start code, then 14-bit width and height.
		if len(data) < 10 || data[3] != 0x9d || data[4] != 0x01 || data[5] != 0x2a {
			break
		}
		w := int64(binary.LittleEndian.Uint16(data[6:]) & 0x3fff)
		h := int64(binary.LittleEndian.Uint16(data[8:]) & 0x3fff)
		return w * h, nil
	case "VP8L":
		// Signature, then width-1 and height-1 in 14 bits each.
		if len(data) < 5 || data[0] != 0x2f {
			break
		}
		bits := binary.LittleEndian.Uint32(data[1:])
		return int64(bits&0x3fff+1) * int64(bits>>14&0x3fff+1), nil
	case "VP8X":
		// Flags (4 bytes), then canvas width-1 and height-1 in 24 bits each.
		if len(data) < 10 {
			break
		}
		w := int64(data[4]) | int64(data[5])<<8 | int64(data[6])<<16
		h := int64(data[7]) | int64(data[8])<<8 | int64(data[9])<<16
		return (w + 1) * (h + 1), nil
	}
	return 0, errors.New("webp: unknown header")
}
