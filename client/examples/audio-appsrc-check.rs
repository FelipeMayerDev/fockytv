//! Isolamento do problema do appsrc no whipsink: o mesmo pipeline de áudio
//! com audiotestsrc (que funciona) e com appsrc alimentado por código.
//!
//! Uso: cargo run --example audio-appsrc-check -- [--src test|app] [--seconds 10]

use gstreamer as gst;
use gstreamer::prelude::*;
use std::time::Duration;

fn main() {
    let mut src = "test".to_string();
    let mut seconds = 10u64;
    let mut server = "http://192.168.1.129:8180".to_string();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--src" => src = args.next().unwrap_or_default(),
            "--seconds" => seconds = args.next().and_then(|s| s.parse().ok()).unwrap_or(10),
            "--server" => server = args.next().unwrap_or_default(),
            _ => {}
        }
    }
    gst::init().unwrap();

    let audio = if src == "app" {
        String::new() // appsrc: caps setados depois do parse
    } else {
        "audiotestsrc is-live=true ! audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved ".into()
    };

    let launch = format!(
        r#"{audio}{chain}
        ! queue name=aq leaky=downstream
        ! audioconvert ! opusenc bitrate=192000 ! rtpopuspay pt=111
        ! queue ! whip.
        whipsink name=whip whip-endpoint="{s}/api/whip" auth-token=smoke use-link-headers=true"#,
        chain = if src == "app" {
            "appsrc name=aud is-live=true do-timestamp=true format=time".to_string()
        } else {
            String::new()
        },
        s = server.trim_end_matches('/'),
    );
    println!("== fonte: {src}\n{launch}");

    let pipe = gst::parse::launch(&launch).expect("parse");
    let bus = pipe.bus().unwrap();

    if src == "app" {
        let appsrc = pipe
            .dynamic_cast_ref::<gst::Bin>()
            .unwrap()
            .by_name("aud")
            .unwrap()
            .dynamic_cast::<gstreamer_app::AppSrc>()
            .unwrap();
        appsrc.set_property(
            "caps",
            &gst::Caps::builder("audio/x-raw")
                .field("format", "F32LE")
                .field("rate", 48000i32)
                .field("channels", 2i32)
                .field("layout", "interleaved")
                .build(),
        );
        // alimenta 20ms de zeros a cada 20ms
        std::thread::spawn(move || {
            let zeros = vec![0u8; 48000 * 8 / 50];
            loop {
                let b = gst::Buffer::from_slice(zeros.clone());
                match appsrc.push_buffer(b) {
                    Ok(_) => {}
                    Err(e) => {
                        eprintln!("push erro: {e}");
                        return;
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
    }

    pipe.set_state(gst::State::Playing).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    let mut ok = true;
    while let Some(rest) = deadline.checked_duration_since(std::time::Instant::now()) {
        let Some(msg) = bus.timed_pop_filtered(
            gst::ClockTime::from_mseconds(rest.min(Duration::from_millis(300)).as_millis() as u64),
            &[gst::MessageType::Error, gst::MessageType::Warning],
        ) else {
            continue;
        };
        match msg.view() {
            gst::MessageView::Error(e) => {
                eprintln!("ERRO: {e}");
                ok = false;
                break;
            }
            gst::MessageView::Warning(w) => eprintln!("WARN: {w}"),
            _ => {}
        }
    }
    let _ = pipe.send_event(gst::event::Eos::new());
    let _ = bus.timed_pop_filtered(gst::ClockTime::from_seconds(2), &[gst::MessageType::Eos]);
    let _ = pipe.set_state(gst::State::Null);
    println!("{}", if ok { "OK" } else { "FALHOU" });
}
