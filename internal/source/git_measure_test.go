package source

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-logr/logr/testr"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

// TestMeasureColdResolve times one cold resolve of a real repository and
// reports the bytes it left on disk. It is a measurement, not a check, and runs
// only when PAPRIKA_GIT_MEASURE_REPO names a repository:
//
//	PAPRIKA_GIT_MEASURE_REPO=https://github.com/skunkworq/brandbrain \
//	PAPRIKA_GIT_MEASURE_PATH=deploy/kubernetes/chart \
//	PAPRIKA_GIT_MEASURE_TOKEN="$(gh auth token)" \
//	PAPRIKA_GIT_MEASURE_BACKEND=cli \
//	go test ./internal/source -run TestMeasureColdResolve -v -timeout 60m
//
// PAPRIKA_GIT_MEASURE_REVISION (default: the remote's HEAD) and
// PAPRIKA_GIT_MEASURE_DIR (default: a temporary directory, removed afterwards)
// are optional. A warm resolve of the same source follows the cold one, and
// PAPRIKA_GIT_MEASURE_OLD, a commit, adds a resolve of it into the warm cache
// (a drift render of an older release).
func TestMeasureColdResolve(t *testing.T) {
	repo := os.Getenv("PAPRIKA_GIT_MEASURE_REPO")
	if repo == "" {
		t.Skip("PAPRIKA_GIT_MEASURE_REPO not set")
	}
	workDir := os.Getenv("PAPRIKA_GIT_MEASURE_DIR")
	if workDir == "" {
		workDir = t.TempDir()
	}
	src := &GitSource{
		RepoURL:  repo,
		Revision: os.Getenv("PAPRIKA_GIT_MEASURE_REVISION"),
		Path:     os.Getenv("PAPRIKA_GIT_MEASURE_PATH"),
		WorkDir:  workDir,
		Auth:     GitAuth{Token: os.Getenv("PAPRIKA_GIT_MEASURE_TOKEN")},
		Shallow:  true,
		Backend:  GitBackend(os.Getenv("PAPRIKA_GIT_MEASURE_BACKEND")),
	}
	phases := []string{"cold", "warm"}
	if os.Getenv("PAPRIKA_GIT_MEASURE_OLD") != "" {
		phases = append(phases, "old")
	}
	for _, phase := range phases {
		if phase == "old" {
			src.Revision = os.Getenv("PAPRIKA_GIT_MEASURE_OLD")
		}
		ctx, cancel := context.WithTimeout(log.IntoContext(context.Background(), testr.New(t)), 60*time.Minute)
		start := time.Now()
		result, err := src.Resolve(ctx)
		elapsed := time.Since(start)
		cancel()
		if err != nil {
			t.Fatalf("%s resolve: %v", phase, err)
		}
		t.Logf("%s resolve: %s, %d bytes under the work dir, revision %s, path %s",
			phase, elapsed.Round(time.Millisecond), dirBytes(t, workDir), result.Revision, result.LocalPath)
	}
}

// dirBytes is the apparent size of the regular files under dir.
func dirBytes(t *testing.T, dir string) int64 {
	t.Helper()
	var total int64
	err := filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error { // #nosec G703 -- the test's own work dir
		if err != nil || !d.Type().IsRegular() {
			return err
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return infoErr
		}
		total += info.Size()
		return nil
	})
	if err != nil {
		t.Fatalf("size %s: %v", dir, err)
	}
	return total
}
