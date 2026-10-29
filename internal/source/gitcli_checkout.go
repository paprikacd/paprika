package source

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	paprikametrics "github.com/benebsworth/paprika/internal/metrics"
)

// checkout is a materialized source path.
type checkout struct {
	localPath string
	dirHash   string
	// release ends the caller's lease on the checkout.
	release func()
}

// checkoutLeases counts, per checkout directory, the resolves whose callers
// may still be reading it. Eviction takes the same lock, skips a leased
// checkout, and moves an unleased one out of place before deleting it, so a
// lease taken after that finds no marker and writes the checkout again.
var checkoutLeases = struct {
	sync.Mutex
	n map[string]int
}{n: map[string]int{}}

// leaseCheckout takes a lease on the checkout at base and returns its
// release, which may be called more than once.
func leaseCheckout(base string) func() {
	checkoutLeases.Lock()
	checkoutLeases.n[base]++
	checkoutLeases.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			checkoutLeases.Lock()
			defer checkoutLeases.Unlock()
			checkoutLeases.n[base]--
			if checkoutLeases.n[base] <= 0 {
				delete(checkoutLeases.n, base)
			}
		})
	}
}

// commitSource is the commit a checkout's tree came from, and the ref that
// named it ("" for a pinned commit): what a server that refuses objects by ID
// is asked for instead.
type commitSource struct {
	sha   string
	ref   string
	depth int
}

// checkoutMarkerSuffix names the file next to a checkout that records it is
// complete. Its mtime is the checkout's last use.
const checkoutMarkerSuffix = ".done"

// checkoutRecord is the content of a checkout's marker.
type checkoutRecord struct {
	DirHash string `json:"dirHash"`
	Tree    string `json:"tree"`
	Path    string `json:"path"`
}

// checkoutBase is the directory of the checkout of tree at srcPath: the tree's
// files are written at <base>/<srcPath>, as they sit in the repository.
func checkoutBase(dir, tree, srcPath string) string {
	sum := sha256.Sum256([]byte(srcPath))
	return filepath.Join(dir, tree+"-"+hex.EncodeToString(sum[:])[:8])
}

// readCheckout returns the complete checkout at base, if there is one.
func readCheckout(base, srcPath string) (checkout, bool) {
	// #nosec G304 -- base is derived from WorkDir and object IDs.
	raw, err := os.ReadFile(base + checkoutMarkerSuffix)
	if err != nil {
		return checkout{}, false
	}
	var rec checkoutRecord
	if json.Unmarshal(raw, &rec) != nil || len(rec.DirHash) < 16 {
		return checkout{}, false
	}
	localPath := filepath.Join(base, filepath.FromSlash(srcPath))
	if info, err := os.Stat(localPath); err != nil || !info.IsDir() {
		return checkout{}, false
	}
	return checkout{localPath: localPath, dirHash: rec.DirHash}, true
}

// touchCheckout records a checkout's use, for LRU eviction.
func touchCheckout(base string) {
	now := time.Now()
	_ = os.Chtimes(base+checkoutMarkerSuffix, now, now) //nolint:errcheck // best effort: eviction order only
}

// ensureCheckout returns the files of tree at srcPath, writing them first if
// no complete checkout exists, under a lease the caller releases once it has
// read them. Concurrent requests for one checkout share one materialization,
// detached from any one request's cancellation.
func ensureCheckout(ctx context.Context, repo *cliRepo, dir, tree, srcPath string, from commitSource, creds *lazyCred) (checkout, error) {
	base := checkoutBase(dir, tree, srcPath)
	release := leaseCheckout(base)
	co, err := leasedCheckout(ctx, repo, base, tree, srcPath, from, creds)
	if err != nil {
		release()
		return checkout{}, err
	}
	co.release = release
	return co, nil
}

func leasedCheckout(ctx context.Context, repo *cliRepo, base, tree, srcPath string, from commitSource, creds *lazyCred) (checkout, error) {
	if co, ok := readCheckout(base, srcPath); ok {
		touchCheckout(base)
		paprikametrics.GitCacheLookups.Add(ctx, 1, metric.WithAttributes(
			attribute.String("layer", "checkout"), attribute.String("result", string(lookupHit))))
		return co, nil
	}
	ch := checkoutFlights.DoChan(base, func() (any, error) {
		workCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), currentGitSettings().fetchTimeout)
		defer cancel()
		defer leaseCheckout(base)()
		return materializeCheckout(workCtx, repo, base, tree, srcPath, from, creds)
	})
	select {
	case res := <-ch:
		result := lookupMiss
		if res.Shared {
			result = lookupShared
		}
		paprikametrics.GitCacheLookups.Add(ctx, 1, metric.WithAttributes(
			attribute.String("layer", "checkout"), attribute.String("result", string(result))))
		if res.Err != nil {
			return checkout{}, res.Err
		}
		co, ok := res.Val.(checkout)
		if !ok {
			return checkout{}, errors.New("checkout tree: unexpected materialization result")
		}
		return co, nil
	case <-ctx.Done():
		return checkout{}, fmt.Errorf("checkout tree: request ended while the checkout continues: %w", ctx.Err())
	}
}

// materializeCheckout fetches the blobs of tree the mirror lacks, in one
// request, writes the tree into a temporary directory and renames it into
// place, so a checkout is either absent or complete.
func materializeCheckout(ctx context.Context, repo *cliRepo, base, tree, srcPath string, from commitSource, creds *lazyCred) (checkout, error) {
	if co, ok := readCheckout(base, srcPath); ok {
		return co, nil
	}
	entries, err := repo.treeWithBlobs(ctx, tree, from, creds)
	if err != nil {
		return checkout{}, err
	}
	if mkErr := os.MkdirAll(filepath.Dir(base), 0o750); mkErr != nil {
		return checkout{}, fmt.Errorf("checkout tree: %w", mkErr)
	}
	tmp, err := os.MkdirTemp(filepath.Dir(base), filepath.Base(base)+checkoutTempInfix)
	if err != nil {
		return checkout{}, fmt.Errorf("checkout tree: %w", err)
	}
	defer os.RemoveAll(tmp) //nolint:errcheck // gone after the rename; cleanup after a failure
	dirHash, err := repo.writeCheckout(ctx, entries, filepath.Join(tmp, filepath.FromSlash(srcPath)))
	if err != nil {
		return checkout{}, err
	}
	if pubErr := publishCheckout(tmp, base, checkoutRecord{DirHash: dirHash, Tree: tree, Path: srcPath}); pubErr != nil {
		return checkout{}, pubErr
	}
	return checkout{localPath: filepath.Join(base, filepath.FromSlash(srcPath)), dirHash: dirHash}, nil
}

// treeWithBlobs lists the files of tree, first fetching those the mirror
// lacks.
func (r *cliRepo) treeWithBlobs(ctx context.Context, tree string, from commitSource, creds *lazyCred) ([]treeEntry, error) {
	entries, missing, err := r.treeEntries(ctx, tree)
	if err != nil {
		return nil, err
	}
	if len(missing) > 0 {
		if fetchErr := r.fetchBlobs(ctx, tree, missing, from, creds); fetchErr != nil {
			return nil, fetchErr
		}
	}
	return entries, nil
}

// writeCheckout writes entries under root and returns root's directory hash.
func (r *cliRepo) writeCheckout(ctx context.Context, entries []treeEntry, root string) (string, error) {
	if err := os.MkdirAll(root, 0o750); err != nil {
		return "", fmt.Errorf("checkout tree: %w", err)
	}
	if err := r.writeEntries(ctx, entries, root); err != nil {
		return "", err
	}
	if err := verifySymlinks(root); err != nil {
		return "", err
	}
	dirHash, err := ComputeDirHash(root)
	if err != nil {
		return "", fmt.Errorf("compute chart hash: %w", err)
	}
	return dirHash, nil
}

// checkoutTempInfix marks a checkout still being written.
const checkoutTempInfix = ".tmp-"

// publishCheckout renames the written tree to base and then writes its
// marker. A base without a marker (a crash between the two) is replaced.
func publishCheckout(tmp, base string, rec checkoutRecord) error {
	if err := os.RemoveAll(base); err != nil {
		return fmt.Errorf("checkout tree: clear stale checkout: %w", err)
	}
	if err := os.Rename(tmp, base); err != nil {
		return fmt.Errorf("checkout tree: %w", err)
	}
	raw, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("checkout tree: %w", err)
	}
	marker := base + checkoutMarkerSuffix
	if err := os.WriteFile(marker+".tmp", raw, 0o600); err != nil {
		return fmt.Errorf("checkout tree: write marker: %w", err)
	}
	if err := os.Rename(marker+".tmp", marker); err != nil {
		return fmt.Errorf("checkout tree: write marker: %w", err)
	}
	return nil
}

// treeEntry is one file of a tree.
type treeEntry struct {
	mode string
	oid  string
	path string
}

// treeEntries lists the files under tree and the objects among them that the
// mirror lacks. Neither command can fetch: rev-list --missing=print reports
// a missing object instead of reading it, and GIT_NO_LAZY_FETCH is set.
func (r *cliRepo) treeEntries(ctx context.Context, tree string) ([]treeEntry, []string, error) {
	r.life.RLock()
	defer r.life.RUnlock()
	out, err := execGit(ctx, gitRun{dir: r.dir, args: []string{"ls-tree", "-r", "-z", tree}})
	if err != nil {
		return nil, nil, &localGitError{err: err}
	}
	entries, err := parseLsTree(out)
	if err != nil {
		return nil, nil, &localGitError{err: err}
	}
	out, err = execGit(ctx, gitRun{dir: r.dir, args: []string{"rev-list", "--objects", "--missing=print", tree}})
	if err != nil {
		return nil, nil, &localGitError{err: err}
	}
	var missing []string
	for _, line := range strings.Split(string(out), "\n") {
		if oid, ok := strings.CutPrefix(line, "?"); ok && isHexSHA(oid) {
			missing = append(missing, oid)
		}
	}
	return entries, missing, nil
}

// parseLsTree parses ls-tree -r -z output, skipping gitlinks: a submodule has
// nothing to write, as in the go-git backend.
func parseLsTree(out []byte) ([]treeEntry, error) {
	var entries []treeEntry
	for _, rec := range bytes.Split(out, []byte{0}) {
		if len(rec) == 0 {
			continue
		}
		meta, name, ok := strings.Cut(string(rec), "\t")
		fields := strings.Fields(meta)
		if !ok || len(fields) != 3 {
			return nil, fmt.Errorf("unexpected ls-tree entry %q", rec)
		}
		if fields[1] != "blob" {
			continue
		}
		entries = append(entries, treeEntry{mode: fields[0], oid: fields[2], path: name})
	}
	return entries, nil
}

// fetchBlobs fetches the objects of tree the mirror lacks in one request, as
// git's own partial-clone prefetch does, and checks that none is still
// missing.
func (r *cliRepo) fetchBlobs(ctx context.Context, tree string, oids []string, from commitSource, creds *lazyCred) error {
	r.life.RLock()
	defer r.life.RUnlock()
	release, err := r.lockFetch(ctx)
	if err != nil {
		return err
	}
	defer release()
	cred, err := creds.get(ctx)
	if err != nil {
		return err
	}
	fetchErr := r.fetch(ctx, "fetch-blobs", cred, fetchOpts{objects: oids})
	if isUnadvertisedRefusal(fetchErr) {
		fetchErr = r.refetchUnfiltered(ctx, cred, from)
	}
	if fetchErr != nil {
		fetchErr = fmt.Errorf("fetch %d files of %s: %w", len(oids), redactURL(r.url), fetchErr)
		if isLocalFetchFailure(fetchErr) {
			return &localGitError{err: fetchErr}
		}
		return fetchErr
	}
	out, err := execGit(ctx, gitRun{dir: r.dir, args: []string{"rev-list", "--objects", "--missing=print", tree}})
	if err != nil {
		return &localGitError{err: err}
	}
	if strings.Contains("\n"+string(out), "\n?") {
		return fmt.Errorf("fetch files of %s: the remote did not send every object of tree %s", redactURL(r.url), tree)
	}
	return nil
}

// isUnadvertisedRefusal reports whether a server refused to send objects by
// ID: protocol v0 without uploadpack.allowAnySHA1InWant (or allowReachable).
// The client refuses before asking ("unadvertised object") or the server does
// ("not our ref").
func isUnadvertisedRefusal(err error) bool {
	return err != nil && gitStderrContains(err, "does not allow request for unadvertised object", "not our ref")
}

// refetchUnfiltered fetches from a server that serves only refs, without the
// blob filter, the objects of the commit a checkout needs: the ref that named
// it at its depth, or for a pinned commit every branch's full history. It
// refetches (--refetch) because the mirror already holds those commits, and a
// server sends nothing for a want the client's haves cover.
func (r *cliRepo) refetchUnfiltered(ctx context.Context, cred *gitCred, from commitSource) error {
	if from.ref != "" {
		return r.fetch(ctx, "fetch-blobs", cred, fetchOpts{depth: from.depth, refetch: true}, "+"+from.ref+":"+refetchRefPrefix+from.sha)
	}
	return r.fetch(ctx, "fetch-blobs", cred, fetchOpts{depth: unshallowDepth, refetch: true}, "+refs/heads/*:refs/paprika/heads/*")
}

// refetchRefPrefix holds the refs fetched whole from a server that refuses
// objects by ID.
const refetchRefPrefix = "refs/paprika/r/"

// unshallowDepth is git's spelling of "the whole history" for --depth, which
// unlike --unshallow also works in a mirror that is not shallow.
const unshallowDepth = 2147483647

// writeEntries writes every entry under root, streaming the blobs from one
// cat-file process.
func (r *cliRepo) writeEntries(ctx context.Context, entries []treeEntry, root string) error {
	for _, e := range entries {
		if err := validateEntryPath(e.path); err != nil {
			return err
		}
	}
	if len(entries) == 0 {
		return nil
	}
	var ids strings.Builder
	for _, e := range entries {
		ids.WriteString(e.oid + "\n")
	}
	guard := newCheckoutGuard(root)
	r.life.RLock()
	defer r.life.RUnlock()
	_, err := execGit(ctx, gitRun{
		dir:   r.dir,
		args:  []string{"cat-file", "--batch"},
		stdin: strings.NewReader(ids.String()),
		stdout: func(out io.Reader) error {
			br := bufio.NewReaderSize(out, 64<<10)
			for i := range entries {
				if err := writeBatchEntry(br, &entries[i], guard); err != nil {
					return err
				}
			}
			return nil
		},
	})
	if err != nil {
		var cmdErr *gitCommandError
		if errors.As(err, &cmdErr) {
			return &localGitError{err: err}
		}
		return fmt.Errorf("checkout tree: %w", err)
	}
	return nil
}

// readBatchHeader reads the header cat-file --batch writes before e's blob
// and returns the blob's size.
func readBatchHeader(br *bufio.Reader, e *treeEntry) (int64, error) {
	header, err := br.ReadString('\n')
	if err != nil {
		return 0, fmt.Errorf("read blob %s: %w", e.path, err)
	}
	fields := strings.Fields(header)
	if len(fields) != 3 || fields[0] != e.oid || fields[1] != "blob" {
		return 0, fmt.Errorf("read blob %s: unexpected cat-file header %q", e.path, strings.TrimSpace(header))
	}
	size, err := strconv.ParseInt(fields[2], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("read blob %s: %w", e.path, err)
	}
	return size, nil
}

// writeBatchEntry reads e's blob from cat-file --batch output and writes it.
func writeBatchEntry(br *bufio.Reader, e *treeEntry, guard *checkoutGuard) error {
	size, err := readBatchHeader(br, e)
	if err != nil {
		return err
	}
	if parentErr := guard.parentsOK(e.path); parentErr != nil {
		return parentErr
	}
	target := filepath.Join(guard.root, filepath.FromSlash(e.path))
	if mkErr := os.MkdirAll(filepath.Dir(target), 0o750); mkErr != nil {
		return fmt.Errorf("checkout tree: create dir for %s: %w", e.path, mkErr)
	}
	body := io.LimitReader(br, size)
	if e.mode == "120000" {
		err = writeSymlink(body, e.path, target)
	} else {
		err = writeFile(body, target, entryPerm(e.mode))
	}
	if err != nil {
		return err
	}
	if _, err := io.Copy(io.Discard, body); err != nil { // what a symlink did not read
		return fmt.Errorf("read blob %s: %w", e.path, err)
	}
	if _, err := br.Discard(1); err != nil { // the newline after each object
		return fmt.Errorf("read blob %s: %w", e.path, err)
	}
	return nil
}

// entryPerm is a file's mode on disk, as the go-git backend writes it.
func entryPerm(mode string) os.FileMode {
	if mode == "100755" {
		return 0o750
	}
	return 0o640
}

func writeFile(body io.Reader, target string, perm os.FileMode) error {
	f, err := createFile(target, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, body); err != nil {
		_ = f.Close() //nolint:errcheck // cleanup after a failed write
		return fmt.Errorf("checkout tree: write %s: %w", target, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("checkout tree: close %s: %w", target, err)
	}
	return nil
}

// writeSymlink writes a symlink whose target stays inside the source path.
// One that leaves it would let a chart read a file of the repo server's own
// (a service account token) through Helm's .Files.
func writeSymlink(body io.Reader, name, target string) error {
	raw, err := io.ReadAll(io.LimitReader(body, 4096))
	if err != nil {
		return fmt.Errorf("checkout tree: read symlink %s: %w", name, err)
	}
	link := string(raw)
	if err := checkSymlinkTarget(name, link); err != nil {
		return err
	}
	if err := os.Symlink(link, target); err != nil {
		return fmt.Errorf("checkout tree: create symlink %s: %w", name, err)
	}
	return nil
}

// validateEntryPath rejects a tree path that would write outside the checkout
// or into a .git directory. git's own trees never hold one; a hostile server
// could send one.
func validateEntryPath(p string) error {
	if p == "" || strings.ContainsAny(p, "\\\x00") || !filepath.IsLocal(filepath.FromSlash(p)) {
		return fmt.Errorf("checkout tree: unsafe path %q in tree", p)
	}
	for _, name := range strings.Split(p, "/") {
		if name == "" || name == "." || name == ".." || strings.EqualFold(name, ".git") {
			return fmt.Errorf("checkout tree: unsafe path %q in tree", p)
		}
	}
	return nil
}
