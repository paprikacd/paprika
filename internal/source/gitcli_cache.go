package source

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"sigs.k8s.io/controller-runtime/pkg/log"

	paprikametrics "github.com/benebsworth/paprika/internal/metrics"
)

// cacheScanInterval spaces the scans of one cache: a scan walks every file.
const cacheScanInterval = 30 * time.Second

// orphanAge is how old a checkout directory without a marker (an
// interrupted write) must be before a scan removes it.
const orphanAge = time.Hour

var cacheScans = struct {
	sync.Mutex
	last    map[string]time.Time
	running map[string]bool
}{last: map[string]time.Time{}, running: map[string]bool{}}

// scheduleCacheEviction scans the cache under root in the background, at
// most once per cacheScanInterval, recording its size and evicting the least
// recently used entries above the size bound.
func scheduleCacheEviction(ctx context.Context, root string) {
	cacheScans.Lock()
	if cacheScans.running[root] || time.Since(cacheScans.last[root]) < cacheScanInterval {
		cacheScans.Unlock()
		return
	}
	cacheScans.running[root], cacheScans.last[root] = true, time.Now()
	cacheScans.Unlock()
	s := currentGitSettings()
	scanCtx := context.WithoutCancel(ctx)
	go func() {
		defer func() {
			cacheScans.Lock()
			cacheScans.running[root] = false
			cacheScans.Unlock()
		}()
		evictCache(scanCtx, root, s.cacheMaxBytes, s.cacheMinAge)
	}()
}

// cacheEntry is one evictable unit of the cache: a mirror, or a checkout with
// its marker.
type cacheEntry struct {
	kind     string
	path     string
	marker   string
	size     int64
	lastUsed time.Time
}

// evictCache removes the least recently used entries until the cache under
// root fits maxBytes (0: no bound), never one used within minAge, which a
// render may still be reading, and never a mirror in use. It returns the bytes
// left.
func evictCache(ctx context.Context, root string, maxBytes int64, minAge time.Duration) int64 {
	entries, total := scanCache(ctx, root)
	if maxBytes > 0 && total > maxBytes {
		sort.Slice(entries, func(i, j int) bool { return entries[i].lastUsed.Before(entries[j].lastUsed) })
		for i := range entries {
			e := &entries[i]
			if total <= maxBytes {
				break
			}
			if time.Since(e.lastUsed) < minAge || !removeCacheEntry(e, minAge) {
				continue
			}
			total -= e.size
			paprikametrics.GitCacheEvictions.Add(ctx, 1, metric.WithAttributes(attribute.String("kind", e.kind)))
			log.FromContext(ctx).Info("Evicted git cache entry", "kind", e.kind, "path", e.path,
				"bytes", e.size, "lastUsed", e.lastUsed.UTC().Format(time.RFC3339))
		}
	}
	paprikametrics.GitCacheSize.Record(ctx, total)
	return total
}

// scanCache lists the cache's mirrors and checkouts, and removes interrupted
// checkouts older than orphanAge.
func scanCache(ctx context.Context, root string) (entries []cacheEntry, total int64) {
	mirrors, _ := os.ReadDir(filepath.Join(root, "mirrors")) //nolint:errcheck // no mirrors yet
	for _, m := range mirrors {
		if !m.IsDir() || !strings.HasSuffix(m.Name(), ".git") {
			continue
		}
		dir := filepath.Join(root, "mirrors", m.Name())
		used := modTime(filepath.Join(dir, mirrorUsedFile))
		if used.IsZero() { // created, never yet used by a resolve that finished
			used = modTime(dir)
		}
		e := cacheEntry{kind: "mirror", path: dir, size: dirSize(dir), lastUsed: used}
		entries, total = append(entries, e), total+e.size
	}
	repos, _ := os.ReadDir(filepath.Join(root, "checkouts")) //nolint:errcheck // no checkouts yet
	for _, r := range repos {
		dir := filepath.Join(root, "checkouts", r.Name())
		items, _ := os.ReadDir(dir) //nolint:errcheck // removed concurrently
		for _, item := range items {
			if !item.IsDir() {
				continue
			}
			e, ok := checkoutEntry(ctx, dir, item.Name())
			if ok {
				entries, total = append(entries, e), total+e.size
			}
		}
	}
	return entries, total
}

// checkoutEntry describes the checkout directory name under dir, removing it
// instead when it is an interrupted write old enough to be abandoned.
func checkoutEntry(ctx context.Context, dir, name string) (cacheEntry, bool) {
	path := filepath.Join(dir, name)
	marker := path + checkoutMarkerSuffix
	if used := modTime(marker); !used.IsZero() && !strings.Contains(name, checkoutTempInfix) {
		return cacheEntry{kind: "checkout", path: path, marker: marker, size: dirSize(path), lastUsed: used}, true
	}
	if time.Since(modTime(path)) > max(orphanAge, 2*currentGitSettings().fetchTimeout) {
		if os.RemoveAll(path) == nil {
			paprikametrics.GitCacheEvictions.Add(ctx, 1, metric.WithAttributes(attribute.String("kind", "orphan")))
		}
	}
	return cacheEntry{}, false
}

// removeCacheEntry removes e, reporting whether it did. A checkout used since
// the scan is kept, and loses its marker first, so no resolve takes it while
// it is removed; a mirror is removed only when no resolve holds it.
func removeCacheEntry(e *cacheEntry, minAge time.Duration) bool {
	if e.kind == "checkout" {
		if time.Since(modTime(e.marker)) < minAge {
			return false
		}
		if err := os.Remove(e.marker); err != nil && !os.IsNotExist(err) {
			return false
		}
		return os.RemoveAll(e.path) == nil
	}
	repo := cliRepoFor(e.path, "")
	if !repo.life.TryLock() {
		return false
	}
	defer repo.life.Unlock()
	repo.inited.Store(false)
	return os.RemoveAll(e.path) == nil
}

// dirSize is the apparent size of the files under dir.
func dirSize(dir string) int64 {
	var total int64
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error { //nolint:errcheck // a partial size is fine
		if err != nil || d.IsDir() {
			return nil //nolint:nilerr // skip what vanished mid-walk
		}
		if info, infoErr := d.Info(); infoErr == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

func modTime(path string) time.Time {
	info, err := os.Lstat(path)
	if err != nil {
		return time.Time{}
	}
	return info.ModTime()
}
