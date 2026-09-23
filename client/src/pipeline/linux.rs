use std::os::fd::AsRawFd;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;

use super::Live;
use crate::audio::{self, AudioMode};
use crate::config::{bitrate_for, Config};

/// Monta e sobe o pipeline completo de publicação:
///
///   pipewiresrc → 60fps nativo → openh264 → rtph264pay ┐
///                                                      ├→ whipsink → WHIP
///   pw-cat → appsrc → opus → rtpopuspay ───────────────┘
///
/// A resolução nunca sobe e nunca re-escala: videorate drop-only derruba o
/// que passar do fps configurado. O bitrate inicial é estimado pelo tamanho
/// (lógico) do portal e afinado depois que os caps reais negociarem.
pub fn build(
    fd: &std::os::fd::OwnedFd,
    node: u32,
    size: Option<(i32, i32)>,
    mode: AudioMode,
    cfg: &Config,
) -> Result<(Live, audio::Running), String> {
    let fd_raw = fd.as_raw_fd();
    let (w, h) = size.unwrap_or((1920, 1080));
    let bitrate = bitrate_for(w.unsigned_abs(), h.unsigned_abs(), cfg.max_bitrate);
    let gop = (cfg.fps * 2).max(30);
    // FOCKYTV_TEST_VIDEO=1 troca a fonte por videotestsrc (diagnóstico sem
    // portal). No caminho normal a captura é PipeWire nativo (video_pw.rs)
    // empurrando neste appsrc — o gstpipewiresrc desta versão dead-locka com
    // encoder na cadeia (pipewire#5459/#4797).
    let test_video = std::env::var("FOCKYTV_TEST_VIDEO").is_ok();
    let source = if test_video {
        "videotestsrc is-live=true pattern=ball".to_string()
    } else {
        "appsrc name=vid is-live=true do-timestamp=true format=time max-bytes=8388608 block=true".to_string()
    };

    let launch = format!(
        r#"
        {source}
        ! queue leaky=downstream max-size-buffers=2 max-size-time=0
        ! {rate_chain}
        ! videoconvert
        ! openh264enc name=venc usage-type=screen rate-control=bitrate scene-change-detection=false complexity=medium bitrate={bitrate} gop-size={gop}
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
        rate_chain = if std::env::var("FOCKYTV_NO_RATE").is_ok() {
            // diagnóstico: sem videorate/caps — deixa o framerate do stream passar direto
            "identity silent=true".to_string()
        } else {
            format!("videorate drop-only=true ! capsfilter name=vcaps caps=video/x-raw,framerate={}/1", cfg.fps)
        },
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

    // FOCKYTV_DOT=1 + GST_DEBUG_DUMP_DOT_DIR=/tmp → grafo do pipeline em .dot
    if std::env::var("FOCKYTV_DOT").is_ok() {
        pipeline.debug_to_dot_file(gst::DebugGraphDetails::all(), "fockytv-share");
    }

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("play: {e}"))?;

    let running = audio::linux::start(mode, appsrc);

    let mut video = None;
    if !test_video {
        let vid = pipeline
            .by_name("vid")
            .and_then(|e| e.dynamic_cast::<gst_app::AppSrc>().ok())
            .ok_or("appsrc vid não achado")?;
        // pw consome o fd: clona pra reconexões futuras manterem a fonte
        let fd2 = fd
            .try_clone()
            .map_err(|e| format!("dup fd: {e}"))?;
        video = Some(crate::video_pw::start(fd2, node, vid));
    }
    Ok((Live { pipeline, video }, running))
}
