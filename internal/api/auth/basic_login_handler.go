package auth

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"

	"golang.org/x/crypto/bcrypt"
)

// BasicLoginRequest is the request body for basic auth login.
type BasicLoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// BasicLoginHandler returns an http.Handler that validates basic auth credentials
// and returns a self-signed token for subsequent API calls.
// POST /auth/basic-login
func BasicLoginHandler(cfg BasicAuthConfig, tokenSecret []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Validate content type.
		if r.Header.Get("Content-Type") != "application/json" {
			http.Error(w, "content-type must be application/json", http.StatusUnsupportedMediaType)
			return
		}

		var req BasicLoginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}

		if req.Username == "" || req.Password == "" {
			http.Error(w, "username and password are required", http.StatusBadRequest)
			return
		}

		if !validateCredentials(req.Username, req.Password, cfg) {
			http.Error(w, "invalid credentials", http.StatusUnauthorized)
			return
		}

		token, err := IssueToken(req.Username, req.Username+"@paprika.cd", req.Username, tokenSecret)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		resp := TokenResponse{
			IDToken:   token,
			ExpiresIn: int(tokenExpiry.Seconds()),
			TokenType: "Bearer",
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		//nolint:gosec // AccessToken is a session token, not a secret
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			http.Error(w, fmt.Sprintf("encode response: %v", err), http.StatusInternalServerError)
		}
	}
}

func validateCredentials(username, password string, cfg BasicAuthConfig) bool {
	if subtle.ConstantTimeCompare([]byte(username), []byte(cfg.Username)) != 1 {
		return false
	}

	return bcrypt.CompareHashAndPassword([]byte(cfg.PasswordHash), []byte(password)) == nil
}
