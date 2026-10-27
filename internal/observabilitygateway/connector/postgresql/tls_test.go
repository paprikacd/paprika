package postgresql

import (
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestTLSCannotDowngradeWhenPostgreSQLDeclinesEncryption(t *testing.T) {
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, listener.Close()) })
	request := make(chan []byte, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		data := make([]byte, 8)
		if _, readErr := io.ReadFull(connection, data); readErr != nil {
			return
		}
		request <- data
		_, _ = connection.Write([]byte{'N'})
	}()
	connection, err := (secureDialer{host: "localhost", encrypted: true}).DialContext(t.Context(), "tcp", listener.Addr().String())
	require.Error(t, err)
	require.Nil(t, connection)
	require.Equal(t, []byte{0, 0, 0, 8, 4, 210, 22, 47}, <-request)
}

func TestTLSRejectsUntrustedCertificateBeforeDatabaseStartup(t *testing.T) {
	// httptest supplies a certificate only; the listener speaks PostgreSQL's
	// SSLRequest handshake, not HTTP or a simulated SQL backend.
	certificate := httptest.NewTLSServer(http.NotFoundHandler())
	t.Cleanup(certificate.Close)
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, listener.Close()) })
	finished := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			finished <- acceptErr
			return
		}
		defer connection.Close()
		data := make([]byte, 8)
		if _, readErr := io.ReadFull(connection, data); readErr != nil {
			finished <- readErr
			return
		}
		if _, writeErr := connection.Write([]byte{'S'}); writeErr != nil {
			finished <- writeErr
			return
		}
		secured := tls.Server(connection, &tls.Config{Certificates: certificate.TLS.Certificates, MinVersion: tls.VersionTLS12})
		finished <- secured.HandshakeContext(t.Context())
	}()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	connection, err := (secureDialer{host: "localhost", encrypted: true}).DialContext(ctx, "tcp", listener.Addr().String())
	require.Error(t, err)
	require.Nil(t, connection)
	require.Error(t, <-finished)
}
