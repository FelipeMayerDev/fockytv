package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Presença do plugin FockyTV do Discord: cada plugin ativo chama a cada 30 s
// com o próprio username e recebe quem está ativo, para marcar [FTV] na call.
// Só memória; o nome não é autenticado (é só uma etiqueta visual).
const presenceTTL = 90 * time.Second

var presence = struct {
	sync.Mutex
	seen map[string]time.Time
}{seen: map[string]time.Time{}}

func presenceGet(w http.ResponseWriter, r *http.Request) {
	user := strings.ToLower(r.URL.Query().Get("user"))
	if user != "" && !keyRe.MatchString(user) {
		http.Error(w, "Usuário inválido", 400)
		return
	}
	now := time.Now()
	presence.Lock()
	if user != "" {
		presence.seen[user] = now
	}
	// ponytail: mapa limitado só pelo TTL; teto de entradas se alguém inundar nomes falsos
	users := make([]string, 0, len(presence.seen))
	for name, at := range presence.seen {
		if now.Sub(at) > presenceTTL {
			delete(presence.seen, name)
			continue
		}
		users = append(users, name)
	}
	presence.Unlock()
	sort.Strings(users)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(users)
}
