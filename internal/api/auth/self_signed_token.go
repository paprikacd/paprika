package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// tokenExpiry is how long self-signed tokens are valid for.
const tokenExpiry = 24 * time.Hour

// jwtHeader is the fixed JWT header for HS256 tokens.
var jwtHeader = base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))

// selfSignedClaims are the claims embedded in a self-signed token.
type selfSignedClaims struct {
	Subject string `json:"sub"`
	Email   string `json:"email"`
	Name    string `json:"name"`
	IAT     int64  `json:"iat"`
	Exp     int64  `json:"exp"`
}

// SelfSignedAuthenticator validates self-signed HMAC-SHA256 tokens.
type SelfSignedAuthenticator struct {
	secret []byte
}

// NewSelfSignedAuthenticator creates an authenticator for self-signed tokens.
func NewSelfSignedAuthenticator(secret []byte) *SelfSignedAuthenticator {
	return &SelfSignedAuthenticator{secret: secret}
}

// Authenticate validates a Bearer token signed with the server's secret.
func (s *SelfSignedAuthenticator) Authenticate(ctx context.Context) (*Principal, error) {
	req, err := requestFromContext(ctx)
	if err != nil {
		return nil, errors.Join(err, ErrUnauthenticated)
	}

	auth := req.Header().Get("Authorization")
	if auth == "" {
		return nil, ErrUnauthenticated
	}

	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return nil, fmt.Errorf("invalid authorization header: %w", ErrUnauthenticated)
	}

	rawToken := parts[1]
	claims, err := verifySelfSigned(rawToken, s.secret)
	if err != nil {
		return nil, errors.Join(err, ErrUnauthenticated)
	}

	return &Principal{
		Subject: claims.Subject,
		Email:   claims.Email,
		Name:    claims.Name,
		Groups:  []string{"users"},
		Claims: map[string]interface{}{
			"sub":    claims.Subject,
			"email":  claims.Email,
			"name":   claims.Name,
			"method": "self-signed",
		},
	}, nil
}

// IssueToken creates a self-signed JWT for the given user.
func IssueToken(subject, email, name string, secret []byte) (string, error) {
	now := time.Now()
	claims := selfSignedClaims{
		Subject: subject,
		Email:   email,
		Name:    name,
		IAT:     now.Unix(),
		Exp:     now.Add(tokenExpiry).Unix(),
	}

	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}

	payloadEnc := base64.RawURLEncoding.EncodeToString(payload)
	signingInput := jwtHeader + "." + payloadEnc
	sig := signHMAC([]byte(signingInput), secret)
	sigEnc := base64.RawURLEncoding.EncodeToString(sig)

	return signingInput + "." + sigEnc, nil
}

func verifySelfSigned(rawToken string, secret []byte) (*selfSignedClaims, error) {
	segments := strings.Split(rawToken, ".")
	if len(segments) != 3 {
		return nil, errors.New("invalid token format")
	}

	// Verify signature.
	signingInput := segments[0] + "." + segments[1]
	expectedSig := signHMAC([]byte(signingInput), secret)
	gotSig, err := base64.RawURLEncoding.DecodeString(segments[2])
	if err != nil {
		return nil, fmt.Errorf("decode signature: %w", err)
	}

	if !hmac.Equal(expectedSig, gotSig) {
		return nil, errors.New("invalid token signature")
	}

	// Parse payload.
	payload, err := base64.RawURLEncoding.DecodeString(segments[1])
	if err != nil {
		return nil, fmt.Errorf("decode payload: %w", err)
	}

	var claims selfSignedClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, fmt.Errorf("parse claims: %w", err)
	}

	// Check expiry.
	if time.Now().Unix() > claims.Exp {
		return nil, errors.New("token expired")
	}

	return &claims, nil
}

func signHMAC(data, secret []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write(data)
	return mac.Sum(nil)
}
