package satellite

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

// TestLinkSenderSpeaksH2CToALoopbackEndpoint pins the transport a cleartext
// loopback link needs.
//
// A bidirectional stream is HTTP/2 only, and Go's transport does not attempt
// h2c on an http:// URL — ForceAttemptHTTP2 applies to TLS. A satellite pointed
// at http://127.0.0.1 therefore needs the shared h2c transport, or the stream
// negotiates HTTP/1.1 and Connect refuses it.
func TestLinkSenderSpeaksH2CToALoopbackEndpoint(t *testing.T) {
	t.Parallel()

	acked := make(chan uint64, 1)
	_, handler := v1connect.NewSatelliteLinkHandler(&h2cLinkServer{acked: acked})
	mux := http.NewServeMux()
	mux.Handle("/paprika.v1.SatelliteLink/", handler)

	server := httptest.NewUnstartedServer(h2c.NewHandler(mux, &http2.Server{}))
	server.Start()
	t.Cleanup(func() {
		server.CloseClientConnections()
		server.Close()
	})

	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("0123456789abcdef0123456789abcdef"), 0o600); err != nil {
		t.Fatalf("write token: %v", err)
	}

	sender, err := NewLinkSender(&LinkConfig{
		ControlPlaneURL:  server.URL,
		ClusterNamespace: "paprika-system",
		ClusterName:      "edge",
		TokenFile:        tokenFile,
	})
	if err != nil {
		t.Fatalf("NewLinkSender: %v", err)
	}
	t.Cleanup(sender.Close)

	if err := sender.Send(context.Background(), &Report{Sequence: 7, SessionID: "s"}); err != nil {
		t.Fatalf("Send over h2c: %v", err)
	}
	select {
	case sequence := <-acked:
		if sequence != 7 {
			t.Fatalf("acknowledged sequence = %d, want 7", sequence)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the server never received the report")
	}
}

// h2cLinkServer acknowledges reports so the client completes its round trip.
type h2cLinkServer struct {
	acked chan uint64
}

func (s *h2cLinkServer) Connect(
	_ context.Context,
	stream *connect.BidiStream[paprikav1.SatelliteFrame, paprikav1.SatelliteFrame],
) error {
	if _, err := stream.Receive(); err != nil {
		return err
	}
	for {
		frame, err := stream.Receive()
		if err != nil {
			return nil
		}
		update := frame.GetUpdate()
		if update == nil {
			continue
		}
		var envelope struct {
			Sequence uint64 `json:"sequence"`
		}
		if err := json.Unmarshal(update.GetReport(), &envelope); err != nil {
			return err
		}
		s.acked <- envelope.Sequence
		if err := stream.Send(&paprikav1.SatelliteFrame{
			Frame: &paprikav1.SatelliteFrame_Ack{Ack: &paprikav1.SatelliteAck{Sequence: envelope.Sequence}},
		}); err != nil {
			return err
		}
	}
}
