//! Captura de tela direto do PipeWire (bypass do gstpipewiresrc).
//!
//! O gstpipewiresrc desta versão morre com encoder na cadeia: a sincronização
//! pseudo-live (pipewire#5459) faz o source esperar antes de entregar cada
//! buffer; com encoder o atraso vira deadlock (pipewire#4797/#5190). Aqui a
//! gente conecta no remote do portal com a API nativa do PipeWire, copia o
//! frame e empurra num appsrc — do appsrc pra frente é GStreamer normal.

use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use pipewire as pw;
use pipewire::spa;

pub struct PwVideo {
    stop: Arc<AtomicBool>,
    loop_thread: Option<std::thread::JoinHandle<()>>,
}

impl PwVideo {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.loop_thread.take() {
            let _ = t.join();
        }
    }
}

/// fd: o remote do portal (fica consumido pelo pw — passe um clone se
/// precisar dele depois); node: id do stream escolhido.
pub fn start(fd: OwnedFd, node: u32, appsrc: gst_app::AppSrc) -> PwVideo {
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let thread = std::thread::Builder::new()
        .name("pw-video".into())
        .spawn(move || run(fd, node, appsrc, stop2))
        .expect("thread pw-video");
    PwVideo {
        stop,
        loop_thread: Some(thread),
    }
}

fn run(fd: OwnedFd, node: u32, appsrc: gst_app::AppSrc, stop: Arc<AtomicBool>) {
    pw::init();
    let mainloop = match pw::main_loop::MainLoopBox::new(None) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[fockytv] pw mainloop: {e}");
            return;
        }
    };
    let context = match pw::context::ContextBox::new(mainloop.loop_(), None) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[fockytv] pw context: {e}");
            return;
        }
    };
    let core = match context.connect_fd(fd, None) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[fockytv] pw connect_fd: {e}");
            return;
        }
    };

    struct UserData {
        format: spa::param::video::VideoInfoRaw,
        appsrc: gst_app::AppSrc,
        started: bool,
    }
    let data = UserData {
        format: Default::default(),
        appsrc: appsrc.clone(),
        started: false,
    };

    let stream = match pw::stream::StreamBox::new(
        &core,
        "fockytv-share",
        pw::properties::properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[fockytv] pw stream: {e}");
            return;
        }
    };

    let listener = stream
        .add_local_listener_with_user_data(data)
        .state_changed(|_, _, old, new| {
            eprintln!("[fockytv] pw estado: {old:?} -> {new:?}");
        })
        .param_changed(|_, user_data, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let (media_type, media_subtype) =
                match pw::spa::param::format_utils::parse_format(param) {
                    Ok(v) => v,
                    Err(_) => return,
                };
            if media_type != spa::param::format::MediaType::Video
                || media_subtype != spa::param::format::MediaSubtype::Raw
            {
                return;
            }
            if let Err(e) = user_data.format.parse(param) {
                eprintln!("[fockytv] formato pw não parseado: {e}");
                return;
            }
            let f = user_data.format.format();
            let size = user_data.format.size();
            eprintln!(
                "[fockytv] pw formato: {:?} {}×{} (framerate {}/{})",
                f,
                size.width,
                size.height,
                user_data.format.framerate().num,
                user_data.format.framerate().denom
            );
            let caps = gst::Caps::builder("video/x-raw")
                .field("format", "BGRA")
                .field("width", size.width as i32)
                .field("height", size.height as i32)
                .field("framerate", gst::Fraction::from(0))
                .field("max-framerate", gst::Fraction::from(120))
                .build();
            user_data.appsrc.set_property("caps", &caps);
        })
        .process(|stream, user_data| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let datas = buffer.datas_mut();
            let Some(data) = datas.first_mut() else { return };
            let chunk = data.chunk();
            let size = chunk.size() as usize;
            let offset = chunk.offset() as usize;
            if size == 0 {
                return;
            }
            let map = match data.data() {
                Some(m) => m,
                None => return,
            };
            let end = (offset + size).min(map.len());
            let frame_bytes = &map[offset..end];
            let buf = gst::Buffer::from_slice(frame_bytes.to_vec());
            if user_data.appsrc.push_buffer(buf).is_err() {
                // pipeline caiu: a tarefa do bus cuida do resto
            }
        })
        .register();
    if let Err(e) = listener {
        eprintln!("[fockytv] pw listener: {e}");
        return;
    }

    // enum format: BGRA (o portal entrega BGRA por padrão)
    let obj = pw::spa::pod::object!(
        pw::spa::utils::SpaTypes::ObjectParamFormat,
        pw::spa::param::ParamType::EnumFormat,
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::MediaType,
            Id,
            pw::spa::param::format::MediaType::Video
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::MediaSubtype,
            Id,
            pw::spa::param::format::MediaSubtype::Raw
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            pw::spa::param::video::VideoFormat::BGRA,
            pw::spa::param::video::VideoFormat::BGRx
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            pw::spa::utils::Rectangle {
                width: 1,
                height: 1
            },
            pw::spa::utils::Rectangle {
                width: 1,
                height: 1
            },
            pw::spa::utils::Rectangle {
                width: 16384,
                height: 16384
            }
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            pw::spa::utils::Fraction { num: 0, denom: 1 },
            pw::spa::utils::Fraction { num: 0, denom: 1 },
            pw::spa::utils::Fraction { num: 240, denom: 1 }
        ),
    );
    let values: Vec<u8> = pw::spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &pw::spa::pod::Value::Object(obj),
    )
    .expect("serializar pod")
    .0
    .into_inner();
    let mut params = [spa::pod::Pod::from_bytes(&values).expect("pod válido")];

    if let Err(e) = stream.connect(
        spa::utils::Direction::Input,
        Some(node),
        pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
        &mut params,
    ) {
        eprintln!("[fockytv] pw connect: {e}");
        return;
    }

    // loop com timeout pra respeitar o stop
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        // itera o mainloop por até 300ms
        mainloop.loop_().iterate(pw::loop_::Timeout::Finite(std::time::Duration::from_millis(300)));
    }
    let _ = stream.disconnect();
    eprintln!("[fockytv] pw captura encerrada");
}
