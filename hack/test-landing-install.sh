#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
landing="${repo_root}/landing/index.html"
cli_docs="${repo_root}/docs/cli.md"
getting_started="${repo_root}/docs/getting-started.md"

python3 - "${landing}" <<'PY'
import re
import sys
from html.parser import HTMLParser

landing_path = sys.argv[1]
html = open(landing_path, encoding="utf-8").read()

class Node:
    def __init__(self, tag="root", attrs=None, parent=None):
        self.tag = tag
        self.attrs = dict(attrs or [])
        self.parent = parent
        self.children = []
        self.data = []

    @property
    def classes(self):
        return set(self.attrs.get("class", "").split())

    def text(self):
        parts = list(self.data)
        for child in self.children:
            if child.tag not in {"script", "style", "template", "noscript"}:
                parts.append(child.text())
        return " ".join(" ".join(parts).split())

    def descendants(self):
        for child in self.children:
            yield child
            yield from child.descendants()

class Parser(HTMLParser):
    void = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in self.void:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.void:
            self.stack.pop()

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data):
        self.stack[-1].data.append(data)

def fail(message):
    raise SystemExit(f"landing install contract: {message}")

def visible(node):
    while node:
        style = node.attrs.get("style", "").replace(" ", "").lower()
        if "hidden" in node.attrs or node.attrs.get("aria-hidden") == "true" or "display:none" in style or "visibility:hidden" in style:
            return False
        node = node.parent
    return True

parser = Parser()
parser.feed(html)
nodes = list(parser.root.descendants())

ids = {}
for node in nodes:
    node_id = node.attrs.get("id")
    if node_id:
        if node_id in ids:
            fail(f"duplicate id {node_id!r}")
        ids[node_id] = node

install = "curl -fsSL https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh | sh"
login = "paprika login --server https://paprika.benebsworth.com"
status = "paprika status"
pin = "curl -fsSL https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh | PAPRIKA_VERSION=vX.Y.Z sh"
install_dir = 'curl -fsSL https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh | PAPRIKA_INSTALL_DIR="$HOME/.local/bin" sh'
expected_targets = {
    "hero-install-command": install,
    "hero-login-command": login,
    "hero-status-command": status,
    "install-latest-command": install,
    "install-version-command": pin,
    "install-dir-command": install_dir,
}

for target, command in expected_targets.items():
    if target not in ids or not visible(ids[target]) or ids[target].text() != command:
        fail(f"copy target {target!r} must contain the exact visible command")

buttons = [node for node in nodes if node.tag == "button" and "data-copy-target" in node.attrs]
if len(buttons) != len(expected_targets):
    fail("expected exactly one copy button for every command target")
button_targets = set()
for button in buttons:
    target = button.attrs["data-copy-target"]
    if button.attrs.get("type") != "button" or not button.attrs.get("aria-label", "").strip():
        fail(f"copy control for {target!r} must be a labeled type=button")
    if target not in expected_targets or target in button_targets:
        fail(f"copy target {target!r} must be expected and unique")
    button_targets.add(target)
    describedby = button.attrs.get("aria-describedby")
    expected_group = "hero" if target.startswith("hero-") else "install"
    if describedby != f"{expected_group}-copy-guidance" or button.attrs.get("data-copy-feedback") != f"{expected_group}-copy-feedback":
        fail(f"copy control for {target!r} must reference visible fallback guidance")

for region_id in ("hero-copy-feedback", "install-copy-feedback"):
    region = ids.get(region_id)
    if not region or not visible(region) or region.attrs.get("role") != "status" or region.attrs.get("aria-live") != "polite":
        fail(f"{region_id} must be a polite visible status region")
    if "sr-only" in region.classes:
        fail(f"{region_id} must be visually available")

for guidance_id in ("hero-copy-guidance", "install-copy-guidance"):
    guidance = ids.get(guidance_id)
    if not guidance or not visible(guidance) or "select" not in guidance.text().lower() or "copy" not in guidance.text().lower():
        fail(f"{guidance_id} must give visible manual-copy recovery guidance")

def has_anchor(container, href, text):
    return any(node.tag == "a" and visible(node) and node.attrs.get("href") == href and node.text() == text for node in container.descendants())

nav = next((node for node in nodes if node.tag == "header" and "nav" in node.classes), None)
hero = next((node for node in nodes if node.tag == "section" and "hero" in node.classes), None)
if not nav or not has_anchor(nav, "#install", "Install CLI"):
    fail("nav must contain an exact visible Install CLI link to #install")
if not hero or not has_anchor(hero, "#install", "Install CLI"):
    fail("hero must contain an exact visible Install CLI link to #install")

skip = next((node for node in nodes if node.tag == "a" and "skip-link" in node.classes), None)
main = ids.get("main-content")
anchors = [node for node in nodes if node.tag == "a"]
if not skip or not anchors or anchors[0] is not skip or skip.attrs.get("href") != "#main-content" or "skip" not in skip.text().lower():
    fail("page must begin with a keyboard-visible skip link to #main-content")
if not main or main.tag != "main" or main.attrs.get("tabindex") != "-1":
    fail("main content must be a programmatically focusable skip target")

latest_checksum = "https://github.com/paprikacd/paprika/releases/latest/download/checksums.txt"
pinned_checksum = "https://github.com/paprikacd/paprika/releases/download/vX.Y.Z/checksums.txt"
links = [node.attrs.get("href") for node in nodes if node.tag == "a"]
if latest_checksum not in links:
    fail("missing real latest-release checksum audit link")
if pinned_checksum in links:
    fail("pinned checksum URL pattern must be text, not a broken placeholder link")
if pinned_checksum not in parser.root.text():
    fail("missing visible pinned checksum URL pattern")

install_section = ids.get("install")
visible_install = install_section.text() if install_section else ""
for phrase in ("Darwin", "Linux", "amd64", "arm64", "PAPRIKA_VERSION", "PAPRIKA_INSTALL_DIR", "checksum", "sudo", "PATH", "Homebrew", "Build from source"):
    if phrase.lower() not in visible_install.lower():
        fail(f"install section missing visible {phrase!r} guidance")
if "never invokes" not in visible_install.lower() or "sudo" not in visible_install.lower() or "not yet supported" not in visible_install.lower():
    fail("install section must explicitly state the no-sudo and unsupported-Homebrew boundaries")
if "git clone https://github.com/paprikacd/paprika.git" not in visible_install:
    fail("install section must show the canonical source clone URL")

script = "\n".join("".join(node.data) for node in nodes if node.tag == "script")
script = re.sub(r"/\*.*?\*/|//[^\n]*", "", script, flags=re.S)
for invariant in ("navigator.clipboard", "document.execCommand", "previousFocus", "isConnected", "focus({ preventScroll: true })", "WeakMap", "feedbackStates", "clearTimeout", "requestAnimationFrame"):
    if invariant not in script:
        fail(f"copy behavior missing {invariant!r}")
if "initiatingButton" in script:
    fail("async copy handlers must not reclaim focus after the user moves on")
if not re.search(r"previousFeedback\.owner\.textContent\s*=\s*previousFeedback\.defaultLabel", script):
    fail("superseding feedback must synchronously restore the previous button label")
if "innerHTML" in script:
    fail("copy behavior must not use an innerHTML sink")
if not re.search(r"@media\s*\(prefers-reduced-motion:\s*reduce\)", html) or ":focus-visible" not in html or ".skip-link:focus-visible" not in html:
    fail("missing reduced-motion or focus-visible CSS")
if re.search(r"v0\.1\.0[^<\n]*first release", html, re.I):
    fail("landing must not claim an unreleased v0.1.0 release")

print("landing DOM contract: PASS")
PY

install_command='curl -fsSL https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh | sh'
login_command='paprika login --server https://paprika.benebsworth.com'
status_command='paprika status'
latest_checksum='https://github.com/paprikacd/paprika/releases/latest/download/checksums.txt'
pinned_checksum='https://github.com/paprikacd/paprika/releases/download/vX.Y.Z/checksums.txt'

fail() {
  printf 'landing install contract: %s\n' "$1" >&2
  exit 1
}

for file in "${cli_docs}" "${getting_started}"; do
  grep -Fq -- "${install_command}" "${file}" || fail "missing canonical installer command in ${file#"${repo_root}/"}"
  grep -Fq -- "${login_command}" "${file}" || fail "missing canonical login command in ${file#"${repo_root}/"}"
  grep -Fq -- "${status_command}" "${file}" || fail "missing status command in ${file#"${repo_root}/"}"
  grep -Fq -- "${latest_checksum}" "${file}" || fail "missing real checksum audit link in ${file#"${repo_root}/"}"
  grep -Fq -- "${pinned_checksum}" "${file}" || fail "missing pinned checksum URL pattern in ${file#"${repo_root}/"}"
  grep -Fq -- 'PAPRIKA_VERSION' "${file}" || fail "missing version pin guidance in ${file#"${repo_root}/"}"
  grep -Fq -- 'PAPRIKA_INSTALL_DIR' "${file}" || fail "missing install directory guidance in ${file#"${repo_root}/"}"
  grep -Fq -- 'Homebrew is not yet supported' "${file}" || fail "missing Homebrew status in ${file#"${repo_root}/"}"
done

grep -Fq -- 'git clone https://github.com/paprikacd/paprika.git' "${getting_started}" || fail 'getting-started source URL is not canonical'
if grep -Fq -- 'git clone https://github.com/benebsworth/paprika.git' "${getting_started}"; then
  fail 'getting-started retains the noncanonical source URL'
fi

printf 'landing install contract: PASS\n'
