use std::os::fd::OwnedFd;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;

use super::Live;
use crate::audio::{self, AudioTarget};
use crate::config::{bitrate_for, Config};

/// Pipeline Windows:
///
///   d3d11screencapturesrc (monitor OU window-handle via WGC) → openh264 ┐
///                                                                      ├→ whipsink
///   audio-helper.exe (WASAPI por processo) → appsrc → opus ───────────┘
///
/// A captura sai em memória D3D11: o d3d11download traz pra RAM antes do
/// videoconvert. Mesma cadeia de qualidade do Linux: 60fps drop-only,
/// resolução nativa, bitrate pela resolução.
pub fn build(
    pick: &crate::picker::windows::Pick,
    target: AudioTarget,
    cfg: &Config,
) -> Result<(Live, audio::Running), String> {
    let source = if pick.monitor != 0 {
        format!(
            "d3d11screencapturesrc monitor-handle={} show-cursor=true",
            pick.monitor
        )
    } else {
        format!(
            "d3d11screencapturesrc window-handle={} show-cursor=true",
            pick.hwnd
        )
    };
    let bitrate = bitrate_for(pick.width.unsigned_abs(), pick.height.unsigned_abs(), cfg.max_bitrate);
    let gop = (cfg.fps * 2).max(30);

    let launch = format!(
        r#"
        {source}
        ! d3d11download
        ! queue leaky=downstream max-size-buffers=2 max-size-time=0
        ! videorate drop-only=true
        ! capsfilter name=vcaps caps=video/x-raw,framerate={fps}/1
        ! videoconvert
        ! openh264enc name=venc usage-type=screen complexity=medium bitrate={bitrate} gop-size={gop}
        ! h264parse
        ! rtph264pay pt=96 config-interval=-1
        ! queue leaky=downstream max-size-time=1000000000
        ! whip.
        appsrc name=aud is-live=true do-timestamp=true format=time max-bytes=524288
        ! queue leaky=downstream max-size-time=300000000
        ! audioconvert
        ! opusenc bitrate={abr} audio-type=generic
        ! rtpopuspay pt=111
        ! queue
        ! whip.
        whipsink name=whip
            whip-endpoint="{url}/api/whip"
            auth-token="{key}"
            use-link-headers=true
        "#,
        fps = cfg.fps,
        url = cfg.server_url.trim_end_matches('/'),
        key = cfg.display_name,
        abr = cfg.audio_bitrate,
    );
    if std::env::var("FOCKYTV_DUMP_LAUNCH").is_ok() {
        eprintln!("[fockytv] launch:\n{launch}");
    }

    let pipeline = gst::parse::launch(&launch)
        .map_err(|e| format!("pipeline: {e}"))?
        .dynamic_cast::<gst::Pipeline>()
        .map_err(|_| "pipeline não é um bin".to_string())?;

    let appsrc = pipeline
        .by_name("aud")
        .and_then(|e| e.dynamic_cast::<gst_app::AppSrc>().ok())
        .ok_or("appsrc aud não achado")?;
    // rate/channels têm que ser (int) no caps — u32 vira (uint) e o sink
    // rejeita na negociação
    appsrc.set_property("caps", &gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("rate", audio::RATE as i32)
        .field("channels", 2i32)
        .field("layout", "interleaved")
        .build());

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("play: {e}"))?;

    let running = audio::windows::start(target, appsrc);
    Ok((
        Live {
            pipeline,
            fd: None::<OwnedFd>,
        },
        running,
    ))
}
