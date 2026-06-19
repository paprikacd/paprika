package main

import (
	"errors"
	"testing"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func newTestWatchModel() *watchModel {
	s := spinner.New()
	s.Spinner = spinner.Dot
	return &watchModel{
		namespace: "ns",
		name:      "app",
		spinner:   s,
		start:     time.Now(),
		timeout:   time.Minute,
	}
}

func TestWatchModel_Init(t *testing.T) {
	t.Parallel()
	m := newTestWatchModel()
	cmd := m.Init()
	if cmd == nil {
		t.Fatal("Init() returned nil command")
	}

	msg := cmd()
	batch, ok := msg.(tea.BatchMsg)
	if !ok {
		t.Fatalf("Init() returned %T, want tea.BatchMsg", msg)
	}
	if len(batch) != 3 {
		t.Fatalf("Init() batch length = %d, want 3", len(batch))
	}
}

func TestWatchModel_Update(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		msg      tea.Msg
		setup    func(*watchModel)
		wantApp  *paprikav1.Application
		wantErr  bool
		wantDone bool
		wantCmd  bool
	}{
		{
			name:     "appMsg stores application on non-terminal phase",
			msg:      appMsg{app: &paprikav1.Application{Phase: "Pending"}},
			wantApp:  &paprikav1.Application{Phase: "Pending"},
			wantDone: false,
			wantCmd:  false,
		},
		{
			name:     "appMsg Healthy marks done and quits",
			msg:      appMsg{app: &paprikav1.Application{Phase: "Healthy"}},
			wantApp:  &paprikav1.Application{Phase: "Healthy"},
			wantDone: true,
			wantCmd:  true,
		},
		{
			name:     "appMsg Failed marks done and quits",
			msg:      appMsg{app: &paprikav1.Application{Phase: "Failed"}},
			wantApp:  &paprikav1.Application{Phase: "Failed"},
			wantDone: true,
			wantCmd:  true,
		},
		{
			name:     "appMsg RolledBack marks done and quits",
			msg:      appMsg{app: &paprikav1.Application{Phase: "RolledBack"}},
			wantApp:  &paprikav1.Application{Phase: "RolledBack"},
			wantDone: true,
			wantCmd:  true,
		},
		{
			name:     "appMsg error stores error and quits",
			msg:      appMsg{err: errors.New("fetch failed")},
			wantErr:  true,
			wantDone: true,
			wantCmd:  true,
		},
		{
			name:     "key q marks done and quits",
			msg:      tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}},
			wantDone: true,
			wantCmd:  true,
		},
		{
			name:     "key ctrl+c marks done and quits",
			msg:      tea.KeyMsg{Type: tea.KeyCtrlC},
			wantDone: true,
			wantCmd:  true,
		},
		{
			name: "tick within timeout fetches again",
			msg:  tickMsg{},
			setup: func(m *watchModel) {
				m.start = time.Now()
			},
			wantDone: false,
			wantCmd:  true,
		},
		{
			name: "tick past timeout stores error and quits",
			msg:  tickMsg{},
			setup: func(m *watchModel) {
				m.start = time.Now().Add(-2 * time.Minute)
				m.timeout = time.Minute
			},
			wantErr:  true,
			wantDone: true,
			wantCmd:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			m := newTestWatchModel()
			if tt.setup != nil {
				tt.setup(m)
			}

			_, cmd := m.Update(tt.msg)

			if m.done != tt.wantDone {
				t.Errorf("done = %v, want %v", m.done, tt.wantDone)
			}
			if tt.wantApp != nil {
				if m.app == nil {
					t.Fatal("app is nil, want non-nil")
				}
				if m.app.Phase != tt.wantApp.Phase {
					t.Errorf("app.Phase = %q, want %q", m.app.Phase, tt.wantApp.Phase)
				}
			}
			if tt.wantErr && m.err == nil {
				t.Error("expected error, got nil")
			}
			if !tt.wantErr && m.err != nil {
				t.Errorf("unexpected error: %v", m.err)
			}
			if (cmd != nil) != tt.wantCmd {
				t.Errorf("cmd = %v, want non-nil %v", cmd, tt.wantCmd)
			}
		})
	}
}
