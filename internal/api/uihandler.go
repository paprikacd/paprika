package api

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:uistatic
var uiFiles embed.FS

// UIHandler returns an HTTP handler that serves the static UI assets and SPA fallback.
func UIHandler() http.Handler {
	sub, err := fs.Sub(uiFiles, "uistatic")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(sub))
	indexPath, _ := fs.ReadFile(sub, "index.html")

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-XSS-Protection", "1; mode=block")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")

		if strings.HasPrefix(r.URL.Path, "/paprika.v1.PaprikaService/") ||
			r.URL.Path == "/healthz" ||
			r.URL.Path == "/readyz" {
			http.DefaultServeMux.ServeHTTP(w, r)
			return
		}

		f, err := sub.Open(r.URL.Path)
		if err != nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(indexPath)
			return
		}
		_ = f.Close()

		if strings.HasSuffix(r.URL.Path, ".html") || r.URL.Path == "/" {
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}

		fileServer.ServeHTTP(w, r)
	})
}
