use crate::picker::Candidate;

use crate::Cmd;

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Idle,
    Picking,
    Live { status: String },
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{Candidate, Cmd, State};
    use ksni::menu::StandardItem;
    use ksni::blocking::TrayMethods;
    use ksni::{MenuItem, Tray};
    use std::sync::{Arc, Mutex};
    use tokio::sync::mpsc::UnboundedSender;

    pub struct FockyTray {
        pub tx: UnboundedSender<Cmd>,
        pub state: Arc<Mutex<State>>,
        /// Quando o modo janela não identificou o app com certeza, o menu do
        /// tray vira a lista de candidatos do "som exclusivo de:".
        pub disambig: Arc<Mutex<Vec<Candidate>>>,
    }

    impl Tray for FockyTray {
        fn id(&self) -> String {
            "fockytv-share".into()
        }
        fn title(&self) -> String {
            "FockyTV".into()
        }
        fn icon_name(&self) -> String {
            match &*self.state.lock().unwrap() {
                State::Live { .. } => "media-record",
                _ => "video-display",
            }
            .into()
        }
        fn tool_tip(&self) -> ksni::ToolTip {
            let tip = match &*self.state.lock().unwrap() {
                State::Idle => "FockyTV — parado".to_string(),
                State::Picking => "FockyTV — escolhendo fonte…".to_string(),
                State::Live { status } => format!("FockyTV — ao vivo ({status})"),
            };
            ksni::ToolTip {
                title: "FockyTV Share".into(),
                description: tip,
                ..Default::default()
            }
        }
        // clique no ícone = mesma coisa que o atalho
        fn activate(&mut self, _x: i32, _y: i32) {
            let _ = self.tx.send(Cmd::Share);
        }
        fn menu(&self) -> Vec<MenuItem<Self>> {
            let mut items: Vec<MenuItem<Self>> = vec![];
            match &*self.state.lock().unwrap() {
                State::Idle => {
                    items.push(MenuItem::Standard(StandardItem {
                        label: "Compartilhar tela".into(),
                        icon_name: "video-share-symbolic".into(),
                        activate: Box::new(|t: &mut Self| {
                            let _ = t.tx.send(Cmd::Share);
                        }),
                        ..Default::default()
                    }));
                }
                State::Picking => {
                    items.push(MenuItem::Standard(StandardItem {
                        label: "Escolhendo fonte…".into(),
                        enabled: false,
                        ..Default::default()
                    }));
                }
                State::Live { status } => {
                    items.push(MenuItem::Standard(StandardItem {
                        label: format!("Ao vivo — {status}"),
                        enabled: false,
                        ..Default::default()
                    }));
                    items.push(MenuItem::Standard(StandardItem {
                        label: "Parar".into(),
                        icon_name: "media-playback-stop-symbolic".into(),
                        activate: Box::new(|t: &mut Self| {
                            let _ = t.tx.send(Cmd::Stop);
                        }),
                        ..Default::default()
                    }));
                }
            }
            let cands = self.disambig.lock().unwrap().clone();
            if !cands.is_empty() {
                items.push(MenuItem::Separator);
                items.push(MenuItem::Standard(StandardItem {
                    label: "Som exclusivo de:".into(),
                    enabled: false,
                    ..Default::default()
                }));
                for c in cands {
                    items.push(MenuItem::Standard(StandardItem {
                        label: format!("{} — {}", c.class, short(&c.title, 40)),
                        activate: Box::new(move |t: &mut Self| {
                            let _ = t.tx.send(Cmd::ChooseAudio(c.pid));
                        }),
                        ..Default::default()
                    }));
                }
            }
            items.push(MenuItem::Separator);
            items.push(MenuItem::Standard(StandardItem {
                label: "Sair".into(),
                activate: Box::new(|t: &mut Self| {
                    let _ = t.tx.send(Cmd::Quit);
                }),
                ..Default::default()
            }));
            items
        }
    }

    fn short(s: &str, n: usize) -> String {
        if s.chars().count() <= n {
            s.to_string()
        } else {
            let cut: String = s.chars().take(n).collect();
            format!("{cut}…")
        }
    }

    pub struct TrayHandle {
        pub state: Arc<Mutex<State>>,
        pub disambig: Arc<Mutex<Vec<Candidate>>>,
        // o handle do ksni bloqueante chama block_on (runtime próprio dele):
        // só pode ser tocado pela thread dedicada do tray
        updates: std::sync::mpsc::Sender<()>,
    }

    impl TrayHandle {
        pub fn set(&self, s: State) {
            *self.state.lock().unwrap() = s;
            let _ = self.updates.send(());
        }
        pub fn set_disambig(&self, c: Vec<Candidate>) {
            *self.disambig.lock().unwrap() = c;
            let _ = self.updates.send(());
        }
    }

    pub fn spawn(tx: UnboundedSender<Cmd>) -> TrayHandle {
        let state = Arc::new(Mutex::new(State::Idle));
        let disambig: Arc<Mutex<Vec<Candidate>>> = Arc::new(Mutex::new(vec![]));
        let tray = FockyTray {
            tx,
            state: state.clone(),
            disambig: disambig.clone(),
        };
        let (updates, rx) = std::sync::mpsc::channel::<()>();
        let (ready, ready_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let handle = match tray.spawn() {
                Ok(h) => h,
                Err(e) => {
                    let _ = ready.send(Err(e.to_string()));
                    return;
                }
            };
            let _ = ready.send(Ok(()));
            // cada mensagem = um refresh do menu/ícone; canal fecha = sair
            while rx.recv().is_ok() {
                handle.update(|_| {});
            }
        });
        match ready_rx.recv() {
            Ok(Ok(())) => {}
            Ok(Err(e)) => panic!("sem StatusNotifierItem (tray) disponível: {e}"),
            Err(_) => panic!("thread do tray morreu"),
        }
        TrayHandle {
            state,
            disambig,
            updates,
        }
    }
}

#[cfg(target_os = "linux")]
pub use imp::{spawn, TrayHandle};

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::{Candidate, Cmd, State};
    use std::sync::{Arc, Mutex};
    use tokio::sync::mpsc::UnboundedSender;

    pub struct TrayHandle {
        pub state: Arc<Mutex<State>>,
        pub disambig: Arc<Mutex<Vec<Candidate>>>,
    }

    impl TrayHandle {
        pub fn set(&self, s: State) {
            *self.state.lock().unwrap() = s;
        }
        pub fn set_disambig(&self, c: Vec<Candidate>) {
            *self.disambig.lock().unwrap() = c;
        }
    }

    pub fn spawn(_tx: UnboundedSender<Cmd>) -> TrayHandle {
        TrayHandle {
            state: Arc::new(Mutex::new(State::Idle)),
            disambig: Arc::new(Mutex::new(vec![])),
        }
    }
}
#[cfg(not(target_os = "linux"))]
pub use imp::{spawn, TrayHandle};
