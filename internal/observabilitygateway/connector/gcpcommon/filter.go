package gcpcommon

import (
	"errors"
	"strings"
)

// PrepareFilter makes a native filter safe to embed inside gateway-owned
// conjunctions. It is a lexical boundary check, not a replacement for the
// provider's parser. Parentheses and quoted strings must close within the
// caller's own expression, so they cannot escape an enclosing scope filter.
//
// Logging supports -- line comments, which are stripped before composition
// so a trailing comment cannot consume the gateway's closing parenthesis or
// timestamp constraints. Monitoring documents no comment support and rejects
// those tokens instead. Errors never contain caller filter text.
func PrepareFilter(raw string, allowLineComments bool) (string, error) {
	filter, err := stripFilterComments(raw, allowLineComments)
	if err != nil {
		return "", err
	}
	if raw != "" && strings.TrimSpace(filter) == "" {
		return "", errors.New("filter must contain an expression")
	}
	if err := validateFilterGroups(filter); err != nil {
		return "", err
	}
	return filter, nil
}

func stripFilterComments(raw string, allowed bool) (string, error) {
	var clean strings.Builder
	segment := 0
	for i := 0; i < len(raw); {
		switch raw[i] {
		case '"':
			end, err := quotedFilterEnd(raw, i+1)
			if err != nil {
				return "", err
			}
			i = end
		case '-', '#':
			end, comment, err := filterComment(raw, i, allowed)
			if err != nil {
				return "", err
			}
			if comment {
				clean.WriteString(raw[segment:i])
				segment = end
			}
			i = end
		default:
			i++
		}
	}
	clean.WriteString(raw[segment:])
	return clean.String(), nil
}

func filterComment(raw string, start int, allowed bool) (end int, comment bool, err error) {
	if raw[start] == '#' && !allowed {
		return 0, false, errors.New("comments are not supported in Monitoring filters")
	}
	if raw[start] != '-' || start+1 >= len(raw) || raw[start+1] != '-' {
		return start + 1, false, nil
	}
	if !allowed {
		return 0, false, errors.New("comments are not supported in Monitoring filters")
	}
	return filterCommentEnd(raw, start), true, nil
}

func filterCommentEnd(raw string, start int) int {
	if end := strings.IndexAny(raw[start:], "\r\n"); end >= 0 {
		return start + end
	}
	return len(raw)
}

func validateFilterGroups(filter string) error {
	depth := 0
	for i := 0; i < len(filter); i++ {
		switch filter[i] {
		case '"':
			end, err := quotedFilterEnd(filter, i+1)
			if err != nil {
				return err
			}
			i = end - 1
		case '(':
			depth++
		case ')':
			depth--
			if depth < 0 {
				return errors.New("filter parentheses must balance within the caller expression")
			}
		}
	}
	if depth != 0 {
		return errors.New("filter parentheses must balance within the caller expression")
	}
	return nil
}

func quotedFilterEnd(filter string, start int) (int, error) {
	for i := start; i < len(filter); i++ {
		switch filter[i] {
		case '\\':
			i++
		case '"':
			return i + 1, nil
		}
	}
	return 0, errors.New("filter contains an unterminated quoted string")
}
