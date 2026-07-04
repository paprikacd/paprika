package main

import (
	"flag"
	"fmt"
	"html"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

var version = "1.0.0"

func main() {
	showVersion := flag.Bool("version", false, "Print version and exit")
	flag.StringVar(&version, "app-version", "1.0.0", "Application version reported in responses")
	healthStatus := flag.Int("health-status", 200, "HTTP status code for /health endpoint")
	healthBody := flag.String("health-body", `{"status":"ok"}`, "Response body for /health endpoint")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		os.Exit(0)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Version", version)
		w.WriteHeader(*healthStatus)
		fmt.Fprint(w, *healthBody)
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("X-Version", version)
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Paprika Demo App</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; }
    h1 { margin: 0 0 0.5rem; color: #333; }
    .version { color: #666; font-size: 1.2rem; }
    .time { color: #999; font-size: 0.9rem; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>%s</h1>
    <div class="version">v%s</div>
    <div class="time">%s</div>
  </div>
</body>
</html>`, html.EscapeString(r.URL.Path), html.EscapeString(version), time.Now().Format(time.RFC3339))
	})

	port := "8080"
	if p := os.Getenv("PORT"); p != "" {
		port = p
	}

	server := &http.Server{Addr: ":" + port, Handler: mux}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("Shutting down...")
		server.Close()
	}()

	log.Printf("Demo app v%s listening on :%s", version, port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}
