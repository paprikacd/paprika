#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cat >"$tmp_dir/release_contract.go" <<'EOF'
package main

import (
	"fmt"
	"os"
	"reflect"
	"strings"

	"gopkg.in/yaml.v3"
)

type config struct {
	Version int `yaml:"version"`
	Dist string `yaml:"dist"`
	Before struct { Hooks []string `yaml:"hooks"` } `yaml:"before"`
	Builds []build `yaml:"builds"`
	Archives []archive `yaml:"archives"`
	Dockers []docker `yaml:"dockers"`
	Release struct {
		Draft            bool `yaml:"draft"`
		UseExistingDraft bool `yaml:"use_existing_draft"`
		Header           string `yaml:"header"`
	} `yaml:"release"`
}

type build struct {
	ID string `yaml:"id"`
	Main string `yaml:"main"`
	Binary string `yaml:"binary"`
	Goos []string `yaml:"goos"`
	Goarch []string `yaml:"goarch"`
	Ldflags []string `yaml:"ldflags"`
}

type archive struct {
	IDs []string `yaml:"ids"`
	Formats []string `yaml:"formats"`
	NameTemplate string `yaml:"name_template"`
	Files []string `yaml:"files"`
}

type docker struct {
	IDs []string `yaml:"ids"`
	Goos string `yaml:"goos"`
	Goarch string `yaml:"goarch"`
	Dockerfile string `yaml:"dockerfile"`
	ImageTemplates []string `yaml:"image_templates"`
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "release contract: "+format+"\n", args...)
	os.Exit(1)
}

func findBuild(builds []build, id string) build {
	for _, candidate := range builds {
		if candidate.ID == id { return candidate }
	}
	fail("missing build %q", id)
	return build{}
}

func main() {
	raw, err := os.ReadFile(".goreleaser.yaml")
	if err != nil { fail("read config: %v", err) }
	var cfg config
	if err := yaml.Unmarshal(raw, &cfg); err != nil { fail("parse config: %v", err) }

	if cfg.Version != 2 { fail("version = %d, want 2", cfg.Version) }
	if cfg.Dist != ".goreleaser-dist" { fail("dist = %q, want .goreleaser-dist", cfg.Dist) }
	if len(cfg.Before.Hooks) != 0 { fail("before hooks write outside the isolated release dist: %v", cfg.Before.Hooks) }
	for _, hook := range cfg.Before.Hooks {
		if strings.Contains(hook, "go mod tidy") { fail("before hook mutates go.mod: %q", hook) }
	}

	if len(cfg.Builds) != 2 { fail("builds count = %d, want cli and server", len(cfg.Builds)) }
	cli := findBuild(cfg.Builds, "cli")
	if cli.Main != "./cmd/paprika" || cli.Binary != "paprika" {
		fail("cli build main/binary = %q/%q", cli.Main, cli.Binary)
	}
	if !reflect.DeepEqual(cli.Goos, []string{"darwin", "linux"}) {
		fail("cli goos = %v, want [darwin linux]", cli.Goos)
	}
	if !reflect.DeepEqual(cli.Goarch, []string{"amd64", "arm64"}) {
		fail("cli goarch = %v, want [amd64 arm64]", cli.Goarch)
	}
	for _, target := range []string{"main.version", "main.commit", "main.date"} {
		found := false
		for _, flag := range cli.Ldflags { found = found || strings.Contains(flag, "-X "+target+"=") }
		if !found { fail("cli ldflags missing %s", target) }
	}

	server := findBuild(cfg.Builds, "server")
	if server.Main != "./cmd" || server.Binary != "paprika-server" {
		fail("server build main/binary = %q/%q", server.Main, server.Binary)
	}
	if !reflect.DeepEqual(server.Goos, []string{"linux"}) || !reflect.DeepEqual(server.Goarch, []string{"amd64"}) {
		fail("server targets = %v/%v, want linux/amd64", server.Goos, server.Goarch)
	}

	if len(cfg.Archives) != 1 { fail("archives count = %d, want 1", len(cfg.Archives)) }
	a := cfg.Archives[0]
	if !reflect.DeepEqual(a.IDs, []string{"cli"}) { fail("archive ids = %v, want [cli]", a.IDs) }
	if !reflect.DeepEqual(a.Formats, []string{"tar.gz"}) { fail("archive formats = %v, want [tar.gz]", a.Formats) }
	if a.NameTemplate != "paprika_{{ .Version }}_{{ .Os }}_{{ .Arch }}" { fail("unexpected archive name template %q", a.NameTemplate) }
	if !reflect.DeepEqual(a.Files, []string{"none*"}) {
		fail("archive files = %v, want [none*] to disable GoReleaser default README/LICENSE files", a.Files)
	}

	if len(cfg.Dockers) != 1 { fail("dockers count = %d, want 1", len(cfg.Dockers)) }
	d := cfg.Dockers[0]
	if !reflect.DeepEqual(d.IDs, []string{"server"}) || d.Goos != "linux" || d.Goarch != "amd64" {
		fail("docker artifact selection = ids %v %s/%s, want server linux/amd64", d.IDs, d.Goos, d.Goarch)
	}
	if d.Dockerfile != "Dockerfile.goreleaser" { fail("dockerfile = %q", d.Dockerfile) }
	if !reflect.DeepEqual(d.ImageTemplates, []string{"ghcr.io/paprikacd/paprika:{{ .Version }}"}) {
		fail("image templates = %v, must contain only the version tag", d.ImageTemplates)
	}
	if !cfg.Release.Draft { fail("release.draft must be true") }
	if !cfg.Release.UseExistingDraft { fail("release.use_existing_draft must be true for safe reruns") }
	if strings.Contains(cfg.Release.Header, "install.yaml") { fail("release header must not link an asset GoReleaser does not upload") }
	if !strings.Contains(cfg.Release.Header, "https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh") { fail("release header must document the canonical CLI installer") }
	if !strings.Contains(cfg.Release.Header, "releases/download/{{ .Tag }}/checksums.txt") { fail("release header must link the canonical checksums asset using .Tag") }
	if !strings.Contains(cfg.Release.Header, "helm install paprika oci://ghcr.io/paprikacd/charts/paprika") { fail("release header must document the canonical OCI Helm install") }
	if !strings.Contains(cfg.Release.Header, "--version {{ .Version }}") { fail("release header must pin the Helm chart version") }
	if strings.Contains(cfg.Release.Header, "helm repo add") { fail("release header must not advertise a classic Helm repository") }
	if !strings.Contains(cfg.Release.Header, "{{ .ReleaseNotes }}") { fail("release header must render GoReleaser's supported .ReleaseNotes field") }
	if strings.Contains(cfg.Release.Header, "{{ .Changelog }}") { fail("release header must not use the unsupported .Changelog field") }

	dockerfile, err := os.ReadFile("Dockerfile.goreleaser")
	if err != nil { fail("read Dockerfile.goreleaser: %v", err) }
	if !strings.Contains(string(dockerfile), "COPY paprika-server /paprika") {
		fail("Dockerfile.goreleaser must copy paprika-server to /paprika")
	}
	for _, base := range []string{
		"alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b",
		"gcr.io/distroless/static:nonroot@sha256:f7f8f729987ad0fdf6b05eeeae94b26e6a0f613bdf46feea7fc40f7bd72953e6",
	} {
		if !strings.Contains(string(dockerfile), "FROM "+base) { fail("Dockerfile.goreleaser base %q must retain its verified digest", base) }
	}
	for architecture, checksum := range map[string]string{
		"amd64": "e57e826410269d72be3113333dbfaac0d8dfdd1b0cc4e9cb08bdf97722731ca9",
		"arm64": "780b5b86f0db5546769b3e9f0204713bbdd2f6696dfdaac122fbe7f2f31541d2",
	} {
		if !strings.Contains(string(dockerfile), "HELM_SHA256_"+architecture+"="+checksum) { fail("Dockerfile.goreleaser missing verified Helm checksum for %s", architecture) }
	}
	if !strings.Contains(string(dockerfile), "sha256sum -c -") { fail("Dockerfile.goreleaser must verify Helm before extraction") }
	if strings.Index(string(dockerfile), "sha256sum -c -") > strings.Index(string(dockerfile), "tar -xzf") {
		fail("Dockerfile.goreleaser must verify Helm before extracting it")
	}
}
EOF

go run "$tmp_dir/release_contract.go"

if ! git check-ignore -q .goreleaser-dist/probe; then
	echo "release contract: .goreleaser-dist/ is not ignored" >&2
	exit 1
fi

if [[ ! -f dist/install.yaml ]]; then
	echo "release contract: tracked dist/install.yaml is missing" >&2
	exit 1
fi

if git check-ignore --no-index -q dist/install.yaml; then
	echo "release contract: tracked distribution manifests must not be ignored" >&2
	exit 1
fi

if command -v goreleaser >/dev/null 2>&1; then
	goreleaser check
fi

echo "CLI release contract passed"
