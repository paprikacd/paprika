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

type config struct {
	listen       string
	assets       string
	applications int
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
	if err := flags.Parse(args); err != nil {
		return config{}, err
	}
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
	log.Printf("fleet console fixture listening on %s with %d applications", cfg.listen, cfg.applications)
	if err := run(ctx, cfg); err != nil {
		stop()
		log.Printf("fleet console fixture: %v", err)
		os.Exit(1)
	}
	stop()
}
