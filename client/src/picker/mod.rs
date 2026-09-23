#[derive(Clone, Debug)]
pub struct Candidate {
    pub pid: u32,
    pub class: String,
    pub title: String,
}

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "linux")]
pub use linux::pick;

#[cfg(target_os = "windows")]
pub mod windows;
