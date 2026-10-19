package satellite

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func testTokenFile(t *testing.T, token string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(file, []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	return file
}

func decodeTestReport(t *testing.T, request *http.Request) Report {
	t.Helper()
	if request.Header.Get("Content-Encoding") != "gzip" {
		t.Error("report is not compressed")
	}
	reader, err := gzip.NewReader(request.Body)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reader.Close() }()
	var report Report
	if err := json.NewDecoder(reader).Decode(&report); err != nil {
		t.Fatal(err)
	}
	return report
}

func TestClientCompressedReportsAndTokenRotation(t *testing.T) {
	tokens := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != ReportPath {
			t.Errorf("path = %s", request.URL.Path)
		}
		tokens <- request.Header.Get("Authorization")
		if report := decodeTestReport(t, request); report.Sequence != 42 {
			t.Errorf("sequence = %d", report.Sequence)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	file := testTokenFile(t, "first-token\n")
	client, err := NewClient(Config{ControlPlaneURL: server.URL, TokenFile: file})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	body, err := EncodeReport(&Report{ProtocolVersion: ProtocolVersion, Sequence: 42})
	if err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{"first-token", "rotated-token"} {
		if err := os.WriteFile(file, []byte(token), 0600); err != nil {
			t.Fatal(err)
		}
		if err := client.SendEncoded(context.Background(), body); err != nil {
			t.Fatal(err)
		}
		if got := <-tokens; got != "Bearer "+token {
			t.Errorf("authorization = %q", got)
		}
	}
}

func TestClientRequiresTLSAndValidatesCertificates(t *testing.T) {
	file := testTokenFile(t, "secret")
	for _, url := range []string{"http://central.example.com", "https://user:secret@central.example.com", "https://central.example.com?token=secret", "file:///tmp/report"} {
		if _, err := NewClient(Config{ControlPlaneURL: url, TokenFile: file}); err == nil {
			t.Errorf("accepted unsafe URL %q", url)
		}
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	body, err := EncodeReport(&Report{})
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewClient(Config{ControlPlaneURL: server.URL, TokenFile: file})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if sendErr := client.SendEncoded(context.Background(), body); sendErr == nil {
		t.Fatal("accepted untrusted TLS certificate")
	}
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	certificate := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	if writeErr := os.WriteFile(caFile, certificate, 0600); writeErr != nil {
		t.Fatal(writeErr)
	}
	trusted, err := NewClient(Config{ControlPlaneURL: server.URL, TokenFile: file, CAFile: caFile})
	if err != nil {
		t.Fatal(err)
	}
	defer trusted.Close()
	if err := trusted.SendEncoded(context.Background(), body); err != nil {
		t.Fatalf("custom CA rejected: %v", err)
	}
}

func TestClientDoesNotFollowCredentialRedirects(t *testing.T) {
	var forwarded atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { forwarded.Store(true) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		http.Redirect(w, request, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	client, err := NewClient(Config{ControlPlaneURL: server.URL, TokenFile: testTokenFile(t, "secret")})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.SendEncoded(context.Background(), []byte("compressed")); err == nil {
		t.Fatal("accepted redirect")
	}
	if forwarded.Load() {
		t.Fatal("forwarded a cluster credential to redirect target")
	}
}

func TestClientResyncAndSanitizedErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte("secret response should not escape"))
	}))
	defer server.Close()
	client, err := NewClient(Config{ControlPlaneURL: server.URL, TokenFile: testTokenFile(t, "secret")})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.SendEncoded(context.Background(), nil); !errors.Is(err, ErrResync) {
		t.Fatalf("resync = %v", err)
	}
}

func TestEncodeReportBoundsUncompressedPayload(t *testing.T) {
	_, err := EncodeReport(&Report{Applications: []Application{{SourceRevision: strings.Repeat("x", MaxReportBytes)}}})
	if err == nil {
		t.Fatal("accepted oversized uncompressed payload")
	}
	_, err = EncodeReport(&Report{Applications: make([]Application, MaxApplications+1)})
	if err == nil {
		t.Fatal("accepted too many applications")
	}
}
