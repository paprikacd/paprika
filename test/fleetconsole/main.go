package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

const maxFixtureApplications = 100_000

// dataSourceMode selects which DataClasses the fixture publishes.
//
// The console has two shapes, not one, and both have to be developable and
// e2e-testable. A fully configured install renders every board; the install
// most operators actually run has no ObservabilitySource and no CostSource, so
// whole boards are absent and the ones that remain must not imply the missing
// ones are merely empty. The degraded shape is the common one, which is why it
// is the default here rather than the special case.
type dataSourceMode string

const (
	// dataSourcesRealistic mirrors production reality: everything a control
	// plane can derive from projected CRs and its own recorders is populated;
	// the three classes needing an external provider are not.
	dataSourcesRealistic dataSourceMode = "realistic"
	// dataSourcesAll publishes every class, including cost, application
	// signals and cluster usage, for exercising the fully configured console.
	dataSourcesAll dataSourceMode = "all"
	// dataSourcesNone publishes nothing. The fixture then runs the real
	// stub handlers unmodified, so this is not an imitation of the
	// unconfigured control plane; it is the unconfigured control plane.
	dataSourcesNone dataSourceMode = "none"
)

// publishes reports whether a class is served given its realistic-mode default.
func (m dataSourceMode) publishes(realistic bool) bool {
	return m == dataSourcesAll || (m == dataSourcesRealistic && realistic)
}

// publishesCost, publishesSignals and publishesUsage name the three classes
// that need a provider nobody binds by default. They are the whole difference
// between "all" and "realistic".
func (m dataSourceMode) publishesCost() bool { return m.publishes(false) }

func (m dataSourceMode) publishesSignals() bool { return m.publishes(false) }

func (m dataSourceMode) publishesUsage() bool { return m.publishes(false) }

// synthesizes reports whether the fixture should wrap the real server at all.
func (m dataSourceMode) synthesizes() bool { return m != dataSourcesNone }

func parseDataSourceMode(value string) (dataSourceMode, error) {
	switch mode := dataSourceMode(strings.TrimSpace(value)); mode {
	case dataSourcesRealistic, dataSourcesAll, dataSourcesNone:
		return mode, nil
	default:
		return "", fmt.Errorf(
			"data-sources must be one of %s, %s or %s",
			dataSourcesAll, dataSourcesNone, dataSourcesRealistic,
		)
	}
}

type config struct {
	listen       string
	assets       string
	applications int
	dataSources  dataSourceMode
}

func parseConfig(args []string) (config, error) {
	return parseConfigWithOutput(args, io.Discard)
}

func parseConfigWithOutput(args []string, output io.Writer) (config, error) {
	cfg := config{}
	flags := flag.NewFlagSet("fleet-console-fixture", flag.ContinueOnError)
	flags.SetOutput(output)
	flags.StringVar(&cfg.listen, "listen", "127.0.0.1:3100", "HTTP listen address")
	flags.StringVar(&cfg.assets, "assets", "ui/out", "compiled Next.js export directory")
	flags.IntVar(&cfg.applications, "applications", 250, "number of deterministic fleet applications")
	dataSources := flags.String(
		"data-sources", string(dataSourcesRealistic),
		"which data classes the fixture publishes: all, none, or realistic",
	)
	if err := flags.Parse(args); err != nil {
		return config{}, err
	}
	mode, err := parseDataSourceMode(*dataSources)
	if err != nil {
		return config{}, err
	}
	cfg.dataSources = mode
	if strings.TrimSpace(cfg.listen) == "" {
		return config{}, errors.New("listen address is required")
	}
	if strings.TrimSpace(cfg.assets) == "" {
		return config{}, errors.New("assets directory is required")
	}
	if cfg.applications <= 0 || cfg.applications > maxFixtureApplications {
		return config{}, fmt.Errorf("applications must be between 1 and %d", maxFixtureApplications)
	}
	return cfg, nil
}

func main() {
	cfg, err := parseConfigWithOutput(os.Args[1:], os.Stderr)
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		log.Fatalf("fleet console fixture configuration: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	log.Printf(
		"fleet console fixture listening on %s with %d applications and %s data sources",
		cfg.listen, cfg.applications, cfg.dataSources,
	)
	if err := run(ctx, cfg); err != nil {
		stop()
		log.Printf("fleet console fixture: %v", err)
		os.Exit(1)
	}
	stop()
}
