package main

func main() {
	cfg := newServeConfigFromEnv()
	startServeMode(cfg)
}
