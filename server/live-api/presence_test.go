package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"
)

func TestPresence(t *testing.T) {
	get := func(query string) (int, []string) {
		response := httptest.NewRecorder()
		presenceGet(response, httptest.NewRequest(http.MethodGet, "/api/presence"+query, nil))
		var users []string
		json.Unmarshal(response.Body.Bytes(), &users)
		return response.Code, users
	}
	if code, users := get("?user=Focky"); code != 200 || !slices.Equal(users, []string{"focky"}) {
		t.Fatalf("registro: %d %v", code, users)
	}
	if code, users := get("?user=felipemayer"); code != 200 || !slices.Equal(users, []string{"felipemayer", "focky"}) {
		t.Fatalf("lista: %d %v", code, users)
	}
	if code, _ := get("?user=a%20b"); code != 400 {
		t.Fatalf("nome inválido aceito: %d", code)
	}
	presence.Lock()
	presence.seen["focky"] = time.Now().Add(-presenceTTL - time.Second)
	presence.Unlock()
	if _, users := get(""); !slices.Equal(users, []string{"felipemayer"}) {
		t.Fatalf("expirado continua: %v", users)
	}
}
