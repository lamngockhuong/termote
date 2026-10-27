package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func encodingFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "encoding", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParseEncoding(t *testing.T) {
	for _, s := range []string{"", "utf-8", "utf-16le", "utf-16be", "shift_jis", "euc-jp"} {
		if e, ok := parseEncoding(s); !ok || string(e) != s {
			t.Errorf("parseEncoding(%q) = %q, %v", s, e, ok)
		}
	}
	for _, s := range []string{"latin1", "UTF-8", "sjis", "utf-32"} {
		if _, ok := parseEncoding(s); ok {
			t.Errorf("parseEncoding(%q) took it", s)
		}
	}
}

func TestDetectEncodingFixtures(t *testing.T) {
	want := string(encodingFixture(t, "expected.txt"))
	crlf := strings.ReplaceAll(want, "\n", "\r\n")
	for _, tc := range []struct {
		file string
		enc  textEncoding
		bom  bool
		text string
	}{
		{"expected.txt", encUTF8, false, want},
		{"utf8-bom.txt", encUTF8, true, want},
		{"sjis.txt", encShiftJIS, false, want},
		{"sjis-crlf.txt", encShiftJIS, false, crlf},
		{"sjis-halfwidth.txt", encShiftJIS, false, "ｶﾀｶﾅ ﾃﾞｰﾀ\n･ﾀﾅｶ ﾀﾛｳ･\n"},
		{"eucjp.txt", encEUCJP, false, want},
		{"utf16le-bom.txt", encUTF16LE, true, want},
		{"utf16be-bom.txt", encUTF16BE, true, want},
	} {
		b := encodingFixture(t, tc.file)
		enc, ok := detectEncoding(b)
		if !ok || enc != tc.enc {
			t.Errorf("%s: detected %q, %v; want %q", tc.file, enc, ok, tc.enc)
			continue
		}
		d := decodeText(b, enc)
		if d.Enc != tc.enc || d.BOM != tc.bom || d.Text != tc.text || !d.Lossless {
			t.Errorf("%s: decoded %+v", tc.file, d)
			continue
		}
		out, err := encodeText(d.Text, d.Enc, d.BOM)
		if err != nil || !bytes.Equal(out, b) {
			t.Errorf("%s: encoded back to % x, %v", tc.file, out, err)
		}
	}
}

func TestDetectEncodingNotText(t *testing.T) {
	for name, b := range map[string][]byte{
		"latin1":       encodingFixture(t, "latin1.txt"),
		"utf16 no bom": encodingFixture(t, "utf16le-nobom.txt"),
		"garbage":      {0x80, 0xFD, 0xFE, 0x81},
		"kanji only":   {0x88, 0x9F, 0x88, 0xA0}, // 亜唖: no kana
		// An accented capital is one half-width katakana alone in Shift-JIS
		"latin1 capitals": []byte("GR\xd6SSE \xdcBER \xc4RGER"),
		"latin1 tilde":    []byte("S\xc3O PAULO"),
		"latin1 accents":  []byte("\xa9 2024 \xc9COLE"),
		"ascii and nul":   []byte("ab\x00cd"),
	} {
		if enc, ok := detectEncoding(b); ok {
			t.Errorf("%s: detected %q", name, enc)
		}
	}
}

func TestDetectEncodingPrefersMoreKana(t *testing.T) {
	// Valid in both: EUC-JP hiragana read as Shift-JIS is half-width
	// katakana, which weigh less than the full-width kana of EUC-JP.
	// A kanji and あい in EUC-JP; ｰｰ､｢､､ as Shift-JIS
	euc := []byte{0xB0, 0xB0, 0xA4, 0xA2, 0xA4, 0xA4}
	if enc, ok := detectEncoding(euc); !ok || enc != encEUCJP {
		t.Errorf("EUC-JP hiragana: %q, %v", enc, ok)
	}
	sj, sjOK := jaScore(euc, encShiftJIS)
	eu, euOK := jaScore(euc, encEUCJP)
	if !sjOK || !euOK || !eu.better(sj) {
		t.Errorf("both readings should pass, EUC-JP's better: %+v %v, %+v %v", sj, sjOK, eu, euOK)
	}
	// A tie goes to Shift-JIS; on kana, then the other characters decide.
	a := jaStats{kana: 2, other: 1}
	if a.better(a) || !a.better(jaStats{kana: 2}) || a.better(jaStats{kana: 3}) {
		t.Error("better compares kana, then other, and a tie is not better")
	}
}

func TestDetectEncodingHalfWidthPair(t *testing.T) {
	// ｱｱ (B1 B1): half-width katakana in Shift-JIS, one kanji in EUC-JP,
	// which has no kana, so only Shift-JIS passes.
	if enc, ok := detectEncoding([]byte{0xB1, 0xB1}); !ok || enc != encShiftJIS {
		t.Errorf("half-width pair: %q, %v", enc, ok)
	}
	if _, ok := jaScore([]byte{0xB1, 0xB1}, encEUCJP); ok {
		t.Error("EUC-JP reading passed")
	}
	if encUTF8.codec() != nil {
		t.Error("UTF-8 has a codec")
	}
}

func TestDecodeTextLossy(t *testing.T) {
	b := encodingFixture(t, "sjis-lossy.txt")
	enc, ok := detectEncoding(b)
	if !ok || enc != encShiftJIS {
		t.Fatalf("detected %q, %v", enc, ok)
	}
	d := decodeText(b, enc)
	if d.Lossless || !strings.Contains(d.Text, "髙") || !strings.Contains(d.Text, "あいうえお") {
		t.Errorf("decoded %+v", d)
	}
	if !d.Valid {
		t.Error("IBM extension codes are valid bytes")
	}
	// Invalid UTF-8 read as UTF-8, a lone surrogate in UTF-16, a bad
	// Shift-JIS byte: bytes lost, not only changed.
	if d := decodeText([]byte("a\xffb"), encUTF8); d.Lossless || d.Valid || d.Text != "a\uFFFDb" {
		t.Errorf("utf-8: %+v", d)
	}
	if d := decodeText([]byte{0xFF, 0xFE, 0x00, 0xD8, 'a', 0}, encUTF16LE); d.Lossless || d.Valid || !d.BOM {
		t.Errorf("utf-16 lone surrogate: %+v", d)
	}
	if d := decodeText([]byte{0x82, 0xA0, 0xFD}, encShiftJIS); d.Lossless || d.Valid {
		t.Errorf("shift_jis bad byte: %+v", d)
	}
	// U+FFFD held by a UTF-16 file is a character, not a lost byte.
	if d := decodeText([]byte{0xFD, 0xFF}, encUTF16LE); !d.Lossless || !d.Valid {
		t.Errorf("utf-16 U+FFFD: %+v", d)
	}
	// An odd byte at the end of UTF-16.
	if d := decodeText([]byte{'a', 0, 'b'}, encUTF16LE); d.Lossless {
		t.Errorf("utf-16 odd length: %+v", d)
	}
	// Encoding back is longer than the file.
	if encodesBackTo("ab", encShiftJIS, []byte("a")) {
		t.Error("longer output matched")
	}
	if encodesBackTo("a", encShiftJIS, []byte("ab")) {
		t.Error("shorter output matched")
	}
}

func TestDecodeTextUTF16NoBOM(t *testing.T) {
	want := string(encodingFixture(t, "expected.txt"))
	d := decodeText(encodingFixture(t, "utf16le-nobom.txt"), encUTF16LE)
	if d.Text != want || d.BOM || !d.Lossless {
		t.Errorf("decoded %+v", d)
	}
}

func TestDecodeTextLarge(t *testing.T) {
	// Longer than the 4 KiB buffers: the scoring and the comparison go on
	// past the first one.
	src := strings.Repeat("日本語のテキストです。\n", 2000)
	b, err := encodeText(src, encShiftJIS, false)
	if err != nil {
		t.Fatal(err)
	}
	enc, ok := detectEncoding(b)
	if !ok || enc != encShiftJIS {
		t.Fatalf("detected %q, %v", enc, ok)
	}
	if d := decodeText(b, enc); d.Text != src || !d.Lossless {
		t.Errorf("decoded %d bytes, lossless %v", len(d.Text), d.Lossless)
	}
}

func TestNormalizeForEncoding(t *testing.T) {
	from := "\u301C\u2212\u2016\u00A2\u00A3\u00AC\u2014\u00A5"
	to := "\uFF5E\uFF0D\u2225\uFFE0\uFFE1\uFFE2\u2015\uFFE5"
	for _, enc := range []textEncoding{encShiftJIS, encEUCJP} {
		if got := normalizeForEncoding(from, enc); got != to {
			t.Errorf("%s: %q", enc, got)
		}
		for _, c := range from {
			if _, err := encodeText(string(c), enc, false); err != nil {
				t.Errorf("%s: %U not encodable: %v", enc, c, err)
			}
		}
	}
	if got := normalizeForEncoding(from, encUTF16LE); got != from {
		t.Errorf("utf-16 changed: %q", got)
	}
	out, err := encodeText("\u301C", encShiftJIS, false)
	if err != nil || !bytes.Equal(out, []byte{0x81, 0x60}) {
		t.Errorf("wave dash: % x, %v", out, err)
	}
}

func TestEncodeTextUnencodable(t *testing.T) {
	text := strings.Repeat("あ", 3000) + "\nいう\nえ😀お\n"
	for _, enc := range []textEncoding{encShiftJIS, encEUCJP} {
		_, err := encodeText(text, enc, false)
		var ue *unencodableError
		if !errors.As(err, &ue) || ue.line != 3 || ue.char != "😀" {
			t.Errorf("%s: %v", enc, err)
		} else if !strings.Contains(ue.Error(), "line 3") {
			t.Errorf("message %q", ue.Error())
		}
	}
	// UTF-8 and UTF-16 hold everything.
	for _, enc := range []textEncoding{encUTF8, encUTF16LE, encUTF16BE} {
		if _, err := encodeText("😀", enc, true); err != nil {
			t.Errorf("%s: %v", enc, err)
		}
	}
}

func TestEncodeTextBOM(t *testing.T) {
	for enc, bom := range map[textEncoding][]byte{
		encUTF8: bomUTF8, encUTF16LE: bomUTF16LE, encUTF16BE: bomUTF16BE, encShiftJIS: nil,
	} {
		out, err := encodeText("a", enc, true)
		if err != nil || !bytes.HasPrefix(out, bom) || len(out) == len(bom) {
			t.Errorf("%s: % x, %v", enc, out, err)
		}
	}
}
