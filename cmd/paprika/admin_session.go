/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/rest"

	"github.com/benebsworth/paprika/internal/api/admin"
)

const (
	adminUpstreamHost       = "127.0.0.1:3001"
	adminUpstreamOrigin     = "http://" + adminUpstreamHost
	adminSessionMaxBody     = 16 << 10
	adminReadyRetryInterval = 10 * time.Millisecond
	adminMintedCleanupLimit = 5 * time.Second
)

type adminSessionState struct {
	token       string
	description admin.SessionDescription
}

type adminSessionExchangeResponse struct {
	Token   string                   `json:"token"`
	Session admin.SessionDescription `json:"session"`
}

type adminSessionClient struct {
	config      *rest.Config
	endpoint    string
	credentials adminCredentialRoundTripperFactory
	transport   http.RoundTripper
	pods        adminSelectedPodGetter
	now         func() time.Time
}

type adminSelectedPodGetter func(context.Context, string, string) (*corev1.Pod, error)

func newAdminSessionClient(
	config *rest.Config,
	forwardPort uint16,
	credentials adminCredentialRoundTripperFactory,
	pods adminSelectedPodGetter,
) *adminSessionClient {
	endpoint := fmt.Sprintf("http://127.0.0.1:%d", forwardPort)
	return &adminSessionClient{
		config:      config,
		endpoint:    endpoint,
		credentials: credentials,
		pods:        pods,
		now:         time.Now,
		transport: adminRoundTripperFunc(func(request *http.Request) (*http.Response, error) {
			forward := request.Clone(request.Context())
			forward.Host = adminUpstreamHost
			stripAdminForwardingHeaders(forward.Header)
			return http.DefaultTransport.RoundTrip(forward)
		}),
	}
}

func (client *adminSessionClient) AwaitAndExchange(
	ctx context.Context,
	pod *corev1.Pod,
) (adminSessionState, error) {
	if err := validateSelectedAdminPod(pod); err != nil {
		return adminSessionState{}, err
	}
	if err := client.awaitReady(ctx); err != nil {
		return adminSessionState{}, err
	}
	if err := client.revalidateSelectedPod(ctx, pod); err != nil {
		return adminSessionState{}, err
	}
	return client.exchangeAndValidate(ctx, "")
}

func (client *adminSessionClient) Rotate(
	ctx context.Context,
	pod *corev1.Pod,
	current string,
) (adminSessionState, error) {
	if err := client.revalidateSelectedPod(ctx, pod); err != nil {
		return adminSessionState{}, err
	}
	if !validAdminSecret(current) {
		return adminSessionState{}, errors.New("current admin session is unavailable")
	}
	return client.exchangeAndValidate(ctx, current)
}

func (client *adminSessionClient) Revoke(ctx context.Context, token string) error {
	if client == nil || !validAdminSecret(token) {
		return errors.New("admin session is unavailable for revocation")
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodDelete,
		client.endpoint+"/admin/session",
		http.NoBody,
	)
	if err != nil {
		return errors.New("build admin session revocation request")
	}
	request.Host = adminUpstreamHost
	request.Header.Set("Origin", adminUpstreamOrigin)
	request.Header.Set(admin.AdminSessionHeader, token)
	response, err := client.transport.RoundTrip(request)
	if err != nil {
		return errors.New("revoke admin session through hidden forward")
	}
	if err = normalizeAdminResponse(response, "admin session revocation"); err != nil {
		return err
	}
	defer closeAdminResponse(response.Body)
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("revoke admin session returned HTTP %d", response.StatusCode)
	}
	return nil
}

func (client *adminSessionClient) awaitReady(ctx context.Context) error {
	if client == nil || client.transport == nil || client.endpoint == "" {
		return errors.New("admin session readiness client is unavailable")
	}
	ticker := time.NewTicker(adminReadyRetryInterval)
	defer ticker.Stop()
	var lastStatus int
	for {
		status, requestErr := client.readyStatus(ctx)
		if requestErr == nil {
			lastStatus = status
			if lastStatus == http.StatusOK {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			if lastStatus == http.StatusNotFound {
				return fmt.Errorf(
					"admin listener readiness unavailable (listener may be disabled): %w",
					ctx.Err(),
				)
			}
			return fmt.Errorf("admin listener readiness deadline: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func (client *adminSessionClient) readyStatus(ctx context.Context) (int, error) {
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		client.endpoint+"/readyz",
		http.NoBody,
	)
	if err != nil {
		return 0, errors.New("build admin listener readiness request")
	}
	request.Host = adminUpstreamHost
	response, err := client.transport.RoundTrip(request)
	if err != nil {
		return 0, fmt.Errorf("request admin listener readiness: %w", err)
	}
	if err = normalizeAdminResponse(response, "admin listener readiness"); err != nil {
		return 0, err
	}
	defer closeAdminResponse(response.Body)
	return response.StatusCode, nil
}

func (client *adminSessionClient) exchangeAndValidate(
	ctx context.Context,
	current string,
) (adminSessionState, error) {
	if client == nil || client.credentials == nil || client.transport == nil {
		return adminSessionState{}, errors.New("admin session exchange client is unavailable")
	}
	credentialClient, err := newAdminExchangeRequestClient(
		client.config,
		client.transport,
		client.credentials,
	)
	if err != nil {
		return adminSessionState{}, err
	}
	response, err := credentialClient.RoundTripWithCurrentSession(
		ctx,
		client.endpoint+"/admin/session/exchange",
		current,
	)
	if err != nil {
		return adminSessionState{}, fmt.Errorf(
			"exchange Kubernetes credential for admin session: %w",
			redactAdminCredentialError(client.config, err),
		)
	}
	exchange, err := decodeAdminExchange(response)
	if err != nil {
		return adminSessionState{}, err
	}
	description, err := client.describe(ctx, exchange.Token)
	if err != nil {
		return adminSessionState{}, client.cleanupMintedSession(ctx, exchange.Token, err)
	}
	now := time.Now
	if client.now != nil {
		now = client.now
	}
	if err := validateAdminDescription(exchange.Session, description, now()); err != nil {
		return adminSessionState{}, client.cleanupMintedSession(ctx, exchange.Token, err)
	}
	return adminSessionState{token: exchange.Token, description: description}, nil
}

func (client *adminSessionClient) cleanupMintedSession(
	ctx context.Context,
	token string,
	primary error,
) error {
	cleanupCtx, cancel := context.WithTimeout(
		context.WithoutCancel(ctx),
		adminMintedCleanupLimit,
	)
	defer cancel()
	if err := client.Revoke(cleanupCtx, token); err != nil {
		return errors.Join(primary, fmt.Errorf("revoke minted admin session: %w", err))
	}
	return primary
}

func (client *adminSessionClient) describe(
	ctx context.Context,
	token string,
) (admin.SessionDescription, error) {
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		client.endpoint+"/admin/session",
		http.NoBody,
	)
	if err != nil {
		return admin.SessionDescription{}, errors.New("build admin session description request")
	}
	request.Host = adminUpstreamHost
	request.Header.Set(admin.AdminSessionHeader, token)
	response, err := client.transport.RoundTrip(request)
	if err != nil {
		return admin.SessionDescription{}, errors.New("read authenticated admin session description")
	}
	if err = normalizeAdminResponse(response, "admin session description"); err != nil {
		return admin.SessionDescription{}, err
	}
	defer closeAdminResponse(response.Body)
	if response.StatusCode != http.StatusOK {
		return admin.SessionDescription{}, fmt.Errorf(
			"admin session description returned HTTP %d",
			response.StatusCode,
		)
	}
	var description admin.SessionDescription
	if err := decodeStrictAdminJSON(response.Body, &description); err != nil {
		return admin.SessionDescription{}, fmt.Errorf("decode admin session description: %w", err)
	}
	return description, nil
}

func decodeAdminExchange(response *http.Response) (adminSessionExchangeResponse, error) {
	if err := normalizeAdminResponse(response, "admin session exchange"); err != nil {
		return adminSessionExchangeResponse{}, err
	}
	defer closeAdminResponse(response.Body)
	if response.StatusCode != http.StatusCreated {
		return adminSessionExchangeResponse{}, fmt.Errorf(
			"admin session exchange returned HTTP %d",
			response.StatusCode,
		)
	}
	var exchange adminSessionExchangeResponse
	if err := decodeStrictAdminJSON(response.Body, &exchange); err != nil {
		return adminSessionExchangeResponse{}, fmt.Errorf("decode admin session exchange: %w", err)
	}
	if !validAdminSecret(exchange.Token) {
		return adminSessionExchangeResponse{}, errors.New("admin session exchange returned an invalid token")
	}
	return exchange, nil
}

func normalizeAdminResponse(
	response *http.Response,
	operation string,
) error {
	if response == nil {
		return fmt.Errorf("%s returned no response", operation)
	}
	if response.Body == nil {
		response.Body = http.NoBody
	}
	return nil
}

func decodeStrictAdminJSON(body io.Reader, target any) error {
	limited := io.LimitReader(body, adminSessionMaxBody+1)
	payload, err := io.ReadAll(limited)
	if err != nil {
		return errors.New("read bounded JSON response")
	}
	if len(payload) == 0 || len(payload) > adminSessionMaxBody {
		return errors.New("JSON response is empty or too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode strict admin JSON: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("JSON response contains trailing data")
	}
	return nil
}

//nolint:cyclop,gocritic // All immutable session fields are checked together as one fail-closed contract.
func validateAdminDescription(
	exchanged, described admin.SessionDescription,
	now time.Time,
) error {
	if exchanged.Subject == "" || described.Subject != exchanged.Subject {
		return errors.New("admin session reviewed subject did not match its description")
	}
	if exchanged.AccessMode != admin.AccessMode || described.AccessMode != admin.AccessMode {
		return errors.New("admin session access mode was not the required Kubernetes admin mode")
	}
	if exchanged.AbsoluteEnds.IsZero() ||
		!exchanged.AbsoluteEnds.Equal(described.AbsoluteEnds) ||
		!now.Before(described.IdleExpires) ||
		!now.Before(described.AbsoluteEnds) ||
		described.AbsoluteEnds.Before(described.IdleExpires) ||
		described.IdleExpires.Before(exchanged.IdleExpires) {
		return errors.New("admin session expiry was malformed or unexpected")
	}
	return nil
}

func validateSelectedAdminPod(pod *corev1.Pod) error {
	if pod == nil ||
		pod.Namespace == "" || strings.TrimSpace(pod.Namespace) != pod.Namespace ||
		pod.Name == "" || strings.TrimSpace(pod.Name) != pod.Name ||
		pod.UID == "" || strings.TrimSpace(string(pod.UID)) != string(pod.UID) {
		return errors.New("selected admin pod identity is incomplete")
	}
	return nil
}

func (client *adminSessionClient) revalidateSelectedPod(
	ctx context.Context,
	expected *corev1.Pod,
) error {
	if err := validateSelectedAdminPod(expected); err != nil {
		return err
	}
	if client == nil || client.pods == nil {
		return errors.New("selected admin pod revalidation is unavailable")
	}
	current, err := client.pods(ctx, expected.Namespace, expected.Name)
	if err != nil {
		return fmt.Errorf("revalidate selected admin pod: %w", err)
	}
	if current == nil ||
		current.Namespace != expected.Namespace ||
		current.Name != expected.Name ||
		current.UID != expected.UID ||
		!isReadyAdminPod(current) {
		return errors.New("selected admin pod identity or readiness changed")
	}
	return nil
}

func validAdminSecret(token string) bool {
	return token != "" &&
		strings.TrimSpace(token) == token &&
		!strings.ContainsAny(token, " \t\r\n")
}

func closeAdminResponse(body io.Closer) {
	if err := body.Close(); err != nil {
		return
	}
}
