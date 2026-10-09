package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLivekitJoin(t *testing.T) {
	oldURL, oldKey, oldSecret := livekitURL, livekitKey, livekitSecret
	defer func() { livekitURL, livekitKey, livekitSecret = oldURL, oldKey, oldSecret }()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			t.Error("missing auth")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"rooms":[]}`))
	}))
	defer upstream.Close()
	livekitURL, livekitKey, livekitSecret = upstream.URL, "test-key", strings.Repeat("s", 32)
	a := newApp()
	for _, role := range []string{"publisher", "viewer"} {
		w := httptest.NewRecorder()
		a.livekitJoin(w, httptest.NewRequest("POST", "/api/livekit/join", strings.NewReader(`{"room":"ana","role":"`+role+`","viewer":"beto"}`)))
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		var result map[string]string
		json.Unmarshal(w.Body.Bytes(), &result)
		parts := strings.Split(result["token"], ".")
		if len(parts) != 3 {
			t.Fatal("invalid JWT")
		}
		mac := hmac.New(sha256.New, []byte(livekitSecret))
		mac.Write([]byte(parts[0] + "." + parts[1]))
		if parts[2] != base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) {
			t.Fatal("bad signature")
		}
		raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
		var claims map[string]any
		json.Unmarshal(raw, &claims)
		grant := claims["video"].(map[string]any)
		if grant["room"] != "ana" || grant["canPublish"] != (role == "publisher") || grant["canSubscribe"] != (role == "viewer") || grant["canPublishData"] != false {
			t.Fatal(grant)
		}
		if claims["name"] != "beto" || claims["exp"].(float64) > float64(time.Now().Unix()+7200) {
			t.Fatal(claims)
		}
	}
	for _, body := range []string{`{"room":"../admin","role":"publisher"}`, `{"room":"ana","role":"admin"}`, `{"room":"ana","role":"viewer","viewer":"../../"}`} {
		w := httptest.NewRecorder()
		a.livekitJoin(w, httptest.NewRequest("POST", "/api/livekit/join", strings.NewReader(body)))
		if w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
	a.paths["ana"] = &mtxPath{Ready: true}
	w := httptest.NewRecorder()
	a.livekitJoin(w, httptest.NewRequest("POST", "/api/livekit/join", strings.NewReader(`{"room":"ana","role":"publisher"}`)))
	if w.Code != 409 {
		t.Fatal(w.Code)
	}
}

func TestLivekitWhipProxy(t *testing.T) {
	oldURL, oldIngress, oldKey, oldSecret := livekitURL, livekitIngressURL, livekitKey, livekitSecret
	defer func() {
		livekitURL, livekitIngressURL, livekitKey, livekitSecret = oldURL, oldIngress, oldKey, oldSecret
	}()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/twirp/livekit.RoomService/ListRooms":
			w.Write([]byte(`{"rooms":[]}`))
		case "/twirp/livekit.Ingress/ListIngress":
			w.Write([]byte(`{"items":[{"ingress_id":"id","url":"http://internal/whip","stream_key":"private-key"}]}`))
		case "/whip/private-key":
			if r.Header.Get("Content-Type") != "application/sdp" {
				t.Error("missing SDP type")
			}
			w.Header().Set("Location", "/whip/resource")
			w.WriteHeader(201)
			w.Write([]byte("answer"))
		case "/whip/resource":
			if r.Method != "DELETE" {
				t.Error("expected DELETE")
			}
			w.WriteHeader(204)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	livekitURL, livekitIngressURL, livekitKey, livekitSecret = upstream.URL, upstream.URL, "key", strings.Repeat("s", 32)
	a := newApp()
	r := httptest.NewRequest("POST", "/api/livekit/whip", strings.NewReader("offer"))
	r.Header.Set("Authorization", "Bearer ana")
	w := httptest.NewRecorder()
	a.livekitWhip(w, r)
	if w.Code != 201 || w.Body.String() != "answer" || strings.Contains(w.Header().Get("Location"), "private-key") {
		t.Fatal(w.Code, w.Body.String(), w.Header())
	}
	id := strings.TrimPrefix(w.Header().Get("Location"), "/api/livekit/whip/")
	for _, who := range []string{"wrong", "ana"} {
		r := httptest.NewRequest("DELETE", "/api/livekit/whip/"+id, nil)
		r.SetPathValue("id", id)
		r.Header.Set("Authorization", "Bearer "+who)
		w := httptest.NewRecorder()
		a.sessDelete("api/livekit/whip")(w, r)
		if who == "wrong" && w.Code != 400 {
			t.Fatal(w.Code)
		}
		if who == "ana" && w.Code != 204 {
			t.Fatal(w.Code)
		}
	}
}
