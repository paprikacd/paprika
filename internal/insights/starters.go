package insights

import (
	"embed"
	"fmt"
	"io/fs"
	"strings"
)

// starterFiles holds the first-party starter dashboards. Each file is a complete
// dashboard document whose id matches its file name without the .json extension.
//
//go:embed starters/*.json
var starterFiles embed.FS

// Starter is a first-party dashboard offered as a starting point. ID is the
// document's id, which is also its file name without the .json extension.
type Starter struct {
	ID       string
	Document Dashboard
}

// Starters returns the starter dashboards in file-name order. The documents are
// embedded in the binary, so only a broken build can make this fail. Each
// starter passes the save-time schema and lint rules; starters_test.go checks that.
func Starters() ([]Starter, error) {
	entries, err := fs.ReadDir(starterFiles, "starters")
	if err != nil {
		return nil, fmt.Errorf("read starters: %w", err)
	}
	starters := make([]Starter, 0, len(entries))
	for _, entry := range entries {
		data, err := starterFiles.ReadFile("starters/" + entry.Name())
		if err != nil {
			return nil, fmt.Errorf("read starter %s: %w", entry.Name(), err)
		}
		starters = append(starters, Starter{ID: strings.TrimSuffix(entry.Name(), ".json"), Document: data})
	}
	return starters, nil
}
