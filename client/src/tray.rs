use crate::picker::Candidate;

use crate::Cmd;

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Idle,
    ChoosingQuality,
    Picking,
    Live { status: String },
}

pub const QUALITY: [(u32, u64); 9] = [
    (15, 2_000_000), (15, 6_000_000), (15, 12_000_000),
    (30, 2_000_000), (30, 6_000_000), (30, 12_000_000),
    (60, 2_000_000), (60, 6_000_000), (60, 12_000_000),
];

pub fn quality_label(fps: u32, bitrate: u64) -> String {
    let name = match bitrate {
        2_000_000 => "econômico",
        6_000_000 => "stream",
        _ => "alta",
    };
    format!("{fps} fps — {} Mbps ({name})", bitrate / 1_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn perfis_cobrem_fps_e_bitrates_pedidos() {
        assert!(QUALITY.iter().any(|p| *p == (15, 2_000_000)));
        assert!(QUALITY.iter().any(|p| *p == (30, 6_000_000)));
        assert!(QUALITY.iter().any(|p| *p == (60, 12_000_000)));
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{quality_label, Candidate, Cmd, State, QUALITY};
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
                State::ChoosingQuality => "FockyTV — escolha a qualidade no menu".to_string(),
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
                State::ChoosingQuality => {
                    items.push(MenuItem::Standard(StandardItem {
                        label: "Escolha a qualidade:".into(),
                        enabled: false,
                        ..Default::default()
                    }));
                    for (fps, bitrate) in QUALITY {
                        items.push(MenuItem::Standard(StandardItem {
                            label: quality_label(fps, bitrate),
                            activate: Box::new(move |t: &mut Self| {
                                let _ = t.tx.send(Cmd::StartShare { fps, bitrate });
                            }),
                            ..Default::default()
                        }));
                    }
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
                label: "Configurar tecla de atalho…".into(),
                activate: Box::new(|t: &mut Self| {
                    let _ = t.tx.send(Cmd::ConfigureHotkey);
                }),
                ..Default::default()
            }));
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

    pub fn spawn(tx: UnboundedSender<Cmd>, _hotkey: Option<String>) -> TrayHandle {
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
    use super::{quality_label, Candidate, Cmd, State, QUALITY};
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
            *self.state.lock().unwrap() = s.clone();
            let _ = self.to_ui.send(s);
        }
        pub fn set_disambig(&self, _c: Vec<Candidate>) {
            // Windows conhece o hwnd desde o picker: nunca desambigua
        }
    }

    /// Tray (tray-icon + muda) e hotkey global (global-hotkey) numa thread
    /// própria com pump de mensagens Win32 — os dois crates exigem uma
    /// message loop na thread que criou os objetos.
    pub fn spawn(tx: UnboundedSender<Cmd>, hotkey: Option<String>) -> TrayHandle {
        let state = Arc::new(Mutex::new(State::Idle));
        let disambig: Arc<Mutex<Vec<Candidate>>> = Arc::new(Mutex::new(vec![]));
        let (to_ui, from_main) = mpsc::channel::<State>();
        std::thread::spawn(move || ui_thread(tx.clone(), from_main, hotkey));
        TrayHandle {
            state,
            disambig,
            to_ui,
        }
    }

    fn ui_thread(tx: UnboundedSender<Cmd>, from_main: mpsc::Receiver<State>, hotkey: Option<String>) -> ! {
        use global_hotkey::hotkey::{Code, HotKey, Modifiers};
        use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
        use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
        use tray_icon::TrayIconBuilder;

        let share = MenuItem::with_id("share", "Compartilhar tela", true, None);
        let stop = MenuItem::with_id("stop", "Parar", false, None);
        let quality = QUALITY.map(|(fps, bitrate)| {
            (MenuItem::with_id(format!("quality-{fps}-{bitrate}"), quality_label(fps, bitrate), false, None), fps, bitrate)
        });
        let hotkey_choices = [
            (MenuItem::with_id("hotkey-f10", "Atalho: Ctrl+Shift+F10", true, None), Code::F10),
            (MenuItem::with_id("hotkey-f11", "Atalho: Ctrl+Shift+F11", true, None), Code::F11),
            (MenuItem::with_id("hotkey-f12", "Atalho: Ctrl+Shift+F12", true, None), Code::F12),
        ];
        let hotkey_label = MenuItem::with_id("hotkey-label", "Configurar atalho (selecione):", false, None);
        let quit = MenuItem::with_id("quit", "Sair", true, None);
        let menu = Menu::new();
        let _ = menu.append_items(&[
            &share,
            &stop,
            &PredefinedMenuItem::separator(),
            &quality[0].0, &quality[1].0, &quality[2].0,
            &quality[3].0, &quality[4].0, &quality[5].0,
            &quality[6].0, &quality[7].0, &quality[8].0,
            &PredefinedMenuItem::separator(),
            &hotkey_label,
            &hotkey_choices[0].0, &hotkey_choices[1].0, &hotkey_choices[2].0,
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
        let default = HotKey::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F12);
        let mut hk = hotkey.and_then(|s| s.parse().ok()).unwrap_or(default);
        if hotkeys.register(hk).is_err() {
            hk = default;
            hotkeys.register(hk).expect("hotkey");
        }

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
                for (item, fps, bitrate) in &quality {
                    if ev.id == *item.id() {
                        let _ = tx.send(Cmd::StartShare { fps: *fps, bitrate: *bitrate });
                    }
                }
                for (item, key) in &hotkey_choices {
                    if ev.id != *item.id() { continue; }
                    let next = HotKey::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), *key);
                    if hotkeys.unregister(hk).is_ok() && hotkeys.register(next).is_ok() {
                        hk = next;
                        if let Err(e) = crate::config::save_hotkey(&hk.into_string()) {
                            eprintln!("[fockytv] {e}");
                        }
                    } else {
                        let _ = hotkeys.register(hk);
                    }
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
                        for (item, ..) in &quality { let _ = item.set_enabled(false); }
                    }
                    State::ChoosingQuality => {
                        let _ = share.set_enabled(false);
                        let _ = share.set_text("Escolha a qualidade abaixo");
                        let _ = stop.set_enabled(false);
                        for (item, ..) in &quality { let _ = item.set_enabled(true); }
                    }
                    State::Picking => {
                        let _ = share.set_enabled(false);
                        let _ = share.set_text("Escolhendo fonte…");
                        for (item, ..) in &quality { let _ = item.set_enabled(false); }
                    }
                    State::Live { status } => {
                        let _ = share.set_text(format!("Ao vivo — {status}"));
                        let _ = share.set_enabled(false);
                        let _ = stop.set_enabled(true);
                        for (item, ..) in &quality { let _ = item.set_enabled(false); }
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
