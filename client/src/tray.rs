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
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use tokio::sync::mpsc::UnboundedSender;

    pub struct TrayHandle {
        pub state: Arc<Mutex<State>>,
        pub disambig: Arc<Mutex<Vec<Candidate>>>,
        to_ui: mpsc::Sender<State>,
    }

    impl TrayHandle {
        pub fn set(&self, s: State) {
            *self.state.lock().unwrap() = s;
            let _ = self.to_ui.send(s.clone());
        }
        pub fn set_disambig(&self, _c: Vec<Candidate>) {
            // Windows conhece o hwnd desde o picker: nunca desambigua
        }
    }

    /// Tray (tray-icon + muda) e hotkey global (global-hotkey) numa thread
    /// própria com pump de mensagens Win32 — os dois crates exigem uma
    /// message loop na thread que criou os objetos.
    pub fn spawn(tx: UnboundedSender<Cmd>) -> TrayHandle {
        let state = Arc::new(Mutex::new(State::Idle));
        let disambig: Arc<Mutex<Vec<Candidate>>> = Arc::new(Mutex::new(vec![]));
        let (to_ui, from_main) = mpsc::channel::<State>();
        std::thread::spawn(move || ui_thread(tx.clone(), from_main));
        TrayHandle {
            state,
            disambig,
            to_ui,
        }
    }

    fn ui_thread(tx: UnboundedSender<Cmd>, from_main: mpsc::Receiver<State>) -> ! {
        use global_hotkey::hotkey::{Code, HotKey, Modifiers};
        use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
        use tray_icon::menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem};
        use tray_icon::{TrayIcon, TrayIconBuilder};

        let share = MenuItem::with_id("share", "Compartilhar tela", true, None);
        let stop = MenuItem::with_id("stop", "Parar", false, None);
        let quit = MenuItem::with_id("quit", "Sair", true, None);
        let menu = Menu::new();
        let _ = menu.append_items(&[
            &share,
            &stop,
            &PredefinedMenuItem::separator(),
            &quit,
        ]);

        let icon = load_icon();
        let _tray = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip("FockyTV Share")
            .with_icon(icon)
            .build()
            .expect("tray");

        // Ctrl+Shift+F12 = toggle (hotkey configurável fica pra depois)
        let hotkeys = GlobalHotKeyManager::new().expect("hotkey manager");
        let hk = HotKey::builder()
            .modifiers(Modifiers::CONTROL | Modifiers::SHIFT)
            .key(Code::F12)
            .build();
        hotkeys.register(hk).expect("hotkey");

        let menu_rx = MenuEvent::receiver();
        let hotkey_rx = GlobalHotKeyEvent::receiver();
        let share_id = share.id().clone();
        let stop_id = stop.id().clone();
        let quit_id = quit.id().clone();

        let mut msg = windows::Win32::UI::WindowsAndMessaging::MSG::default();
        loop {
            // pump win32: tray e hotkey entregam eventos pela fila desta thread
            unsafe {
                use windows::Win32::UI::WindowsAndMessaging::*;
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            while let Ok(ev) = menu_rx.try_recv() {
                if ev.id == share_id {
                    let _ = tx.send(Cmd::Share);
                } else if ev.id == stop_id {
                    let _ = tx.send(Cmd::Stop);
                } else if ev.id == quit_id {
                    let _ = tx.send(Cmd::Quit);
                }
            }
            while let Ok(ev) = hotkey_rx.try_recv() {
                if ev.state == HotKeyState::Pressed {
                    let _ = tx.send(Cmd::Share); // toggle
                }
            }
            while let Ok(s) = from_main.try_recv() {
                match s {
                    State::Idle => {
                        let _ = share.set_text("Compartilhar tela");
                        let _ = share.set_enabled(true);
                        let _ = stop.set_enabled(false);
                    }
                    State::Picking => {
                        let _ = share.set_enabled(false);
                        let _ = share.set_text("Escolhendo fonte…");
                    }
                    State::Live { status } => {
                        let _ = share.set_text(format!("Ao vivo — {status}"));
                        let _ = share.set_enabled(false);
                        let _ = stop.set_enabled(true);
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
    }

    fn load_icon() -> tray_icon::Icon {
        let png = include_bytes!("../../build/icon.png");
        let img = image::load_from_memory(png).expect("icon.png inválido");
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        tray_icon::Icon::from_rgba(rgba.into_raw(), w, h).expect("icon rgba")
    }
}
#[cfg(not(target_os = "linux"))]
pub use imp::{spawn, TrayHandle};
