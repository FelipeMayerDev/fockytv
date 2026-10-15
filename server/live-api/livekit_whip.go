package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var livekitIngressURL = env("LIVEKIT_INGRESS_URL", "")

type ingressInfo struct {
	ID        string `json:"ingress_id"`
	URL       string `json:"url"`
	StreamKey string `json:"stream_key"`
}

// O cliente GStreamer envia H264/Opus pronto; ingress encaminha sem transcode.
func (a *app) livekitWhip(w http.ResponseWriter, r *http.Request) {
	key := bearer(r)
	if !keyRe.MatchString(key) {
		http.Error(w, "stream key inválida", 400)
		return
	}
	if livekitIngressURL == "" {
		http.Error(w, "Ingress indisponível", 503)
		return
	}
	streams, err := a.livekitStreams(r.Context())
	if err != nil {
		http.Error(w, "LiveKit indisponível", 503)
		return
	}
	for _, st := range streams {
		if st.StreamKey == key {
			http.Error(w, "session already has a host (active)", 400)
			return
		}
	}
	a.mu.Lock()
	path := a.paths[key]
	busy := path != nil && path.Ready
	a.mu.Unlock()
	if busy {
		http.Error(w, "session already has a host (active)", 400)
		return
	}
	var list struct {
		Items []ingressInfo `json:"items"`
	}
	if err := a.livekitRPC(r.Context(), "ListIngress", map[string]string{"room_name": key}, &list); err != nil {
		http.Error(w, "Ingress indisponível", 503)
		return
	}
	var ingress ingressInfo
	if len(list.Items) > 0 {
		ingress = list.Items[0]
	} else {
		err := a.livekitRPC(r.Context(), "CreateIngress", map[string]any{
			"input_type": "WHIP_INPUT", "name": key, "room_name": key, "participant_identity": "publisher", "participant_name": key, "enable_transcoding": false,
		}, &ingress)
		if err != nil {
			http.Error(w, "Não foi possível criar ingress", 502)
			return
		}
	}
	endpoint, err := url.Parse(ingress.URL)
	if err != nil || ingress.StreamKey == "" {
		http.Error(w, "Endpoint ingress inválido", 502)
		return
	}
	// Nunca expor a chave de ingress; a UI recebe só o id local da sessão.
	target := strings.TrimRight(livekitIngressURL, "/") + strings.TrimRight(endpoint.Path, "/") + "/" + url.PathEscape(ingress.StreamKey)
	req, err := http.NewRequestWithContext(r.Context(), "POST", target, http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		http.Error(w, "Endpoint inválido", 502)
		return
	}
	req.Header.Set("Content-Type", "application/sdp")
	res, err := a.http.Do(req)
	if err != nil {
		http.Error(w, "Ingress indisponível", 502)
		return
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		http.Error(w, "Resposta ingress inválida", 502)
		return
	}
	if res.StatusCode != 201 {
		w.WriteHeader(res.StatusCode)
		w.Write(body)
		return
	}
	location, err := url.Parse(res.Header.Get("Location"))
	if err != nil || res.Header.Get("Location") == "" {
		http.Error(w, "Ingress sem recurso", 502)
		return
	}
	base, _ := url.Parse(target)
	location = base.ResolveReference(location)
	// O recurso sempre fica no backend configurado, inclusive Location absoluto.
	backend, _ := url.Parse(livekitIngressURL)
	location.Scheme = backend.Scheme
	location.Host = backend.Host
	id := newUUID()
	a.mu.Lock()
	for _, previous := range a.sessions {
		if previous.kind == "livekit-whip" && previous.path == key {
			a.drop(previous)
		}
	}
	a.sessions[id] = &session{kind: "livekit-whip", path: key, nick: key, location: location.String(), id: id, createdAt: time.Now()}
	a.mu.Unlock()
	w.Header().Set("Location", "/api/livekit/whip/"+id)
	w.Header().Set("Content-Type", "application/sdp")
	w.WriteHeader(201)
	w.Write(body)
}

// Resolução (0 = fonte) e FPS escolhidos por quem transmite; o plugin mostra no selo da live.
type streamQuality struct {
	Resolution int `json:"resolution"`
	FPS        int `json:"fps"`
}

func (q streamQuality) valid() bool {
	return q.Resolution >= 0 && q.Resolution <= 4320 && q.FPS > 0 && q.FPS <= 240
}

// Só o dono da sessão WHIP (id secreto + bearer da live) anuncia a qualidade, guardada no metadata do publisher.
func (a *app) livekitQuality(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	s := a.sessions[r.PathValue("id")]
	a.mu.Unlock()
	if s == nil || s.kind != "livekit-whip" {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	if bearer(r) != s.nick {
		http.Error(w, "Authorization was not set", http.StatusBadRequest)
		return
	}
	var quality streamQuality
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&quality); err != nil || !quality.valid() {
		http.Error(w, "Qualidade inválida", 400)
		return
	}
	metadata, _ := json.Marshal(quality)
	var out struct{}
	if err := a.livekitRPC(r.Context(), "UpdateParticipant", map[string]string{"room": s.path, "identity": "publisher", "metadata": string(metadata)}, &out); err != nil {
		http.Error(w, "LiveKit indisponível", 502)
		return
	}
	w.WriteHeader(204)
}
