#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AudioMode {
    /// Nada é ligado — aguardando o usuário desambiguar qual app da janela.
    Pending,
    /// Sistema inteiro MENOS Discord/FockyTV (tela inteira: a conversa é
    /// privada e o canal de música local voltaria como eco).
    Exclude,
    /// Só o processo da janela escolhida — o "som exclusivo".
    OnlyPid(u32),
}

mod feeder;
pub use feeder::RATE;

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "linux")]
pub use linux::Running;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "windows")]
pub use windows::{AudioTarget, Running};
