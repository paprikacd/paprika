// Command validate-image-ref validates the IMG environment variable as a
// Docker image reference without evaluating it as shell input.
package main

import (
	_ "crypto/sha256"
	"fmt"
	"os"

	"github.com/distribution/reference"
)

func main() {
	image := os.Getenv("IMG")
	if image == "" {
		fmt.Fprintln(os.Stderr, "IMG must be a non-empty Docker image reference")
		os.Exit(2)
	}
	if _, err := reference.ParseNormalizedNamed(image); err != nil {
		fmt.Fprintln(os.Stderr, "IMG must be a valid Docker image reference")
		os.Exit(2)
	}
}
