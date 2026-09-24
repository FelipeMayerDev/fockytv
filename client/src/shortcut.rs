use crate::Cmd;
use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
use futures::StreamExt;
use std::sync::OnceLock;
use tokio::sync::mpsc::UnboundedSender;

static CONFIGURE: OnceLock<UnboundedSender<()>> = OnceLock::new();

/// O portal guarda a escolha do usuário; se o desktop não o implementar, o
/// bind do compositor documentado no README continua funcionando.
pub fn configure(tx: UnboundedSender<Cmd>) {
    if let Some(configure) = CONFIGURE.get() {
        let _ = configure.send(());
        return;
    }
    let (configure, mut requests) = tokio::sync::mpsc::unbounded_channel();
    if CONFIGURE.set(configure).is_err() {
        return;
    }
    tokio::spawn(async move {
        let Ok(portal) = GlobalShortcuts::new().await else {
            eprintln!("[fockytv] portal de atalhos indisponível");
            return;
        };
        let Ok(session) = portal.create_session(Default::default()).await else {
            eprintln!("[fockytv] sessão de atalhos falhou");
            return;
        };
        let shortcut = NewShortcut::new("share", "Compartilhar/parar tela");
        let Ok(request) = portal
            .bind_shortcuts(&session, &[shortcut], None, Default::default())
            .await
        else {
            eprintln!("[fockytv] não foi possível registrar o atalho");
            return;
        };
        if request.response().is_err() {
            eprintln!("[fockytv] atalho recusado pelo portal");
            return;
        }
        let Ok(mut events) = portal.receive_activated().await else {
            return;
        };
        let _ = portal
            .configure_shortcuts(&session, None, Default::default())
            .await;
        loop {
            tokio::select! {
                Some(_) = requests.recv() => {
                    let _ = portal.configure_shortcuts(&session, None, Default::default()).await;
                }
                Some(event) = events.next() => {
                    if event.shortcut_id() == "share" {
                        let _ = tx.send(Cmd::Share);
                    }
                }
                else => return,
            }
        }
    });
}
