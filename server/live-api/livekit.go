package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

var livekitURL = env("LIVEKIT_URL", "")
var livekitKey = env("LIVEKIT_API_KEY", "")
var livekitSecret = env("LIVEKIT_API_SECRET", "")

func livekitToken(identity string, grant map[string]any, name ...string) string {
	encode := func(v any) string { b, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(b) }
	now := time.Now().Unix()
	claims := map[string]any{
		"iss": livekitKey, "sub": identity, "nbf": now - 5, "exp": now + 7200, "video": grant,
	}
	if len(name) > 0 {
		claims["name"] = name[0]
	}
	data := encode(map[string]string{"alg": "HS256", "typ": "JWT"}) + "." + encode(claims)
	mac := hmac.New(sha256.New, []byte(livekitSecret))
	mac.Write([]byte(data))
	return data + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *app) livekitRPC(ctx context.Context, method string, input, output any) error {
	b, err := json.Marshal(input)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", livekitURL+"/twirp/"+serviceMethod(method), bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+livekitToken("live-api", map[string]any{"roomList": true, "roomAdmin": true, "ingressAdmin": true, "room": roomFrom(input)}))
	res, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("%s: HTTP %d", method, res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(output)
}

func roomFrom(input any) string {
	if m, ok := input.(map[string]string); ok {
		return m["room"]
	}
	return ""
}

type lkParticipant struct {
	Identity string `json:"identity"`
	Name     string `json:"name"`
	JoinedAt string `json:"joined_at"`
	Tracks   []struct {
		Type string `json:"type"`
	} `json:"tracks"`
}

func (a *app) livekitStreams(ctx context.Context) ([]streamState, error) {
	if livekitURL == "" {
		return nil, nil
	}
	var rooms struct {
		Rooms []struct {
			Name string `json:"name"`
		} `json:"rooms"`
	}
	if err := a.livekitRPC(ctx, "ListRooms", map[string]string{}, &rooms); err != nil {
		return nil, err
	}
	out := []streamState{}
	for _, room := range rooms.Rooms {
		if !keyRe.MatchString(room.Name) {
			continue
		}
		var people struct {
			Participants []lkParticipant `json:"participants"`
		}
		if err := a.livekitRPC(ctx, "ListParticipants", map[string]string{"room": room.Name}, &people); err != nil {
			return nil, err
		}
		st := streamState{Engine: "livekit", StreamKey: room.Name, IsPublic: true, AudioTracks: []trackState{}, VideoTracks: []trackState{}, Sessions: []sessState{}}
		for _, p := range people.Participants {
			if p.Identity != "publisher" {
				st.Sessions = append(st.Sessions, sessState{ID: p.Identity, Viewer: p.Name})
				continue
			}
			seconds, _ := strconv.ParseInt(p.JoinedAt, 10, 64)
			st.StreamStart = time.Unix(seconds, 0).UTC().Format(time.RFC3339Nano)
			for _, t := range p.Tracks {
				entry := trackState{"rid": "", "packetsReceived": 0, "packetsDropped": 0}
				if t.Type == "VIDEO" {
					st.VideoTracks = append(st.VideoTracks, entry)
				}
				if t.Type == "AUDIO" {
					st.AudioTracks = append(st.AudioTracks, entry)
				}
			}
		}
		if len(st.VideoTracks)+len(st.AudioTracks) > 0 {
			out = append(out, st)
		}
	}
	return out, nil
}

func (a *app) livekitJoin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if livekitURL == "" || livekitKey == "" || len(livekitSecret) < 32 {
		http.Error(w, "LiveKit indisponível", 503)
		return
	}
	var input struct {
		Room   string `json:"room"`
		Role   string `json:"role"`
		Viewer string `json:"viewer"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&input); err != nil || !keyRe.MatchString(input.Room) || (input.Role != "publisher" && input.Role != "viewer") || (input.Viewer != "" && !keyRe.MatchString(input.Viewer)) {
		http.Error(w, "Sala, função ou viewer inválido", 400)
		return
	}
	publish := input.Role == "publisher"
	if publish {
		streams, err := a.livekitStreams(r.Context())
		if err != nil {
			http.Error(w, "Não foi possível verificar a sala", 503)
			return
		}
		for _, st := range streams {
			if st.StreamKey == input.Room {
				http.Error(w, "Já existe uma transmissão nesta sala", 409)
				return
			}
		}
		a.mu.Lock()
		path := a.paths[input.Room]
		busy := path != nil && path.Ready
		a.mu.Unlock()
		if busy {
			http.Error(w, "Já existe uma transmissão nesta sala", 409)
			return
		}
	}
	identity := "viewer-" + newUUID()
	if publish {
		identity = "publisher"
	}
	token := livekitToken(identity, map[string]any{"roomJoin": true, "room": input.Room, "canPublish": publish, "canSubscribe": !publish, "canPublishData": false}, input.Viewer)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": token, "path": "/livekit"})
}

func serviceMethod(method string) string {
	if strings.HasSuffix(method, "Ingress") {
		return "livekit.Ingress/" + method
	}
	return "livekit.RoomService/" + method
}
