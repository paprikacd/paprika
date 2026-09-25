/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Package version is the single source of truth for build identity. Every
// binary (server modes and the paprika CLI) stamps these vars via
//
//	-ldflags "-X github.com/benebsworth/paprika/internal/version.Version=vX.Y.Z
//	          -X github.com/benebsworth/paprika/internal/version.Commit=<sha>
//	          -X github.com/benebsworth/paprika/internal/version.Date=<iso8601>"
//
// Release builds set them from the tag (GoReleaser); CI images stamp the
// commit sha; unversioned local builds keep the "dev" defaults.
package version

import "runtime/debug"

var (
	// Version is the release semver (v-prefixed) or "dev" for local builds.
	Version = "dev"
	// Commit is the full git SHA the binary was built from.
	Commit = "none"
	// Date is the ISO-8601 build timestamp.
	Date = "unknown"
)

// String renders a compact one-line identity, e.g. "v1.2.3 (abc1234)".
func String() string {
	if Commit != "none" && len(Commit) >= 7 {
		return Version + " (" + Commit[:7] + ")"
	}
	return Version
}

// moduleVersion reads the Go module version stamped by `go install`-style
// builds (no ldflags involved), so a `go install ...@vX.Y.Z` binary still
// reports its real version instead of "dev".
func moduleVersion() string {
	if bi, ok := debug.ReadBuildInfo(); ok && bi.Main.Version != "" &&
		bi.Main.Version != "(devel)" {
		return bi.Main.Version
	}
	return ""
}

func init() {
	if Version == "dev" {
		if v := moduleVersion(); v != "" {
			Version = v
		}
	}
}
