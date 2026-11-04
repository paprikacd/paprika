// Command gen-time-zones writes the dashboard time zone allowlist that both
// halves of Insights share: internal/insights/timezones_generated.go for the
// server and ui/src/features/insights/time-zones.generated.ts for the UI.
//
// Source: the Go toolchain's lib/time/zoneinfo.zip. That archive is what
// time/tzdata embeds, so the server accepts exactly these names, and the
// allowlist changes only when the toolchain's tz database changes. Each entry
// is an IANA zone or link name, spelled as the database spells it.
//
// Exclusions: Factory, Local, localtime, posixrules, the posix/ and right/
// prefixes, and offsets such as +05:30.
//
// Kept on purpose: links such as US/Pacific and Asia/Calcutta, and the
// Etc/GMT+-N names (which are sign-inverted, but valid). The browser and the
// server both accepted them before this list existed, and saved dashboards may
// name them. The server validates every saved dashboard when it opens, so
// dropping a name that was once valid would stop the server from starting. The
// archive does not mark links, so separating them from canonical zones would
// need a second source; keeping them is the simpler, deterministic choice.
//
// Usage, from the repository root:
//
//	go run ./hack/gen-time-zones         # write both files
//	go run ./hack/gen-time-zones -check  # exit 1 if either file is stale
package main

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"go/format"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

const (
	uiPath = "ui/src/features/insights/time-zones.generated.ts"
	goPath = "internal/insights/timezones_generated.go"
)

// zoneName admits only the spellings that need no escaping in either output
// language: letters, digits, underscore, plus, minus and slash.
var zoneName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_+\-]*(/[A-Za-z0-9_+\-]+)*$`)

func main() {
	root := flag.String("root", ".", "repository root that holds the generated files")
	archive := flag.String("zoneinfo", "", "zoneinfo.zip to read (default: the toolchain's lib/time/zoneinfo.zip)")
	check := flag.Bool("check", false, "exit 1 instead of writing when a generated file is stale")
	flag.Parse()

	if *archive == "" {
		path, err := toolchainArchive()
		if err != nil {
			fail(err)
		}
		*archive = path
	}
	names, err := readArchive(*archive)
	if err != nil {
		fail(err)
	}
	zones, err := allowlist(names)
	if err != nil {
		fail(err)
	}
	goSource, err := format.Source(renderGo(zones))
	if err != nil {
		fail(fmt.Errorf("format Go output: %w", err))
	}
	outputs := map[string][]byte{
		filepath.Join(*root, uiPath): renderTS(zones),
		filepath.Join(*root, goPath): goSource,
	}
	if err := writeOutputs(outputs, *check); err != nil {
		fail(err)
	}
	fmt.Fprintf(os.Stderr, "%d dashboard time zones from %s\n", len(zones), *archive)
}

func writeOutputs(outputs map[string][]byte, check bool) error {
	for path, content := range outputs {
		if check {
			current, err := os.ReadFile(path) //nolint:gosec // G304: the generator reads its two fixed output files under -root.
			if err != nil || !bytes.Equal(current, content) {
				return fmt.Errorf("%s is stale: run go run ./hack/gen-time-zones", path)
			}
			continue
		}
		if err := os.WriteFile(path, content, 0o644); err != nil { //nolint:gosec // G306: the generated sources are committed and read by the build, like their neighbours.
			return err
		}
	}
	return nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "gen-time-zones:", err)
	os.Exit(1)
}

// toolchainArchive asks the go command where its toolchain lives, so the
// generator reads the tz database that the server build embeds.
func toolchainArchive() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "go", "env", "GOROOT").Output()
	if err != nil {
		return "", fmt.Errorf("find the Go toolchain: %w", err)
	}
	return filepath.Join(strings.TrimSpace(string(out)), "lib", "time", "zoneinfo.zip"), nil
}

// readArchive lists every file entry in the zip, in the archive's own spelling.
func readArchive(path string) ([]string, error) {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return nil, fmt.Errorf("open zoneinfo archive: %w", err)
	}
	names := make([]string, 0, len(reader.File))
	for _, file := range reader.File {
		if !strings.HasSuffix(file.Name, "/") {
			names = append(names, file.Name)
		}
	}
	if err := reader.Close(); err != nil {
		return nil, fmt.Errorf("close zoneinfo archive: %w", err)
	}
	if len(names) == 0 {
		return nil, errors.New("zoneinfo archive holds no zone files")
	}
	return names, nil
}

// excluded reports whether an archive entry is not a dashboard zone name.
func excluded(name string) bool {
	switch name {
	case "Factory", "Local", "localtime", "posixrules":
		return true
	}
	if strings.HasPrefix(name, "posix/") || strings.HasPrefix(name, "right/") {
		return true
	}
	// Offsets such as +05:30 are not zone names, whatever the runtime accepts.
	return strings.HasPrefix(name, "+") || strings.HasPrefix(name, "-")
}

// allowlist returns the kept names, sorted byte-wise and without duplicates.
func allowlist(names []string) ([]string, error) {
	kept := make([]string, 0, len(names))
	for _, name := range names {
		if excluded(name) {
			continue
		}
		if !zoneName.MatchString(name) {
			return nil, fmt.Errorf("archive entry %q is not a plain zone name", name)
		}
		kept = append(kept, name)
	}
	slices.Sort(kept)
	kept = slices.Compact(kept)
	if len(kept) == 0 {
		return nil, errors.New("no zone names survived the exclusions")
	}
	return kept, nil
}

const header = `// Code generated by hack/gen-time-zones. DO NOT EDIT.
// Regenerate with: go run ./hack/gen-time-zones
// The dashboard time zone allowlist. The server and the UI hold the same names,
// and a Go test keeps them equal.
`

func renderTS(zones []string) []byte {
	var b strings.Builder
	b.WriteString("// Code generated by hack/gen-time-zones. DO NOT EDIT.\n")
	b.WriteString("// Regenerate with: go run ./hack/gen-time-zones\n")
	b.WriteString("// The dashboard time zone allowlist. The server holds the same names (internal/insights/timezones_generated.go),\n")
	b.WriteString("// and a Go test keeps the two lists equal.\n\n")
	b.WriteString("export const timeZones = [\n")
	for _, zone := range zones {
		fmt.Fprintf(&b, "  %q,\n", zone)
	}
	b.WriteString("] as const\n")
	return []byte(b.String())
}

func renderGo(zones []string) []byte {
	var b strings.Builder
	b.WriteString(header)
	b.WriteString("\npackage insights\n\n")
	b.WriteString("// canonicalTimeZones lists the IANA zone names a dashboard may name. Matching is exact and case-sensitive.\n")
	b.WriteString("var canonicalTimeZones = map[string]struct{}{\n")
	for _, zone := range zones {
		fmt.Fprintf(&b, "\t%q: {},\n", zone)
	}
	b.WriteString("}\n")
	return []byte(b.String())
}
