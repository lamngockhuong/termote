package main

// cliVersion is this binary's version. release-please updates it for each
// release, and release.yml refuses a tag whose commit names another version
// here (a release made by hand bumps it first); the release build also sets
// it (-ldflags "-X main.cliVersion=<v>").
var cliVersion = "2.26.4" // x-release-please-version
