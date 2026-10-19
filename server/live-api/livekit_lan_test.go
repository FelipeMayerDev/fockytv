package main

import (
	"strings"
	"testing"
)

func TestWHIPLANAddress(t *testing.T) {
	original := "v=0\r\na=ice-ufrag:preserved\r\na=candidate:123 1 udp 2130706431 203.0.113.1 7885 typ host ufrag abc\r\na=candidate:123 2 udp 2130706431 203.0.113.1 7885 typ host ufrag abc\r\n"
	got := string(withWHIPLANAddress([]byte(original), "192.168.1.129"))
	if strings.Count(got, "203.0.113.1 7885") != 2 || strings.Count(got, "192.168.1.129 7885") != 2 {
		t.Fatal("must preserve public candidates and add LAN candidates for both components")
	}
	if !strings.Contains(got, "a=ice-ufrag:preserved\r\n") || !strings.HasSuffix(got, "\r\n") {
		t.Fatal("must preserve SDP credentials and line endings")
	}
	for _, ip := range []string{"", "bad\r\na=injected", "203.0.113.1"} {
		if string(withWHIPLANAddress([]byte(original), ip)) != original {
			t.Fatalf("unexpected change for %q", ip)
		}
	}
}
