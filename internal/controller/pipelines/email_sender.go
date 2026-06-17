package controller

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"strconv"
	"strings"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// EmailSender delivers email notifications via SMTP.
type EmailSender struct {
	SMTP      paprikav1.SMTPConfig
	Auth      smtp.Auth
	TLSConfig *tls.Config
}

// NewEmailSender creates an EmailSender from SMTP configuration and optional auth.
func NewEmailSender(cfg paprikav1.SMTPConfig, auth smtp.Auth) *EmailSender {
	return &EmailSender{SMTP: cfg, Auth: auth}
}

func (s *EmailSender) tlsConfig(host string) *tls.Config {
	if s.TLSConfig != nil {
		return s.TLSConfig
	}
	return &tls.Config{ServerName: host}
}

// Send delivers a plain-text email to the provided recipient.
func (s *EmailSender) Send(ctx context.Context, to, subject, body string) error {
	host := s.SMTP.Host
	port := s.SMTP.Port
	if port == 0 {
		port = 587
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))

	msg := buildMimeMessage(s.SMTP.From, to, subject, body)

	if s.SMTP.TLSEnabled {
		dialer := &tls.Dialer{Config: s.tlsConfig(host)}
		conn, err := dialer.DialContext(ctx, "tcp", addr)
		if err != nil {
			return fmt.Errorf("tls dial: %w", err)
		}
		defer func() { _ = conn.Close() }()
		client, err := smtp.NewClient(conn, host)
		if err != nil {
			return fmt.Errorf("smtp client: %w", err)
		}
		defer func() { _ = client.Close() }()
		return sendWithClient(ctx, client, s.Auth, s.SMTP.From, []string{to}, msg)
	}

	dialer := &net.Dialer{}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("smtp dial: %w", err)
	}
	defer func() { _ = conn.Close() }()
	client, err := smtp.NewClient(conn, host)
	if err != nil {
		return fmt.Errorf("smtp client: %w", err)
	}
	defer func() { _ = client.Close() }()
	if ok, _ := client.Extension("STARTTLS"); ok {
		if err := client.StartTLS(s.tlsConfig(host)); err != nil {
			return fmt.Errorf("starttls: %w", err)
		}
	}
	return sendWithClient(ctx, client, s.Auth, s.SMTP.From, []string{to}, msg)
}

func sendWithClient(_ context.Context, client *smtp.Client, auth smtp.Auth, from string, to []string, msg []byte) error {
	if auth != nil {
		if err := client.Auth(auth); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := client.Mail(from); err != nil {
		return fmt.Errorf("smtp mail: %w", err)
	}
	for _, rcpt := range to {
		if err := client.Rcpt(rcpt); err != nil {
			return fmt.Errorf("smtp rcpt: %w", err)
		}
	}
	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("smtp data: %w", err)
	}
	if _, err := w.Write(msg); err != nil {
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp close data: %w", err)
	}
	if err := client.Quit(); err != nil {
		return fmt.Errorf("smtp quit: %w", err)
	}
	return nil
}

func buildMimeMessage(from, to, subject, body string) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", to)
	fmt.Fprintf(&b, "Subject: %s\r\n", subject)
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=\"utf-8\"\r\n")
	b.WriteString("\r\n")
	b.WriteString(body)
	return []byte(b.String())
}
