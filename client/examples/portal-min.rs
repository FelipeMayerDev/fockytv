//! Mínimo portal + pipewiresrc + fakesink com contador de buffers — isola o
//! livelock de renegociação do resto do app.
//!
//! Uso: cargo run --example portal-min [-- --mode plain|queue|caps]

use std::os::fd::AsRawFd;
use gstreamer as gst;
use gst::prelude::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[tokio::main]
async fn main() -> ashpd::Result<()> {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let mode = mode.trim_start_matches("--mode=").to_string();

    gst::init().unwrap();
    let proxy = ashpd::desktop::screencast::Screencast::new().await?;
    let session = proxy.create_session(Default::default()).await?;
    proxy
        .select_sources(
            &session,
            ashpd::desktop::screencast::SelectSourcesOptions::default()
                .set_cursor_mode(ashpd::desktop::screencast::CursorMode::Embedded)
                .set_sources(
                    ashpd::desktop::screencast::SourceType::Monitor
                        | ashpd::desktop::screencast::SourceType::Window,
                )
                .set_multiple(false),
        )
        .await?;
    let response = proxy
        .start(&session, None, Default::default())
        .await?
        .response()?;
    let stream = response.streams().first().expect("sem stream").to_owned();
    let fd = proxy
        .open_pipe_wire_remote(&session, Default::default())
        .await?;

    let launch = format!(
        "pipewiresrc fd={} path={} keepalive-time=1000 name=src \
         ! videoconvert ! fakesink sync=false",
        fd.as_raw_fd(),
        stream.pipe_wire_node_id()
    );
    if mode == "barrier" {
        return run_barrier(fd, stream.pipe_wire_node_id()).await;
    }
    let launch = match mode.as_str() {
        "queue" => launch.replace("name=src", "name=src ! queue"),
        "caps" => launch.replace("! videoconvert", "! videorate drop-only=true ! video/x-raw,framerate=60/1 ! videoconvert"),
        "enc" => launch.replace(
            "! videoconvert ! fakesink sync=false",
            "! videoconvert ! openh264enc usage-type=screen complexity=medium bitrate=16000000 ! fakesink sync=false"),
        "vp9" => launch.replace(
            "! videoconvert ! fakesink sync=false",
            "! videoconvert ! vp9enc cpu-used=8 deadline=1 threads=4 ! fakesink sync=false"),
        "nok" => launch.replace(
            "keepalive-time=1000 ",
            "").replace(
            "! videoconvert ! fakesink sync=false",
            "! videoconvert ! openh264enc usage-type=screen complexity=medium bitrate=16000000 ! fakesink sync=false"),
        "nolive" => launch.replace(
            "keepalive-time=1000",
            "keepalive-time=1000 is-live=false").replace(
            "! videoconvert ! fakesink sync=false",
            "! videoconvert ! openh264enc usage-type=screen complexity=medium bitrate=16000000 ! fakesink sync=false"),
        "dt" => launch.replace(
            "keepalive-time=1000",
            "keepalive-time=1000 do-timestamp=true").replace(
            "! videoconvert ! fakesink sync=false",
            "! videoconvert ! openh264enc usage-type=screen complexity=medium bitrate=16000000 ! fakesink sync=false"),
        "copy" => launch.replace(
            "keepalive-time=1000",
            "keepalive-time=1000 always-copy=true").replace(
            "! videoconvert ! fakesink sync=false",
            "! videoconvert ! openh264enc usage-type=screen complexity=medium bitrate=16000000 ! fakesink sync=false"),
        "nobp" => launch.replace(
            "keepalive-time=1000",
            "keepalive-time=1000 use-bufferpool=false").replace(
            "! videoconvert ! fakesink sync=false",
            "! videoconvert ! openh264enc usage-type=screen complexity=medium bitrate=16000000 ! fakesink sync=false"),
        "encql" => launch.replace(
            "! videoconvert ! fakesink sync=false",
            "! queue leaky=downstream max-size-buffers=2 max-size-time=0 ! videorate drop-only=true ! capsfilter caps=video/x-raw,framerate=60/1 ! videoconvert ! openh264enc usage-type=screen complexity=medium bitrate=16000000 ! fakesink sync=false"),
        "encq" => launch.replace(
            "! videoconvert ! fakesink sync=false",
            "! queue ! videoconvert ! openh264enc usage-type=screen complexity=medium bitrate=16000000 ! fakesink sync=false"),
        "enc60" => launch.replace(
            "! videoconvert ! fakesink sync=false",
            "! capsfilter caps=video/x-raw,framerate=60/1 ! videoconvert ! openh264enc usage-type=screen complexity=medium bitrate=16000000 ! fakesink sync=false"),
        "force60" => launch.replace(
            "keepalive-time=1000 name=src \"",
            "keepalive-time=1000 name=src \" ! capsfilter caps=video/x-raw,framerate=60/1"),
        "fix60" => launch.replace(
            "! videoconvert",
            "! videorate drop-only=true ! capsfilter caps=video/x-raw,framerate=60/1 ! videoconvert"),
        "whip" => launch.replace(
            "! videoconvert ! fakesink sync=false",
            "! videoconvert ! openh264enc usage-type=screen complexity=medium bitrate=16000000 ! h264parse ! rtph264pay pt=96 config-interval=-1 ! queue ! whipsink whip-endpoint=\"http://192.168.1.129:8180/api/whip\" auth-token=fix3 use-link-headers=true"),
        _ => launch,
    };
    eprintln!("== modo {mode:?}\n{launch}");

    let pipeline = gst::parse::launch(&launch).unwrap();
    let count = Arc::new(AtomicU64::new(0));
    {
        let pipeline = pipeline.clone();
        let count = count.clone();
        let src = pipeline
            .dynamic_cast_ref::<gst::Bin>()
            .unwrap()
            .by_name("src")
            .unwrap();
        let pad = src.static_pad("src").unwrap();
        pad.add_probe(
            gst::PadProbeType::BUFFER,
            move |_pad, info| {
                if let Some(_b) = info.buffer() {
                    let n = count.fetch_add(1, Ordering::Relaxed);
                    if n % 120 == 0 {
                        eprintln!("[{:.1}s] {n} buffers", elapsed_secs());
                    }
                }
                gst::PadProbeReturn::Ok
            },
        )
        .unwrap();
    }
    let _ = std::mem::forget(session); // segura a sessão
    std::mem::forget(fd); // segura o fd

    pipeline.set_state(gst::State::Playing).unwrap();
    let start = std::time::Instant::now();
    while start.elapsed().as_secs() < 25 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let n = count.load(Ordering::Relaxed);
        eprintln!("t={:>2}s  total={n}", start.elapsed().as_secs());
    }
    let _ = pipeline.set_state(gst::State::Null);
    let n = count.load(Ordering::Relaxed);
    eprintln!("FINAL: {n} buffers em 25s ({})", n / 25);
    Ok(())
}

fn elapsed_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
        % 10_000.0
}


/// Barreira appsink→appsrc: corta toda negociação de pool/allocation entre
/// o pipewiresrc e o encoder (uma cópia a mais por frame).
async fn run_barrier(fd: std::os::fd::OwnedFd, node: u32) -> ashpd::Result<()> {
    use gstreamer_app as app;
    let count = Arc::new(AtomicU64::new(0));

    let src = gst::ElementFactory::make("pipewiresrc")
        .property("fd", fd.as_raw_fd())
        .property("path", node.to_string())
        .property("keepalive-time", 1000i32)
        .build().unwrap();
    let conv = gst::ElementFactory::make("videoconvert").build().unwrap();
    let caps = gst::Caps::builder("video/x-raw")
        .field("format", "I420")
        .build();
    let sink = app::AppSink::builder()
        .caps(&caps)
        .sync(false)
        .max_buffers(2)
        .drop(true)
        .build();
    let enc = gst::parse::launch(
        "openh264enc usage-type=screen complexity=medium bitrate=16000000",
    ).unwrap();
    let fsink = gst::ElementFactory::make("fakesink")
        .property("sync", false)
        .build().unwrap();
    let appsrc = app::AppSrc::builder()
        .is_live(true)
        .do_timestamp(true)
        .format(gst::Format::Time)
        .caps(&caps)
        .build();

    let pipeline = gst::Pipeline::new();
    let appsrc_el: &gst::Element = appsrc.upcast_ref();
    let sink_el: &gst::Element = sink.upcast_ref();
    pipeline.add_many([&src, &conv, sink_el, appsrc_el, &enc, &fsink]).unwrap();
    gst::Element::link_many([&src, &conv, sink_el]).unwrap();
    gst::Element::link_many([appsrc_el, &enc, &fsink]).unwrap();

    // move samples appsink→appsrc
    {
        let sink = sink.clone();
        let appsrc = appsrc.clone();
        let count = count.clone();
        std::thread::spawn(move || {
            eprintln!("[barrier] thread mover viva");
            loop {
                match sink.pull_sample() {
                    Ok(sample) => {
                        let Some(buffer) = sample.buffer() else { continue };
                        let b = buffer.copy();
                        if appsrc.push_buffer(b).is_err() {
                            return;
                        }
                        let n = count.fetch_add(1, Ordering::Relaxed);
                        if n % 120 == 0 {
                            eprintln!("[barrier] {n} frames");
                        }
                    }
                    Err(_) => return,
                }
            }
        });
    }
    std::mem::forget(fd);
    pipeline.set_state(gst::State::Playing).unwrap();
    // mensagens do bus nos primeiros 3s
    {
        let bus = pipeline.bus().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if let Some(m) = bus.timed_pop(gst::ClockTime::from_mseconds(200)) {
                eprintln!("[bus] {m:?}");
            }
        }
        eprintln!("[barrier] estado: {:?}", pipeline.state(gst::ClockTime::from_seconds(1)));
    }
    let start = std::time::Instant::now();
    while start.elapsed().as_secs() < 25 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        eprintln!("t={:>2}s total={}", start.elapsed().as_secs(), count.load(Ordering::Relaxed));
    }
    let _ = pipeline.set_state(gst::State::Null);
    let n = count.load(Ordering::Relaxed);
    eprintln!("FINAL: {n} frames em 25s");
    Ok(())
}
