use serde::Deserialize;
use std::path::PathBuf;

/// Config do client: as mesmas chaves do config.json do app Electron
/// (serverUrl/displayName) mais ajustes opcionais de qualidade.
#[derive(Clone, Debug)]
pub struct Config {
    pub server_url: String,
    pub display_name: String,
    pub fps: u32,
    /// 0 = escolher pela resolução da tela
    pub max_bitrate: u64,
    pub audio_bitrate: u32,
    pub hotkey: Option<String>,
}

#[derive(Deserialize, Default)]
struct Raw {
    #[serde(default)]
    #[serde(rename = "serverUrl")]
    server_url: String,
    #[serde(default)]
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(default)]
    fps: Option<u32>,
    #[serde(default)]
    #[serde(rename = "maxBitrate")]
    max_bitrate: Option<u64>,
    #[serde(default)]
    #[serde(rename = "audioBitrate")]
    audio_bitrate: Option<u32>,
    #[serde(default)]
    hotkey: Option<String>,
}

/// Onde procurar o config.json: variável dedicada, ao lado do AppImage,
/// ao lado do binário, raiz do AppDir e diretório atual.
fn candidates() -> Vec<PathBuf> {
    let mut out = vec![];
    if let Ok(p) = std::env::var("FOCKYTV_CONFIG") {
        out.push(PathBuf::from(p));
    }
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        let p = PathBuf::from(&appimage);
        if let Some(dir) = p.parent() {
            out.push(dir.join("config.json"));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("config.json"));
            // AppImage: binário em AppDir/usr/bin → config na raiz do AppDir
            if let Some(root) = dir.ancestors().nth(2) {
                out.push(root.join("config.json"));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join("config.json"));
    }
    out
}

pub fn load() -> Result<Config, String> {
    let mut raw = Raw::default();
    let mut found: Option<PathBuf> = None;
    for p in candidates() {
        if let Ok(text) = std::fs::read_to_string(&p) {
            raw = serde_json::from_str(&text)
                .map_err(|e| format!("config.json inválido ({}): {e}", p.display()))?;
            found = Some(p);
            break;
        }
    }
    let cfg = Config {
        server_url: std::env::var("FOCKYTV_SERVER")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or(raw.server_url),
        display_name: std::env::var("FOCKYTV_NAME")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or(raw.display_name),
        fps: raw.fps.filter(|f| *f > 0 && *f <= 240).unwrap_or(60),
        max_bitrate: raw.max_bitrate.unwrap_or(0),
        audio_bitrate: raw.audio_bitrate.unwrap_or(192_000),
        hotkey: load_hotkey().or(raw.hotkey),
    };
    if cfg.server_url.is_empty() {
        return Err(format!(
            "sem serverUrl: coloque um config.json (procurado em: {})",
            candidates()
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if cfg.display_name.is_empty() {
        return Err("sem displayName no config.json".into());
    }
    if let Some(p) = found {
        eprintln!("[fockytv] config: {} (server {}, nick {}, {}fps)",
            p.display(), cfg.server_url, cfg.display_name, cfg.fps);
    }
    Ok(cfg)
}

#[cfg(target_os = "windows")]
pub fn save_hotkey(hotkey: &str) -> Result<(), String> {
    let path = settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("criar {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, format!("{{\"hotkey\":{}}}", serde_json::to_string(hotkey).unwrap()))
        .map_err(|e| format!("salvar {}: {e}", path.display()))
}

fn load_hotkey() -> Option<String> {
    serde_json::from_str::<Raw>(&std::fs::read_to_string(settings_path()).ok()?)
        .ok()?
        .hotkey
}

fn settings_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(target_os = "windows"))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")));
    base.unwrap_or_else(|| PathBuf::from(".")).join("fockytv-share/settings.json")
}

/// Bitrate de vídeo pela quantidade de pixels — 60fps em resolução nativa
/// pede folga; quem quiser trava no config.json (maxBitrate).
pub fn bitrate_for(width: u32, height: u32, manual: u64) -> u64 {
    if manual > 0 {
        return manual;
    }
    match width as u64 * height as u64 {
        p if p <= 2_300_000 => 10_000_000,   // ~1080p
        p if p <= 3_800_000 => 16_000_000,   // ~1440p
        _ => 24_000_000,                     // 4K
    }
}
