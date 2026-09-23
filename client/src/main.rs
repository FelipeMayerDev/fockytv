mod audio;
mod config;
mod control;
mod picker;
mod pipeline;
mod tray;

use gstreamer as gst;
use gstreamer::prelude::*;
use tokio::sync::mpsc;

enum Cmd {
    Share,
    Stop,
    Quit,
    ChooseAudio(u32),
    RefreshStatus,
}

struct Session {
    live: pipeline::Live,
    audio: audio::Running,
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let want_toggle = args.iter().any(|a| a == "--share" || a == "share");

    gst::init().expect("GStreamer não inicializa");

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
    control::listen(tx.clone()).await;
    let tray = tray::spawn(tx.clone());

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
                    session = start_share(&cfg, &tray, &tx).await;
                }
            }
            Cmd::Stop => stop_session(&mut session, &tray).await,
            Cmd::ChooseAudio(pid) => {
                if let Some(s) = &session {
                    eprintln!("[fockytv] som exclusivo: pid {pid}");
                    s.audio.set_mode(audio::AudioMode::OnlyPid(pid));
                    tray.set_disambig(vec![]);
                    let _ = tx.send(Cmd::RefreshStatus);
                }
            }
            Cmd::RefreshStatus => {
                if let Some(s) = &session {
                    let _ = pipeline::refine_bitrate(&s.live, cfg.max_bitrate);
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

fn status_text(live: &pipeline::Live) -> String {
    match pipeline::current_caps(live) {
        Some((w, h, fps)) => format!("{w}×{h}@{fps}"),
        None => "…".into(),
    }
}

async fn start_share(
    cfg: &config::Config,
    tray: &tray::TrayHandle,
    tx: &mpsc::UnboundedSender<Cmd>,
) -> Option<Session> {
    tray.set(tray::State::Picking);
    tray.set_disambig(vec![]);
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
        let clients = picker::linux::hypr_clients().await;
        let mut hits = picker::linux::match_window(&clients, pick.size, pick.position);
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

    let (live, running) = match pipeline::build(pick.fd, pick.node, pick.size, mode, cfg) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[fockytv] pipeline: {e}");
            tray.set(tray::State::Idle);
            return None;
        }
    };

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
        audio: running,
    })
}

fn watch_bus(live: &pipeline::Live, tx: mpsc::UnboundedSender<Cmd>) {
    use futures::StreamExt;
    let Some(bus) = live.pipeline.bus() else { return };
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
                    let _ = tx.send(Cmd::Stop);
                    return;
                }
                gst::MessageView::Eos(_) => {
                    let _ = tx.send(Cmd::Stop);
                    return;
                }
                _ => {}
            }
        }
    });
}

async fn stop_session(session: &mut Option<Session>, tray: &tray::TrayHandle) {
    if let Some(s) = session.take() {
        let pipe = s.live.pipeline.clone();
        let _ = pipe.send_event(gst::event::Eos::new());
        // dar tempo do whipsink escoar e mandar o DELETE da sessão WHIP
        let drained = tokio::task::spawn_blocking(move || {
            let Some(bus) = pipe.bus() else { return };
            let _ = bus.timed_pop_filtered(
                gst::ClockTime::from_seconds(2),
                &[gst::MessageType::Eos, gst::MessageType::Error],
            );
            let _ = pipe.set_state(gst::State::Null);
        });
        let _ = tokio::time::timeout(std::time::Duration::from_secs(4), drained).await;
        s.audio.stop().await;
        eprintln!("[fockytv] parado");
    }
    tray.set_disambig(vec![]);
    tray.set(tray::State::Idle);
}

/// pids com nó de saída de áudio ativo agora (para desempatar janelas)
async fn audio_pids() -> Option<Vec<u32>> {
    let out = tokio::process::Command::new("pw-dump").output().await.ok()?;
    let v: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).ok()?;
    let mut pids = vec![];
    for n in &v {
        let Some(props) = n.get("info").and_then(|i| i.get("props")).and_then(|p| p.as_object())
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
        if let Some(p) = props.get("application.process.pid").and_then(|p| p.as_i64()) {
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
        let Some(props) = n.get("info").and_then(|i| i.get("props")).and_then(|p| p.as_object())
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
        let Some(pid) = props.get("application.process.pid").and_then(|p| p.as_i64()) else {
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
