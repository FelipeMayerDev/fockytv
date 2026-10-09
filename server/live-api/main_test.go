package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCORSSessionLocation(t *testing.T) {
	handler := cors(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "/api/whip/test")
		w.WriteHeader(http.StatusCreated)
	}))
	request := httptest.NewRequest(http.MethodPost, "/api/whip", nil)
	request.Header.Set("Origin", "http://localhost:8180")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || response.Header().Get("Location") != "/api/whip/test" ||
		response.Header().Get("Access-Control-Allow-Origin") != "*" || response.Header().Get("Access-Control-Expose-Headers") != "Location" {
		t.Fatalf("sessão CORS sem Location acessível: %v", response.Result().Header)
	}
}
