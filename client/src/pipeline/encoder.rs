use gstreamer as gst;
use gstreamer::prelude::*;

/// Escada de encoders de vídeo: hardware primeiro, software por último.
///
/// A escolha não é por nome de elemento — é por probe de verdade: monta um
/// pipeline mínimo com a MESMA string de propriedades do launch real e
/// espera chegar em PAUSED. Um probe que chega em PAUSED provou as três
/// coisas que costumam quebrar separado: o elemento existe (plugin bundled),
/// o driver/device abre (VA sem driver, NV sem CUDA) e as propriedades
/// existem nessa versão do GStreamer. O resultado vale pelo processo; um
/// build que falhe depois invalida o cache pra re-probe na próxima sessão.
///
/// Ordem (Linux):   VAAPI → NVENC → x264 → OpenH264
/// Ordem (Windows): D3D11 → Media Foundation → x264 → OpenH264

// D3d11/Mf só entram na escada do Windows; no Linux o compilador os vê como
// não-construídos, mas a escada é simétrica de propósito.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    VaH264,
    NvH264,
    D3d11H264,
    MfH264,
    X264,
    OpenH264,
}

impl Kind {
    pub fn element(self) -> &'static str {
        match self {
            Kind::VaH264 => "vah264lpenc",
            Kind::NvH264 => "nvh264enc",
            Kind::D3d11H264 => "d3d11h264enc",
            Kind::MfH264 => "mfh264enc",
            Kind::X264 => "x264enc",
            Kind::OpenH264 => "openh264enc",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Kind::VaH264 => "VAAPI (hardware)",
            Kind::NvH264 => "NVENC (hardware)",
            Kind::D3d11H264 => "D3D11 (hardware)",
            Kind::MfH264 => "Media Foundation",
            Kind::X264 => "x264 (software)",
            Kind::OpenH264 => "OpenH264 (software)",
        }
    }

    fn hw(self) -> bool {
        !matches!(self, Kind::X264 | Kind::OpenH264)
    }

    /// Unidade do `bitrate` varia por encoder: openh264 quer bps, os outros
    /// kbps. O refine_bitrate ao vivo usa a mesma conversão.
    pub fn bitrate(self, bps: u64) -> u64 {
        match self {
            Kind::OpenH264 => bps,
            _ => (bps / 1000).max(1),
        }
    }

    /// Chunk do launch (`elemento name=venc props…`). As propriedades de
    /// valores por-string no gst::parse::launch não dependem do tipo gint/
    /// guint de cada encoder — mas os NOMES sim, e o probe valida.
    pub fn props(self, bitrate_bps: u64, gop: u32) -> String {
        let kbps = self.bitrate(bitrate_bps);
        match self {
            Kind::OpenH264 => format!(
                "openh264enc name=venc usage-type=screen rate-control=bitrate \
                 scene-change-detection=false complexity=medium bitrate={kbps} gop-size={gop}"
            ),
            // zerolatency: sem b-frames, sem lookahead — a latência do encode
            // é um quadro. superfast segura 1080p60 realtime com folga.
            Kind::X264 => format!(
                "x264enc name=venc tune=zerolatency speed-preset=superfast \
                 bitrate={kbps} key-int-max={gop}"
            ),
            // LP = VDENC, o bloco de encode leve dos iGPUs Intel/AMD: feito
            // pra realtime e consome pouca CPU. Sem rate-control explícito,
            // o default CBR do plugin serve.
            Kind::VaH264 => format!("vah264lpenc name=venc bitrate={kbps} gop-size={gop}"),
            Kind::NvH264 => format!(
                "nvh264enc name=venc preset=low-latency-hq tune=ultra-low-latency \
                 rc-mode=cbr bitrate={kbps} gop-size={gop}"
            ),
            Kind::D3d11H264 => {
                format!("d3d11h264enc name=venc bitrate={kbps} gop-size={gop}")
            }
            Kind::MfH264 => format!("mfh264enc name=venc bitrate={kbps} gop-size={gop}"),
        }
    }
}

#[cfg(target_os = "linux")]
pub const LADDER: [Kind; 4] = [Kind::VaH264, Kind::NvH264, Kind::X264, Kind::OpenH264];
#[cfg(target_os = "windows")]
pub const LADDER: [Kind; 4] = [Kind::D3d11H264, Kind::MfH264, Kind::X264, Kind::OpenH264];

static CHOSEN: std::sync::Mutex<Option<Kind>> = std::sync::Mutex::new(None);
/// Último bitrate aplicado no venc, JÁ na unidade do encoder escolhido —
/// o refine_bitrate compara com isso em vez de ler a property de tipo
/// variável (gint no Media Foundation, guint no resto).
static APPLIED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn applied_bitrate() -> u64 {
    APPLIED.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn set_applied_bitrate(v: u64) {
    APPLIED.store(v, std::sync::atomic::Ordering::Relaxed);
}

/// Esquece a escolha: o próximo build re-probe a escada do zero (encoder de
/// hardware que morreu com a sessão não pode ficar preso no cache).
pub fn invalidate() {
    *CHOSEN.lock().unwrap() = None;
}

/// O encoder escolhido nesta sessão (unidade de bitrate no refine ao vivo).
pub fn chosen_kind() -> Option<Kind> {
    *CHOSEN.lock().unwrap()
}

/// `knob` vem do config/env: "auto" (default), "hw", "sw" ou o nome exato do
/// elemento. Pedido explícito que não funciona é erro, não fallback silencioso.
pub fn select(knob: &str) -> Result<Kind, String> {
    if let Some(k) = CHOSEN.lock().unwrap().as_ref() {
        return Ok(*k);
    }
    let knob = knob.trim();
    let unknown = |n: &str| {
        format!(
            "encoder desconhecido: {n} (use \"auto\", \"hw\", \"sw\" ou um de: {})",
            LADDER.iter().map(|k| k.element()).collect::<Vec<_>>().join(", ")
        )
    };
    let order: Vec<Kind> = match knob {
        "" | "auto" => LADDER.to_vec(),
        "hw" => LADDER.iter().copied().filter(|k| k.hw()).collect(),
        "sw" => LADDER.iter().copied().filter(|k| !k.hw()).collect(),
        name => vec![*LADDER.iter().find(|k| k.element() == name).ok_or_else(|| unknown(name))?],
    };
    for k in order {
        if probe(k) {
            eprintln!("[fockytv] encoder de vídeo: {} ({})", k.element(), k.label());
            *CHOSEN.lock().unwrap() = Some(k);
            return Ok(k);
        }
        eprintln!("[fockytv] encoder {}: indisponível, tentando o próximo", k.element());
    }
    Err(match knob {
        "hw" => "nenhum encoder de hardware funcionou nesta máquina — verifique o driver \
                 de vídeo (VAAPI/NVENC/D3D11) ou use encoder: auto"
            .into(),
        _ => "nenhum encoder de vídeo funcionou (toda a escada falhou no probe)".into(),
    })
}

fn probe(kind: Kind) -> bool {
    // 5 quadros bastam: chegar em PAUSED = pelo menos 1 buffer negociado,
    // passado pelo encoder e entregue ao fakesink. Sem is-live de propósito:
    // fonte live devolve NoPreroll no PAUSED (não faz preroll) e o teste do
    // resultado teria que aceitar os dois caminhos.
    let launch = format!("videotestsrc num-buffers=5 ! {} ! fakesink", kind.props(6_000_000, 120));
    let parsed = match gst::parse::launch(&launch) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[probe:{}] parse: {e}", kind.element());
            return false;
        }
    };
    let bin = match parsed.dynamic_cast::<gst::Pipeline>() {
        Ok(b) => b,
        Err(_) => {
            eprintln!("[probe:{}] não é pipeline", kind.element());
            return false;
        }
    };
    if let Err(e) = bin.set_state(gst::State::Paused) {
        eprintln!("[probe:{}] set_state: {e}", kind.element());
        return false;
    }
    // get_state devolve Err na falha e Ok(Async) quando estoura o timeout —
    // Success OU NoPreroll em Paused provam que o encode rolou
    let outcome = bin.state(Some(gst::ClockTime::from_seconds(3)));
    let _ = bin.set_state(gst::State::Null);
    match outcome {
        (Ok(state_change), gst::State::Paused, _)
            if matches!(
                state_change,
                gst::StateChangeSuccess::Success | gst::StateChangeSuccess::NoPreroll
            ) =>
        {
            true
        }
        _ => {
            eprintln!("[probe:{}] estado: {outcome:?}", kind.element());
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_tem_o_nome_venc_e_unidade_certa() {
        for kind in LADDER {
            let chunk = kind.props(12_000_000, 120);
            assert!(chunk.starts_with(kind.element()), "chunk sem o elemento: {chunk}");
            assert!(chunk.contains("name=venc"), "chunk sem name=venc: {chunk}");
            if kind == Kind::OpenH264 {
                assert!(chunk.contains("bitrate=12000000"), "esperava bps: {chunk}");
            } else {
                assert!(chunk.contains("bitrate=12000"), "esperava kbps: {chunk}");
            }
        }
    }

    #[test]
    fn escada_termina_num_software() {
        assert!(LADDER.last().unwrap().element() == "openh264enc");
    }

    #[test]
    fn probe_passa_pro_que_a_maquina_tiver() {
        gst::init().unwrap();
        for kind in LADDER {
            if gst::ElementFactory::find(kind.element()).is_some() {
                assert!(probe(kind), "{} existe mas o probe falhou", kind.element());
            }
        }
    }

    #[test]
    fn knob_invalido_e_erro_nao_fallback() {
        assert!(select("h264enc-doido").is_err());
    }

    #[test]
    fn select_auto_acha_algum_da_escada() {
        gst::init().unwrap();
        let k = select("auto").expect("auto sempre acha alguém — openh264 é core");
        assert!(LADDER.contains(&k));
    }

    #[test]
    fn launch_de_producao_parseia_com_o_encoder_escolhido() {
        gst::init().unwrap();
        let k = select("auto").unwrap();
        // cadeia do linux.rs sem o whipsink (que exigiria o server): mesmo
        // formato de chunk, mesma negociação de caps até o payloader
        let launch = format!(
            "appsrc name=vid is-live=true do-timestamp=true format=time max-bytes=8388608 block=true \
             ! queue leaky=downstream max-size-buffers=2 max-size-time=0 \
             ! videorate drop-only=true ! capsfilter caps=video/x-raw,framerate=60/1 \
             ! videoconvert ! compositor name=canvas \
             canvas. ! capsfilter caps=video/x-raw,width=1920,height=1080 ! tee name=out \
             out. ! queue leaky=downstream max-size-buffers=2 max-size-time=0 \
             ! {} ! h264parse ! rtph264pay pt=96 config-interval=-1 ! fakesink \
             out. ! queue ! intervideosink channel=fockytv-share-preview",
            k.props(12_000_000, 120)
        );
        gst::parse::launch(&launch)
            .unwrap_or_else(|e| panic!("launch de produção não parseia: {e}\n{launch}"));
    }
}
