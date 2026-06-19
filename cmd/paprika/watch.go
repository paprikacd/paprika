package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-isatty"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

type watchModel struct {
	client        v1connect.PaprikaServiceClient
	namespace     string
	name          string
	release       *paprikav1.Release
	policyResults []*paprikav1.PolicyResult
	app           *paprikav1.Application
	err           error
	done          bool
	spinner       spinner.Model
	start         time.Time
	timeout       time.Duration
}

type appMsg struct {
	app *paprikav1.Application
	err error
}

type tickMsg struct{}

func watchApplication(
	ctx context.Context,
	client v1connect.PaprikaServiceClient,
	namespace, name string,
	release *paprikav1.Release,
	policyResults []*paprikav1.PolicyResult,
	timeout time.Duration,
) error {
	if !isTerminal() {
		return watchPlain(ctx, client, namespace, name, release, policyResults, timeout)
	}

	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))

	m := &watchModel{
		client:        client,
		namespace:     namespace,
		name:          name,
		release:       release,
		policyResults: policyResults,
		spinner:       s,
		start:         time.Now(),
		timeout:       timeout,
	}

	p := tea.NewProgram(m, tea.WithContext(ctx))
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("run TUI: %w", err)
	}
	return nil
}

func isTerminal() bool {
	return isatty.IsTerminal(os.Stdout.Fd()) && isatty.IsTerminal(os.Stdin.Fd())
}

func (m *watchModel) Init() tea.Cmd {
	return tea.Batch(m.spinner.Tick, m.tickCmd(), m.fetchCmd())
}

func (m *watchModel) fetchCmd() tea.Cmd {
	return func() tea.Msg {
		resp, err := m.client.GetApplication(context.Background(), connect.NewRequest(&paprikav1.GetApplicationRequest{
			Namespace: m.namespace,
			Name:      m.name,
		}))
		if err != nil {
			return appMsg{err: err}
		}
		return appMsg{app: resp.Msg.Application}
	}
}

func (m *watchModel) tickCmd() tea.Cmd {
	return tea.Tick(time.Second, func(time.Time) tea.Msg {
		return tickMsg{}
	})
}

func (m *watchModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if msg.String() == "q" || msg.String() == "ctrl+c" {
			m.done = true
			return m, tea.Quit
		}
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	case tickMsg:
		if time.Since(m.start) > m.timeout {
			m.err = errors.New("timed out waiting for terminal phase")
			m.done = true
			return m, tea.Quit
		}
		return m, tea.Batch(m.tickCmd(), m.fetchCmd())
	case appMsg:
		if msg.err != nil {
			m.err = msg.err
			m.done = true
			return m, tea.Quit
		}
		m.app = msg.app
		if isTerminalPhase(msg.app.Phase) {
			m.done = true
			return m, tea.Quit
		}
	}
	return m, nil
}

func isTerminalPhase(phase string) bool {
	switch phase {
	case "Healthy", "Degraded", "Failed", "RolledBack":
		return true
	}
	return false
}

func (m *watchModel) View() string {
	if m.err != nil {
		return fmt.Sprintf("Error: %v\n", m.err)
	}
	if m.app == nil {
		return fmt.Sprintf("%s Submitting %s/%s...\n", m.spinner.View(), m.namespace, m.name)
	}

	var b strings.Builder
	bold := lipgloss.NewStyle().Bold(true)
	fmt.Fprint(&b, bold.Render(fmt.Sprintf("%s/%s", m.namespace, m.name)))
	fmt.Fprintf(&b, "  phase=%s  health=%s  duration=%s\n\n", m.app.Phase, m.app.Health, time.Since(m.start).Round(time.Second))

	writeResources(&b, m.app.Resources, m.app.ResourceHealth)
	writePolicies(&b, m.policyResults)

	if m.done {
		fmt.Fprint(&b, finalSummary(m.app, m.policyResults, time.Since(m.start)))
	} else {
		fmt.Fprintln(&b, "Press 'q' to quit watching.")
	}
	return b.String()
}

func writeResources(b *strings.Builder, resources []*paprikav1.ResourceSync, health []*paprikav1.ResourceHealth) {
	if len(resources) == 0 {
		return
	}
	bold := lipgloss.NewStyle().Bold(true).Underline(true)
	fmt.Fprintln(b, bold.Render("Resources"))
	healthMap := make(map[string]string, len(health))
	for _, h := range health {
		key := resourceKey(h.Kind, h.Name, h.Namespace)
		healthMap[key] = h.Health
	}
	for _, r := range resources {
		h := healthMap[resourceKey(r.Kind, r.Name, r.Namespace)]
		fmt.Fprintf(b, "  %-15s %-30s %-15s %-15s %-15s\n", r.Kind, r.Name, r.Namespace, r.Status, h)
	}
	fmt.Fprintln(b)
}

func resourceKey(kind, name, namespace string) string {
	return fmt.Sprintf("%s/%s/%s", kind, namespace, name)
}

func writePolicies(b *strings.Builder, policies []*paprikav1.PolicyResult) {
	if len(policies) == 0 {
		return
	}
	bold := lipgloss.NewStyle().Bold(true).Underline(true)
	fmt.Fprintln(b, bold.Render("Policies"))
	for _, p := range policies {
		status := "PASS"
		if !p.Passed {
			status = "FAIL"
		}
		fmt.Fprintf(b, "  %-30s %s  severity=%s action=%s\n", p.Name, status, p.Severity, p.Action)
	}
	fmt.Fprintln(b)
}

func finalSummary(app *paprikav1.Application, policies []*paprikav1.PolicyResult, d time.Duration) string {
	icon := "✓"
	style := lipgloss.NewStyle().Foreground(lipgloss.Color("42"))
	if app.Phase == "Failed" || app.Phase == "Degraded" || app.Phase == "RolledBack" {
		icon = "✗"
		style = lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
	}
	passed := 0
	warns := 0
	for _, p := range policies {
		if p.Passed {
			passed++
		} else if p.Action == "warn" {
			warns++
		}
	}
	return style.Render(fmt.Sprintf("%s %s is %s\n\nResources applied: %d\nPolicies passed:   %d\nWarnings:          %d\nDuration:          %s\n",
		icon, app.Name, app.Phase, len(app.Resources), passed, warns, d.Round(time.Second)))
}

func watchPlain(
	ctx context.Context,
	client v1connect.PaprikaServiceClient,
	namespace, name string,
	release *paprikav1.Release,
	policyResults []*paprikav1.PolicyResult,
	timeout time.Duration,
) error {
	start := time.Now()
	fmt.Printf("Submitted %s/%s, release=%s\n", namespace, name, release.Name)
	printPolicyResults(policyResults)

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("context cancelled: %w", ctx.Err())
		case <-ticker.C:
			if time.Since(start) > timeout {
				return errors.New("timed out waiting for terminal phase")
			}
			resp, err := client.GetApplication(ctx, connect.NewRequest(&paprikav1.GetApplicationRequest{
				Namespace: namespace,
				Name:      name,
			}))
			if err != nil {
				return fmt.Errorf("get application: %w", err)
			}
			app := resp.Msg.Application
			fmt.Printf("[%s] %s phase=%s health=%s resources=%d\n", time.Now().Format(time.TimeOnly), app.Name, app.Phase, app.Health, len(app.Resources))
			if isTerminalPhase(app.Phase) {
				fmt.Print(finalSummary(app, policyResults, time.Since(start)))
				return nil
			}
		}
	}
}
