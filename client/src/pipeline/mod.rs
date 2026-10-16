use gstreamer as gst;
use gstreamer::prelude::*;

#[cfg(target_os = "linux")]
use crate::audio::AudioMode;
#[cfg(target_os = "windows")]
use crate::audio::AudioTarget;
use crate::config::Config;

pub mod encoder;

/// Pipeline ao vivo. O fd do portal fica com a sessão no main (ela o
/// mantém aberto e o reutiliza nas reconexões do whipsink).
pub struct Live {
    pub pipeline: gst::Pipeline,
    pub camera: Option<Camera>,
    /// captura pw nativa (Linux; None = fonte de teste/videotestsrc)
    #[cfg(target_os = "linux")]
    pub video: Option<crate::video_pw::PwVideo>,
}

pub struct Camera {
    bin: gst::Bin,
    pad: gst::Pad,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    mirrored: bool,
}

pub fn enable_camera(live: &mut Live) -> Result<(), String> {
    if live.camera.is_some() {
        return Ok(());
    }
    let canvas = live.pipeline.by_name("canvas").ok_or("canvas não achado")?;
    let bin = gst::Bin::new();
    #[cfg(target_os = "linux")]
    let source = gst::ElementFactory::make("v4l2src")
        .property("device", "/dev/video0")
        .build()
        .map_err(|e| format!("webcam: {e}"))?;
    #[cfg(target_os = "windows")]
    let source = gst::ElementFactory::make("ksvideosrc")
        .build()
        .map_err(|e| format!("webcam: {e}"))?;
    let convert = gst::ElementFactory::make("videoconvert")
        .build()
        .map_err(|e| e.to_string())?;
    let scale = gst::ElementFactory::make("videoscale")
        .build()
        .map_err(|e| e.to_string())?;
    let flip = gst::ElementFactory::make("videoflip")
        .name("camflip")
        .build()
        .map_err(|e| e.to_string())?;
    let caps = gst::ElementFactory::make("capsfilter")
        .build()
        .map_err(|e| e.to_string())?;
    caps.set_property(
        "caps",
        gst::Caps::builder("video/x-raw")
            .field("width", 320i32)
            .field("height", 180i32)
            .build(),
    );
    let queue = gst::ElementFactory::make("queue")
        .build()
        .map_err(|e| e.to_string())?;
    bin.add_many([&source, &convert, &scale, &flip, &caps, &queue])
        .map_err(|e| e.to_string())?;
    gst::Element::link_many([&source, &convert, &scale, &flip, &caps, &queue])
        .map_err(|e| e.to_string())?;
    let ghost = gst::GhostPad::with_target(&queue.static_pad("src").ok_or("webcam sem saída")?)
        .map_err(|e| e.to_string())?;
    bin.add_pad(&ghost).map_err(|e| e.to_string())?;
    let pad = canvas
        .request_pad_simple("sink_%u")
        .ok_or("canvas sem pad")?;
    pad.set_property("xpos", 32i32);
    pad.set_property("ypos", 32i32);
    pad.set_property("width", 320i32);
    pad.set_property("height", 180i32);
    pad.set_property("zorder", 1u32);
    live.pipeline.add(&bin).map_err(|e| e.to_string())?;
    ghost.link(&pad).map_err(|e| e.to_string())?;
    bin.sync_state_with_parent().map_err(|e| e.to_string())?;
    live.camera = Some(Camera {
        bin,
        pad,
        x: 32,
        y: 32,
        width: 320,
        height: 180,
        mirrored: false,
    });
    Ok(())
}

pub fn camera_rect(live: &Live) -> Option<(i32, i32, i32, i32)> {
    let camera = live.camera.as_ref()?;
    Some((camera.x, camera.y, camera.width, camera.height))
}

pub fn camera_set_position(live: &mut Live, x: i32, y: i32) {
    let Some(camera) = &mut live.camera else {
        return;
    };
    camera.x = x.max(0);
    camera.y = y.max(0);
    camera.pad.set_property("xpos", camera.x);
    camera.pad.set_property("ypos", camera.y);
}

pub fn camera_set_width(live: &mut Live, width: i32) {
    let Some(camera) = &mut live.camera else {
        return;
    };
    camera.width = width.clamp(120, 960);
    camera.height = camera.width * 9 / 16;
    camera.pad.set_property("width", camera.width);
    camera.pad.set_property("height", camera.height);
}

pub fn camera_mirror(live: &mut Live) {
    let Some(camera) = &mut live.camera else {
        return;
    };
    camera.mirrored = !camera.mirrored;
    if let Some(flip) = camera.bin.by_name("camflip") {
        flip.set_property_from_str(
            "method",
            if camera.mirrored {
                "horizontal-flip"
            } else {
                "none"
            },
        );
    }
}

/// Janela local que consome a composição antes do encoder. Ela fica em uma
/// pipeline separada: fechar o preview nunca interfere no WHIP.
pub struct Preview {
    pipeline: gst::Pipeline,
    active: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

pub fn open_preview(tx: tokio::sync::mpsc::UnboundedSender<crate::Cmd>) -> Result<Preview, String> {
    // ximagesink (não glimagesink): sob Wayland a janela GL do glimagesink
    // recebe mouse-move mas não repassa clique/tecla pro GstNavigation —
    // o sink X11 clássico (via XWayland) tem esse suporte maduro e completo.
    #[cfg(target_os = "linux")]
    let sink = "ximagesink";
    #[cfg(target_os = "windows")]
    let sink = "d3d11videosink";

    let pipeline = gst::parse::launch(&format!(
        "intervideosrc name=previewsrc channel=fockytv-share-preview ! queue name=previewinput ! videoconvert ! textoverlay text=\"Setas: mover webcam   + / -: tamanho\" valignment=top halignment=left shaded-background=true font-desc=\"Sans 18\" ! {sink} name=previewsink sync=false"
    ))
    .map_err(|e| format!("preview: {e}"))?
    .dynamic_cast::<gst::Pipeline>()
    .map_err(|_| "preview não é um bin".to_string())?;
    // Navegação sobe do renderizador; este pad fica imediatamente antes dele
    // e não depende da implementação interna do glimagesinkbin.
    let input = pipeline
        .by_name("previewinput")
        .ok_or("preview sem entrada")?;
    let pad = input.static_pad("src").ok_or("preview sem saída")?;
    let event_tx = tx.clone();
    pad.add_probe(gst::PadProbeType::EVENT_UPSTREAM, move |_, info| {
        let Some(event) = info.event() else {
            return gst::PadProbeReturn::Ok;
        };
        let Some(structure) = event.structure() else {
            return gst::PadProbeReturn::Ok;
        };
        if let Some((phase, x, y)) = preview_pointer(structure) {
            let _ = event_tx.send(crate::Cmd::PreviewPointer { phase, x, y });
        } else if let Some(key) = preview_key(structure) {
            let _ = event_tx.send(crate::Cmd::PreviewKey(key));
        }
        gst::PadProbeReturn::Ok
    });
    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("abrir preview: {e}"))?;

    let active = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let watch_active = active.clone();
    let watch_pipeline = pipeline.clone();
    std::thread::spawn(move || {
        let Some(bus) = watch_pipeline.bus() else {
            return;
        };
        while watch_active.load(std::sync::atomic::Ordering::Relaxed) {
            if bus
                .timed_pop_filtered(
                    gst::ClockTime::from_mseconds(250),
                    &[gst::MessageType::Error, gst::MessageType::Eos],
                )
                .is_some()
            {
                let _ = tx.send(crate::Cmd::PreviewClosed);
                return;
            }
        }
    });
    Ok(Preview { pipeline, active })
}

fn preview_pointer(structure: &gst::StructureRef) -> Option<(crate::PointerPhase, i32, i32)> {
    let phase = match structure.get::<String>("event").ok()?.as_str() {
        "mouse-button-press" if structure.get::<i32>("button").ok() == Some(1) => {
            crate::PointerPhase::Down
        }
        "mouse-button-release" if structure.get::<i32>("button").ok() == Some(1) => {
            crate::PointerPhase::Up
        }
        "mouse-move" => crate::PointerPhase::Move,
        _ => return None,
    };
    Some((
        phase,
        structure.get::<f64>("pointer_x").ok()? as i32,
        structure.get::<f64>("pointer_y").ok()? as i32,
    ))
}

fn preview_key(structure: &gst::StructureRef) -> Option<crate::PreviewKey> {
    if structure.get::<String>("event").ok()?.as_str() != "key-press" {
        return None;
    }
    match structure.get::<String>("key").ok()?.as_str() {
        "Left" => Some(crate::PreviewKey::Left),
        "Right" => Some(crate::PreviewKey::Right),
        "Up" => Some(crate::PreviewKey::Up),
        "Down" => Some(crate::PreviewKey::Down),
        // ximagesink manda o keysym base (nível 0) do X11, ignorando o
        // shift: a tecla física "=/+" chega sempre como "equal", nunca "plus".
        "plus" | "equal" | "KP_Add" => Some(crate::PreviewKey::Grow),
        "minus" | "KP_Subtract" => Some(crate::PreviewKey::Shrink),
        _ => None,
    }
}

impl Preview {
    pub fn close(self) {
        self.active
            .store(false, std::sync::atomic::Ordering::Relaxed);
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "windows")]
pub mod windows;

/// Build com invalidação da escada de encoders: um erro depois da escolha
/// (device de hardware que sumiu, driver resetado) não pode deixar a escolha
/// morta presa no cache — a próxima sessão re-probe.
#[cfg(target_os = "linux")]
pub fn build(
    fd: &std::os::fd::OwnedFd,
    node: u32,
    size: Option<(i32, i32)>,
    mode: AudioMode,
    cfg: &Config,
) -> Result<(Live, crate::audio::Running), String> {
    linux::build(fd, node, size, mode, cfg).inspect_err(|_| encoder::invalidate())
}

#[cfg(target_os = "windows")]
pub fn build(
    pick: &crate::picker::windows::Pick,
    target: AudioTarget,
    cfg: &Config,
) -> Result<(Live, crate::audio::Running), String> {
    windows::build(pick, target, cfg).inspect_err(|_| encoder::invalidate())
}

pub fn quality_caps(
    width: u32,
    height: u32,
    target_height: u32,
    fps: u32,
) -> Result<gst::Caps, String> {
    if width < 2 || height < 2 || fps == 0 || fps > 240 || target_height > 4320 {
        return Err("Qualidade inválida.".into());
    }
    let out_height = if target_height == 0 {
        height
    } else {
        height.min(target_height)
    } & !1;
    let out_width = ((width as u64 * out_height as u64 / height as u64) as u32).max(2) & !1;
    Ok(gst::Caps::builder("video/x-raw")
        .field("width", out_width as i32)
        .field("height", out_height as i32)
        .field("framerate", gst::Fraction::new(fps as i32, 1))
        .build())
}

/// Reconfigura somente o ramo de vídeo; fonte, áudio e whipsink continuam vivos.
pub async fn set_quality(live: &Live, fps: u32, height: u32, bitrate: u64) -> Result<(), String> {
    let source = live
        .pipeline
        .by_name("sourcecaps")
        .ok_or("Resolução da fonte indisponível.")?;
    let source_caps = source.property::<gst::Caps>("caps");
    let dimensions = source_caps.structure(0).ok_or("Fonte sem dimensões.")?;
    let width = dimensions.get::<i32>("width").map_err(|e| e.to_string())? as u32;
    let source_height = dimensions.get::<i32>("height").map_err(|e| e.to_string())? as u32;
    let wanted = quality_caps(width, source_height, height, fps)?;
    let output = live
        .pipeline
        .by_name("qualitycaps")
        .ok_or("Controle de qualidade indisponível.")?;
    let previous = output.property::<gst::Caps>("caps");
    let previous_encoded = current_caps(live);
    let expected = wanted.structure(0).unwrap();
    let expected = (
        expected.get::<i32>("width").unwrap() as u32,
        expected.get::<i32>("height").unwrap() as u32,
        fps,
    );
    output.set_property("caps", &wanted);
    // A propriedade aceita caps antes da negociação: confirmar no vídeo já codificado.
    if wait_for_caps(live, expected).await {
        refine_bitrate(live, bitrate);
        return Ok(());
    }
    output.set_property("caps", previous);
    if let Some(previous) = previous_encoded {
        if wait_for_caps(live, previous).await {
            return Err(
                "Encoder não confirmou a qualidade; configuração anterior restaurada.".into(),
            );
        }
    }
    Err("Encoder não confirmou a qualidade nem a restauração anterior.".into())
}

async fn wait_for_caps(live: &Live, expected: (u32, u32, u32)) -> bool {
    for _ in 0..100 {
        if current_caps(live) == Some(expected) {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    false
}

/// Ajusta o bitrate do encoder ao vivo quando a resolução real negociada
/// difere da estimativa (portal devolve tamanho lógico, não pixels). A
/// unidade do `bitrate` depende do encoder escolhido (bps no OpenH264, kbps
/// no resto) — a conversão fica no encoder::Kind.
pub fn refine_bitrate(live: &Live, manual: u64) -> Option<(u32, u32, u32)> {
    let (w, h, fps) = current_caps(live)?;
    if let Some(enc) = live.pipeline.by_name("venc") {
        let factory = enc.factory()?;
        let kind = encoder::LADDER
            .iter()
            .find(|kind| kind.element() == factory.name())?;
        let want = kind.bitrate(crate::config::bitrate_for(w, h, manual, fps));
        if encoder::applied_bitrate() != want {
            // por string: o tipo gint/guint da property varia por encoder
            enc.set_property_from_str("bitrate", &want.to_string());
            encoder::set_applied_bitrate(want);
        }
    }
    Some((w, h, fps))
}

/// Lê a resolução negociada sem mexer em nada (para o status do tray).
pub fn current_caps(live: &Live) -> Option<(u32, u32, u32)> {
    let encoder = live.pipeline.by_name("venc")?;
    let pad = encoder.static_pad("src")?;
    let caps = pad.current_caps()?;
    let s = caps.structure(0)?;
    Some((
        s.get::<i32>("width").ok()? as u32,
        s.get::<i32>("height").ok()? as u32,
        s.get::<gst::Fraction>("framerate")
            .ok()
            .map(|f| (f.numer() / f.denom().max(1)) as u32)
            .unwrap_or(0),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_preserves_aspect_and_rejects_invalid_values() {
        gst::init().unwrap();
        let caps = quality_caps(2560, 1080, 720, 60).unwrap();
        let s = caps.structure(0).unwrap();
        assert_eq!(s.get::<i32>("width").unwrap(), 1706);
        assert_eq!(s.get::<i32>("height").unwrap(), 720);
        assert_eq!(
            quality_caps(1280, 720, 1080, 30)
                .unwrap()
                .structure(0)
                .unwrap()
                .get::<i32>("height")
                .unwrap(),
            720
        );
        assert!(quality_caps(1920, 1080, 720, 0).is_err());
        assert!(quality_caps(1920, 1080, 5000, 30).is_err());
    }

    #[tokio::test]
    async fn live_quality_reconfigures_encoded_video_without_stopping_audio() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        gst::init().unwrap();
        let pipeline = gst::parse::launch(
            "videotestsrc is-live=true ! video/x-raw,width=1280,height=720,framerate=60/1 \
             ! videoconvert ! compositor name=canvas canvas. \
             ! capsfilter name=sourcecaps caps=video/x-raw,width=1280,height=720 \
             ! videoscale ! videorate drop-only=true \
             ! capsfilter name=qualitycaps caps=video/x-raw,width=1280,height=720,framerate=60/1 \
             ! x264enc name=venc tune=zerolatency speed-preset=ultrafast bitrate=8000 \
             ! h264parse ! rtph264pay config-interval=-1 ! fakesink sync=false \
             audiotestsrc is-live=true ! opusenc ! fakesink name=audio sync=false",
        )
        .unwrap()
        .dynamic_cast::<gst::Pipeline>()
        .unwrap();
        let audio = Arc::new(AtomicUsize::new(0));
        let count = audio.clone();
        pipeline
            .by_name("audio")
            .unwrap()
            .static_pad("sink")
            .unwrap()
            .add_probe(gst::PadProbeType::BUFFER, move |_, _| {
                count.fetch_add(1, Ordering::Relaxed);
                gst::PadProbeReturn::Ok
            });
        pipeline.set_state(gst::State::Playing).unwrap();
        let live = Live {
            pipeline: pipeline.clone(),
            camera: None,
            #[cfg(target_os = "linux")]
            video: None,
        };
        let result: Result<(), String> = async {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            for (fps, height, expected) in [
                (30, 480, (852, 480, 30)),
                (60, 0, (1280, 720, 60)),
                (15, 240, (426, 240, 15)),
            ] {
                let before = audio.load(Ordering::Relaxed);
                set_quality(&live, fps, height, 8_000_000).await?;
                assert_eq!(current_caps(&live), Some(expected));
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                assert!(audio.load(Ordering::Relaxed) > before);
                assert_eq!(pipeline.current_state(), gst::State::Playing);
            }
            let caps = current_caps(&live);
            assert!(set_quality(&live, 0, 720, 8_000_000).await.is_err());
            assert_eq!(current_caps(&live), caps);
            Ok(())
        }
        .await;
        pipeline.set_state(gst::State::Null).unwrap();
        result.unwrap();
    }

    #[test]
    fn canvas_entrega_whip_e_preview() {
        gst::init().unwrap();
        assert!(gst::parse::launch(
            "videotestsrc ! videoconvert ! compositor name=canvas canvas. ! tee name=out out. ! queue ! fakesink out. ! queue ! intervideosink channel=fockytv-share-preview"
        ).is_ok());
    }

    #[test]
    fn le_evento_de_mouse_do_gst_navigation() {
        gst::init().unwrap();
        let structure = gst::Structure::builder("application/x-gst-navigation")
            .field("event", "mouse-button-press")
            .field("button", 1i32)
            .field("pointer_x", 123.0f64)
            .field("pointer_y", 456.0f64)
            .build();
        assert_eq!(
            preview_pointer(&structure),
            Some((crate::PointerPhase::Down, 123, 456))
        );
    }
}
