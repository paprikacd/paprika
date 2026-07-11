package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const (
	htmlCacheControl  = "no-cache, no-store, must-revalidate"
	assetCacheControl = "public, max-age=31536000, immutable"
)

type staticHandler struct {
	assets fs.FS
}

// newStaticHandler serves a Next.js static export without relying on process
// working-directory state after construction. URL paths are validated before
// lookup; the configured compiled-asset directory itself is trusted.
func newStaticHandler(assetsDir string) (http.Handler, error) {
	if strings.TrimSpace(assetsDir) == "" {
		return nil, errors.New("assets directory is required")
	}
	absAssets, err := filepath.Abs(assetsDir)
	if err != nil {
		return nil, fmt.Errorf("resolve assets directory: %w", err)
	}
	info, err := os.Stat(absAssets)
	if err != nil {
		return nil, fmt.Errorf("stat assets directory: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("assets path %q is not a directory", assetsDir)
	}

	assets := os.DirFS(absAssets)
	indexInfo, err := fs.Stat(assets, "index.html")
	if err != nil {
		return nil, fmt.Errorf("stat UI index: %w", err)
	}
	if !indexInfo.Mode().IsRegular() {
		return nil, errors.New("UI index is not a regular file")
	}
	return &staticHandler{assets: assets}, nil
}

func (h *staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setStaticSecurityHeaders(w.Header())
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}

	requestPath, ok := safeStaticPath(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	assetPath, ok := resolveStaticAsset(h.assets, requestPath)
	if !ok {
		http.NotFound(w, r)
		return
	}
	if strings.HasSuffix(assetPath, ".html") {
		w.Header().Set("Cache-Control", htmlCacheControl)
	} else {
		w.Header().Set("Cache-Control", assetCacheControl)
	}
	serveStaticAsset(w, r, h.assets, assetPath)
}

func safeStaticPath(requestPath string) (string, bool) {
	if strings.ContainsRune(requestPath, '\x00') || strings.Contains(requestPath, `\`) {
		return "", false
	}
	for _, segment := range strings.Split(requestPath, "/") {
		if segment == ".." {
			return "", false
		}
	}

	cleaned := strings.TrimPrefix(path.Clean("/"+requestPath), "/")
	if cleaned == "." {
		cleaned = ""
	}
	if cleaned != "" && !fs.ValidPath(cleaned) {
		return "", false
	}
	return cleaned, true
}

func resolveStaticAsset(assets fs.FS, requestPath string) (string, bool) {
	if requestPath == "" {
		return "index.html", true
	}
	if isRegularFile(assets, requestPath) {
		return requestPath, true
	}

	// Next static exports can use either route.html or route/index.html,
	// depending on the trailingSlash build option. Resolve both forms for both
	// incoming URL spellings without redirecting away query state.
	if path.Ext(requestPath) == "" {
		for _, candidate := range []string{requestPath + ".html", path.Join(requestPath, "index.html")} {
			if isRegularFile(assets, candidate) {
				return candidate, true
			}
		}
	}

	// Missing compiled assets must fail closed instead of returning HTML under
	// a script or stylesheet MIME expectation. Extensionless UI deep links are
	// safe to route through the application shell.
	if path.Ext(requestPath) != "" || requestPath == "_next" || strings.HasPrefix(requestPath, "_next/") {
		return "", false
	}
	return "index.html", true
}

func isRegularFile(assets fs.FS, name string) bool {
	info, err := fs.Stat(assets, name)
	return err == nil && info.Mode().IsRegular()
}

func serveStaticAsset(w http.ResponseWriter, r *http.Request, assets fs.FS, name string) {
	file, err := assets.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close() //nolint:errcheck // response is already being served

	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	if seeker, ok := file.(io.ReadSeeker); ok {
		http.ServeContent(w, r, name, info.ModTime(), seeker)
		return
	}
	contents, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}
	http.ServeContent(w, r, name, info.ModTime(), bytes.NewReader(contents))
}

func setStaticSecurityHeaders(header http.Header) {
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-Frame-Options", "DENY")
	header.Set("Referrer-Policy", "strict-origin-when-cross-origin")
}
