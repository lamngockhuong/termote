package main

import (
	"errors"
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

// Windows refuses more in a name than Unix: none of it is ever asked for
func TestValidUploadNameWindows(t *testing.T) {
	for _, name := range []string{`a:b`, `a*b`, `a?b`, `a"b`, `a<b`, `a>b`, `a|b`, "NUL", "con.txt", `C:x`} {
		if validUploadName(name) {
			t.Errorf("%q accepted", name)
		}
	}
	for _, err := range []error{errors.ErrUnsupported, windows.ERROR_INVALID_FUNCTION, windows.ERROR_NOT_SUPPORTED} {
		if !isLinkUnsupported(&os.LinkError{Err: err}) {
			t.Errorf("isLinkUnsupported(%v) = false", err)
		}
	}
	if isLinkUnsupported(&os.LinkError{Err: windows.ERROR_ALREADY_EXISTS}) {
		t.Error("an existing name taken for no hard links")
	}
}
