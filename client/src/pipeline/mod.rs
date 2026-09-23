use gstreamer as gst;
use gstreamer::prelude::*;


/// Sessão ao vivo: segura o pipeline e o fd do portal (o pipewiresrc usa o
/// fd por número; se ele fechar, a captura morre).
pub struct Live {
    pub pipeline: gst::Pipeline,
    #[allow(dead_code)] // viva apenas para manter o fd aberto
    pub fd: Option<std::os::fd::OwnedFd>,
}

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "linux")]
pub use linux::build;

#[cfg(target_os = "windows")]
pub mod windows;

/// Ajusta o bitrate do openh264enc ao vivo quando a resolução real negociada
/// difere da estimativa (portal devolve tamanho lógico, não pixels).
pub fn refine_bitrate(live: &Live, manual: u64) -> Option<(u32, u32, u32)> {
    let capsfilter = live.pipeline.by_name("vcaps")?;
    let pad = capsfilter.static_pad("sink")?;
    let caps = pad.current_caps()?;
    let s = caps.structure(0)?;
    let w = s.get::<i32>("width").ok()? as u32;
    let h = s.get::<i32>("height").ok()? as u32;
    let fps = s
        .get::<gst::Fraction>("framerate")
        .ok()
        .map(|f| f.numer() as u32)
        .unwrap_or(0);
    if let Some(enc) = live.pipeline.by_name("venc") {
        let want = crate::config::bitrate_for(w, h, manual);
        let cur = enc.property::<u32>("bitrate");
        if cur != want as u32 {
            let _ = enc.set_property("bitrate", want as u32);
        }
    }
    Some((w, h, fps))
}

/// Lê a resolução negociada sem mexer em nada (para o status do tray).
pub fn current_caps(live: &Live) -> Option<(u32, u32, u32)> {
    let capsfilter = live.pipeline.by_name("vcaps")?;
    let pad = capsfilter.static_pad("sink")?;
    let caps = pad.current_caps()?;
    let s = caps.structure(0)?;
    Some((
        s.get::<i32>("width").ok()? as u32,
        s.get::<i32>("height").ok()? as u32,
        s.get::<gst::Fraction>("framerate")
            .ok()
            .map(|f| f.numer() as u32)
            .unwrap_or(0),
    ))
}
