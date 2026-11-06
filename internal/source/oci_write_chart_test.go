package source

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/chart/loader"
	"helm.sh/helm/v3/pkg/chartutil"
	"helm.sh/helm/v3/pkg/registry"
)

// testChartArchive returns a packaged chart whose template carries marker.
func testChartArchive(t *testing.T, marker string) []byte {
	t.Helper()
	c := &chart.Chart{
		Metadata:  &chart.Metadata{APIVersion: chart.APIVersionV2, Name: "demo", Version: "0.1.0"},
		Templates: []*chart.File{{Name: "templates/cm.yaml", Data: []byte("kind: ConfigMap\\n# " + marker + "\\n")}},
	}
	dir := t.TempDir()
	path, err := chartutil.Save(c, dir)
	if err != nil {
		t.Fatalf("package chart: %v", err)
	}
	data, err := os.ReadFile(path) // #nosec G304 -- chart written to t.TempDir()
	if err != nil {
		t.Fatalf("read chart: %v", err)
	}
	return data
}

func summary(data []byte) *registry.DescriptorPullSummaryWithMeta {
	return &registry.DescriptorPullSummaryWithMeta{
		DescriptorPullSummary: registry.DescriptorPullSummary{Data: data},
		Meta:                  &chart.Metadata{Name: "demo"},
	}
}

// TestWriteChartConcurrentResolvesShareOneCompleteDirectory is the regression
// test for the repo-server failure "remove temporary chart tarball ...". Every
// resolve of one chart wrote and removed the same <chart>.tgz and extracted into
// the same directory, so a concurrent resolve lost its archive or read a half
// written chart.
func TestWriteChartConcurrentResolvesShareOneCompleteDirectory(t *testing.T) {
	dest := t.TempDir()
	data := testChartArchive(t, "v1")
	const workers = 16
	paths := make([]string, workers)
	errs := make([]error, workers)
	var start, done sync.WaitGroup
	start.Add(1)
	for i := range workers {
		done.Add(1)
		go func() {
			defer done.Done()
			start.Wait()
			paths[i], errs[i] = writeChart(summary(data), dest)
		}()
	}
	start.Done()
	done.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("resolve %d failed: %v", i, err)
		}
		if paths[i] != paths[0] {
			t.Fatalf("resolve %d returned %q, want the shared directory %q", i, paths[i], paths[0])
		}
	}
	c, err := loader.Load(paths[0])
	if err != nil {
		t.Fatalf("load extracted chart: %v", err)
	}
	if c.Name() != "demo" || len(c.Templates) != 1 || !bytes.Contains(c.Templates[0].Data, []byte("v1")) {
		t.Fatalf("extracted chart is incomplete: name=%q templates=%d", c.Name(), len(c.Templates))
	}
	entries, err := os.ReadDir(dest)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			t.Errorf("left temporary entry %q behind", e.Name())
		}
	}
	if len(entries) != 1 {
		t.Errorf("cache holds %d entries, want one directory per chart digest", len(entries))
	}
}

// A new chart version under the same name lands in its own directory, so a
// render still reading the old directory never sees files change under it.
func TestWriteChartKeepsEachDigestInItsOwnImmutableDirectory(t *testing.T) {
	dest := t.TempDir()
	first, err := writeChart(summary(testChartArchive(t, "v1")), dest)
	if err != nil {
		t.Fatal(err)
	}
	second, err := writeChart(summary(testChartArchive(t, "v2")), dest)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatalf("two chart digests share %q", first)
	}
	old, err := os.ReadFile(filepath.Join(first, "templates", "cm.yaml")) // #nosec G304 -- chart under t.TempDir()
	if err != nil || !bytes.Contains(old, []byte("v1")) {
		t.Fatalf("the first directory changed after a second version arrived: %q, %v", old, err)
	}
	again, err := writeChart(summary(testChartArchive(t, "v1")), dest)
	if err != nil || again != first {
		t.Fatalf("re-resolving the first version returned %q (%v), want the existing %q", again, err, first)
	}
}

func TestWriteChartRejectsAnArchiveItCannotLoad(t *testing.T) {
	dest := t.TempDir()
	if _, err := writeChart(summary([]byte("not a chart")), dest); err == nil {
		t.Fatal("writeChart accepted bytes that are not a chart archive")
	}
	entries, _ := os.ReadDir(dest)
	if len(entries) != 0 {
		t.Errorf("a failed extract left %d entries behind", len(entries))
	}
}
