package main

import "encoding/base64"

// brandOwlPath is the Prompt Owl symbol as one path whose eyes and beak are
// holes (assets/branding/termote/logo/symbol-knockout.svg; a test keeps the
// two equal). The sign-in and pairing pages are served before any
// authentication, while every icon file sits behind it, so they carry the
// mark and their favicon inline.
const brandOwlPath = "M28 20 L166 62 L304 20 L282 68 L297 91 L286 203 Q283 226 261 237 L166 280 L71 237 Q49 226 46 203 L35 91 L50 68 ZM68 103 L112 135 L68 167 L68 146 L88 135 L68 124 ZM264 103 L220 135 L264 167 L264 146 L244 135 L264 124 ZM145 175 L187 175 L166 211 Z"

// brandHead is the favicon link of the server's own pages, drawn as
// icons/favicon.svg is (the owl in white on an ink tile, here one path with
// the eyes cut out), as a data: URL (img-src allows data:). Literal template text, so
// html/template copies it as is.
var brandHead = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,` +
	base64.StdEncoding.EncodeToString([]byte(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`+
			`<rect width="64" height="64" rx="14" fill="#101316"/>`+
			`<path transform="translate(.4 3) scale(.19)" fill="#fff" fill-rule="evenodd" d="`+brandOwlPath+`"/></svg>`)) +
	`">`

// brandMark is the decorative symbol, in the text colour. It sits beside
// the name, as the horizontal lockup and the app's sidebar have it.
const brandMark = `<svg class="mark" viewBox="28 20 276 260" width="30" height="28" aria-hidden="true" focusable="false">` +
	`<path fill="currentColor" fill-rule="evenodd" d="` + brandOwlPath + `"/></svg>`

// brandMarkCSS lays out the mark and the name in one row; shared by both
// pages' style blocks. The row's h1 or name keeps the page's heading size.
const brandMarkCSS = `  .brand { display: flex; align-items: center; gap: 10px; margin: 0 0 8px; }
  .brand .mark { flex: none; }
  .brand h1 { margin: 0; }
  .brand .name { font-size: 22px; font-weight: 600; }
`
