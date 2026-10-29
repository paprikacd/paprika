package source

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// The cluster image (Dockerfile, published by ci.yml and run by omega's repo
// server and manager) and the images built for pushing to a cluster by hand
// install a pinned git series new enough for the CLI backend. The release
// image (Dockerfile.goreleaser) ships none, as hack/test-cli-release-contract.sh
// requires, and resolves with go-git.
func TestImagesShipGitOnlyWhereTheClusterRuntimeUsesIt(t *testing.T) {
	pinned := regexp.MustCompile(`apk add --no-cache ca-certificates "git~2\.(\d+)"`)
	for _, name := range []string{"Dockerfile", "Dockerfile.fast", "Dockerfile.ko"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", name)) // #nosec G304 -- fixed repository files
		if err != nil {
			t.Fatal(err)
		}
		m := pinned.FindSubmatch(raw)
		if m == nil {
			t.Errorf("%s does not install a pinned git series", name)
			continue
		}
		if minor := string(m[1]); len(minor) < 2 || minor < "44" {
			t.Errorf("%s pins git 2.%s; the CLI backend needs 2.%d or newer", name, minor, minGitMinor)
		}
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "Dockerfile.goreleaser"))
	if err != nil {
		t.Fatal(err)
	}
	if regexp.MustCompile(`apk add[^\n]*\bgit\b`).Match(raw) {
		t.Error("Dockerfile.goreleaser installs git; the release contract keeps the release runtime in-process")
	}
}
