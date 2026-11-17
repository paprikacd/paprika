package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

// googleGKEToken uses the process's application-default identity, including a
// GKE Workload Identity binding. The kubeconfig carries no Google credential.
func googleGKEToken(ctx context.Context) (*oauth2.Token, error) {
	source, err := google.DefaultTokenSource(ctx, "https://www.googleapis.com/auth/cloud-platform")
	if err != nil {
		return nil, fmt.Errorf("load Google credentials: %w", err)
	}
	token, err := source.Token()
	if err != nil {
		return nil, fmt.Errorf("obtain Google credentials: %w", err)
	}
	return token, nil
}

// runGKEExecCredential implements the client-go exec-credential protocol.
// client-go caches this credential until its expiration and re-executes the
// helper, allowing long-running controller clients to renew without key files.
//
//nolint:cyclop // Each protocol and token property must be checked independently.
func runGKEExecCredential(ctx context.Context, info string, out io.Writer, tokenFn func(context.Context) (*oauth2.Token, error)) error {
	var request struct {
		APIVersion string `json:"apiVersion"`
		Kind       string `json:"kind"`
	}
	if err := json.Unmarshal([]byte(info), &request); err != nil || request.Kind != "ExecCredential" ||
		(request.APIVersion != "client.authentication.k8s.io/v1" && request.APIVersion != "client.authentication.k8s.io/v1beta1") {
		return errors.New("invalid Kubernetes exec credential request")
	}

	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	token, err := tokenFn(ctx)
	if err != nil || token == nil || token.AccessToken == "" || token.Expiry.IsZero() || !token.Valid() {
		// The credential chain may contain private identity data; never print it.
		return errors.New("unable to obtain a valid short-lived Google credential")
	}
	response := struct {
		APIVersion string `json:"apiVersion"`
		Kind       string `json:"kind"`
		Status     struct {
			Token               string    `json:"token"`
			ExpirationTimestamp time.Time `json:"expirationTimestamp"`
		} `json:"status"`
	}{APIVersion: request.APIVersion, Kind: "ExecCredential"}
	response.Status.Token = token.AccessToken
	response.Status.ExpirationTimestamp = token.Expiry.UTC()
	if err := json.NewEncoder(out).Encode(response); err != nil {
		return fmt.Errorf("write Kubernetes credential response: %w", err)
	}
	return nil
}
