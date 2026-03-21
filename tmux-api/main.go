package main

import (
	"net/http"
	"os"
)

func main() {
	// Full server mode: --serve flag or TERMOTE_SERVE env
	if hasFlag("--serve") || os.Getenv("TERMOTE_SERVE") == "true" {
		cfg := newServeConfigFromEnv()
		startServeMode(cfg)
		return
	}

	// API-only mode (backward compatible, port 7682)
	http.HandleFunc("/windows", handleWindows)
	http.HandleFunc("/select/", handleSelect)
	http.HandleFunc("/new", handleNew)
	http.HandleFunc("/kill/", handleKill)
	http.HandleFunc("/rename/", handleRename)
	http.HandleFunc("/send-keys", handleSendKeys)
	http.HandleFunc("/health", handleHealth)

	http.ListenAndServe(":7682", nil)
}

func hasFlag(flag string) bool {
	for _, arg := range os.Args[1:] {
		if arg == flag {
			return true
		}
	}
	return false
}
