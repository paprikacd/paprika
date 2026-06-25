package pipelines

import (
	"regexp"
	"strings"
)

var invalidNameChars = regexp.MustCompile(`[^a-z0-9]+`)

func sanitizeSegment(s string) string {
	s = strings.ToLower(s)
	s = invalidNameChars.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if s == "" {
		return "x"
	}
	return s
}

func sanitizeArtifactName(pipeline, step, output string) string {
	pipeline = sanitizeSegment(pipeline)
	step = sanitizeSegment(step)
	output = sanitizeSegment(output)

	var parts []string
	if step != "" && step != "x" {
		parts = []string{pipeline, step, output}
	} else {
		parts = []string{pipeline, output}
	}

	name := strings.Join(parts, "-")
	if len(name) <= 63 {
		return name
	}

	for len(name) > 63 {
		longest := 0
		for i, p := range parts {
			if len(p) > len(parts[longest]) {
				longest = i
			}
		}
		parts[longest] = parts[longest][:len(parts[longest])-1]
		parts[longest] = strings.Trim(parts[longest], "-")
		if parts[longest] == "" {
			parts[longest] = "x"
		}
		name = strings.Join(parts, "-")
	}

	name = strings.Trim(name, "-")
	if name == "" {
		return "artifact"
	}
	return name
}
