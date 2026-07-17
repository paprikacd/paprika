package admin

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"
)

const (
	AdminListenerAddress         = "127.0.0.1:3001"
	adminListenerShutdownTimeout = 5 * time.Second
)

var ErrInvalidListenerConfig = errors.New("invalid admin listener configuration")

type Listener struct {
	ctx             context.Context
	listener        net.Listener
	server          *http.Server
	shutdownTimeout time.Duration
	stop            chan struct{}
	close           sync.Once
	closeErr        error
}

func NewListener(ctx context.Context, handler http.Handler) (*Listener, error) {
	return newListener(ctx, handler, adminListenerShutdownTimeout)
}

func newListener(
	ctx context.Context,
	handler http.Handler,
	shutdownTimeout time.Duration,
) (*Listener, error) {
	if ctx == nil || handler == nil || shutdownTimeout <= 0 {
		return nil, ErrInvalidListenerConfig
	}
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp4", AdminListenerAddress)
	if err != nil {
		return nil, fmt.Errorf("admin listener bind %s: %w", AdminListenerAddress, err)
	}
	adminListener := &Listener{
		ctx:      ctx,
		listener: listener,
		server: &http.Server{
			Addr:              AdminListenerAddress,
			Handler:           handler,
			ReadHeaderTimeout: 10 * time.Second,
		},
		shutdownTimeout: shutdownTimeout,
		stop:            make(chan struct{}),
	}
	go func() {
		select {
		case <-ctx.Done():
			if err := adminListener.closeWithContext(ctx); err != nil {
				return
			}
		case <-adminListener.stop:
		}
	}()
	return adminListener, nil
}

func (listener *Listener) Addr() net.Addr {
	return listener.listener.Addr()
}

func (listener *Listener) Serve() error {
	err := listener.server.Serve(listener.listener)
	if err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
		return fmt.Errorf("admin listener serve: %w", err)
	}
	return listener.Close()
}

func (listener *Listener) Close() error {
	return listener.closeWithContext(listener.ctx)
}

func (listener *Listener) closeWithContext(ctx context.Context) error {
	listener.close.Do(func() {
		close(listener.stop)
		shutdownCtx, cancel := context.WithTimeout(
			context.WithoutCancel(ctx),
			listener.shutdownTimeout,
		)
		shutdownErr := listener.server.Shutdown(shutdownCtx)
		cancel()
		if isNormalListenerCloseError(shutdownErr) {
			shutdownErr = nil
		}
		var forceCloseErr error
		if shutdownErr != nil {
			forceCloseErr = listener.server.Close()
			if isNormalListenerCloseError(forceCloseErr) {
				forceCloseErr = nil
			}
		}
		socketErr := listener.listener.Close()
		if errors.Is(socketErr, net.ErrClosed) {
			socketErr = nil
		}
		if shutdownErr != nil {
			shutdownErr = fmt.Errorf("admin listener graceful shutdown: %w", shutdownErr)
		}
		if forceCloseErr != nil {
			forceCloseErr = fmt.Errorf("admin listener force close: %w", forceCloseErr)
		}
		if socketErr != nil {
			socketErr = fmt.Errorf("admin listener socket close: %w", socketErr)
		}
		listener.closeErr = errors.Join(shutdownErr, forceCloseErr, socketErr)
	})
	return listener.closeErr
}

func isNormalListenerCloseError(err error) bool {
	return err == nil || errors.Is(err, http.ErrServerClosed) || errors.Is(err, net.ErrClosed)
}
