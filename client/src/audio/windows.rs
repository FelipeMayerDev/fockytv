//! Áudio Windows: o helper WASAPI do app Electron (capture.cpp), mesmo
//! protocolo — header "FPCM" (16 bytes: magic + u32 rate + u32 ch + pad)
//! seguido de f32 interleaved no stdout. Modos: `--hwnd N` (áudio exclusivo
//! da árvore de processos da janela) ou `--mix-except` (sistema menos
//! Discord/FockyTV). Helper morto no meio (Discord reiniciando, etc.) →
//! respawn com contador de geração; enquanto isso o pacer mantém silêncio.

use gstreamer_app as gst_app;
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::feeder;

#[derive(Clone, Copy, Debug)]
pub enum AudioTarget {
    /// só a árvore de processos da janela escolhida
    WindowHwnd(isize),
    /// sistema inteiro menos Discord/FockyTV/eu
    AllExceptDiscord,
}

pub const RATE: u32 = feeder::RATE;

/// mesma lista do app Electron (prefixo de nome do executável)
const NEVER: &str = "Discord,FockyTV,fockytv-share";

pub struct Running {
    cancel: Arc<tokio::sync::Notify>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    child: Arc<Mutex<Option<Child>>>,
}

impl Running {
    pub fn set_mode(&self, _m: ()) {} // alvo é fixo no início (hwnd conhecido)
    pub async fn stop(mut self) {
        self.cancel.notify_waiters();
        for t in self.tasks.drain(..) {
            t.abort();
        }
        if let Some(mut c) = self.child.lock().await.take() {
            let _ = c.start_kill();
        }
    }
}

fn helper_path() -> std::path::PathBuf {
    let exe = std::env::current_exe().ok();
    if let Some(p) = exe.as_ref().and_then(|e| e.parent()) {
        let cand = p.join("audio-helper.exe");
        if cand.exists() {
            return cand;
        }
    }
    std::path::PathBuf::from("audio-helper.exe")
}

fn spawn_helper(target: AudioTarget) -> std::io::Result<Child> {
    let mut cmd = Command::new(helper_path());
    match target {
        AudioTarget::WindowHwnd(hwnd) => {
            cmd.arg("--hwnd").arg(hwnd.to_string());
        }
        AudioTarget::AllExceptDiscord => {
            cmd.arg("--mix-except").arg(NEVER);
        }
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
}

pub fn start(target: AudioTarget, appsrc: gst_app::AppSrc) -> Running {
    let cancel = Arc::new(tokio::sync::Notify::new());
    let queue = feeder::spawn(appsrc, cancel.clone());
    let child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let mut tasks = vec![];

    {
        let queue = queue.clone();
        let cancel = cancel.clone();
        let child_slot = child.clone();
        tasks.push(tokio::spawn(async move {
            let mut gen: u32 = 0;
            loop {
                gen += 1;
                let spawned = spawn_helper(target);
                match spawned {
                    Ok(c) => {
                        eprintln!("[fockytv] audio-helper no ar (geração {gen})");
                        *child_slot.lock().await = Some(c);
                    }
                    Err(e) => {
                        eprintln!("[fockytv] audio-helper não subiu ({e}) — silêncio");
                        sleep_or_cancel(&cancel, 3).await;
                        continue;
                    }
                }
                let stdout = {
                    let mut g = child_slot.lock().await;
                    g.as_mut().and_then(|c| c.stdout.take())
                };
                let Some(mut stdout) = stdout else {
                    sleep_or_cancel(&cancel, 3).await;
                    continue;
                };

                // header FPCM: valida e esgota (16 bytes)
                let mut header = [0u8; 16];
                if read_exact_or_die(&mut stdout, &mut header).await.is_err() {
                    eprintln!("[fockytv] helper morreu antes do header (gen {gen})");
                    sleep_or_cancel(&cancel, 3).await;
                    continue;
                }
                if &header[..4] != b"FPCM" {
                    eprintln!("[fockytv] protocolo FPCM inválido do helper (gen {gen})");
                    sleep_or_cancel(&cancel, 3).await;
                    continue;
                }
                let rate = u32::from_le_bytes(header[4..8].try_into().unwrap());
                let ch = u32::from_le_bytes(header[8..12].try_into().unwrap());
                if rate != feeder::RATE || ch != 2 {
                    eprintln!("[fockytv] helper entregou {rate}Hz {ch}ch — esperado 48kHz estéreo");
                    sleep_or_cancel(&cancel, 3).await;
                    continue;
                }

                // laço de PCM até o helper morrer
                let mut buf = [0u8; 1 << 14];
                let mut announced = false;
                loop {
                    match stdout.read(&mut buf).await {
                        Ok(0) | Err(_) => {
                            eprintln!("[fockytv] helper caiu (gen {gen}) — respawn em 3s");
                            break;
                        }
                        Ok(n) => {
                            if !announced {
                                announced = true;
                                eprintln!("[fockytv] primeiro chunk real de áudio (gen {gen})");
                            }
                            queue.lock().await.extend(&buf[..n]);
                        }
                    }
                }
                sleep_or_cancel(&cancel, 3).await;
            }
        }));
    }

    Running {
        cancel,
        tasks,
        child,
    }
}

async fn sleep_or_cancel(cancel: &Arc<tokio::sync::Notify>, secs: u64) {
    tokio::select! {
        _ = tokio::time::sleep(std::time::Duration::from_secs(secs)) => {}
        _ = cancel.notified() => {}
    }
}

async fn read_exact_or_die<S: AsyncReadExt + Unpin>(
    s: &mut S,
    buf: &mut [u8],
) -> std::io::Result<()> {
    s.read_exact(buf).await
}
