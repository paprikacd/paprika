package apiserver

import (
	"embed"
	"fmt"
	"io/fs"
	"net/http"
	"strings"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/metrics"
)

func cleanUIPath(p string) string {
	p = strings.TrimPrefix(p, "/")
	if p == "" {
		p = "."
	}
	return p
}

//go:embed all:uistatic
var uiFiles embed.FS

// UIHandler returns an HTTP handler that serves the static UI assets and SPA fallback.
//
//nolint:cyclop // request routing has several small branches.
func UIHandler() (http.Handler, error) {
	sub, err := fs.Sub(uiFiles, "uistatic")
	if err != nil {
		return nil, fmt.Errorf("open embedded UI files: %w", err)
	}
	fileServer := http.FileServer(http.FS(sub))
	indexPath, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		return nil, fmt.Errorf("read embedded index.html: %w", err)
	}

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

		if r.URL.Path == "/metrics" {
			promhttp.HandlerFor(metrics.Registry, promhttp.HandlerOpts{
				ErrorHandling: promhttp.HTTPErrorOnError,
			}).ServeHTTP(w, r)
			return
		}

		f, err := sub.Open(cleanUIPath(r.URL.Path))
		if err != nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			if _, err := w.Write(indexPath); err != nil {
				log.FromContext(r.Context()).Error(err, "Failed to write index fallback")
			}
			return
		}
		f.Close() //nolint:errcheck,gosec // safe to ignore close error

		if strings.HasSuffix(r.URL.Path, ".html") || r.URL.Path == "/" {
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}

		fileServer.ServeHTTP(w, r)
	}), nil
}
