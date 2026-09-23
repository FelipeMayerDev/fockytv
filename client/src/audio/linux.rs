use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use gstreamer_app as gst_app;
use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

use super::{feeder, AudioMode};

/// Binário cujo áudio NUNCA entra na transmissão (prefixo, sem distinguir
/// maiúsculas): o Discord (conversa privada) e tudo que for FockyTV (o canal
/// de música local voltaria como eco fora de sincronia).
const AUDIO_NEVER: [&str; 2] = ["discord", "fockytv"];

/// Um nó de gravação pw-cat com autoconnect desligado; o poller liga nele os
/// apps aprovados com pw-link (nó↔nó — o PipeWire casa os canais e mistura).
/// O link ADICIONA um caminho: o app continua tocando nos alto-falantes.
pub struct Running {
    mode: Arc<std::sync::RwLock<AudioMode>>,
    cancel: Arc<tokio::sync::Notify>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    child: Arc<Mutex<Option<tokio::process::Child>>>,
}

impl Running {
    pub fn set_mode(&self, m: AudioMode) {
        if let Ok(mut g) = self.mode.write() {
            *g = m;
        }
    }
    pub async fn stop(mut self) {
        self.cancel.notify_waiters();
        for t in self.tasks.drain(..) {
            t.abort();
        }
        if let Some(mut c) = self.child.lock().await.take() {
            let _ = c.start_kill();
        }
    }
}

#[derive(Deserialize)]
struct PwNode {
    id: u32,
    #[serde(rename = "type")]
    ty: String,
    info: Option<PwInfo>,
}

#[derive(Deserialize)]
struct PwInfo {
    props: Option<HashMap<String, Value>>,
}

fn vstr<'a>(p: &'a HashMap<String, Value>, k: &str) -> Option<&'a str> {
    p.get(k).and_then(|v| v.as_str())
}

fn vi64(p: &HashMap<String, Value>, k: &str) -> Option<i64> {
    match p.get(k) {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Mesma regra do linuxSelect do app Electron.
fn eligible(p: &HashMap<String, Value>, own_node: &str, mode: &AudioMode) -> bool {
    if vstr(p, "media.class") != Some("Stream/Output/Audio") {
        return false;
    }
    if vstr(p, "node.name").unwrap_or("").starts_with(own_node) {
        return false;
    }
    match mode {
        AudioMode::Pending => false,
        AudioMode::OnlyPid(pid) => vi64(p, "application.process.pid") == Some(*pid as i64),
        AudioMode::Exclude => {
            let bin = vstr(p, "application.process.binary").unwrap_or("").to_lowercase();
            !AUDIO_NEVER.iter().any(|n| bin.starts_with(n))
        }
    }
}

/// Captura PCM do sistema (ou de um pid só) e empurra no appsrc do pipeline.
pub fn start(mode: AudioMode, appsrc: gst_app::AppSrc) -> Running {
    let mode = Arc::new(std::sync::RwLock::new(mode));
    let cancel = Arc::new(tokio::sync::Notify::new());
    let node_name = format!("fockytv-capture-{}-{}", std::process::id(), now_ms());

    let spawned = spawn_pwcat(&node_name);
    match &spawned {
        Ok(_) => eprintln!("[fockytv] pw-cat no ar ({node_name})"),
        Err(e) => eprintln!("[fockytv] pw-cat NÃO subiu ({e}) — silêncio"),
    }
    let child = Arc::new(Mutex::new(spawned.ok()));
    let mut tasks = vec![];

    // pacer comum (fila → appsrc, completando com silêncio)
    let queue = feeder::spawn(appsrc.clone(), cancel.clone());

    // leitor: stdout do pw-cat → fila
    {
        let child = child.clone();
        let queue = queue.clone();
        tasks.push(tokio::spawn(async move {
            let stdout = {
                let mut guard = child.lock().await;
                match guard.as_mut() {
                    Some(c) => c.stdout.take(),
                    None => None,
                }
            };
            let Some(mut stdout) = stdout else {
                eprintln!("[fockytv] pw-cat sem stdout — silêncio permanente");
                return;
            };
            let mut live = false;
            let mut buf = [0u8; 1 << 14];
            loop {
                match stdout.read(&mut buf).await {
                    Ok(0) | Err(_) => {
                        eprintln!("[fockytv] captura de áudio caiu — silêncio até a próxima");
                        return;
                    }
                    Ok(n) => {
                        if !live {
                            live = true;
                            eprintln!("[fockytv] primeiro chunk real de áudio");
                        }
                        queue.lock().await.extend(&buf[..n]);
                    }
                }
            }
        }));
    }

    // poll de 1s: descobre o id do nosso nó e liga quem é elegível
    {
        let mode = mode.clone();
        let cancel = cancel.clone();
        let node_name = node_name.clone();
        let prefix = "fockytv-capture".to_string();
        tasks.push(tokio::spawn(async move {
            let mut own_id: Option<u32> = None;
            let mut linked: HashSet<i64> = HashSet::new();
            loop {
                poll_once(&node_name, &prefix, &mut own_id, &mut linked, &mode).await;
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
                    _ = cancel.notified() => return,
                }
            }
        }));
    }

    Running {
        mode,
        cancel,
        tasks,
        child,
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn spawn_pwcat(node: &str) -> std::io::Result<tokio::process::Child> {
    use tokio::process::Command;
    // `--record` como opção longa: o pw-cat novo recusa o modo solto
    Command::new("pw-cat")
        .args([
            "--record",
            "--raw",
            "--format",
            "f32",
            "--rate",
            &feeder::RATE.to_string(),
            "--channels",
            "2",
            "-P",
            &format!("{{ node.autoconnect=false node.name={node} }}"),
            "-",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
}

/// Uma rodada do pw-dump/pw-link.
async fn poll_once(
    node_name: &str,
    prefix: &str,
    own_id: &mut Option<u32>,
    linked: &mut HashSet<i64>,
    mode: &Arc<std::sync::RwLock<AudioMode>>,
) {
    let Ok(out) = tokio::process::Command::new("pw-dump").output().await else {
        return;
    };
    let Ok(nodes) = serde_json::from_slice::<Vec<PwNode>>(&out.stdout) else {
        return;
    };
    let nodes: Vec<&PwNode> = nodes
        .iter()
        .filter(|n| n.ty == "PipeWire:Interface:Node")
        .collect();

    if own_id.is_none() {
        *own_id = nodes.iter().find_map(|n| {
            let p = n.info.as_ref()?.props.as_ref()?;
            (vstr(p, "node.name") == Some(node_name)).then_some(n.id)
        });
        if own_id.is_none() {
            return; // nó ainda não registrou
        }
    }
    let own = own_id.unwrap();

    let current = *mode.read().unwrap();
    for n in nodes {
        let Some(props) = n.info.as_ref().and_then(|i| i.props.as_ref()) else {
            continue;
        };
        if !eligible(props, prefix, &current) {
            continue;
        }
        let Some(serial) = vi64(props, "object.serial") else {
            continue;
        };
        if serial <= 0 || linked.contains(&serial) {
            continue;
        }
        linked.insert(serial);
        let who = vstr(props, "application.process.binary")
            .or_else(|| vstr(props, "node.name"))
            .unwrap_or("?");
        match tokio::process::Command::new("pw-link")
            .args([n.id.to_string(), own.to_string()])
            .output()
            .await
        {
            Ok(o) if o.status.success() => {
                eprintln!("[fockytv] áudio ligado: {who} (nó {})", n.id)
            }
            Ok(o) => eprintln!(
                "[fockytv] pw-link {who} falhou: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            ),
            Err(e) => eprintln!("[fockytv] pw-link não rodou: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn props(pairs: &[(&str, Value)]) -> HashMap<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn exclui_discord_e_fockytv() {
        let mut p = props(&[
            ("media.class", Value::String("Stream/Output/Audio".into())),
            ("application.process.binary", Value::String("Discord".into())),
        ]);
        assert!(!eligible(&p, "fockytv-capture", &AudioMode::Exclude));
        p.insert(
            "application.process.binary".into(),
            Value::String("firefox".into()),
        );
        assert!(eligible(&p, "fockytv-capture", &AudioMode::Exclude));
        p.insert(
            "application.process.binary".into(),
            Value::String("fockytv-share".into()),
        );
        assert!(!eligible(&p, "fockytv-capture", &AudioMode::Exclude));
    }

    #[test]
    fn janela_so_o_pid() {
        let p = props(&[
            ("media.class", Value::String("Stream/Output/Audio".into())),
            ("application.process.binary", Value::String("firefox".into())),
            ("application.process.pid", Value::Number(4242.into())),
        ]);
        assert!(eligible(&p, "fockytv-capture", &AudioMode::OnlyPid(4242)));
        assert!(!eligible(&p, "fockytv-capture", &AudioMode::OnlyPid(7)));
        assert!(!eligible(&p, "fockytv-capture", &AudioMode::Pending));
    }

    #[test]
    fn pid_como_string_tambem_conta() {
        let p = props(&[
            ("media.class", Value::String("Stream/Output/Audio".into())),
            ("application.process.pid", Value::String("99".into())),
        ]);
        assert!(eligible(&p, "fockytv-capture", &AudioMode::OnlyPid(99)));
    }

    #[test]
    fn ignora_no_de_captura_proprio() {
        let p = props(&[
            ("media.class", Value::String("Stream/Output/Audio".into())),
            ("node.name", Value::String("fockytv-capture-1-2".into())),
            ("application.process.binary", Value::String("pw-cat".into())),
        ]);
        assert!(!eligible(&p, "fockytv-capture", &AudioMode::Exclude));
    }
}
