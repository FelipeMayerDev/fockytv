use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

use crate::Cmd;

/// Socket de instância única. No Wayland não existe hotkey global: o bind do
/// compositor chama `fockytv-share --share`, que fala com o daemon por aqui.
fn sock_path() -> PathBuf {
    if let Ok(run) = std::env::var("XDG_RUNTIME_DIR") {
        return PathBuf::from(run).join("fockytv-share.sock");
    }
    let uid = std::fs::metadata("/proc/self")
        .map(|m| std::os::unix::fs::MetadataExt::uid(&m))
        .unwrap_or(1000);
    PathBuf::from(format!("/tmp/fockytv-share-{uid}.sock"))
}

/// Tenta mandar "share" a um daemon já rodando. true = mandou, a gente sai.
pub async fn forward() -> bool {
    let Ok(mut s) = UnixStream::connect(sock_path()).await else {
        return false;
    };
    if s.write_all(b"share\n").await.is_err() {
        return false;
    }
    let mut ack = [0u8; 1];
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), s.read(&mut ack)).await;
    eprintln!("[fockytv] pedido enviado ao client em execução");
    true
}

pub async fn listen(tx: tokio::sync::mpsc::UnboundedSender<Cmd>) {
    let path = sock_path();
    let _ = std::fs::remove_file(&path);
    let Ok(listener) = UnixListener::bind(&path) else {
        eprintln!("[fockytv] aviso: sem socket de controle ({})", path.display());
        return;
    };
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut buf = String::new();
                let mut raw = [0u8; 64];
                let n = sock.read(&mut raw).await.unwrap_or(0);
                buf.push_str(&String::from_utf8_lossy(&raw[..n]));
                if buf.trim() == "share" {
                    let _ = sock.write_all(b"ok").await;
                    let _ = tx.send(Cmd::Share);
                }
            });
        }
    });
}
