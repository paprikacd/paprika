package postgresql

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"unicode"

	"github.com/benebsworth/paprika/internal/dataframe"
)

type queryDocument struct {
	SQL        string                `json:"sql"`
	Parameters []any                 `json:"parameters,omitempty"`
	Projection *dataframe.Projection `json:"projection,omitempty"`
}

// A range reference is resolved to a driver parameter, never inserted into SQL.
type rangeParameter string

func parseQuery(source string) (queryDocument, error) {
	if len(source) > 64<<10 {
		return queryDocument{}, errors.New("SQL query exceeds its size limit")
	}
	query := queryDocument{SQL: source}
	if strings.HasPrefix(strings.TrimSpace(source), "{") && decodeStrict([]byte(source), &query) != nil {
		return queryDocument{}, errors.New("SQL envelope accepts only sql, parameters and projection")
	}
	if strings.TrimSpace(source) == "" {
		query.SQL = "SELECT 1 AS value"
	}
	if len(query.SQL) > 32<<10 || len(query.Parameters) > 64 || strings.ContainsRune(query.SQL, 0) {
		return queryDocument{}, errors.New("SQL text or parameter count exceeds its limit")
	}
	if err := validateParameters(query.Parameters); err != nil {
		return queryDocument{}, err
	}
	statement, err := readStatement(query.SQL, len(query.Parameters))
	if err != nil {
		return queryDocument{}, err
	}
	query.SQL = statement
	return query, nil
}

func validateParameters(parameters []any) error {
	for index, parameter := range parameters {
		switch value := parameter.(type) {
		case nil, bool:
		case string:
			if len(value) > dataframe.MaxCellBytes || strings.ContainsRune(value, 0) {
				return errors.New("SQL parameter exceeds its text limit")
			}
		case json.Number:
			// Let PostgreSQL's declared/inferred parameter type parse the exact
			// decimal text rather than rounding it through a float64.
			parameters[index] = value.String()
		case map[string]any:
			reference, ok := value["range"].(string)
			if len(value) != 1 || !ok || (reference != "start" && reference != "end") {
				return errors.New("SQL range parameters must be exactly {\"range\":\"start\"} or {\"range\":\"end\"}")
			}
			parameters[index] = rangeParameter(reference)
		default:
			return errors.New("SQL parameters must be scalar values, null or a range reference")
		}
	}
	return nil
}

// This lexer bounds the supported shape; PostgreSQL's READ ONLY transaction and
// database grants remain the security boundary, including inside SQL functions.
//
//nolint:gocognit,gocyclo,cyclop // Keep the bounded lexical state transitions together; prepared statements independently reject multiple commands.
func readStatement(source string, parameterCount int) (string, error) {
	const reason = "SQL must be one SELECT or read-only WITH statement without writes, locks or session commands"
	tokens := make([]string, 0)
	semicolon := -1
	parameters := make(map[int]bool)
	for index := 0; index < len(source); {
		char := source[index]
		if unicode.IsSpace(rune(char)) {
			index++
			continue
		}
		if strings.HasPrefix(source[index:], "--") {
			index += 2
			for index < len(source) && source[index] != '\n' && source[index] != '\r' {
				index++
			}
			continue
		}
		if strings.HasPrefix(source[index:], "/*") {
			next, err := skipComment(source, index)
			if err != nil {
				return "", errors.New(reason)
			}
			index = next
			continue
		}
		if semicolon >= 0 {
			return "", errors.New(reason)
		}
		if char == ';' {
			semicolon = index
			index++
			continue
		}
		if char == '\'' || char == '"' {
			next, content, err := skipQuoted(source, index, char)
			if err != nil {
				return "", errors.New(reason)
			}
			if char == '"' {
				tokens = append(tokens, strings.ToLower(content))
			}
			index = next
			continue
		}
		if char == '$' {
			if next, ok, err := skipDollarString(source, index); ok {
				if err != nil {
					return "", errors.New(reason)
				}
				index = next
				continue
			}
			next, position, err := readParameter(source, index, parameterCount)
			if err != nil {
				return "", err
			}
			parameters[position] = true
			index = next
			continue
		}
		if asciiWord(char) && (char < '0' || char > '9') {
			start := index
			for index < len(source) && asciiWord(source[index]) {
				index++
			}
			tokens = append(tokens, strings.ToLower(source[start:index]))
			continue
		}
		if char == 0 || char == '\\' {
			return "", errors.New(reason)
		}
		index++
	}
	if err := validateTokens(tokens, len(parameters), parameterCount); err != nil {
		return "", err
	}
	if semicolon >= 0 {
		source = source[:semicolon]
	}
	return strings.TrimSpace(source), nil
}

func readParameter(source string, index, count int) (next, position int, err error) {
	next = index + 1
	for next < len(source) && source[next] >= '0' && source[next] <= '9' {
		next++
	}
	position, err = strconv.Atoi(source[index+1 : next])
	if err != nil || position < 1 || position > count {
		return 0, 0, errors.New("SQL placeholders must match the envelope parameters")
	}
	return next, position, nil
}

func validateTokens(tokens []string, used, parameterCount int) error {
	if len(tokens) == 0 || (tokens[0] != "select" && tokens[0] != "with") {
		return errors.New("SQL must be one SELECT or read-only WITH statement")
	}
	if used != parameterCount {
		return errors.New("SQL placeholders must match the envelope parameters")
	}
	for _, token := range tokens {
		if forbiddenToken(token) {
			return errors.New("SQL writes, locks and session commands are not supported")
		}
	}
	return nil
}

func forbiddenToken(token string) bool {
	switch token {
	case "insert", "update", "delete", "merge", "into", "create", "alter", "drop", "truncate", "grant", "revoke", "copy", "call", "do", "execute", "prepare", "deallocate", "set", "reset", "discard", "begin", "commit", "rollback", "savepoint", "release", "lock", "share", "listen", "unlisten", "notify", "vacuum", "analyze", "refresh", "reindex", "cluster", "set_config", "nextval", "setval", "pg_notify", "pg_cancel_backend", "pg_terminate_backend", "pg_reload_conf", "pg_rotate_logfile", "pg_promote":
		return true
	}
	return strings.HasPrefix(token, "dblink") || strings.HasPrefix(token, "lo_") || strings.HasPrefix(token, "pg_advisory_") || strings.HasPrefix(token, "pg_try_advisory_") || strings.HasPrefix(token, "pg_read_file") || strings.HasPrefix(token, "pg_read_binary_file") || strings.HasPrefix(token, "pg_ls_") || strings.HasPrefix(token, "pg_log_")
}

func asciiWord(char byte) bool {
	return char == '_' || char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9'
}

func skipComment(source string, index int) (int, error) {
	depth := 1
	for index += 2; index < len(source); {
		switch {
		case strings.HasPrefix(source[index:], "/*"):
			depth++
			index += 2
		case strings.HasPrefix(source[index:], "*/"):
			depth--
			index += 2
			if depth == 0 {
				return index, nil
			}
		default:
			index++
		}
	}
	return 0, errors.New("unterminated comment")
}

func skipQuoted(source string, index int, quote byte) (next int, content string, err error) {
	start := index + 1
	for index++; index < len(source); index++ {
		if source[index] == '\\' {
			// Escape strings and Unicode identifiers add unnecessary alternate
			// token spellings. Use bound parameters for strings containing slashes.
			return 0, "", errors.New("SQL escape literals are unsupported; use parameters")
		}
		if source[index] == quote {
			if index+1 < len(source) && source[index+1] == quote {
				index++
				continue
			}
			return index + 1, source[start:index], nil
		}
	}
	return 0, "", errors.New("unterminated quoted value")
}

func skipDollarString(source string, index int) (next int, matched bool, err error) {
	end := index + 1
	for end < len(source) && asciiWord(source[end]) && (end != index+1 || source[end] < '0' || source[end] > '9') {
		end++
	}
	if end >= len(source) || source[end] != '$' {
		return index, false, nil
	}
	tag := source[index : end+1]
	closing := strings.Index(source[end+1:], tag)
	if closing < 0 {
		return 0, true, errors.New("unterminated dollar string")
	}
	return end + 1 + closing + len(tag), true, nil
}
