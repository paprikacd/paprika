package postgresql

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"unicode"
)

type config struct {
	Host     string `json:"host"`
	Port     int    `json:"port,omitempty"`
	Database string `json:"database"`
	SSLMode  string `json:"sslmode,omitempty"`
}

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func parseConfig(raw json.RawMessage) (config, error) {
	cfg := config{Port: 5432, SSLMode: "verify-full"}
	if len(raw) > 8192 || decodeStrict(raw, &cfg) != nil {
		return config{}, errors.New("postgresql config must contain only host, port, database and sslmode")
	}
	if !validHost(cfg.Host) || cfg.Port < 1 || cfg.Port > 65535 || !boundedText(cfg.Database, 63) {
		return config{}, errors.New("postgresql config requires a valid host, port and database")
	}
	if cfg.SSLMode != "verify-full" && (cfg.SSLMode != "disable" || !loopbackHost(cfg.Host)) {
		return config{}, errors.New("postgresql requires verify-full TLS; disable is limited to loopback test servers")
	}
	return cfg, nil
}

func parseCredentials(raw []byte) (credentials, error) {
	var result credentials
	if len(raw) > 16<<10 || decodeStrict(raw, &result) != nil || !boundedText(result.Username, 63) || !boundedText(result.Password, 8192) {
		return credentials{}, errors.New("postgresql requires a credential Secret containing username and password")
	}
	return result, nil
}

func boundedText(text string, maximum int) bool {
	return text != "" && len(text) <= maximum && !strings.ContainsRune(text, 0)
}

func loopbackHost(host string) bool {
	return strings.EqualFold(host, "localhost") || net.ParseIP(host).IsLoopback()
}

func validHost(host string) bool {
	if host == "" || len(host) > 253 || strings.ContainsAny(host, "/\\,@[] \t\r\n") {
		return false
	}
	if net.ParseIP(host) != nil {
		return true
	}
	for _, label := range strings.Split(host, ".") {
		if !validHostLabel(label) {
			return false
		}
	}
	return true
}

func validHostLabel(label string) bool {
	if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
		return false
	}
	for _, char := range label {
		if char > unicode.MaxASCII || !unicode.IsLetter(char) && !unicode.IsDigit(char) && char != '-' {
			return false
		}
	}
	return true
}

// Reject duplicate JSON keys before normal decoding could silently replace them.
func decodeStrict(raw []byte, destination any) error {
	reader := json.NewDecoder(bytes.NewReader(raw))
	reader.UseNumber()
	if err := walkJSON(reader, 0); err != nil {
		return err
	}
	if _, err := reader.Token(); !errors.Is(err, io.EOF) {
		return errors.New("invalid JSON document")
	}
	reader = json.NewDecoder(bytes.NewReader(raw))
	reader.UseNumber()
	reader.DisallowUnknownFields()
	if err := reader.Decode(destination); err != nil {
		return fmt.Errorf("decode document: %w", err)
	}
	return nil
}

func walkJSON(reader *json.Decoder, depth int) error {
	if depth > 8 {
		return errors.New("JSON nesting exceeds its limit")
	}
	token, err := reader.Token()
	if err != nil {
		return errors.New("invalid JSON document")
	}
	delimiter, collection := token.(json.Delim)
	if !collection {
		return nil
	}
	seen := make(map[string]bool)
	for reader.More() {
		if delimiter == '{' {
			if keyErr := readJSONKey(reader, seen); keyErr != nil {
				return keyErr
			}
		}
		if childErr := walkJSON(reader, depth+1); childErr != nil {
			return childErr
		}
	}
	_, err = reader.Token()
	if err != nil {
		return fmt.Errorf("finish JSON collection: %w", err)
	}
	return nil
}

func readJSONKey(reader *json.Decoder, seen map[string]bool) error {
	key, err := reader.Token()
	name, ok := key.(string)
	if err != nil || !ok || seen[name] {
		return errors.New("duplicate or invalid JSON field")
	}
	seen[name] = true
	return nil
}
