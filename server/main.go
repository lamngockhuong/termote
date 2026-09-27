package main

import "os"

// Without arguments (or with "serve") the binary runs the server, as every
// 0.x launcher and the container entrypoint expect; anything else is a CLI
// subcommand.
func main() {
	if len(os.Args) > 1 && os.Args[1] != "serve" {
		os.Exit(runCLI(os.Args[1:]))
	}
	cfg := newServeConfigFromEnv()
	scrubSecretEnv()
	startServeMode(cfg)
}
