mod audio;
mod config;
#[cfg(unix)]
mod control;
mod picker;
mod pipeline;
#[cfg(target_os = "linux")]
mod shortcut;
mod tray;
#[cfg(target_os = "linux")]
mod video_pw;

use gstreamer as gst;
use gstreamer::prelude::*;
use tokio::sync::mpsc;

#[derive(Clone)]
enum Cmd {
    Share,
    StartShare {
        fps: u32,
        bitrate: u64,
    },
    Stop,
    Preview,
    PreviewClosed,
    Webcam,
    PreviewPointer {
        phase: PointerPhase,
        x: i32,
        y: i32,
    },
    PreviewKey(PreviewKey),
    MirrorWebcam,
    Quit,
    ConfigureHotkey,
    ChooseAudio(u32),
    RefreshStatus,
    /// erro no pipeline (whipsink bateu 400 de host fantasma etc.) → tenta
    /// reconstruir a transmissão com a MESMA fonte (sem reabrir o portal)
    PipelineFailed,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum PointerPhase {
    Down,
    Move,
    Up,
}

#[derive(Clone, Copy)]
enum PreviewKey {
    Left,
    Right,
    Up,
    Down,
    Grow,
    Shrink,
}

enum CameraDrag {
    Move { offset_x: i32, offset_y: i32 },
    Resize { start_x: i32, start_width: i32 },
}

/// Fonte escolhida: guardada pra reconstruir o pipeline sem novo picker.
#[cfg(target_os = "linux")]
struct Source {
    fd: std::os::fd::OwnedFd,
    node: u32,
    size: Option<(i32, i32)>,
    mode: audio::AudioMode,
}

#[cfg(target_os = "windows")]
struct Source {
    pick: picker::windows::Pick,
    target: audio::AudioTarget,
}

struct Session {
    live: pipeline::Live,
    preview: Option<pipeline::Preview>,
    audio: audio::Running,
    source: Source,
    cfg: config::Config,
    retries: u32,
    drag: Option<CameraDrag>,
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let want_toggle = args.iter().any(|a| a == "--share" || a == "share");

    gst::init().expect("GStreamer não inicializa");

    #[cfg(unix)]
    if want_toggle && control::forward().await {
        return; // um daemon já estava rodando e recebeu o pedido
    }

    let cfg = match config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[fockytv] {e}");
            std::process::exit(1);
        }
    };

    let (tx, mut rx) = mpsc::unbounded_channel();
    #[cfg(unix)]
    control::listen(tx.clone()).await;
    let tray = tray::spawn(tx.clone(), cfg.hotkey.clone());

    // Ctrl+C / SIGTERM → parar limpo (DELETE do WHIP)
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            #[cfg(unix)]
            {
                use tokio::signal::unix::{signal, SignalKind};
                let mut term = signal(SignalKind::terminate()).unwrap();
                let mut int = signal(SignalKind::interrupt()).unwrap();
                tokio::select! {
                    _ = term.recv() => {}
                    _ = int.recv() => {}
                }
            }
            let _ = tx.send(Cmd::Quit);
        });
    }

    if want_toggle {
        let _ = tx.send(Cmd::Share);
    }

    let mut session: Option<Session> = None;
    while let Some(cmd) = rx.recv().await {
        match cmd {
            Cmd::Share => {
                if session.is_some() {
                    stop_session(&mut session, &tray).await;
                } else {
                    tray.set(tray::State::ChoosingQuality);
                }
            }
            Cmd::StartShare { fps, bitrate } if session.is_none() => {
                let mut share_cfg = cfg.clone();
                share_cfg.fps = fps;
                share_cfg.max_bitrate = bitrate;
                session = start_share(share_cfg, &tray, &tx).await;
            }
            Cmd::StartShare { .. } => {}
            Cmd::Stop => stop_session(&mut session, &tray).await,
            Cmd::Preview => {
                if let Some(s) = &mut session {
                    if let Some(preview) = s.preview.take() {
                        preview.close();
                    }
                    match pipeline::open_preview(tx.clone()) {
                        Ok(preview) => s.preview = Some(preview),
                        Err(e) => eprintln!("[fockytv] {e}"),
                    }
                }
            }
            Cmd::PreviewClosed => {
                if let Some(s) = &mut session {
                    if let Some(preview) = s.preview.take() {
                        preview.close();
                    }
                }
            }
            Cmd::Webcam => {
                if let Some(s) = &mut session {
                    if let Err(e) = pipeline::enable_camera(&mut s.live) {
                        eprintln!("[fockytv] {e}");
                    } else if s.preview.is_none() {
                        let _ = tx.send(Cmd::Preview);
                    }
                }
            }
            Cmd::PreviewPointer { phase, x, y } => adjust_camera(&mut session, phase, x, y),
            Cmd::PreviewKey(key) => adjust_camera_key(&mut session, key),
            Cmd::MirrorWebcam => {
                if let Some(s) = &mut session {
                    pipeline::camera_mirror(&mut s.live);
                }
            }
            Cmd::PipelineFailed => {
                session = restart_or_giveup(session, &tray, &tx).await;
            }
            Cmd::ConfigureHotkey => {
                #[cfg(target_os = "linux")]
                shortcut::configure(tx.clone());
            }
            Cmd::ChooseAudio(pid) => {
                if let Some(s) = &mut session {
                    eprintln!("[fockytv] som exclusivo: pid {pid}");
                    s.audio.set_mode(audio::AudioMode::OnlyPid(pid));
                    #[cfg(target_os = "linux")]
                    {
                        s.source.mode = audio::AudioMode::OnlyPid(pid);
                    }
                    tray.set_disambig(vec![]);
                    let _ = tx.send(Cmd::RefreshStatus);
                }
            }
            Cmd::RefreshStatus => {
                if let Some(s) = &session {
                    let _ = pipeline::refine_bitrate(&s.live, s.cfg.max_bitrate);
                    let text = status_text(&s.live);
                    tray.set(tray::State::Live { status: text });
                }
            }
            Cmd::Quit => {
                stop_session(&mut session, &tray).await;
                break;
            }
        }
    }
}

/// Derruba pipeline+áudio e devolve a fonte pra um restart.
async fn teardown(mut s: Session) -> Source {
    if let Some(preview) = s.preview.take() {
        preview.close();
    }
    #[cfg(target_os = "linux")]
    let pw_video = s.live.video.take();
    let pipe = s.live.pipeline.clone();
    let _ = pipe.send_event(gst::event::Eos::new());
    let drained = tokio::task::spawn_blocking(move || {
        if let Some(bus) = pipe.bus() {
            let _ = bus.timed_pop_filtered(
                gst::ClockTime::from_seconds(2),
                &[gst::MessageType::Eos, gst::MessageType::Error],
            );
        }
        let _ = pipe.set_state(gst::State::Null);
    });
    let _ = tokio::time::timeout(std::time::Duration::from_secs(4), drained).await;
    s.audio.stop().await;
    #[cfg(target_os = "linux")]
    if let Some(v) = pw_video {
        v.stop(); // depois do pipeline: o pw descarta pushes no appsrc morto
    }
    s.source
}

/// O whipsink morreu no meio (400 de host fantasma é o caso comum: o
/// host-takeover do servidor só assume depois de 10s sem RTP). Reconstrói o
/// pipeline com a mesma fonte em vez de derrubar o compartilhamento.
async fn restart_or_giveup(
    session: Option<Session>,
    tray: &tray::TrayHandle,
    tx: &mpsc::UnboundedSender<Cmd>,
) -> Option<Session> {
    let mut retries = session.as_ref().map(|s| s.retries).unwrap_or(0);
    let cfg = session.as_ref()?.cfg.clone();
    let source = teardown(session?).await;
    loop {
        retries += 1;
        if retries > 5 {
            eprintln!("[fockytv] pipeline caiu {retries}× — desistindo");
            tray.set(tray::State::Idle);
            return None;
        }
        eprintln!("[fockytv] reconectando ({retries}/5) em 3s…");
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        #[cfg(target_os = "linux")]
        let built = pipeline::build(&source.fd, source.node, source.size, source.mode, &cfg);
        #[cfg(target_os = "windows")]
        let built = pipeline::build(&source.pick, source.target, &cfg);
        match built {
            Ok((live, audio)) => {
                watch_bus(&live, tx.clone());
                tray.set(tray::State::Live {
                    status: status_text(&live),
                });
                return Some(Session {
                    live,
                    preview: None,
                    audio,
                    source,
                    cfg,
                    retries,
                    drag: None,
                });
            }
            Err(e) => {
                eprintln!("[fockytv] restart falhou: {e}");
            }
        }
    }
}

fn status_text(live: &pipeline::Live) -> String {
    match pipeline::current_caps(live) {
        Some((w, h, fps)) => format!("{w}×{h}@{fps}"),
        None => "…".into(),
    }
}

/// O preview recebe as coordenadas já no espaço do vídeo pelo GstNavigation.
/// Arrastar dentro da webcam move; os últimos 24px do canto inferior direito redimensionam.
fn adjust_camera(session: &mut Option<Session>, phase: PointerPhase, x: i32, y: i32) {
    let Some(s) = session else { return };
    match phase {
        PointerPhase::Down => {
            let Some((cam_x, cam_y, width, height)) = pipeline::camera_rect(&s.live) else {
                return;
            };
            // Folga de 16px: a caixinha é pequena na tela, mirar exato nela é chato.
            const MARGIN: i32 = 16;
            if x < cam_x - MARGIN
                || y < cam_y - MARGIN
                || x > cam_x + width + MARGIN
                || y > cam_y + height + MARGIN
            {
                return;
            }
            s.drag = Some(if x >= cam_x + width - 24 && y >= cam_y + height - 24 {
                CameraDrag::Resize {
                    start_x: x,
                    start_width: width,
                }
            } else {
                CameraDrag::Move {
                    offset_x: x - cam_x,
                    offset_y: y - cam_y,
                }
            });
        }
        PointerPhase::Move => match s.drag {
            Some(CameraDrag::Move { offset_x, offset_y }) => {
                pipeline::camera_set_position(&mut s.live, x - offset_x, y - offset_y)
            }
            Some(CameraDrag::Resize {
                start_x,
                start_width,
            }) => pipeline::camera_set_width(&mut s.live, start_width + x - start_x),
            None => {}
        },
        PointerPhase::Up => s.drag = None,
    }
}

fn adjust_camera_key(session: &mut Option<Session>, key: PreviewKey) {
    let Some(s) = session else { return };
    let Some((x, y, width, _)) = pipeline::camera_rect(&s.live) else {
        return;
    };
    match key {
        PreviewKey::Left => pipeline::camera_set_position(&mut s.live, x - 32, y),
        PreviewKey::Right => pipeline::camera_set_position(&mut s.live, x + 32, y),
        PreviewKey::Up => pipeline::camera_set_position(&mut s.live, x, y - 32),
        PreviewKey::Down => pipeline::camera_set_position(&mut s.live, x, y + 32),
        PreviewKey::Grow => pipeline::camera_set_width(&mut s.live, width + 32),
        PreviewKey::Shrink => pipeline::camera_set_width(&mut s.live, width - 32),
    }
}

async fn start_share(
    cfg: config::Config,
    tray: &tray::TrayHandle,
    tx: &mpsc::UnboundedSender<Cmd>,
) -> Option<Session> {
    tray.set(tray::State::Picking);
    tray.set_disambig(vec![]);

    #[cfg(target_os = "linux")]
    let (live, running, source, cands) = start_linux(&cfg, tray).await?;
    #[cfg(target_os = "windows")]
    let (live, running, source, cands) = start_windows(&cfg, tray).await?;

    // erros do pipeline derrubam a sessão sozinhos (bus → Stop)
    watch_bus(&live, tx.clone());

    tray.set_disambig(cands);
    tray.set(tray::State::Live {
        status: status_text(&live),
    });
    // caps reais negociam um pouco depois: reler pro status e afinar bitrate
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            let _ = tx.send(Cmd::RefreshStatus);
        });
    }
    Some(Session {
        live,
        preview: None,
        audio: running,
        source,
        cfg,
        retries: 0,
        drag: None,
    })
}

/// Fluxo Linux: portal (monitor|janela) + áudio por pw-cat/pw-link.
#[cfg(target_os = "linux")]
async fn start_linux(
    cfg: &config::Config,
    tray: &tray::TrayHandle,
) -> Option<(
    pipeline::Live,
    audio::Running,
    Source,
    Vec<picker::Candidate>,
)> {
    let pick = match picker::pick().await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[fockytv] seleção falhou: {e}");
            tray.set(tray::State::Idle);
            return None;
        }
    };
    eprintln!(
        "[fockytv] fonte: {} (nó {}){}",
        if pick.is_window { "janela" } else { "monitor" },
        pick.node,
        pick.size
            .map(|(w, h)| format!(" {w}×{h}"))
            .unwrap_or_default()
    );

    // modo de áudio: janela → exclusivo do processo (o hyprctl casa a
    // geometria do stream com as janelas); monitor → tudo menos Discord
    let mut mode = audio::AudioMode::Exclude;
    let mut cands: Vec<picker::Candidate> = vec![];
    if pick.is_window {
        let (clients, scales) =
            tokio::join!(picker::linux::hypr_clients(), picker::linux::hypr_scales());
        let mut hits = picker::linux::match_window(&clients, pick.size, &scales);
        eprintln!(
            "[fockytv] match: {} clients, scales {:?}, {} hits (size {:?})",
            clients.len(),
            scales,
            hits.len(),
            pick.size
        );
        if hits.len() > 1 {
            // desempata: se só uma das janelas empatadas toca áudio, é ela
            if let Some(pids) = audio_pids().await {
                let com_audio: Vec<_> = hits
                    .iter()
                    .filter(|c| pids.contains(&c.pid))
                    .cloned()
                    .collect();
                if com_audio.len() == 1 {
                    hits = com_audio;
                }
            }
        }
        match hits.len() {
            0 => {
                eprintln!("[fockytv] janela sem match no hyprctl — escolha o app no tray");
                mode = audio::AudioMode::Pending;
                cands = app_candidates().await;
            }
            1 => {
                eprintln!(
                    "[fockytv] som exclusivo: {} (pid {})",
                    hits[0].class, hits[0].pid
                );
                mode = audio::AudioMode::OnlyPid(hits[0].pid);
            }
            _ => {
                eprintln!(
                    "[fockytv] {} janelas com a mesma geometria — desambigue no tray",
                    hits.len()
                );
                mode = audio::AudioMode::Pending;
                cands = hits;
            }
        }
    }

    let source = Source {
        fd: pick.fd,
        node: pick.node,
        size: pick.size,
        mode,
    };
    match pipeline::build(&source.fd, source.node, source.size, source.mode, cfg) {
        Ok((live, running)) => Some((live, running, source, cands)),
        Err(e) => {
            eprintln!("[fockytv] pipeline: {e}");
            tray.set(tray::State::Idle);
            None
        }
    }
}

/// Fluxo Windows: picker Win32 (HMONITOR/HWND conhecidos na hora — sem
/// desambiguação) + áudio WASAPI por processo no helper.
#[cfg(target_os = "windows")]
async fn start_windows(
    cfg: &config::Config,
    tray: &tray::TrayHandle,
) -> Option<(
    pipeline::Live,
    audio::Running,
    Source,
    Vec<picker::Candidate>,
)> {
    let pick = match tokio::task::spawn_blocking(picker::windows::pick).await {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => {
            eprintln!("[fockytv] seleção falhou: {e}");
            tray.set(tray::State::Idle);
            return None;
        }
        Err(e) => {
            eprintln!("[fockytv] picker morreu: {e}");
            tray.set(tray::State::Idle);
            return None;
        }
    };
    eprintln!(
        "[fockytv] fonte: {} {}×{}",
        if pick.monitor != 0 {
            format!("tela (monitor {})", pick.monitor)
        } else {
            format!("janela [{}] {}", pick.process, pick.title)
        },
        pick.width,
        pick.height
    );

    let target = if pick.hwnd != 0 {
        audio::AudioTarget::WindowHwnd(pick.hwnd)
    } else {
        audio::AudioTarget::AllExceptDiscord
    };
    let source = Source { pick, target };
    match pipeline::build(&source.pick, source.target, cfg) {
        Ok((live, running)) => Some((live, running, source, vec![])),
        Err(e) => {
            eprintln!("[fockytv] pipeline: {e}");
            tray.set(tray::State::Idle);
            None
        }
    }
}

fn watch_bus(live: &pipeline::Live, tx: mpsc::UnboundedSender<Cmd>) {
    use futures::StreamExt;
    let Some(bus) = live.pipeline.bus() else {
        return;
    };
    let mut stream = bus.stream();
    tokio::spawn(async move {
        while let Some(msg) = stream.next().await {
            match msg.view() {
                gst::MessageView::Error(e) => {
                    eprintln!(
                        "[fockytv] erro no pipeline: {} ({})\n  debug: {}",
                        e.error(),
                        e.src().map(|s| s.to_string()).unwrap_or_default(),
                        e.debug().unwrap_or_default()
                    );
                    let _ = tx.send(Cmd::PipelineFailed);
                    return;
                }
                gst::MessageView::Eos(_) => {
                    let _ = tx.send(Cmd::PipelineFailed);
                    return;
                }
                _ => {}
            }
        }
    });
}

async fn stop_session(session: &mut Option<Session>, tray: &tray::TrayHandle) {
    if session.is_some() {
        let _ = teardown(session.take().unwrap()).await;
        eprintln!("[fockytv] parado");
    }
    tray.set_disambig(vec![]);
    tray.set(tray::State::Idle);
}

/// pids com nó de saída de áudio ativo agora (para desempatar janelas)
async fn audio_pids() -> Option<Vec<u32>> {
    let out = tokio::process::Command::new("pw-dump")
        .output()
        .await
        .ok()?;
    let v: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).ok()?;
    let mut pids = vec![];
    for n in &v {
        let Some(props) = n
            .get("info")
            .and_then(|i| i.get("props"))
            .and_then(|p| p.as_object())
        else {
            continue;
        };
        let class_ok = props
            .get("media.class")
            .and_then(|c| c.as_str())
            .map(|c| c == "Stream/Output/Audio")
            .unwrap_or(false);
        if !class_ok {
            continue;
        }
        if let Some(p) = props
            .get("application.process.pid")
            .and_then(|p| p.as_i64())
        {
            pids.push(p as u32);
        }
    }
    Some(pids)
}

/// candidatos manuais: apps que estão tocando áudio agora
async fn app_candidates() -> Vec<picker::Candidate> {
    let Ok(out) = tokio::process::Command::new("pw-dump").output().await else {
        return vec![];
    };
    let Ok(v) = serde_json::from_slice::<Vec<serde_json::Value>>(&out.stdout) else {
        return vec![];
    };
    let mut out = vec![];
    let mut seen = std::collections::HashSet::new();
    for n in &v {
        let Some(props) = n
            .get("info")
            .and_then(|i| i.get("props"))
            .and_then(|p| p.as_object())
        else {
            continue;
        };
        if props.get("media.class").and_then(|c| c.as_str()) != Some("Stream/Output/Audio") {
            continue;
        }
        let bin = props
            .get("application.process.binary")
            .and_then(|b| b.as_str())
            .unwrap_or("?");
        let low = bin.to_lowercase();
        if low.starts_with("pw-cat") || low.starts_with("discord") || low.starts_with("fockytv") {
            continue;
        }
        let Some(pid) = props
            .get("application.process.pid")
            .and_then(|p| p.as_i64())
        else {
            continue;
        };
        if pid <= 0 || !seen.insert(pid) {
            continue;
        }
        let label = props
            .get("application.name")
            .and_then(|n| n.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(bin);
        out.push(picker::Candidate {
            pid: pid as u32,
            class: label.to_string(),
            title: bin.to_string(),
        });
    }
    out.sort_by(|a, b| a.class.to_lowercase().cmp(&b.class.to_lowercase()));
    out
}
