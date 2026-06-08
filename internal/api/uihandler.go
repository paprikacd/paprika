package api

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed all:uistatic
var uiFiles embed.FS

func UIHandler() http.Handler {
	sub, err := fs.Sub(uiFiles, "uistatic")
	if err != nil {
		panic(err)
	}
	return http.FileServer(http.FS(sub))
}
