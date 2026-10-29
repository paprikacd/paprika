package source

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// gitCred is the HTTP credential for one repository host.
type gitCred struct {
	host     string
	username string
	password string
}

// credentialHelper answers git's credential requests from the environment,
// and only for the repository's own host: git asks again, naming the new
// host, after a redirect to another one, and gets nothing. The secret stays
// out of argv, out of the mirror's config and out of every other host's
// requests.
const credentialHelper = `!f() { test "$1" = get || exit 0; h=; ` +
	`while IFS= read -r l; do test -n "$l" || break; case "$l" in host=*) h=${l#host=};; esac; done; ` +
	`test -n "$h" && test "$h" = "$PAPRIKA_GIT_CRED_HOST" || exit 0; ` +
	`printf 'username=%s\npassword=%s\n' "$PAPRIKA_GIT_CRED_USERNAME" "$PAPRIKA_GIT_CRED_PASSWORD"; }; f`

// gitRun is one git invocation.
type gitRun struct {
	// dir is the repository the command runs in; empty runs it in the
	// process's working directory.
	dir  string
	args []string
	// stdin feeds the command; nil gives it none.
	stdin io.Reader
	// stdout, when set, reads the command's output as it streams; otherwise
	// execGit returns it.
	stdout func(io.Reader) error
	cred   *gitCred
}

// gitProcessStarted, when set, sees every git process the CLI backend starts.
// Tests use it to prove a cancelled fetch leaves no process behind.
var gitProcessStarted func(args []string, pid int)

// gitWaitDelay bounds how long a killed git may hold its output pipes open.
const gitWaitDelay = 10 * time.Second

// execGit runs git and returns its output. When ctx ends, git and every
// process it started are killed.
func execGit(ctx context.Context, r gitRun) ([]byte, error) {
	bin, err := gitCLI()
	if err != nil {
		return nil, err
	}
	op := gitOp(r.args)
	cmd, stderr := newGitCmd(ctx, bin, &r)
	var out bytes.Buffer
	var pipe io.ReadCloser
	if r.stdout != nil {
		if pipe, err = cmd.StdoutPipe(); err != nil {
			return nil, fmt.Errorf("git %s: %w", op, err)
		}
	} else {
		cmd.Stdout = &out
	}
	if startErr := cmd.Start(); startErr != nil {
		return nil, fmt.Errorf("start git %s: %w", op, startErr)
	}
	if hook := gitProcessStarted; hook != nil {
		hook(r.args, cmd.Process.Pid)
	}
	streamErr := streamGitOutput(cmd, pipe, r.stdout)
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		// Reap anything git started that outlived it.
		_ = killProcessGroup(cmd.Process.Pid) //nolint:errcheck // the group may be gone already
		return nil, fmt.Errorf("git %s: %w", op, ctx.Err())
	}
	if waitErr != nil {
		return nil, &gitCommandError{op: op, err: waitErr, stderr: redactGitText(stderr.String(), r.cred)}
	}
	if streamErr != nil {
		return nil, fmt.Errorf("git %s: read output: %w", op, streamErr)
	}
	return out.Bytes(), nil
}

// newGitCmd builds the git command for r in its own process group, with its
// stderr kept for errors.
func newGitCmd(ctx context.Context, bin string, r *gitRun) (*exec.Cmd, *tailBuffer) {
	// #nosec G204 -- the binary is fixed and the arguments are built by this
	// package from validated revisions, object IDs and refspecs.
	cmd := exec.CommandContext(ctx, bin, r.args...)
	cmd.Dir = r.dir
	cmd.Env = gitEnv(r.dir, r.cred)
	cmd.Stdin = r.stdin
	cmd.WaitDelay = gitWaitDelay
	isolateProcessGroup(cmd)
	stderr := &tailBuffer{limit: 8 << 10}
	cmd.Stderr = stderr
	return cmd, stderr
}

// streamGitOutput hands a streaming command's output to read, killing the
// command when read fails, and drains what read left so Wait can return.
func streamGitOutput(cmd *exec.Cmd, pipe io.Reader, read func(io.Reader) error) error {
	if pipe == nil {
		return nil
	}
	err := read(pipe)
	if err != nil {
		_ = killProcessGroup(cmd.Process.Pid) //nolint:errcheck // best effort: the stream already failed
	}
	_, _ = io.Copy(io.Discard, pipe) //nolint:errcheck // drain so Wait can return
	return err
}

// gitOp names a git invocation for errors: its subcommand, past any -c.
func gitOp(args []string) string {
	for i := 0; i < len(args); i++ {
		if args[i] == "-c" {
			i++
			continue
		}
		return args[i]
	}
	return "git"
}

// gitEnv is the environment git runs in: the process's own without any GIT_
// variable, with prompts, system and global config, lazy fetches and
// protocols other than HTTP(S) and file switched off.
func gitEnv(dir string, cred *gitCred) []string {
	parent := os.Environ()
	env := make([]string, 0, len(parent)+24)
	for _, kv := range parent {
		name, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(name, "GIT_") || strings.HasPrefix(name, "PAPRIKA_GIT_CRED_") || name == "SSH_ASKPASS" {
			continue
		}
		env = append(env, kv)
	}
	env = append(env,
		"GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL="+os.DevNull,
		"GIT_NO_LAZY_FETCH=1",
		"GIT_NO_REPLACE_OBJECTS=1",
		"GIT_ALLOW_PROTOCOL=https:http:file",
	)
	config := [][2]string{
		{"credential.helper", ""},
		{"protocol.version", "2"},
		// A transfer slower than 1 KiB/s for a minute is a stalled one.
		{"http.lowSpeedLimit", "1024"},
		{"http.lowSpeedTime", "60"},
		{"core.hooksPath", os.DevNull},
	}
	if dir != "" {
		config = append(config, [2]string{"safe.directory", dir})
	}
	if cred != nil {
		config = append(config, [2]string{"credential.helper", credentialHelper})
		env = append(env,
			"PAPRIKA_GIT_CRED_HOST="+cred.host,
			"PAPRIKA_GIT_CRED_USERNAME="+cred.username,
			"PAPRIKA_GIT_CRED_PASSWORD="+cred.password,
		)
	}
	env = append(env, "GIT_CONFIG_COUNT="+strconv.Itoa(len(config)))
	for i, kv := range config {
		env = append(env,
			"GIT_CONFIG_KEY_"+strconv.Itoa(i)+"="+kv[0],
			"GIT_CONFIG_VALUE_"+strconv.Itoa(i)+"="+kv[1])
	}
	return env
}

// gitCommandError is a git command that exited unsuccessfully.
type gitCommandError struct {
	op     string
	err    error
	stderr string
}

func (e *gitCommandError) Error() string {
	msg := strings.TrimSpace(e.stderr)
	if msg == "" {
		return fmt.Sprintf("git %s: %v", e.op, e.err)
	}
	return fmt.Sprintf("git %s: %v: %s", e.op, e.err, msg)
}

func (e *gitCommandError) Unwrap() error { return e.err }

// gitStderrContains reports whether err is a git command whose stderr holds
// any of needles.
func gitStderrContains(err error, needles ...string) bool {
	var cmdErr *gitCommandError
	if !errors.As(err, &cmdErr) {
		return false
	}
	return containsAny(strings.ToLower(cmdErr.stderr), needles...)
}

// localGitError is a failed read of the local mirror: the mirror, not the
// remote, is at fault, so the resolve rebuilds the mirror and retries once.
type localGitError struct{ err error }

func (e *localGitError) Error() string { return "read git mirror: " + e.err.Error() }
func (e *localGitError) Unwrap() error { return e.err }

var urlUserinfoRe = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s]+@`)

// redactGitText removes URL userinfo and the credential's password from git
// output before it reaches an error or a log.
func redactGitText(s string, cred *gitCred) string {
	s = urlUserinfoRe.ReplaceAllString(s, "${1}***@")
	if cred != nil && cred.password != "" {
		s = strings.ReplaceAll(s, cred.password, "***")
	}
	return s
}

// redactURL removes userinfo from a repository URL.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return urlUserinfoRe.ReplaceAllString(raw, "${1}***@")
	}
	u.User = url.User("***")
	return u.String()
}

// tailBuffer keeps the last limit bytes written to it.
type tailBuffer struct {
	limit int
	buf   []byte
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.buf = append(b.buf, p...)
	if over := len(b.buf) - b.limit; over > 0 {
		b.buf = append(b.buf[:0], b.buf[over:]...)
	}
	return len(p), nil
}

func (b *tailBuffer) String() string { return string(b.buf) }
