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
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"

	"github.com/benebsworth/paprika/internal/api/admin"
)

type adminTokenHolder struct {
	mu            sync.Mutex
	token         string
	paused        bool
	cleared       bool
	shuttingDown  bool
	rotating      bool
	rotateCancel  context.CancelFunc
	rotateCleanup func(string) error
	active        int
	changed       chan struct{}
}

func newAdminTokenHolder(token string) *adminTokenHolder {
	return &adminTokenHolder{token: token, changed: make(chan struct{})}
}

func (holder *adminTokenHolder) Acquire(
	ctx context.Context,
) (token string, release func(), err error) {
	if holder == nil {
		return "", func() {}, errors.New("admin session holder is unavailable")
	}
	for {
		holder.mu.Lock()
		if holder.shuttingDown {
			holder.mu.Unlock()
			return "", func() {}, errors.New("admin proxy is shutting down")
		}
		if !holder.paused {
			if holder.cleared || !validAdminSecret(holder.token) {
				holder.mu.Unlock()
				return "", func() {}, errors.New("admin session is unavailable")
			}
			token := holder.token
			holder.active++
			var releaseOnce sync.Once
			release := func() {
				releaseOnce.Do(func() {
					holder.mu.Lock()
					holder.active--
					holder.notifyLocked()
					holder.mu.Unlock()
				})
			}
			holder.mu.Unlock()
			return token, release, nil
		}
		changed := holder.changed
		holder.mu.Unlock()
		select {
		case <-ctx.Done():
			return "", func() {}, fmt.Errorf(
				"wait for admin session rotation: %w",
				ctx.Err(),
			)
		case <-changed:
		}
	}
}

func (holder *adminTokenHolder) Current() string {
	if holder == nil {
		return ""
	}
	holder.mu.Lock()
	defer holder.mu.Unlock()
	return holder.token
}

func (holder *adminTokenHolder) Rotate(
	ctx context.Context,
	refresh func(context.Context, string) (string, error),
	cleanup func(string) error,
) error {
	if err := validateAdminRotationInputs(holder, refresh, cleanup); err != nil {
		return err
	}
	holder.mu.Lock()
	for holder.rotating {
		changed := holder.changed
		holder.mu.Unlock()
		select {
		case <-ctx.Done():
			return fmt.Errorf("wait for concurrent admin session rotation: %w", ctx.Err())
		case <-changed:
		}
		holder.mu.Lock()
	}
	if holder.rotationUnavailableLocked() {
		holder.mu.Unlock()
		return errors.New("current admin session is unavailable")
	}
	holder.paused = true
	holder.notifyLocked()
	for holder.active != 0 {
		changed := holder.changed
		holder.mu.Unlock()
		select {
		case <-ctx.Done():
			holder.mu.Lock()
			holder.paused = false
			holder.notifyLocked()
			holder.mu.Unlock()
			return fmt.Errorf("pause active admin proxy requests: %w", ctx.Err())
		case <-changed:
		}
		holder.mu.Lock()
	}
	current := holder.token
	refreshCtx, cancelRefresh := context.WithCancel(ctx)
	holder.rotating = true
	holder.rotateCancel = cancelRefresh
	holder.rotateCleanup = cleanup
	holder.notifyLocked()
	holder.mu.Unlock()

	replacement, err := refresh(refreshCtx, current)
	refreshContextErr := refreshCtx.Err()
	cancelRefresh()

	return holder.finishRotation(current, replacement, err, refreshContextErr)
}

func validateAdminRotationInputs(
	holder *adminTokenHolder,
	refresh func(context.Context, string) (string, error),
	cleanup func(string) error,
) error {
	if holder == nil || refresh == nil {
		return errors.New("admin session rotation is unavailable")
	}
	if cleanup == nil {
		return errors.New("admin session orphan replacement cleanup is unavailable")
	}
	return nil
}

func (holder *adminTokenHolder) rotationUnavailableLocked() bool {
	return holder.cleared ||
		holder.shuttingDown ||
		holder.rotating ||
		!validAdminSecret(holder.token)
}

func (holder *adminTokenHolder) finishRotation(
	current, replacement string,
	refreshErr, refreshContextErr error,
) error {
	holder.mu.Lock()
	orphaned := validAdminSecret(replacement) &&
		replacement != current &&
		(holder.shuttingDown || holder.cleared || refreshErr != nil)
	cleanup := holder.rotateCleanup
	if orphaned {
		holder.mu.Unlock()
		cleanupErr := cleanupAdminOrphanReplacement(cleanup, replacement)
		holder.mu.Lock()
		holder.completeRotationLocked()
		holder.mu.Unlock()
		return errors.Join(
			adminRotationResultError(refreshErr, refreshContextErr),
			cleanupErr,
		)
	}
	defer holder.mu.Unlock()
	holder.completeRotationLocked()
	if refreshErr != nil {
		return refreshErr
	}
	if !validAdminSecret(replacement) || replacement == current {
		return errors.New("admin session rotation returned an invalid replacement")
	}
	holder.token = replacement
	if refreshContextErr != nil {
		return fmt.Errorf(
			"admin session rotation completed after its deadline: %w",
			refreshContextErr,
		)
	}
	return nil
}

func (holder *adminTokenHolder) completeRotationLocked() {
	holder.rotating = false
	holder.rotateCancel = nil
	holder.rotateCleanup = nil
	if !holder.shuttingDown {
		holder.paused = false
	}
	holder.notifyLocked()
}

func cleanupAdminOrphanReplacement(
	cleanup func(string) error,
	replacement string,
) error {
	if cleanup == nil {
		return errors.New("clean orphaned admin session replacement: cleanup is unavailable")
	}
	if err := cleanup(replacement); err != nil {
		return fmt.Errorf("clean orphaned admin session replacement: %w", err)
	}
	return nil
}

func adminRotationResultError(refreshErr, refreshContextErr error) error {
	if refreshErr != nil {
		return refreshErr
	}
	if refreshContextErr != nil {
		return fmt.Errorf(
			"admin session rotation completed after its deadline: %w",
			refreshContextErr,
		)
	}
	return errors.New("admin session replacement discarded during shutdown")
}

func (holder *adminTokenHolder) BeginShutdown(ctx context.Context) (string, error) {
	if holder == nil {
		return "", nil
	}
	holder.mu.Lock()
	if holder.cleared {
		holder.mu.Unlock()
		return "", nil
	}
	holder.shuttingDown = true
	holder.paused = true
	if holder.rotateCancel != nil {
		holder.rotateCancel()
	}
	holder.notifyLocked()
	for holder.rotating {
		changed := holder.changed
		holder.mu.Unlock()
		select {
		case <-ctx.Done():
			holder.mu.Lock()
			token := holder.token
			holder.mu.Unlock()
			return token, fmt.Errorf("wait for admin session refresh handoff: %w", ctx.Err())
		case <-changed:
		}
		holder.mu.Lock()
	}
	token := holder.token
	holder.mu.Unlock()
	if !validAdminSecret(token) {
		return "", errors.New("admin session is unavailable for shutdown")
	}
	return token, nil
}

func (holder *adminTokenHolder) Clear(ctx context.Context) (string, error) {
	if holder == nil {
		return "", nil
	}
	token, err := holder.BeginShutdown(ctx)
	holder.mu.Lock()
	holder.token = ""
	holder.cleared = true
	holder.shuttingDown = true
	holder.paused = false
	holder.notifyLocked()
	holder.mu.Unlock()
	return token, err
}

func (holder *adminTokenHolder) notifyLocked() {
	close(holder.changed)
	holder.changed = make(chan struct{})
}

type adminProxy struct {
	origin         string
	server         *http.Server
	done           chan struct{}
	watchStop      chan struct{}
	watchJoined    chan struct{}
	closeOnce      sync.Once
	watchStopOnce  sync.Once
	requests       adminRequestGate
	forceCloseHook func()
	errMu          sync.Mutex
	err            error
}

type adminRequestGate struct {
	mu      sync.Mutex
	closed  bool
	active  int
	changed chan struct{}
}

func (gate *adminRequestGate) Enter() bool {
	gate.mu.Lock()
	defer gate.mu.Unlock()
	gate.ensureChangedLocked()
	if gate.closed {
		return false
	}
	gate.active++
	return true
}

func (gate *adminRequestGate) Leave() {
	gate.mu.Lock()
	gate.ensureChangedLocked()
	gate.active--
	gate.notifyLocked()
	gate.mu.Unlock()
}

func (gate *adminRequestGate) CloseAdmissions() {
	gate.mu.Lock()
	gate.ensureChangedLocked()
	gate.closed = true
	gate.notifyLocked()
	gate.mu.Unlock()
}

func (gate *adminRequestGate) Wait(ctx context.Context) error {
	for {
		gate.mu.Lock()
		gate.ensureChangedLocked()
		if gate.active == 0 {
			gate.mu.Unlock()
			return nil
		}
		changed := gate.changed
		gate.mu.Unlock()
		select {
		case <-ctx.Done():
			return fmt.Errorf("wait for admin proxy request handlers: %w", ctx.Err())
		case <-changed:
		}
	}
}

func (gate *adminRequestGate) ensureChangedLocked() {
	if gate.changed == nil {
		gate.changed = make(chan struct{})
	}
}

func (gate *adminRequestGate) notifyLocked() {
	close(gate.changed)
	gate.changed = make(chan struct{})
}

func startAdminProxy(
	ctx context.Context,
	localPort int,
	upstreamPort uint16,
	holder *adminTokenHolder,
) (*adminProxy, error) {
	if err := validateAdminProxyConfiguration(ctx, localPort, upstreamPort, holder); err != nil {
		return nil, err
	}
	listener, err := (&net.ListenConfig{}).Listen(
		ctx,
		"tcp4",
		net.JoinHostPort("127.0.0.1", strconv.Itoa(localPort)),
	)
	if err != nil {
		return nil, fmt.Errorf("bind loopback admin proxy: %w", err)
	}
	authority := listener.Addr().String()
	origin := "http://" + authority
	upstream, err := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", upstreamPort))
	if err != nil {
		closeErr := listener.Close()
		return nil, errors.Join(errors.New("build hidden admin upstream URL"), closeErr)
	}
	reverse := newAdminReverseProxy(upstream, authority)
	proxy := &adminProxy{
		origin:      origin,
		done:        make(chan struct{}),
		watchStop:   make(chan struct{}),
		watchJoined: make(chan struct{}),
	}
	proxy.server = &http.Server{
		Addr: authority,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
			proxy.serveRequest(w, request, authority, origin, holder, reverse)
		}),
		ReadHeaderTimeout: defaultAdminDashboardTimeout,
	}
	go func() {
		defer close(proxy.done)
		serveErr := proxy.server.Serve(listener)
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			proxy.errMu.Lock()
			proxy.err = fmt.Errorf("serve loopback admin proxy: %w", serveErr)
			proxy.errMu.Unlock()
		}
	}()
	go func() {
		defer close(proxy.watchJoined)
		select {
		case <-ctx.Done():
			proxy.initiateClose()
		case <-proxy.watchStop:
		}
	}()
	return proxy, nil
}

func validateAdminProxyConfiguration(
	ctx context.Context,
	localPort int,
	upstreamPort uint16,
	holder *adminTokenHolder,
) error {
	if ctx == nil ||
		localPort < 0 ||
		localPort > 65535 ||
		upstreamPort == 0 ||
		holder == nil {
		return errors.New("admin proxy configuration is invalid")
	}
	return nil
}

func newAdminReverseProxy(
	upstream *url.URL,
	authority string,
) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Rewrite: func(proxyRequest *httputil.ProxyRequest) {
			proxyRequest.SetURL(upstream)
			proxyRequest.Out.Host = adminUpstreamHost
			stripAdminForwardingHeaders(proxyRequest.Out.Header)
		},
		ModifyResponse: func(response *http.Response) error {
			return hardenAdminProxyResponse(response, authority)
		},
	}
}

func hardenAdminProxyResponse(response *http.Response, authority string) error {
	stripAdminCrossOriginResponseHeaders(response.Header)
	// Preserve Set-Cookie for same-origin UI state. The admin credential is
	// header-only and is never exposed to, or persisted by, the browser.
	location := response.Header.Get("Location")
	if location == "" {
		return nil
	}
	parsedLocation, err := url.Parse(location)
	if err != nil {
		response.Header.Del("Location")
		return errors.New("reject malformed absolute admin redirect")
	}
	if !parsedLocation.IsAbs() && parsedLocation.Host == "" {
		return nil
	}
	if parsedLocation.Scheme != "http" ||
		parsedLocation.Host != adminUpstreamHost ||
		parsedLocation.User != nil {
		response.Header.Del("Location")
		return errors.New("reject absolute admin redirect outside hidden upstream")
	}
	parsedLocation.Scheme = "http"
	parsedLocation.Host = authority
	response.Header.Set("Location", parsedLocation.String())
	return nil
}

func (proxy *adminProxy) serveRequest(
	w http.ResponseWriter,
	request *http.Request,
	authority, origin string,
	holder *adminTokenHolder,
	reverse *httputil.ReverseProxy,
) {
	if !proxy.requests.Enter() {
		http.Error(w, "admin proxy is shutting down", http.StatusServiceUnavailable)
		return
	}
	defer proxy.requests.Leave()
	if request.Host != authority {
		http.Error(w, "invalid request host", http.StatusBadRequest)
		return
	}
	mutation, allowed := adminProxyMethod(request.Method)
	if !allowed {
		http.Error(w, "request method is not allowed", http.StatusMethodNotAllowed)
		return
	}
	if mutation {
		origins := request.Header.Values("Origin")
		if len(origins) != 1 || origins[0] != origin {
			http.Error(w, "invalid request origin", http.StatusForbidden)
			return
		}
	}
	stripAdminForwardingHeaders(request.Header)
	if mutation {
		request.Header.Set("Origin", adminUpstreamOrigin)
	}
	token, release, err := holder.Acquire(request.Context())
	if err != nil {
		http.Error(w, "admin session unavailable", http.StatusServiceUnavailable)
		return
	}
	defer release()
	request.Header.Set(admin.AdminSessionHeader, token)
	reverse.ServeHTTP(w, request)
}

func (proxy *adminProxy) URL() string {
	if proxy == nil {
		return ""
	}
	return proxy.origin
}

func (proxy *adminProxy) Done() <-chan struct{} {
	if proxy == nil {
		closed := make(chan struct{})
		close(closed)
		return closed
	}
	return proxy.done
}

func (proxy *adminProxy) Close(ctx context.Context) error {
	if proxy == nil {
		return nil
	}
	if ctx == nil {
		return errors.New("close loopback admin proxy requires a context")
	}
	proxy.requests.CloseAdmissions()
	proxy.watchStopOnce.Do(func() { close(proxy.watchStop) })
	shutdownErr := proxy.server.Shutdown(ctx)
	if shutdownErr != nil {
		proxy.initiateClose()
		shutdownErr = fmt.Errorf("gracefully close loopback admin proxy: %w", shutdownErr)
	}
	doneErr := waitAdminProxyJoin(ctx, proxy.done, "serve loop")
	watchErr := waitAdminProxyJoin(ctx, proxy.watchJoined, "context watcher")
	requestErr := proxy.requests.Wait(ctx)
	if doneErr != nil || watchErr != nil || requestErr != nil {
		proxy.initiateClose()
	}
	proxy.errMu.Lock()
	defer proxy.errMu.Unlock()
	return errors.Join(shutdownErr, doneErr, watchErr, requestErr, proxy.err)
}

func (proxy *adminProxy) initiateClose() {
	proxy.requests.CloseAdmissions()
	proxy.closeOnce.Do(func() {
		if proxy.forceCloseHook != nil {
			proxy.forceCloseHook()
		}
		var closeErr error
		if proxy.server != nil {
			closeErr = proxy.server.Close()
		}
		proxy.errMu.Lock()
		if closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
			proxy.err = errors.Join(proxy.err, fmt.Errorf("close loopback admin proxy: %w", closeErr))
		}
		proxy.errMu.Unlock()
	})
}

func waitAdminProxyJoin(
	ctx context.Context,
	joined <-chan struct{},
	component string,
) error {
	if joined == nil {
		return fmt.Errorf("admin proxy %s has no join channel", component)
	}
	select {
	case <-joined:
		return nil
	default:
	}
	select {
	case <-joined:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("wait for admin proxy %s: %w", component, ctx.Err())
	}
}

func stripAdminForwardingHeaders(header http.Header) {
	for name := range header {
		lowerName := strings.ToLower(name)
		if lowerName == "forwarded" ||
			strings.HasPrefix(lowerName, "x-forwarded-") ||
			lowerName == "x-original-host" {
			delete(header, name)
		}
	}
	for _, connection := range header.Values("Connection") {
		for name := range strings.SplitSeq(connection, ",") {
			header.Del(strings.TrimSpace(name))
		}
	}
	for _, name := range []string{
		"Connection",
		"Keep-Alive",
		"Proxy-Authenticate",
		"Proxy-Authorization",
		"Te",
		"Trailer",
		"Transfer-Encoding",
		"Upgrade",
	} {
		header.Del(name)
	}
}

func adminProxyMethod(method string) (mutation, allowed bool) {
	switch method {
	case http.MethodGet, http.MethodHead:
		return false, true
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true, true
	default:
		return false, false
	}
}

func stripAdminCrossOriginResponseHeaders(header http.Header) {
	for name := range header {
		if strings.HasPrefix(strings.ToLower(name), "access-control-") {
			delete(header, name)
		}
	}
}
