package admin

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
)

const AdminListenerOrigin = "http://127.0.0.1:3001"

var (
	ErrInvalidLoopbackHost   = errors.New("invalid loopback request host")
	ErrInvalidMutationOrigin = errors.New("invalid mutation origin")
)

var rejectedForwardingHeaders = []string{
	"Forwarded",
	"X-Forwarded-Host",
	"X-Forwarded-For",
	"X-Forwarded-Proto",
	"X-Original-Host",
}

func ValidateLoopbackHost(request *http.Request) error {
	if request == nil || !canonicalLoopbackHost(request.Host) {
		return ErrInvalidLoopbackHost
	}
	for _, header := range rejectedForwardingHeaders {
		if len(request.Header.Values(header)) != 0 {
			return ErrInvalidLoopbackHost
		}
	}
	return nil
}

func ValidateAndRewriteMutationOrigin(
	request *http.Request,
	upstreamOrigin string,
) error {
	if err := ValidateLoopbackHost(request); err != nil {
		return err
	}
	if upstreamOrigin != AdminListenerOrigin || !canonicalLoopbackOrigin(upstreamOrigin) {
		return ErrInvalidMutationOrigin
	}
	origins := request.Header.Values("Origin")
	if len(origins) != 1 || origins[0] != "http://"+request.Host {
		return ErrInvalidMutationOrigin
	}
	request.Header.Set("Origin", upstreamOrigin)
	return nil
}

func canonicalLoopbackOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "http" || parsed.Opaque != "" ||
		parsed.User != nil || parsed.Path != "" || parsed.RawPath != "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" ||
		!canonicalLoopbackHost(parsed.Host) {
		return false
	}
	return origin == "http://"+parsed.Host
}

func canonicalLoopbackHost(authority string) bool {
	host, portText, err := net.SplitHostPort(authority)
	if err != nil || host != "127.0.0.1" {
		return false
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return false
	}
	return authority == net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
}
