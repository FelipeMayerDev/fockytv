//! Alimentador do appsrc: fila + pacer de TICK ms. O lado da captura (pw-cat
//! no Linux, audio-helper no Windows) empilha bytes na fila; o pacer drena
//! num ritmo fixo — fila vazia vira silêncio, porque o m-line de áudio do
//! WHIP só existe se os buffers fluirem (sem link/áudio ativo o capturador
//! não produz nada).

use gstreamer as gst;
use gstreamer_app as gst_app;
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::Mutex;

pub const RATE: u32 = 48_000;
pub const FRAME: usize = 2 * 4; // estéreo f32 interleaved
pub const TICK_MS: u64 = 20;

pub type Queue = Arc<Mutex<VecDeque<u8>>>;

/// Sobe o pacer e devolve a fila pra quem captura empurrar PCM.
pub fn spawn(appsrc: gst_app::AppSrc, cancel: Arc<tokio::sync::Notify>) -> Queue {
    let queue: Queue = Arc::new(Mutex::new(VecDeque::new()));
    let q = queue.clone();
    tokio::spawn(async move {
        let chunk = RATE as usize * FRAME * TICK_MS as usize / 1000; // 7680 = 20ms
        loop {
            let drained: Vec<u8> = {
                let mut q = q.lock().await;
                let take = chunk.min(q.len());
                q.drain(..take).collect()
            };
            let mut buf = drained;
            if buf.len() < chunk {
                buf.resize(chunk, 0); // silêncio pra manter o ritmo
            }
            if push(&appsrc, buf).is_err() {
                eprintln!("[fockytv] appsrc rejeitou buffer (flushing) — feed encerra");
                return;
            }
            // backlog grande (captura gerou mais do que transmitimos): descarta
            // o excesso pra não acumular latência
            let mut q = q.lock().await;
            while q.len() > chunk * 10 {
                q.drain(..chunk);
            }
            drop(q);
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(TICK_MS)) => {}
                _ = cancel.notified() => return,
            }
        }
    });
    queue
}

fn push(appsrc: &gst_app::AppSrc, bytes: Vec<u8>) -> Result<(), ()> {
    let buf = gst::Buffer::from_slice(bytes);
    appsrc.push_buffer(buf).map(|_| ()).map_err(|_| ())
}
