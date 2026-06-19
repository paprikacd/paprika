package pipelines

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestEmailSender_Send(t *testing.T) {
	t.Parallel()

	startTLSListener := func(t *testing.T) (smtpAddr, chan string, func()) {
		t.Helper()
		cert, _ := generateCert(t)
		lc := net.ListenConfig{}
		baseListener, err := lc.Listen(context.Background(), "tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		listener := tls.NewListener(baseListener, &tls.Config{Certificates: []tls.Certificate{cert}})
		cleanup := func() { _ = listener.Close() }
		t.Cleanup(cleanup)

		addr, ok := listener.Addr().(*net.TCPAddr)
		if !ok {
			t.Fatal("listener address is not TCP")
		}
		received := make(chan string, 1)
		go runSMTP(listener, received)
		return smtpAddr{port: addr.Port}, received, cleanup
	}

	tests := []struct {
		name      string
		startTLS  bool
		tlsConfig *tls.Config
		start     func(t *testing.T) (smtpAddr, chan string, func())
		cfg       paprikav1.SMTPConfig
		recipient string
		wantErr   bool
	}{
		{
			name:      "plain",
			startTLS:  false,
			cfg:       paprikav1.SMTPConfig{From: "from@example.com"},
			recipient: "to@example.com",
		},
		{
			name:      "STARTTLS",
			startTLS:  true,
			cfg:       paprikav1.SMTPConfig{From: "from@example.com"},
			recipient: "to@example.com",
			tlsConfig: &tls.Config{ServerName: "localhost", InsecureSkipVerify: true}, //nolint:gosec // test-only self-signed cert
		},
		{
			name:      "TLS",
			start:     startTLSListener,
			cfg:       paprikav1.SMTPConfig{From: "from@example.com", TLSEnabled: true},
			recipient: "to@example.com",
			tlsConfig: &tls.Config{ServerName: "localhost", InsecureSkipVerify: true}, //nolint:gosec // test-only self-signed cert
		},
		{
			name:    "missing recipient",
			cfg:     paprikav1.SMTPConfig{From: "from@example.com"},
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var addr smtpAddr
			var received chan string
			switch {
			case tc.start != nil:
				addr, received, _ = tc.start(t)
			default:
				addr, received = startSMTPServer(t, tc.startTLS)
			}

			cfg := tc.cfg
			cfg.Host = "localhost"
			cfg.Port = addr.port

			sender := NewEmailSender(cfg, nil)
			if tc.tlsConfig != nil {
				sender.TLSConfig = tc.tlsConfig
			}

			err := sender.Send(context.Background(), tc.recipient, "subject", "body")
			if tc.wantErr {
				if err == nil {
					t.Error("expected error for missing recipient")
				}
				return
			}
			if err != nil {
				t.Fatalf("Send() error = %v", err)
			}

			msg := <-received
			if !strings.Contains(msg, "body") {
				t.Errorf("missing body: %s", msg)
			}
		})
	}
}

type smtpAddr struct {
	port int
}

func startSMTPServer(t *testing.T, startTLS bool) (result smtpAddr, received chan string) {
	t.Helper()

	cert, _ := generateCert(t)
	lc := net.ListenConfig{}
	listener, err := lc.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	tcpAddr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatal("listener address is not TCP")
	}

	received = make(chan string, 1)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go handleSMTPConn(conn, startTLS, &cert, received)
		}
	}()

	return smtpAddr{port: tcpAddr.Port}, received
}

//nolint:gocyclo // test SMTP protocol handler
func handleSMTPConn(conn net.Conn, startTLS bool, cert *tls.Certificate, received chan<- string) {
	defer func() { _ = conn.Close() }()
	br := bufio.NewReader(conn)
	bw := bufio.NewWriter(conn)
	var msg strings.Builder
	var inData bool
	var tlsActive bool

	writeLine := func(line string) error {
		if _, err := bw.WriteString(line + "\r\n"); err != nil {
			return err
		}
		return bw.Flush()
	}

	if err := writeLine("220 localhost ESMTP"); err != nil {
		return
	}
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimSpace(line)
		if inData {
			if line == "." {
				inData = false
				received <- msg.String()
				if err := writeLine("250 OK"); err != nil {
					return
				}
				continue
			}
			msg.WriteString(line)
			msg.WriteString("\n")
			continue
		}
		switch {
		case strings.HasPrefix(line, "EHLO"), strings.HasPrefix(line, "HELO"):
			if err := writeLine("250-localhost"); err != nil {
				return
			}
			if startTLS && !tlsActive {
				if err := writeLine("250-STARTTLS"); err != nil {
					return
				}
			}
			if err := writeLine("250 AUTH PLAIN"); err != nil {
				return
			}
		case strings.HasPrefix(line, "STARTTLS"):
			if err := writeLine("220 Ready"); err != nil {
				return
			}
			tlsConn := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{*cert}})
			if err := tlsConn.HandshakeContext(context.Background()); err != nil {
				return
			}
			conn = tlsConn
			br = bufio.NewReader(conn)
			bw = bufio.NewWriter(conn)
			tlsActive = true
		case strings.HasPrefix(line, "AUTH"):
			if err := writeLine("235 OK"); err != nil {
				return
			}
		case strings.HasPrefix(line, "MAIL FROM"):
			if err := writeLine("250 OK"); err != nil {
				return
			}
		case strings.HasPrefix(line, "RCPT TO"):
			if !strings.Contains(line, "@") {
				if err := writeLine("501 Bad recipient"); err != nil {
					return
				}
				return
			}
			if err := writeLine("250 OK"); err != nil {
				return
			}
		case strings.HasPrefix(line, "DATA"):
			if err := writeLine("354 Start mail input"); err != nil {
				return
			}
			inData = true
		case strings.HasPrefix(line, "QUIT"):
			if err := writeLine("221 Bye"); err != nil {
				return
			}
			return
		default:
			if err := writeLine("500 Unknown command"); err != nil {
				return
			}
		}
	}
}

func runSMTP(listener net.Listener, received chan<- string) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go handleSMTPConn(conn, false, nil, received)
	}
}

func generateCert(t *testing.T) (cert tls.Certificate, parsed *x509.Certificate) {
	t.Helper()

	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatalf("create cert: %v", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)})
	cert, err = tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatalf("x509 key pair: %v", err)
	}
	parsed, _ = x509.ParseCertificate(der)
	return cert, parsed
}
