// Package kube builds Kubernetes clients tuned for this control plane's access
// patterns: protobuf on the wire where the API server supports it, and one
// long-lived client per remote cluster rather than one per reconcile.
package kube

import (
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/rest"
)

// acceptProtobufThenJSON is the Accept header value used for every client here.
//
// Listing both formats is what makes protobuf safe to ask for globally: the API
// server serves protobuf for built-in types and falls back to JSON for anything
// it has no generated marshaler for.
const acceptProtobufThenJSON = runtime.ContentTypeProtobuf + "," + runtime.ContentTypeJSON

// WithProtobufResponses returns a copy of cfg that asks for protobuf responses
// while continuing to send JSON request bodies.
//
// This is the setting that is safe on a config shared with clients that touch
// CustomResourceDefinition-backed types. Custom resources are JSON-only — the
// API server has no generated protobuf marshalers for them, so it answers a
// protobuf-only Accept header with 406 Not Acceptable and a protobuf request
// body with 415 Unsupported Media Type. Content negotiation handles the read
// path for us; the write path must stay JSON.
//
// Reads dominate this control plane's traffic, so accepting protobuf captures
// most of the benefit at no correctness risk.
func WithProtobufResponses(cfg *rest.Config) *rest.Config {
	if cfg == nil {
		return nil
	}
	// Copy: callers frequently pass a manager's shared base config, and
	// mutating it in place changes the wire format for every client derived
	// from it afterwards — including CRD clients.
	out := rest.CopyConfig(cfg)
	out.AcceptContentTypes = acceptProtobufThenJSON
	out.ContentType = runtime.ContentTypeJSON
	return out
}

// WithProtobufBothWays returns a copy of cfg that both sends and receives
// protobuf.
//
// Only use this for a client that will never touch a custom resource — nodes,
// pods, deployments, namespaces, events and the discovery endpoints are all
// fine. Point it at an Application, Release or Stage and writes fail with 415.
//
// Note that setting NegotiatedSerializer here would be pointless: every typed
// client's setConfigDefaults overwrites it with that API group's own scheme
// codecs (client-go v0.36 kubernetes/typed/*/*_client.go). The two content-type
// fields are what actually select the wire format.
func WithProtobufBothWays(cfg *rest.Config) *rest.Config {
	if cfg == nil {
		return nil
	}
	out := rest.CopyConfig(cfg)
	out.AcceptContentTypes = acceptProtobufThenJSON
	out.ContentType = runtime.ContentTypeProtobuf
	return out
}
