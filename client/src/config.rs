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
    /// Escada de encoder de vídeo: "auto" (default), "hw", "sw" ou o nome
    /// exato do elemento (ex.: "vah264lpenc", "x264enc").
    pub encoder: String,
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
    encoder: Option<String>,
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
        encoder: std::env::var("FOCKYTV_ENCODER")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .or(raw.encoder.filter(|s| !s.trim().is_empty()))
            .unwrap_or_else(|| "auto".into()),
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
        eprintln!(
            "[fockytv] config: {} (server {}, nick {}, {}fps, encoder {})",
            p.display(),
            cfg.server_url,
            cfg.display_name,
            cfg.fps,
            cfg.encoder
        );
    }
    Ok(cfg)
}

#[cfg(target_os = "windows")]
pub fn save_hotkey(hotkey: &str) -> Result<(), String> {
    let path = settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("criar {}: {e}", dir.display()))?;
    }
    std::fs::write(
        &path,
        format!("{{\"hotkey\":{}}}", serde_json::to_string(hotkey).unwrap()),
    )
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
    base.unwrap_or_else(|| PathBuf::from("."))
        .join("fockytv-share/settings.json")
}

/// Bitrate do Fluxer por resolução/FPS; maxBitrate preserva o override manual.
pub fn bitrate_for(width: u32, height: u32, manual: u64, fps: u32) -> u64 {
    if manual > 0 {
        return manual;
    }
    let pixels = width as u64 * height as u64;
    let index = if fps >= 60 {
        2
    } else if fps >= 30 {
        1
    } else {
        0
    };
    let floor = if pixels < 854 * 480 {
        [300_000, 500_000, 700_000][index]
    } else if pixels < 1280 * 720 {
        [1_200_000, 2_000_000, 3_000_000][index]
    } else if pixels < 1920 * 1080 {
        [2_000_000, 3_000_000, 4_500_000][index]
    } else if pixels < 2560 * 1440 {
        [3_000_000, 4_500_000, 6_000_000][index]
    } else if pixels < 3840 * 2160 {
        [4_000_000, 5_500_000, 6_000_000][index]
    } else {
        [4_500_000, 6_000_000, 6_000_000][index]
    };
    // Perfil de bitrate do Fluxer; limite de fonte/4K em 9 Mbps.
    (pixels * fps as u64 / 50).max(floor).min(9_000_000)
}

#[cfg(test)]
mod bitrate_tests {
    #[test]
    fn fluxer_budget() {
        assert_eq!(super::bitrate_for(1920, 1080, 0, 60), 6_000_000);
        assert_eq!(super::bitrate_for(3840, 2160, 0, 60), 9_000_000);
        assert_eq!(super::bitrate_for(1280, 720, 0, 60), 4_500_000);
        assert_eq!(super::bitrate_for(1280, 720, 0, 30), 3_000_000);
        assert_eq!(super::bitrate_for(1920, 1080, 8_000_000, 60), 8_000_000);
    }
}
