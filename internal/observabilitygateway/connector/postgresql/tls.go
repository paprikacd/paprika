package postgresql

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

// Negotiate the PostgreSQL SSLRequest directly so pq cannot load ambient client
// certificates from a home directory. Go verifies the host using system roots.
type secureDialer struct {
	host      string
	encrypted bool
}

func (d secureDialer) Dial(network, address string) (net.Conn, error) {
	return d.DialTimeout(network, address, queryTimeout)
}

func (d secureDialer) DialTimeout(network, address string, timeout time.Duration) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), min(timeout, queryTimeout))
	defer cancel()
	return d.DialContext(ctx, network, address)
}

func (d secureDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()
	connection, err := (&net.Dialer{}).DialContext(ctx, network, address)
	if err != nil {
		return nil, fmt.Errorf("dial SQL server: %w", err)
	}
	if !d.encrypted {
		peer, ok := connection.RemoteAddr().(*net.TCPAddr)
		if !ok || !peer.IP.IsLoopback() {
			return failConnection(connection)
		}
		return connection, nil
	}
	return d.negotiateTLS(ctx, connection)
}

func (d secureDialer) negotiateTLS(ctx context.Context, connection net.Conn) (net.Conn, error) {
	deadline, _ := ctx.Deadline()
	if err := connection.SetDeadline(deadline); err != nil {
		return failConnection(connection)
	}
	// Length 8, PostgreSQL SSLRequest code 80877103.
	if _, err := connection.Write([]byte{0, 0, 0, 8, 4, 210, 22, 47}); err != nil {
		return failConnection(connection)
	}
	var response [1]byte
	if _, err := io.ReadFull(connection, response[:]); err != nil || response[0] != 'S' {
		return failConnection(connection)
	}
	secured := tls.Client(connection, &tls.Config{ServerName: d.host, MinVersion: tls.VersionTLS12})
	if err := secured.HandshakeContext(ctx); err != nil {
		return failConnection(connection)
	}
	if err := secured.SetDeadline(time.Time{}); err != nil {
		return failConnection(connection)
	}
	return secured, nil
}

func failConnection(connection net.Conn) (net.Conn, error) {
	if err := connection.Close(); err != nil {
		return nil, errors.New("postgresql secure connection could not be closed")
	}
	return nil, errors.New("postgresql secure connection could not be established")
}
