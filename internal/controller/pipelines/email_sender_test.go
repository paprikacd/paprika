package controller

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

func TestEmailSender_Plain(t *testing.T) {
	t.Parallel()

	addr, received := startSMTPServer(t, false)
	sender := NewEmailSender(paprikav1.SMTPConfig{Host: "localhost", Port: addr.port, From: "from@example.com"}, nil)
	if err := sender.Send(context.Background(), "to@example.com", "subject", "body"); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	msg := <-received
	if !strings.Contains(msg, "From: from@example.com") {
		t.Errorf("missing from: %s", msg)
	}
	if !strings.Contains(msg, "To: to@example.com") {
		t.Errorf("missing to: %s", msg)
	}
	if !strings.Contains(msg, "body") {
		t.Errorf("missing body: %s", msg)
	}
}

func TestEmailSender_STARTTLS(t *testing.T) {
	t.Parallel()

	addr, received := startSMTPServer(t, true)
	sender := NewEmailSender(paprikav1.SMTPConfig{Host: "localhost", Port: addr.port, From: "from@example.com"}, nil)
	sender.TLSConfig = &tls.Config{ServerName: "localhost", InsecureSkipVerify: true} //nolint:gosec // test-only self-signed cert
	if err := sender.Send(context.Background(), "to@example.com", "subject", "body"); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	msg := <-received
	if !strings.Contains(msg, "body") {
		t.Errorf("missing body: %s", msg)
	}
}

func TestEmailSender_TLS(t *testing.T) {
	t.Parallel()

	cert, _ := generateCert(t)
	lc := net.ListenConfig{}
	baseListener, err := lc.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	listener := tls.NewListener(baseListener, &tls.Config{Certificates: []tls.Certificate{cert}})
	received := make(chan string, 1)
	go runSMTP(listener, received)
	t.Cleanup(func() { _ = listener.Close() })

	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatal("listener address is not TCP")
	}
	sender := NewEmailSender(paprikav1.SMTPConfig{Host: "localhost", Port: addr.Port, From: "from@example.com", TLSEnabled: true}, nil)
	sender.TLSConfig = &tls.Config{ServerName: "localhost", InsecureSkipVerify: true} //nolint:gosec // test-only self-signed cert
	if err := sender.Send(context.Background(), "to@example.com", "subject", "body"); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	msg := <-received
	if !strings.Contains(msg, "body") {
		t.Errorf("missing body: %s", msg)
	}
}

func TestEmailSender_MissingRecipient(t *testing.T) {
	t.Parallel()

	addr, _ := startSMTPServer(t, false)
	sender := NewEmailSender(paprikav1.SMTPConfig{Host: "localhost", Port: addr.port, From: "from@example.com"}, nil)
	if err := sender.Send(context.Background(), "", "subject", "body"); err == nil {
		t.Error("expected error for missing recipient")
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

func handleSMTPConn(conn net.Conn, startTLS bool, cert *tls.Certificate, received chan<- string) {
	defer func() { _ = conn.Close() }()
	br := bufio.NewReader(conn)
	bw := bufio.NewWriter(conn)
	var msg strings.Builder
	var inData bool
	var tlsActive bool

	writeLine := func(line string) {
		_, _ = bw.WriteString(line + "\r\n")
		_ = bw.Flush()
	}

	writeLine("220 localhost ESMTP")
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
				writeLine("250 OK")
				continue
			}
			msg.WriteString(line)
			msg.WriteString("\n")
			continue
		}
		switch {
		case strings.HasPrefix(line, "EHLO"), strings.HasPrefix(line, "HELO"):
			writeLine("250-localhost")
			if startTLS && !tlsActive {
				writeLine("250-STARTTLS")
			}
			writeLine("250 AUTH PLAIN")
		case strings.HasPrefix(line, "STARTTLS"):
			writeLine("220 Ready")
			tlsConn := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{*cert}})
			if err := tlsConn.HandshakeContext(context.Background()); err != nil {
				return
			}
			conn = tlsConn
			br = bufio.NewReader(conn)
			bw = bufio.NewWriter(conn)
			tlsActive = true
		case strings.HasPrefix(line, "AUTH"):
			writeLine("235 OK")
		case strings.HasPrefix(line, "MAIL FROM"):
			writeLine("250 OK")
		case strings.HasPrefix(line, "RCPT TO"):
			if !strings.Contains(line, "@") {
				writeLine("501 Bad recipient")
				return
			}
			writeLine("250 OK")
		case strings.HasPrefix(line, "DATA"):
			writeLine("354 Start mail input")
			inData = true
		case strings.HasPrefix(line, "QUIT"):
			writeLine("221 Bye")
			return
		default:
			writeLine("500 Unknown command")
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
