package cicontract

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The image build runs `go build` inside a Docker context that .dockerignore filters down to an allowlist. A
// go:embed file the allowlist leaves out compiles locally and in go-test, then fails only when the image is
// built. Every file a built package embeds must survive the filter, unless the Dockerfile copies it in from an
// earlier stage.
func TestDockerContextKeepsEveryEmbeddedFile(t *testing.T) {
	root := repositoryRoot(t)
	dockerfile := readRepoFile(t, root, "Dockerfile")
	rules := parseDockerignore(t, readRepoFile(t, root, ".dockerignore"))

	targets := dockerGoBuildTargets(dockerfile)
	if len(targets) == 0 {
		t.Fatal("Dockerfile has no go build targets; this test no longer knows what the image compiles")
	}
	staged := dockerStagedCopies(dockerfile)

	args := append([]string{"list", "-e", "-deps", "-f", `{{if not .Standard}}{{.Dir}}{{range .EmbedFiles}}|{{.}}{{end}}{{end}}`}, targets...)
	cmd := exec.CommandContext(t.Context(), "go", args...) // #nosec G204 -- fixed tool, arguments come from the repository Dockerfile.
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("go list %v: %v", targets, err)
	}

	checked := 0
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		fields := strings.Split(line, "|")
		dir, embeds := fields[0], fields[1:]
		rel, err := filepath.Rel(root, dir)
		if err != nil || strings.HasPrefix(rel, "..") {
			continue // a dependency outside the module
		}
		for _, embed := range embeds {
			path := filepath.ToSlash(filepath.Join(rel, embed))
			if stagedCopy(staged, path) {
				continue
			}
			checked++
			if rules.excluded(path) {
				t.Errorf("%s is embedded by %s but .dockerignore leaves it out of the image build context; add !%s", path, filepath.ToSlash(rel), path)
			}
		}
	}
	if checked == 0 {
		t.Fatal("found no embedded files to check; go list output changed shape")
	}
}

func readRepoFile(t *testing.T, root, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, name)) // #nosec G304 -- fixed repository paths.
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(data)
}

var goBuildTarget = regexp.MustCompile(`\bgo build\b.*?((?:\s\./\S*)+)\s*$`)

// dockerGoBuildTargets returns the package paths of every `go build` line in the Dockerfile.
func dockerGoBuildTargets(dockerfile string) []string {
	var targets []string
	for _, line := range strings.Split(dockerfile, "\n") {
		if m := goBuildTarget.FindStringSubmatch(line); m != nil {
			targets = append(targets, strings.Fields(m[1])...)
		}
	}
	return targets
}

var stagedCopyLine = regexp.MustCompile(`^COPY\s+--from=\S+\s+\S+\s+(\S+)\s*$`)

// dockerStagedCopies returns the destinations that COPY --from writes into the build stage's working tree.
func dockerStagedCopies(dockerfile string) []string {
	var dests []string
	for _, line := range strings.Split(dockerfile, "\n") {
		if m := stagedCopyLine.FindStringSubmatch(strings.TrimSpace(line)); m != nil && !strings.HasPrefix(m[1], "/") && m[1] != "." {
			dests = append(dests, strings.TrimPrefix(m[1], "./"))
		}
	}
	return dests
}

func stagedCopy(dests []string, path string) bool {
	for _, dest := range dests {
		if path == dest || (strings.HasSuffix(dest, "/") && strings.HasPrefix(path, dest)) {
			return true
		}
	}
	return false
}

type dockerignoreRule struct {
	pattern *regexp.Regexp
	include bool
}

type dockerignoreRules []dockerignoreRule

// parseDockerignore follows Docker's rules: patterns are relative to the context root, `**` spans directories,
// `*` and `?` stay within one path element, a pattern also matches everything under a directory it matches, and
// the last matching rule wins.
func parseDockerignore(t *testing.T, text string) dockerignoreRules {
	t.Helper()
	var rules dockerignoreRules
	scanner := bufio.NewScanner(strings.NewReader(text))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		include := strings.HasPrefix(line, "!")
		line = strings.TrimPrefix(strings.TrimPrefix(line, "!"), "/")
		var expr strings.Builder
		expr.WriteString("^")
		for i := 0; i < len(line); i++ {
			switch c := line[i]; {
			case c == '*' && i+1 < len(line) && line[i+1] == '*':
				i++
				if i+1 < len(line) && line[i+1] == '/' {
					i++
					expr.WriteString("(?:.*/)?")
				} else {
					expr.WriteString(".*")
				}
			case c == '*':
				expr.WriteString("[^/]*")
			case c == '?':
				expr.WriteString("[^/]")
			default:
				expr.WriteString(regexp.QuoteMeta(string(c)))
			}
		}
		expr.WriteString("(?:/.*)?$")
		pattern, err := regexp.Compile(expr.String())
		if err != nil {
			t.Fatalf(".dockerignore pattern %q: %v", line, err)
		}
		rules = append(rules, dockerignoreRule{pattern: pattern, include: include})
	}
	return rules
}

func (rules dockerignoreRules) excluded(path string) bool {
	excluded := false
	for _, rule := range rules {
		if rule.pattern.MatchString(path) {
			excluded = !rule.include
		}
	}
	return excluded
}
