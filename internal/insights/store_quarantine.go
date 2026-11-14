package insights

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// quarantineDirName is the directory under the data root that holds documents moved aside at startup. Loaders read
// only the regular .json files directly inside each store directory, so nothing below this directory is ever read as
// a store entry.
const quarantineDirName = "quarantine"

// Quarantine kinds name both the quarantine subdirectory and the kind label of the counter.
const (
	quarantineKindDashboard  = "dashboard"
	quarantineKindSavedQuery = "saved_query"
)

// errDocumentTooLarge reports a stored document over its size limit. Startup quarantines it like any other invalid
// document, because a newer build may have written a larger one.
var errDocumentTooLarge = errors.New("document exceeds its size limit")

// quarantineStoredDocument moves an invalid stored document out of its store so the store can open. The file becomes
// <root>/quarantine/<kind>/<id>.<unix-nanos>.json, a warning names the kind, id and reason, and the quarantine counter
// increments. A failed move is returned, so the store refuses to open rather than let a later write replace the copy
// it could not move.
func quarantineStoredDocument(root, dir, kind, id string, reason error) error {
	target := filepath.Join(root, quarantineDirName, kind)
	if err := os.MkdirAll(target, 0o700); err != nil {
		return fmt.Errorf("create quarantine directory: %w", err)
	}
	destination := uniqueQuarantinePath(target, id, time.Now().UnixNano())
	if err := os.Rename(filepath.Join(dir, id+".json"), destination); err != nil {
		return fmt.Errorf("quarantine %s %s: %w", kind, id, err)
	}
	if err := errors.Join(syncDirectory(dir), syncDirectory(target)); err != nil {
		return fmt.Errorf("quarantine %s %s: %w", kind, id, err)
	}
	slog.Warn("quarantined invalid stored document; the store opened without it", "kind", kind, "id", id, "reason", reason.Error(), "moved_to", destination)
	recordQuarantine(kind)
	return nil
}

// uniqueQuarantinePath never returns an existing file, so an earlier quarantined copy is never overwritten.
func uniqueQuarantinePath(target, id string, stamp int64) string {
	for ; ; stamp++ {
		candidate := filepath.Join(target, fmt.Sprintf("%s.%d.json", id, stamp))
		if _, err := os.Lstat(candidate); err != nil {
			return candidate
		}
	}
}

// recordQuarantine increments paprika_insights_store_quarantined_total on the meter provider installed when the
// document is quarantined, so the counter follows whichever provider main or a test has set.
func recordQuarantine(kind string) {
	counter, err := otel.Meter("paprika").Int64Counter("paprika_insights_store_quarantined", metric.WithDescription("Stored documents quarantined at startup because they failed validation"))
	if err != nil {
		slog.Warn("quarantine counter unavailable", "error", err)
		return
	}
	counter.Add(context.Background(), 1, metric.WithAttributes(attribute.String("kind", kind)))
}
