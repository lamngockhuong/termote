package main

import (
	"bytes"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

// textEncoding is one of the encodings the files routes read and save a text
// file in. The PWA only ever sees UTF-8: the server decodes on read and
// encodes back on save.
type textEncoding string

const (
	encUTF8     textEncoding = "utf-8"
	encUTF16LE  textEncoding = "utf-16le"
	encUTF16BE  textEncoding = "utf-16be"
	encShiftJIS textEncoding = "shift_jis"
	encEUCJP    textEncoding = "euc-jp"
)

var (
	bomUTF8    = []byte{0xEF, 0xBB, 0xBF}
	bomUTF16LE = []byte{0xFF, 0xFE}
	bomUTF16BE = []byte{0xFE, 0xFF}
)

// jaThreshold is the share of the non-ASCII characters a Shift-JIS or EUC-JP
// reading must turn into Japanese ones (kana, kanji, CJK punctuation) to be
// taken. Below it the file stays binary: a Latin-1 file is valid Shift-JIS
// more often than not.
const jaThreshold = 0.6

// parseEncoding checks a client's encoding name. "" means "detect it".
func parseEncoding(s string) (textEncoding, bool) {
	switch e := textEncoding(s); e {
	case "", encUTF8, encUTF16LE, encUTF16BE, encShiftJIS, encEUCJP:
		return e, true
	}
	return "", false
}

// codec is the x/text codec of e; nil for UTF-8, which needs none.
func (e textEncoding) codec() encoding.Encoding {
	switch e {
	case encUTF16LE:
		return unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM)
	case encUTF16BE:
		return unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM)
	case encShiftJIS:
		return japanese.ShiftJIS
	case encEUCJP:
		return japanese.EUCJP
	}
	return nil
}

// bomOf is the byte order mark of e.
func (e textEncoding) bomOf() []byte {
	switch e {
	case encUTF8:
		return bomUTF8
	case encUTF16LE:
		return bomUTF16LE
	case encUTF16BE:
		return bomUTF16BE
	}
	return nil
}

// sniffBOM is the encoding b's byte order mark names, if it starts with one.
func sniffBOM(b []byte) (textEncoding, bool) {
	switch {
	case bytes.HasPrefix(b, bomUTF8):
		return encUTF8, true
	case bytes.HasPrefix(b, bomUTF16LE):
		return encUTF16LE, true
	case bytes.HasPrefix(b, bomUTF16BE):
		return encUTF16BE, true
	}
	return "", false
}

// detectEncoding tells which encoding the file b is text in, ok false when
// it is none of them. A byte order mark decides first; then a NUL early on
// marks the file binary, valid UTF-8 is UTF-8, and otherwise the Shift-JIS
// and EUC-JP readings that are valid byte by byte and look Japanese enough
// compete on their kana. UTF-16 without a BOM is never guessed.
func detectEncoding(b []byte) (textEncoding, bool) {
	if enc, ok := sniffBOM(b); ok {
		return enc, true
	}
	if bytes.IndexByte(b[:min(len(b), binarySniffSize)], 0) >= 0 {
		return "", false
	}
	if utf8.Valid(b) {
		return encUTF8, true
	}
	sj, sjOK := jaScore(b, encShiftJIS)
	eu, euOK := jaScore(b, encEUCJP)
	switch {
	case sjOK && euOK:
		if eu.better(sj) {
			return encEUCJP, true
		}
		return encShiftJIS, true
	case sjOK:
		return encShiftJIS, true
	case euOK:
		return encEUCJP, true
	}
	return "", false
}

// jaStats counts what a Japanese reading of a file turned its non-ASCII
// bytes into.
type jaStats struct {
	kana      int // kana weighed by bytes: a full-width one 2, a half-width one 1
	kanaChars int
	other     int // kanji, CJK punctuation, a half-width katakana alone
	nonASCII  int
	run       int // half-width katakana in a row so far
}

// endRun counts the half-width katakana just read in a row: as kana when
// there are at least two, else as another Japanese character. Latin-1
// read as Shift-JIS turns an accented capital (Ö, É, Ã) into one alone.
func (s *jaStats) endRun() {
	if s.run >= 2 {
		s.kana += s.run
		s.kanaChars += s.run
	} else {
		s.other += s.run
	}
	s.run = 0
}

// better: s wins over t on kana, then on the other Japanese characters. A
// tie is t's.
func (s jaStats) better(t jaStats) bool {
	if s.kana != t.kana {
		return s.kana > t.kana
	}
	return s.other > t.other
}

// jaScore reads b as enc into a small buffer, over and over, and counts its
// characters. ok is false when a byte is not valid in enc, or the reading
// has no kana or too few Japanese characters (jaThreshold).
//
// Kana are weighed by the bytes they take, so a half-width katakana weighs
// half a full-width one: EUC-JP text read as Shift-JIS turns nearly every
// byte into a half-width katakana, while its EUC-JP reading has full-width
// kana of two bytes each. Shift-JIS half-width katakana read as EUC-JP turn
// into kanji, which only count towards the threshold. A half-width
// katakana is kana only next to another one (endRun).
func jaScore(b []byte, enc textEncoding) (s jaStats, ok bool) {
	t := enc.codec().NewDecoder()
	dst := make([]byte, 4<<10)
	for src := b; ; {
		// A decoder writes whole characters only, so dst[:n] holds no
		// cut one.
		n, used, err := t.Transform(dst, src, true)
		for _, c := range string(dst[:n]) {
			if c >= 0xFF66 && c <= 0xFF9F {
				s.run++
				s.nonASCII++
				continue
			}
			s.endRun()
			switch {
			case c == utf8.RuneError:
				return jaStats{}, false
			case c < utf8.RuneSelf:
				continue
			case c >= 0x3040 && c <= 0x30FF:
				s.kana += 2
				s.kanaChars++
			case c >= 0x4E00 && c <= 0x9FFF, c >= 0x3000 && c <= 0x303F,
				c >= 0xFF01 && c <= 0xFF65:
				s.other++
			}
			s.nonASCII++
		}
		src = src[used:]
		if err != transform.ErrShortDst {
			break
		}
	}
	s.endRun()
	ja := s.kanaChars + s.other
	return s, s.kanaChars > 0 && float64(ja) >= jaThreshold*float64(s.nonASCII)
}

// decoded is a file's text as UTF-8, how it was read, and whether encoding
// it back gives the very same bytes.
type decoded struct {
	Text string
	Enc  textEncoding
	BOM  bool
	// Lossless: encodeText of Text gives back the bytes read. A file that
	// is not can be viewed but not edited, unless saved as UTF-8.
	Lossless bool
	// Valid: every byte read is valid in Enc, so Text holds all of them
	// (a lossy Shift-JIS file of IBM extension codes still is). A file that
	// is not would lose those bytes saved as UTF-8 too.
	Valid bool
}

// decodeText reads b as enc, once. A byte order mark of enc is dropped from
// Text; bytes not valid in enc become U+FFFD and make it lossy.
func decodeText(b []byte, enc textEncoding) decoded {
	d := decoded{Enc: enc}
	if bom := enc.bomOf(); bom != nil && bytes.HasPrefix(b, bom) {
		d.BOM = true
		b = b[len(bom):]
	}
	if enc == encUTF8 {
		d.Lossless = utf8.Valid(b)
		d.Valid = d.Lossless
		d.Text = string(b)
		if !d.Lossless {
			d.Text = strings.ToValidUTF8(d.Text, "\uFFFD")
		}
		return d
	}
	// x/text's decoders never fail: a bad byte becomes U+FFFD.
	text, _ := enc.codec().NewDecoder().Bytes(b)
	d.Text = string(text)
	d.Lossless = encodesBackTo(d.Text, enc, b)
	// A bad byte became U+FFFD, which no Japanese encoding holds and a
	// UTF-16 file holding one encodes back to
	d.Valid = d.Lossless || !strings.ContainsRune(d.Text, utf8.RuneError)
	return d
}

// encodesBackTo tells whether text encoded in enc is exactly want. It
// encodes a small buffer at a time and stops at the first byte that
// differs.
func encodesBackTo(text string, enc textEncoding, want []byte) bool {
	t := enc.codec().NewEncoder()
	dst := make([]byte, 4<<10)
	for src := []byte(text); ; {
		n, used, err := t.Transform(dst, src, true)
		if n > len(want) || !bytes.Equal(dst[:n], want[:n]) {
			return false
		}
		want, src = want[n:], src[used:]
		if err != transform.ErrShortDst {
			return err == nil && len(want) == 0
		}
	}
}

// cp932Variants maps characters an Apple keyboard types to the ones
// Shift-JIS and EUC-JP hold for them: the file's own characters already
// are the latter, so only newly typed ones change.
var cp932Variants = strings.NewReplacer(
	"\u301C", "\uFF5E", // WAVE DASH → FULLWIDTH TILDE
	"\u2212", "\uFF0D", // MINUS SIGN → FULLWIDTH HYPHEN-MINUS
	"\u2016", "\u2225", // DOUBLE VERTICAL LINE → PARALLEL TO
	"\u00A2", "\uFFE0", // CENT SIGN → FULLWIDTH CENT SIGN
	"\u00A3", "\uFFE1", // POUND SIGN → FULLWIDTH POUND SIGN
	"\u00AC", "\uFFE2", // NOT SIGN → FULLWIDTH NOT SIGN
	"\u2014", "\u2015", // EM DASH → HORIZONTAL BAR
	"\u00A5", "\uFFE5", // YEN SIGN → FULLWIDTH YEN SIGN
)

// normalizeForEncoding replaces, for Shift-JIS and EUC-JP only, the
// characters of cp932Variants.
func normalizeForEncoding(text string, enc textEncoding) string {
	if enc != encShiftJIS && enc != encEUCJP {
		return text
	}
	return cp932Variants.Replace(text)
}

// unencodableError: the text has a character the target encoding cannot
// hold. line is 1-based; char is the first such character, from the text
// the client sent.
type unencodableError struct {
	line int
	char string
}

func (e *unencodableError) Error() string {
	return fmt.Sprintf("line %d has a character the encoding cannot hold", e.line)
}

// encodeText encodes text in enc, with enc's byte order mark when bom. A
// character enc cannot hold fails the whole text: it is never replaced.
func encodeText(text string, enc textEncoding, bom bool) ([]byte, error) {
	var prefix []byte
	if bom {
		prefix = enc.bomOf()
	}
	if enc == encUTF8 {
		return append(append([]byte{}, prefix...), text...), nil
	}
	text = normalizeForEncoding(text, enc)
	out, used, err := transform.String(enc.codec().NewEncoder(), text)
	if err != nil {
		// used is where the encoder stopped: the character it could not
		// hold.
		c, _ := utf8.DecodeRuneInString(text[used:])
		return nil, &unencodableError{line: strings.Count(text[:used], "\n") + 1, char: string(c)}
	}
	return append(append([]byte{}, prefix...), out...), nil
}
