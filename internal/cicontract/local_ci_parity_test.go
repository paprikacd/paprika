package cicontract

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// localCIExcludedJobs are the ci.yml jobs that are not local CI jobs. publish is replaced by the image build in
// hack/deploy/vke.sh, and deploy-vke is a reusable workflow whose steps hack/deploy/vke-cluster.sh mirrors.
var localCIExcludedJobs = map[string]bool{"publish": true, "deploy-vke": true}

// localCIGitHubActions are the `uses:` actions that have no command of their own locally. Each one is replaced
// by the local step named in its value. An action missing from this map fails the test, so a new step cannot
// be skipped without a decision.
var localCIGitHubActions = map[string]string{
	"actions/checkout":                      "the job runs in a fresh detached worktree of the commit (hack/ci/run.sh)",
	"./.github/actions/reclaim-runner-disk": "a GitHub-hosted runner disk step; the local runner has no shared disk to reclaim",
	"actions/setup-go":                      "Go is pinned and verified by hack/ci/tools.sh",
	"actions/setup-node":                    "Node 22 is resolved by hack/ci/lib.sh (ci_node22_bin) and first on PATH",
	"hashicorp/setup-terraform":             "Terraform is pinned, checksum-verified and installed by hack/ci/tools.sh",
	"azure/setup-helm":                      "Helm is pinned, checksum-verified and installed by hack/ci/tools.sh",
	"go-task/setup-task":                    "Task is verified at its pinned version by hack/ci/tools.sh",
	"goreleaser/goreleaser-action":          "GoReleaser is verified at its pinned version by hack/ci/tools.sh",
	"docker/setup-buildx-action":            "the developer's Docker builder is used; the build step checks it",
	"actions/upload-artifact":               "ci_collect copies the listed paths to artifacts/ci/<tree>/<job>/ when the job ends",
	// docker/build-push-action is accepted only in cluster-integration, where it maps to docker buildx build --load.
	"docker/build-push-action": "cluster-integration only: docker buildx build --load (checked by checkLocalCIAction)",
}

// localCIGitHubOnlyRunSteps are `run:` steps with no command of their own locally, keyed "job/step name".
var localCIGitHubOnlyRunSteps = map[string]string{
	"cluster-integration/Install kind":                                       "kind is downloaded, checksum-verified and installed at its pinned version by hack/ci/tools.sh",
	"fleet-ui-smoke/Decide whether the Insights browser checks are affected": "ci.yml reads the base commit from the event and fetches it with the job token; the local job takes the merge base with master itself (hack/ci/jobs/fleet-ui-smoke.sh)",
}

// localCIPlatformForks are run steps whose local mirror branches on the host OS, because the ci.yml command is
// Linux-only. Keyed "job/step name". The branches must still run the ci.yml command, which the test checks.
var localCIPlatformForks = map[string]string{
	"application-records/Install Chromium": "--with-deps installs apt packages, which only Linux has; the macOS branch installs the browser alone",
}

// localCIRenames maps names that ci.yml writes literally to the local job's variable for the same thing.
// The cluster name is unique per run locally (see CI_CLUSTER in cluster-integration.sh).
var localCIRenames = map[string]string{"paprika-ci-integration": "$CI_CLUSTER"}

// localCIEquivalents maps a normalised ci.yml line to the normalised local line that does the same job.
var localCIEquivalents = map[string]string{
	"if [[ $RUNNER_OS == Linux ]]; then": "if [ $(uname -s) = Linux ]; then", // the local job tests the host OS
	"set -euo pipefail":                  "set -Eeuo pipefail",               // every job script starts with it
	"trap 'rm -rf -- $work' EXIT":        "ci_cleanup() {",                   // generated.sh removes its work directory on exit
	// A cleanup step (if: always()) must not fail the job after the cleanup itself has run, so the local line adds
	// the best-effort form. Only this exact line is accepted; any other `|| true` fails the test.
	"kind delete cluster --name $CI_CLUSTER": "kind delete cluster --name $CI_CLUSTER >/dev/null 2>&1 || true",
}

// localCIPinnedEnv are env keys that ci.yml sets but a local job does not export, because the pin lives in
// hack/ci/lib.sh, where ci_check_pins compares it with ci.yml. Keyed "job/KEY".
var localCIPinnedEnv = map[string]string{
	"cluster-integration/KIND_SHA256": "pinned as CI_KIND_LINUX_AMD64_SHA256 in hack/ci/lib.sh and checked by ci_check_pins",
}

var (
	shellContinuation = regexp.MustCompile(`\\[ \t]*\r?\n`)
	shellBraceVar     = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)
)

// localCIReporter is where the parity checks report. A *testing.T is one; a problemRecorder collects the messages,
// so a test can assert that a drifted script is rejected.
type localCIReporter interface {
	Helper()
	Errorf(format string, args ...any)
	Fatalf(format string, args ...any)
}

type problemRecorder struct{ msgs []string }

func (r *problemRecorder) Helper() {}

func (r *problemRecorder) Errorf(format string, args ...any) {
	r.msgs = append(r.msgs, fmt.Sprintf(format, args...))
}

func (r *problemRecorder) Fatalf(format string, args ...any) { r.Errorf(format, args...) }

// normaliseShell reduces a shell script to comparable lines: line continuations are joined, double quotes and
// the braces of ${NAME} are dropped, comments and blank lines are removed, and whitespace is collapsed.
func normaliseShell(text string) []string {
	text = shellContinuation.ReplaceAllString(text, " ")
	text = strings.ReplaceAll(text, `"`, "")
	text = shellBraceVar.ReplaceAllString(text, "$$$1")
	var lines []string
	for line := range strings.SplitSeq(text, "\n") {
		line = strings.Join(strings.Fields(line), " ")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}

func renameLocalCI(line string) string {
	for from, to := range localCIRenames {
		line = strings.ReplaceAll(line, from, to)
	}
	return line
}

// readLocalCIJob returns the normalised text of hack/ci/jobs/<job>.sh.
func readLocalCIJob(t *testing.T, job string) string {
	t.Helper()
	path := filepath.Join(repositoryRoot(t), "hack", "ci", "jobs", job+".sh")
	// #nosec G304 -- the path is a fixed repository location built from a job name that ci.yml defines.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ci.yml job %s has no local script %s: %v", job, filepath.ToSlash(path), err)
	}
	return strings.Join(normaliseShell(string(data)), "\n")
}

func mappingOrEmpty(value any) map[string]any {
	values, _ := value.(map[string]any)
	return values
}

// TestLocalCIJobParity checks that every command, working directory, job or step environment value, and
// service environment value of a ci.yml job is mirrored by its hack/ci/jobs script. A new step in ci.yml fails
// this test until the script mirrors it. The order of the steps is not compared.
//
// A command line must appear in the script as a whole line, after its continuations are joined. The only
// wrappers a local line may add are the ones the runner provides: "(cd DIR && ...)" for a step with a
// working-directory (the line must run in that directory), "export NAME=VALUE && " or "NAME=VALUE " before the
// command when ci.yml sets NAME to VALUE for the job or step, and "ci_with_timeout SECONDS " for a step with a
// timeout-minutes (required, with SECONDS = minutes x 60). A local line must not be guarded by a preceding line
// ending in ||, && or |, or sit inside an if, case, loop or function block, unless ci.yml's command does too. A
// trailing "|| true" or a different command does not match. A step that uses a GitHub-only action or a GitHub-only
// run step must be listed above with its reason.
func TestLocalCIJobParity(t *testing.T) {
	workflow := loadWorkflow(t, "ci.yml")
	for _, name := range sortedKeys(workflow.jobs) {
		if localCIExcludedJobs[name] {
			continue
		}
		job, ok := workflow.jobs[name].(map[string]any)
		if !ok {
			t.Fatalf("ci.yml job %s is not a mapping", name)
		}
		checkLocalCIJob(t, name, job, readLocalCIJob(t, name))
	}
}

// TestLocalCIParityRejectsDrift checks that the parity matcher rejects the drift that a plain substring match accepts:
// an inline setting that changes the command (x06), a guard on the line before a command that decides whether it
// runs (x07), a standalone export of a name ci.yml does not set (n14), and a command moved into a function that is
// never called (n15). The unmodified scripts pass, so each rejection is caused by the drift alone.
func TestLocalCIParityRejectsDrift(t *testing.T) {
	workflow := loadWorkflow(t, "ci.yml")
	cases := []struct {
		job, from, to string
	}{
		{"go-test", "make test-race", "GOFLAGS=-run=NONE make test-race"},
		{"chart", "helm lint charts/chart/", "test -n x ||\nhelm lint charts/chart/"},
		{"go-test", "make test-race", "export GOFLAGS=-run=NONE\nmake test-race"},
		{"go-test", "make test-race", "export GOFLAGS=-run=NONE;\nmake test-race"},
		{"go-test", "make test-race", "declare -x GOFLAGS=-run=NONE\nmake test-race"},
		{"go-test", "make test-race", "typeset -gx GOFLAGS=-run=NONE\nmake test-race"},
		{"go-test", "make test-race", "export GOFLAGS=-run=NONE || true\nmake test-race"},
		{"go-test", "make test-race", "true; export GOFLAGS=-run=NONE\nmake test-race"},
		{"go-test", "make test-race", "[ -n x ] && export GOFLAGS=-run=NONE\nmake test-race"},
		{"go-test", "make test-race", "if true; then export GOFLAGS=-run=NONE; fi\nmake test-race"},
		{"go-test", "make test-race", "{ export GOFLAGS=-run=NONE; }\nmake test-race"},
		{"go-test", "make test-race", "case x in x) export GOFLAGS=-run=NONE ;; esac\nmake test-race"},
		{"go-test", "make test-race", "for i in 1; do export GOFLAGS=-run=NONE; done\nmake test-race"},
		{"go-test", "make test-race", "command export GOFLAGS=-run=NONE\nmake test-race"},
		{"go-test", "make test-race", "eval 'export GOFLAGS=-run=NONE'\nmake test-race"},
		{"go-test", "make test-race", "source /dev/null\nmake test-race"},
		{"go-test", "make test-race", "set -a\nGOFLAGS=-run=NONE\nmake test-race"},
		{"go-test", "make test-race", "set -o allexport\nGOFLAGS=-run=NONE\nmake test-race"},
		{"chart", "helm lint charts/chart/", "lint_chart() {\nhelm lint charts/chart/\n}"},
		{"ui", "ci_npm_ci ui", "ci_npm_ci internal/api/mcp/ui"},
	}
	for _, tc := range cases {
		job, ok := workflow.jobs[tc.job].(map[string]any)
		if !ok {
			t.Fatalf("ci.yml has no job %s", tc.job)
		}
		script := readLocalCIJob(t, tc.job)
		if problems := localCIJobProblems(tc.job, job, script); len(problems) != 0 {
			t.Fatalf("%s: the unmodified script reports %v", tc.job, problems)
		}
		drifted := strings.Replace(script, tc.from, tc.to, 1)
		if drifted == script {
			t.Fatalf("%s: the drift case did not change the script (%q not found)", tc.job, tc.from)
		}
		if problems := localCIJobProblems(tc.job, job, drifted); len(problems) == 0 {
			t.Errorf("%s: a script that replaces %q with %q passes the parity check", tc.job, tc.from, tc.to)
		}
	}
}

// localCIJobProblems returns what checkLocalCIJob reports for a script, without failing a test.
func localCIJobProblems(job string, spec map[string]any, script string) []string {
	var rec problemRecorder
	checkLocalCIJob(&rec, job, spec, script)
	return rec.msgs
}

func checkLocalCIJob(t localCIReporter, job string, spec map[string]any, script string) {
	t.Helper()
	checkLocalCIStandaloneExports(t, job, spec, script)
	jobEnv := mappingOrEmpty(spec["env"])
	checkLocalCIEnv(t, job, "job env", script, jobEnv)
	services := mappingOrEmpty(spec["services"])
	for _, service := range sortedKeys(services) {
		checkLocalCIEnv(t, job, "service "+service+" env", script, mappingOrEmpty(mappingOrEmpty(services[service])["env"]))
	}
	for _, raw := range anyList(spec["steps"]) {
		step, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("ci.yml job %s has a step that is not a mapping", job)
		}
		stepName := scalarString(step["name"])
		if uses := scalarString(step["uses"]); uses != "" {
			checkLocalCIAction(t, job, stepName, uses, script)
		}
		_, gitHubOnly := localCIGitHubOnlyRunSteps[job+"/"+stepName]
		if _, hasRun := step["run"]; hasRun {
			if !gitHubOnly {
				// Inline assignments are accepted only for names that ci.yml sets to that value for this job or step.
				allowed := localCIEnvValues(jobEnv, mappingOrEmpty(step["env"]))
				_, forked := localCIPlatformForks[job+"/"+stepName]
				checkLocalCIRun(t, job, stepName, scalarString(step["run"]), scalarString(step["working-directory"]),
					scalarString(step["timeout-minutes"]), script, allowed, scalarString(step["if"]) != "" || forked)
			}
		}
		// A GitHub-only step's environment (event-derived values) has no local equivalent to compare.
		if !gitHubOnly {
			checkLocalCIEnv(t, job, "step "+stepName+" env", script, mappingOrEmpty(step["env"]))
		}
	}
}

// localCIStandaloneExports are names a local job script may export on a line of its own. They point the local run at
// the pinned toolchain, the job's temporary directory, the Docker context, the test databases and the Insights output
// paths; none of them changes what a ci.yml command tests. Any other name must be one that ci.yml sets for the job, with
// the same value, so that a flag such as GOFLAGS cannot reach every later command unseen.
var localCIStandaloneExports = map[string]bool{
	"GOTOOLCHAIN": true, "GOBIN": true, "PATH": true, "TMPDIR": true, "RUNNER_TEMP": true, "DOCKER_CONTEXT": true,
	"IMG": true, "PAPRIKA_POSTGRES_TEST_DSN": true, "PAPRIKA_POSTGRES_CONTAINER": true, "PAPRIKA_POSTGRES_PORT": true,
	"PAPRIKA_FLEET_SCALE_PARTS": true, "PAPRIKA_FLEET_SCALE_ALLOW_EMULATED_AMD64": true,
	"INSIGHTS_POLISH_OUTPUT": true, "INSIGHTS_PRESENTATION_OUTPUT": true, "INSIGHTS_QUERY_INSPECTOR_OUTPUT": true,
	"INSIGHTS_BUILDER_KEYBOARD_ONLY": true,
}

// checkLocalCIStandaloneExports checks the lines of a local job script that only export names. Such a line changes the
// environment of every command after it, so each name must be allowed above or be set by ci.yml for the job or one of
// its steps. A value ci.yml sets as a literal must match it; a value built from a GitHub expression is not compared.
func checkLocalCIStandaloneExports(t localCIReporter, job string, spec map[string]any, script string) {
	t.Helper()
	ciKeys := map[string]bool{}
	ciValues := map[string]string{}
	envMaps := []map[string]any{mappingOrEmpty(spec["env"])}
	for _, raw := range anyList(spec["steps"]) {
		if step, ok := raw.(map[string]any); ok {
			envMaps = append(envMaps, mappingOrEmpty(step["env"]))
		}
	}
	for _, env := range envMaps {
		for key, raw := range env {
			ciKeys[key] = true
			if value := scalarString(raw); !strings.Contains(value, "${{") {
				ciValues[key] = strings.ReplaceAll(value, `"`, "")
			}
		}
	}
	for line := range strings.SplitSeq(script, "\n") {
		// Each command of a line is checked on its own: "export A=1; make", "export A=1 || true" and "export A=1 && make".
		for part := range strings.SplitSeq(standalonePartSeparators.Replace(line), "\n") {
			checkStandalonePart(t, job, ciKeys, ciValues, part)
		}
	}
}

// localCISourcedLibraries are the only files a job script may source: the shared local CI helpers.
var localCISourcedLibraries = map[string]bool{
	// The script text reaches this check with its quotes removed.
	`$(dirname ${BASH_SOURCE[0]})/../lib.sh`:         true,
	`$(dirname ${BASH_SOURCE[0]})/../fleet-lapse.sh`: true,
}

// standaloneCommandPrefixes are the words that may come before a command without changing what it does.
var standaloneCommandPrefixes = map[string]bool{
	"then": true, "do": true, "else": true, "elif": true, "if": true, "while": true, "until": true,
	"{": true, "(": true, "!": true, "time": true, "builtin": true, "command": true, "exec": true,
}

// standalonePartSeparators split a script line into the commands it runs.
var standalonePartSeparators = strings.NewReplacer(";", "\n", "&&", "\n", "||", "\n", "|", "\n")

// checkStandalonePart checks one command that may change the environment of the commands after it: export, declare -x,
// typeset -x (each names the variables it exports), and set -a or set -o allexport (every assignment after it is
// exported). The names are checked as checkLocalCIStandaloneExports describes.
func checkStandalonePart(t localCIReporter, job string, ciKeys map[string]bool, ciValues map[string]string, part string) {
	t.Helper()
	fields := strings.Fields(part)
	fields = stripCommandPrefixes(fields)
	if len(fields) == 0 {
		return
	}
	var names []string
	switch fields[0] {
	case "eval", "source", ".":
		// These run text the parity check cannot see, so a job script may use them only to load the local CI libraries.
		if fields[0] != "eval" && localCISourcedLibraries[strings.Join(fields[1:], " ")] {
			return
		}
		t.Errorf("hack/ci/jobs/%s.sh runs %s; the parity check cannot see the commands it runs", job, fields[0])
		return
	case "set":
		if setEnablesAllExport(fields[1:]) {
			t.Errorf("hack/ci/jobs/%s.sh turns on allexport (set -a or set -o allexport); every later assignment would be exported unchecked", job)
		}
		return
	case "export":
		names = exportedNames(fields[1:])
	case "declare", "typeset":
		if !declaresExport(fields[1:]) {
			return
		}
		names = exportedNames(fields[1:])
	default:
		return
	}
	for _, field := range names {
		name, value, hasValue := strings.Cut(field, "=")
		if localCIStandaloneExports[name] {
			continue
		}
		if !ciKeys[name] {
			t.Errorf("hack/ci/jobs/%s.sh exports %s on its own line, which ci.yml does not set for %s; "+
				"a setting exported there reaches every later command unchecked", job, name, job)
			continue
		}
		if want, literal := ciValues[name]; literal && hasValue && strings.ReplaceAll(value, `"`, "") != want {
			t.Errorf("hack/ci/jobs/%s.sh exports %s=%s on its own line; ci.yml sets %s=%s for %s", job, name, value, name, want, job)
		}
	}
}

// stripCommandPrefixes drops what runs the following command unchanged. Reserved words, grouping and command prefixes
// such as "then export A=1", "{ export A=1", "! export A=1", "time export A=1" and "command export A=1" are removed,
// and so is a case pattern such as "case x in x) export A=1".
func stripCommandPrefixes(fields []string) []string {
	if len(fields) > 0 && fields[0] == "case" {
		for len(fields) > 0 && !strings.HasSuffix(fields[0], ")") {
			fields = fields[1:]
		}
	}
	for len(fields) > 0 && (standaloneCommandPrefixes[fields[0]] || strings.HasSuffix(fields[0], ")")) {
		fields = fields[1:]
	}
	return fields
}

// setEnablesAllExport reports whether the arguments of a set command turn on allexport: -a in any flag group, or -o allexport.
func setEnablesAllExport(args []string) bool {
	for i, arg := range args {
		if strings.HasPrefix(arg, "-") && !strings.HasPrefix(arg, "--") && strings.Contains(arg, "a") {
			return true
		}
		if arg == "-o" && i+1 < len(args) && args[i+1] == "allexport" {
			return true
		}
	}
	return false
}

// declaresExport reports whether a declare or typeset command carries the -x flag (in any flag group, such as -gx).
func declaresExport(args []string) bool {
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") && strings.Contains(arg, "x") {
			return true
		}
	}
	return false
}

// exportedNames returns the assignments or names among the arguments of an export-style command: flags are dropped, and
// so is everything after a comment.
func exportedNames(args []string) []string {
	var names []string
	for _, arg := range args {
		if strings.HasPrefix(arg, "#") {
			break
		}
		if strings.HasPrefix(arg, "-") {
			continue
		}
		names = append(names, arg)
	}
	return names
}

func checkLocalCIAction(t localCIReporter, job, step, uses, script string) {
	t.Helper()
	action := uses
	if before, _, found := strings.Cut(uses, "@"); found {
		action = before
	}
	if action == "docker/build-push-action" {
		if job != "cluster-integration" {
			t.Errorf("ci.yml %s step %q builds an image with %s, which only cluster-integration may map locally", job, step, uses)
		} else if !strings.Contains(script, "docker buildx build --load") {
			t.Errorf("ci.yml %s step %q builds the manager image with %s; hack/ci/jobs/%s.sh must run docker buildx build --load", job, step, uses, job)
		}
		return
	}
	if _, ok := localCIGitHubActions[action]; !ok {
		t.Errorf("ci.yml %s step %q uses %s, which has no local mapping; add it to localCIGitHubActions with its local equivalent", job, step, uses)
	}
}

// localCIEnvValues returns the literal values of the env mappings given, with quotes removed. Values built from a
// GitHub expression are left out, because the local script must assign those itself.
func localCIEnvValues(maps ...map[string]any) map[string]string {
	values := map[string]string{}
	for _, env := range maps {
		for key, raw := range env {
			value := scalarString(raw)
			if strings.Contains(value, "${{") {
				continue
			}
			values[key] = strings.ReplaceAll(value, `"`, "")
		}
	}
	return values
}

// localCILine is one normalised line of a local job script. dir is the directory it runs in ("" for the checkout).
// guarded reports that the line before it ends in ||, && or |; nested that it sits inside an if, case, loop or
// function block.
type localCILine struct {
	dir     string
	text    string
	guarded bool
	nested  bool
}

// localCIExportPrefix is a wrapper a local line may put before its command: "export NAME=VALUE && " or an inline
// "NAME=VALUE " assignment. Whether the assignment is allowed is decided by localCIAssignmentAllowed.
var localCIExportPrefix = regexp.MustCompile(`^(export [A-Za-z_][A-Za-z0-9_]*=\S* && |[A-Za-z_][A-Za-z0-9_]*=\S* )`)

// localCIAssignmentAllowed reports whether a wrapper "export K=V && " or "K=V " sets a name that ci.yml sets to
// that same value for the job or step. Any other assignment changes the command, so it is not a wrapper.
func localCIAssignmentAllowed(prefix string, allowed map[string]string) bool {
	assignment := strings.TrimPrefix(prefix, "export ")
	assignment = strings.TrimSuffix(strings.TrimSuffix(assignment, " && "), " ")
	key, value, ok := strings.Cut(assignment, "=")
	if !ok {
		return false
	}
	want, found := allowed[key]
	return found && want == value
}

// endsWithOperator reports whether a normalised line continues into the next one through a list or pipe operator,
// so that the next line runs only when this one succeeds or fails.
func endsWithOperator(line string) bool {
	return strings.HasSuffix(line, "||") || strings.HasSuffix(line, "&&") || strings.HasSuffix(line, "|")
}

// localCIFunctionHeader matches the line that opens a shell function: "name() {", with an optional comment.
var localCIFunctionHeader = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*\(\) \{( #.*)?$`)

// nestingFlags reports, for each normalised line, whether it sits inside an if, case or loop block, or inside a
// function body, which decides whether the line runs. A one-line if (ending in "fi") opens no block. A function
// body counts as nested too: a command in a function that nothing calls never runs, so a local mirror must not place
// a required command there unless ci.yml's step is itself guarded (the failure and cleanup handlers are functions
// that mirror steps with if: failure() or always(), and those steps carry the nesting themselves). A plain brace
// group, "{" on its own line, is tracked so that its closing brace is paired, but it does not make a line nested.
func nestingFlags(raw []string) []bool {
	flags := make([]bool, len(raw))
	depth := 0      // open if, case and loop blocks
	inFunc := 0     // open function bodies
	var open []bool // one entry per open brace-like block: true for a function body
	for i, text := range raw {
		flags[i] = depth > 0 || inFunc > 0
		switch {
		case localCIFunctionHeader.MatchString(text):
			open = append(open, true)
			inFunc++
		case text == "{":
			open = append(open, false)
		case text == "}":
			if n := len(open); n > 0 {
				if open[n-1] {
					inFunc--
				}
				open = open[:n-1]
			}
		case strings.HasPrefix(text, "if ") && !strings.HasSuffix(text, " fi"):
			depth++
		case strings.HasPrefix(text, "case ") && strings.HasSuffix(text, " in"):
			depth++
		case (strings.HasPrefix(text, "for ") || strings.HasPrefix(text, "while ")) && !strings.Contains(text, "done"):
			depth++
		case text == "fi" || text == "esac" || text == "done":
			if depth > 0 {
				depth--
			}
		}
	}
	return flags
}

// localCIScript annotates each normalised line of a local job script with its working directory, whether it is
// guarded, and whether it is nested. A line written "(cd DIR && CMD)" runs in DIR, and so does every line of a block
// written as "(", then "cd DIR", then the commands, then ")".
func localCIScript(script string) []localCILine {
	raw := strings.Split(script, "\n")
	nested := nestingFlags(raw)
	guarded := func(i int) bool { return i > 0 && endsWithOperator(raw[i-1]) }
	var lines []localCILine
	var blocks []string // the working directory of each open block, innermost last
	for i, text := range raw {
		enclosing := ""
		if n := len(blocks); n > 0 {
			enclosing = blocks[n-1]
		}
		switch {
		case text == "(":
			dir := ""
			if i+1 < len(raw) && strings.HasPrefix(raw[i+1], "cd ") {
				dir = strings.TrimPrefix(raw[i+1], "cd ")
			}
			blocks = append(blocks, dir)
		case text == ")":
			if n := len(blocks); n > 0 {
				blocks = blocks[:n-1]
			}
		case strings.HasPrefix(text, "cd "):
			// A change of directory is not a command of its own; the lines it governs carry it.
		case strings.HasPrefix(text, "(cd ") && strings.HasSuffix(text, ")") && strings.Contains(text, " && "):
			rest := strings.TrimSuffix(strings.TrimPrefix(text, "(cd "), ")")
			dir, cmd, _ := strings.Cut(rest, " && ")
			lines = append(lines, localCILine{dir: dir, text: cmd, guarded: guarded(i), nested: nested[i]})
		case strings.HasPrefix(text, "ci_npm_ci "):
			// The helper runs "npm ci" in the directory it is given (hack/ci/lib.sh).
			dir := strings.TrimPrefix(text, "ci_npm_ci ")
			lines = append(lines, localCILine{dir: dir, text: "npm ci", guarded: guarded(i), nested: nested[i]})
		default:
			lines = append(lines, localCILine{dir: enclosing, text: text, guarded: guarded(i), nested: nested[i]})
		}
	}
	return lines
}

// localCIMatches reports whether one local line runs want, the normalised ci.yml command, in directory dir. secs
// is the step's time limit in seconds ("" when the step has none); a step with a limit needs its wrapper. allowed
// holds the env values ci.yml sets for the job and step. wantGuarded and wantNested describe the ci.yml command: a
// local line may not be guarded, or nested, where ci.yml's command is not.
func localCIMatches(line localCILine, want, dir, secs string, allowed map[string]string, wantGuarded, wantNested bool) bool {
	if line.dir != dir {
		return false
	}
	if line.guarded && !wantGuarded {
		return false
	}
	if line.nested && !wantNested {
		return false
	}
	// The line as written is tried first: an assignment such as goos=$(go env GOOS) is a command, not a wrapper.
	forms := []string{line.text}
	for rest := line.text; ; {
		loc := localCIExportPrefix.FindStringIndex(rest)
		if loc == nil || !localCIAssignmentAllowed(rest[:loc[1]], allowed) {
			break
		}
		rest = rest[loc[1]:]
		forms = append(forms, rest)
	}
	for _, cmd := range forms {
		if secs != "" {
			prefix := "ci_with_timeout " + secs + " "
			if !strings.HasPrefix(cmd, prefix) {
				continue
			}
			cmd = cmd[len(prefix):]
		}
		if cmd == want {
			return true
		}
	}
	return false
}

// isShellStructure reports whether a normalised line is shell structure (a block, a branch or a loop header). A
// local script lays these out in its own way, so they must appear as whole lines in the script, in any directory.
func isShellStructure(line string) bool {
	switch line {
	case "(", ")", "{", "}", "then", "else", "fi", "do", "done", "esac", ";;":
		return true
	}
	for _, prefix := range []string{"if ", "elif ", "for ", "while ", "case "} {
		if strings.HasPrefix(line, prefix) {
			return true
		}
	}
	return false
}

func checkLocalCIRun(t localCIReporter, job, step, body, dir, timeout, script string, allowed map[string]string, stepIf bool) {
	t.Helper()
	lines := localCIScript(script)
	raw := strings.Split(script, "\n")
	secs := ""
	if timeout != "" {
		minutes, err := strconv.Atoi(timeout)
		if err != nil {
			t.Fatalf("ci.yml %s step %q has a timeout-minutes that is not a whole number: %q", job, step, timeout)
		}
		secs = strconv.Itoa(minutes * 60)
	}
	bodyLines := normaliseShell(body)
	bodyNested := nestingFlags(bodyLines)
	for j, line := range bodyLines {
		want := renameLocalCI(line)
		if equivalent, ok := localCIEquivalents[want]; ok {
			want = equivalent
		}
		if isShellStructure(want) {
			if !slices.Contains(raw, want) {
				t.Errorf("ci.yml %s step %q: shell structure %q is not present as a whole line in hack/ci/jobs/%s.sh", job, step, line, job)
			}
			continue
		}
		wantGuarded := j > 0 && endsWithOperator(bodyLines[j-1])
		// A step with its own if: runs on some hosts only, so its local mirror may branch on the host.
		wantNested := bodyNested[j] || stepIf
		found := false
		for _, candidate := range lines {
			if localCIMatches(candidate, want, dir, secs, allowed, wantGuarded, wantNested) {
				found = true
				break
			}
		}
		if !found {
			required := ""
			if dir != "" {
				required += fmt.Sprintf(" in (cd %s && ...)", dir)
			}
			if secs != "" {
				required += " under ci_with_timeout " + secs
			}
			if wantGuarded {
				required += " after the same guard"
			}
			t.Errorf("ci.yml %s step %q: command %q is not mirrored in hack/ci/jobs/%s.sh as a whole line%s", job, step, line, job, required)
		}
	}
}

// checkLocalCIEnv checks each env entry. A literal value must appear as KEY=value in the script (quotes are
// ignored). A value built from a GitHub expression, such as a service port or a workspace path, must still
// have its key assigned in the script.
func checkLocalCIEnv(t localCIReporter, job, where, script string, env map[string]any) {
	t.Helper()
	for _, key := range sortedKeys(env) {
		if _, pinned := localCIPinnedEnv[job+"/"+key]; pinned {
			continue
		}
		value := scalarString(env[key])
		if strings.Contains(value, "${{") {
			assignment := regexp.MustCompile(`(^|[^A-Za-z0-9_])` + regexp.QuoteMeta(key) + `=`)
			if !assignment.MatchString(script) {
				t.Errorf("ci.yml %s %s sets %s from a GitHub expression; hack/ci/jobs/%s.sh must assign %s itself", job, where, key, job, key)
			}
			continue
		}
		want := key + "=" + strings.ReplaceAll(value, `"`, "")
		if !strings.Contains(script, want) {
			t.Errorf("ci.yml %s %s sets %s; hack/ci/jobs/%s.sh must export %s", job, where, key, job, want)
		}
	}
}
