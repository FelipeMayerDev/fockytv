use serde::Deserialize;
use std::os::fd::OwnedFd;

use super::Candidate;
use ashpd::desktop::screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType};

/// O que o portal entregou depois da escolha do usuário.
pub struct Pick {
    pub fd: OwnedFd,
    pub node: u32,
    pub is_window: bool,
    /// Tamanho/posição no espaço lógico do compositor (podem estar ausentes).
    pub size: Option<(i32, i32)>,
}

/// Abre o diálogo nativo do portal (monitor OU janela) e devolve a fonte.
/// Não usa restore token: cada compartilhamento precisa permitir nova escolha.
pub async fn pick() -> Result<Pick, String> {
    let proxy = Screencast::new()
        .await
        .map_err(|e| format!("portal indisponível: {e}"))?;
    let session = proxy
        .create_session(Default::default())
        .await
        .map_err(|e| format!("create_session: {e}"))?;

    let opts = SelectSourcesOptions::default()
        .set_cursor_mode(CursorMode::Embedded)
        .set_sources(SourceType::Monitor | SourceType::Window)
        .set_multiple(false);
    proxy
        .select_sources(&session, opts)
        .await
        .map_err(|e| format!("select_sources: {e}"))?;

    let streams = proxy
        .start(&session, None, Default::default())
        .await
        .map_err(|e| format!("start: {e}"))?
        .response()
        .map_err(|e| format!("seleção cancelada ({e})"))?;
    let stream = streams
        .streams()
        .first()
        .ok_or("o portal não devolveu stream nenhum")?;

    let node = stream.pipe_wire_node_id();
    let is_window = stream.source_type() == Some(SourceType::Window);
    let fd = proxy
        .open_pipe_wire_remote(&session, Default::default())
        .await
        .map_err(|e| format!("open_pipe_wire_remote: {e}"))?;

    // A Session do ashpd manda Close no Drop — se ela morrer, o portal
    // derruba a stream. Enquanto não guardamos direito, segura ela viva.
    std::mem::forget(session);

    Ok(Pick {
        fd,
        node,
        is_window,
        size: stream.size(),
    })
}

// ── casamento da janela escolhida com os clientes do Hyprland ──────────────
// O portal não diz QUAL janela foi escolhida; ele entrega o tamanho (e às
// vezes a posição) no espaço lógico. O hyprctl lista as janelas com
// at/size/pid — a geometria bate, a gente acha o processo, e o áudio
// exclusivo vira um pw-link naquele pid.

#[derive(Deserialize, Clone, Debug)]
pub struct HyprClient {
    #[serde(rename = "initialClass")]
    pub class: String,
    pub title: String,
    pub pid: i64,
    pub size: Vec<i64>,
    #[serde(default)]
    pub mapped: bool,
}

pub async fn hypr_clients() -> Vec<HyprClient> {
    let out = tokio::process::Command::new("hyprctl")
        .args(["clients", "-j"])
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => serde_json::from_slice(&o.stdout).unwrap_or_default(),
        _ => vec![],
    }
}

/// Escalas dos monitores (o portal entrega o tamanho do stream em pixels
/// FÍSICOS; o hyprctl lista as janelas em lógico — sem dividir pela escala
/// o casamento nunca bate em monitor com scale ≠ 1).
pub async fn hypr_scales() -> Vec<f64> {
    let out = tokio::process::Command::new("hyprctl")
        .args(["monitors", "-j"])
        .output()
        .await;
    let mut scales = vec![1.0];
    if let Ok(o) = out {
        if let Ok(list) = serde_json::from_slice::<Vec<serde_json::Value>>(&o.stdout) {
            for m in list {
                if let Some(s) = m.get("scale").and_then(|s| s.as_f64()) {
                    if s > 0.0 && !scales.contains(&s) {
                        scales.push(s);
                    }
                }
            }
        }
    }
    scales
}

/// Candidatos cuja geometria casa com a do stream. Casa por TAMANHO em cada
/// escala de monitor — a posição que o portal entrega pra janela não são
/// coordenadas globais (aqui veio (0,0)) e só atrapalha. Mesmo pid em
/// várias janelas (abas maximizadas) conta uma vez.
pub fn match_window(
    clients: &[HyprClient],
    size: Option<(i32, i32)>,
    scales: &[f64],
) -> Vec<Candidate> {
    let Some((w, h)) = size else { return vec![] };
    let tol = 4i64;
    let mut out: Vec<Candidate> = vec![];
    for c in clients {
        if !c.mapped || c.pid <= 0 || c.size.len() != 2 {
            continue;
        }
        let ok = scales.iter().any(|s| {
            (c.size[0] as f64 - w as f64 / s).abs() <= tol as f64
                && (c.size[1] as f64 - h as f64 / s).abs() <= tol as f64
        });
        if ok && !out.iter().any(|x| x.pid == c.pid as u32) {
            out.push(Candidate {
                pid: c.pid as u32,
                class: c.class.clone(),
                title: c.title.clone(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(class: &str, pid: i64, _x: i64, _y: i64, w: i64, h: i64) -> HyprClient {
        HyprClient {
            class: class.into(),
            title: format!("{class} window"),
            pid,
            size: vec![w, h],
            mapped: true,
        }
    }

    #[test]
    fn casa_por_tamanho_e_posicao() {
        let clients = vec![
            client("firefox", 100, 0, 0, 1920, 1080),
            client("game", 200, 100, 50, 1280, 720),
            client("unmapped", 0, 0, 0, 1280, 720),
        ];
        let hit = match_window(&clients, Some((1280, 720)), &[1.0]);
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].pid, 200);
    }

    #[test]
    fn sem_posicao_casa_so_por_tamanho() {
        let clients = vec![
            client("firefox", 100, 0, 0, 1920, 1080),
            client("outro", 300, 500, 500, 1920, 1080),
        ];
        // mesmo tamanho = 2 pids distintos: ambos (desambiguação decide)
        let hit = match_window(&clients, Some((1920, 1080)), &[1.0]);
        assert_eq!(hit.len(), 2);
    }

    #[test]
    fn monitor_com_scale_casa_em_pixels_fisicos() {
        // portal: 1894×1098 físico; hyprctl: 1184×686 lógico (scale 1.6)
        // duas janelas do MESMO pid com mesma geometria: 1 candidato
        let clients = vec![
            client("brave", 42, 8, 56, 1184, 686),
            client("brave", 42, 8, 56, 1184, 686),
        ];
        let hit = match_window(&clients, Some((1894, 1098)), &[1.0, 1.6]);
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].pid, 42);
    }
}
