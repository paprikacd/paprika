package governance

import (
	"fmt"
	"strings"
)

func StringEqual(a, b string) bool {
	return a == b
}

func CheckList(items []string, value string, match func(string, string) bool, format string, args ...any) error {
	if len(items) == 0 {
		return nil
	}
	for _, item := range items {
		if match(item, value) {
			return nil
		}
	}
	return fmt.Errorf(format, args...)
}

func CheckDenyList(items []string, value string, match func(string, string) bool, format string, args ...any) error {
	for _, item := range items {
		if match(item, value) {
			return fmt.Errorf(format, args...)
		}
	}
	return nil
}

func GlobMatch(pattern, s string) bool {
	if pattern == "" {
		return s == ""
	}
	if pattern == "*" {
		return true
	}
	parts := strings.Split(pattern, "*")
	if len(parts) == 1 {
		return pattern == s
	}
	if !strings.HasPrefix(s, parts[0]) {
		return false
	}
	s = s[len(parts[0]):]
	for i, part := range parts[1:] {
		idx := strings.Index(s, part)
		if idx == -1 {
			return false
		}
		// The final non-empty part must match the suffix exactly.
		if i == len(parts)-2 && part != "" && len(s) > idx+len(part) {
			return false
		}
		s = s[idx+len(part):]
	}
	return true
}
