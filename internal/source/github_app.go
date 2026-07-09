package source

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	// githubAppJWTExpiry is how long the JWT used to request installation tokens is valid.
	githubAppJWTExpiry = 10 * time.Minute
	// githubAppTokenHeader is the HTTP header used to send the GitHub App JWT.
	githubAppTokenHeader = "Authorization"
)

// GitHubAppAuth holds the pieces needed to mint a GitHub App installation token.
type GitHubAppAuth struct {
	AppID          int64
	InstallationID int64
	PrivateKey     []byte
	EnterpriseURL  string
}

// InstallationToken mints a GitHub App JWT and exchanges it for an installation token.
func (g *GitHubAppAuth) InstallationToken(ctx context.Context) (string, error) {
	if g == nil || len(g.PrivateKey) == 0 {
		return "", errors.New("github app auth missing private key")
	}
	if g.AppID == 0 {
		return "", errors.New("github app auth missing appID")
	}
	if g.InstallationID == 0 {
		return "", errors.New("github app auth missing installationID")
	}

	key, err := parseRSAPrivateKey(g.PrivateKey)
	if err != nil {
		return "", fmt.Errorf("parse github app private key: %w", err)
	}

	jwtToken, err := signGitHubAppJWT(key, g.AppID)
	if err != nil {
		return "", fmt.Errorf("sign github app jwt: %w", err)
	}

	return exchangeForInstallationToken(ctx, jwtToken, g.InstallationID, g.EnterpriseURL)
}

func parseRSAPrivateKey(pemBytes []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("no PEM block found")
	}
	key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err == nil {
		return key, nil
	}
	keyPKCS8, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse rsa private key: %w", err)
	}
	rsaKey, ok := keyPKCS8.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("private key is not RSA")
	}
	return rsaKey, nil
}

func signGitHubAppJWT(key *rsa.PrivateKey, appID int64) (string, error) {
	now := time.Now()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, err := json.Marshal(map[string]any{
		"iat": now.Add(-60 * time.Second).Unix(),
		"exp": now.Add(githubAppJWTExpiry).Unix(),
		"iss": appID,
	})
	if err != nil {
		return "", fmt.Errorf("marshal claims: %w", err)
	}
	payload := base64.RawURLEncoding.EncodeToString(claims)
	signingInput := header + "." + payload

	hash := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, hash[:])
	if err != nil {
		return "", fmt.Errorf("sign jwt: %w", err)
	}
	signature := base64.RawURLEncoding.EncodeToString(sig)

	return signingInput + "." + signature, nil
}

type installationTokenResponse struct {
	Token string `json:"token"`
}

func exchangeForInstallationToken(ctx context.Context, jwtToken string, installationID int64, enterpriseURL string) (_ string, err error) {
	url := fmt.Sprintf("https://api.github.com/app/installations/%d/access_tokens", installationID)
	if enterpriseURL != "" {
		base := strings.TrimSuffix(enterpriseURL, "/")
		url = base + "/api/v3/app/installations/" + strconv.FormatInt(installationID, 10) + "/access_tokens"
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, http.NoBody)
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}
	req.Header.Set(githubAppTokenHeader, "Bearer "+jwtToken)
	req.Header.Set("Accept", "application/vnd.github.v3+json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("request installation token: %w", err)
	}
	defer func() {
		if cerr := resp.Body.Close(); cerr != nil && err == nil {
			err = fmt.Errorf("close response body: %w", cerr)
		}
	}()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("github installation token request failed %d: %s", resp.StatusCode, string(body))
	}

	var tok installationTokenResponse
	if err := json.Unmarshal(body, &tok); err != nil {
		return "", fmt.Errorf("parse installation token response: %w", err)
	}
	if tok.Token == "" {
		return "", errors.New("empty installation token")
	}
	return tok.Token, nil
}
