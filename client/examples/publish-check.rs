//! Smoke test de publicação WHIP: videotestsrc + audiotestsrc → whipsink.
//! Valida endpoint, auth, codecs (H264/Opus) e o DELETE no fim — sem portal,
//! sem captura de tela de verdade.
//!
//! Uso: cargo run --example publish-check -- [--server URL] [--key NICK] [--seconds 15]
//!
//! Acompanhe em outro terminal:
//!   watch -n1 'curl -s URL/api/status'

use gstreamer as gst;
use gstreamer::prelude::*;
use std::time::Duration;

fn main() {
    let mut server = "https://fockytv.felipemayer.com.br".to_string();
    let mut key = "focky".to_string();
    let mut seconds = 15u64;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--server" => server = args.next().unwrap_or_default(),
            "--key" => key = args.next().unwrap_or_default(),
            "--seconds" => seconds = args.next().and_then(|s| s.parse().ok()).unwrap_or(15),
            _ => {}
        }
    }

    gst::init().expect("gst init");
    let launch = format!(
        r#"
        videotestsrc pattern=ball
        ! video/x-raw,width=1920,height=1080,framerate=60/1
        ! openh264enc usage-type=screen complexity=medium bitrate=10000000
        ! h264parse ! rtph264pay pt=96 config-interval=-1
        ! queue ! whip.
        audiotestsrc wave=sine freq=440
        ! audioconvert ! audioresample ! opusenc bitrate=192000
        ! rtpopuspay pt=111
        ! queue ! whip.
        whipsink name=whip whip-endpoint="{s}/api/whip" auth-token="{k}" use-link-headers=true
        "#,
        s = server.trim_end_matches('/'),
        k = key
    );
    println!("publicando em {server}/api/whip como '{key}' por {seconds}s…");
    let pipe = gst::parse::launch(&launch).expect("pipeline");
    let bus = pipe.bus().unwrap();
    pipe.set_state(gst::State::Playing).expect("play");

    // drena o bus por N segundos; erro → sai não-zero
    let mut ok = true;
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    while let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) {
        let Some(msg) = bus.timed_pop_filtered(
            gst::ClockTime::from_mseconds(
                remaining.min(Duration::from_millis(500)).as_millis() as u64
            ),
            &[gst::MessageType::Error],
        ) else {
            continue;
        };
        if let gst::MessageView::Error(e) = msg.view() {
            eprintln!("ERRO: {e}");
            ok = false;
            break;
        }
    }

    println!("encerrando (EOS → DELETE)…");
    let _ = pipe.send_event(gst::event::Eos::new());
    let _ = bus.timed_pop_filtered(
        gst::ClockTime::from_seconds(3),
        &[gst::MessageType::Eos, gst::MessageType::Error],
    );
    let _ = pipe.set_state(gst::State::Null);
    println!("{}", if ok { "OK" } else { "FALHOU" });
    std::process::exit(if ok { 0 } else { 1 });
}
