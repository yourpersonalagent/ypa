package internalapi

import (
	"encoding/json"
	"net/http"
)

// OpenAI-shaped error envelopes. Mirrors the JS side at
// bridge/chat/openai-internal.ts:52-100, 137-145.
//
// Codes/types map:
//
//	401 — invalid_request_error / invalid_api_key
//	400 — invalid_request_error
//	404 — invalid_request_error
//	500 — server_error
//	502 — server_error (upstream passthrough preserves the upstream body)

type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    string `json:"code,omitempty"`
}

// writeError writes a JSON error envelope with the OpenAI shape and
// the given status code. status is the HTTP status sent.
func writeError(w http.ResponseWriter, status int, message, errType, code string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorEnvelope{
		Error: errorBody{
			Message: message,
			Type:    errType,
			Code:    code,
		},
	})
}

// writeUpstreamError forwards an upstream status + body as-is when
// possible, but always wraps unrecognised content in the OpenAI
// envelope so the client always gets a parseable JSON shape. Mirrors
// the JS side's "passthrough upstream JSON or plaintext" behaviour.
func writeUpstreamError(w http.ResponseWriter, status int, contentType string, body []byte) {
	w.Header().Set("Content-Type", contentType)
	if status <= 0 {
		status = http.StatusBadGateway
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
