//! Picker Win32 nativo: uma LISTBOX com monitores e janelas visíveis.
//! Sem framework — RegisterClass + CreateWindow + pump de mensagens, tudo
//! na thread que chama (rode via spawn_blocking).

use std::cell::RefCell;
use std::sync::mpsc;

#[derive(Clone, Debug)]
pub struct Pick {
    /// HMONITOR (modo tela inteira) — 0 quando é janela
    pub monitor: usize,
    /// HWND (modo janela, som exclusivo via helper --hwnd)
    pub hwnd: isize,
    pub title: String,
    pub process: String,
    pub pid: u32,
    pub width: i32,
    pub height: i32,
}

struct Entry {
    label: String,
    pick: Pick,
}

// tudo vive na thread do diálogo
thread_local! {
    static TX: RefCell<Option<mpsc::SyncSender<Option<Pick>>>> = const { RefCell::new(None) };
    static ENTRIES: RefCell<&'static Vec<Entry>> = const { RefCell::new(&Vec::new()) };
}

pub fn pick() -> Result<Pick, String> {
    let (tx, rx) = mpsc::sync_channel(1);
    unsafe {
        let entries: &'static Vec<Entry> = Box::leak(collect_entries().into());
        if entries.is_empty() {
            return Err("nenhuma tela/janela pra compartilhar".into());
        }
        TX.with(|t| *t.borrow_mut() = Some(tx));
        ENTRIES.with(|e| *e.borrow_mut() = entries);

        let hinst = windows::Win32::System::LibraryLoader::GetModuleHandleW(None)
            .map_err(|e| format!("GetModuleHandle: {e}"))?;
        let class_name: Vec<u16> = "FOCKYSHAREPICK".encode_utf16().chain([0]).collect();
        let wc = windows::Win32::UI::WindowsAndMessaging::WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinst.into(),
            lpszClassName: windows::core::PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        windows::Win32::UI::WindowsAndMessaging::RegisterClassW(&wc);

        let (sw, sh) = (
            windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
                windows::Win32::UI::WindowsAndMessaging::SM_CXSCREEN,
            ),
            windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
                windows::Win32::UI::WindowsAndMessaging::SM_CYSCREEN,
            ),
        );
        let (w, h) = (620, 640);
        let title: Vec<u16> = "FockyTV — o que compartilhar?".encode_utf16().chain([0]).collect();
        use windows::Win32::UI::WindowsAndMessaging::*;
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            windows::core::PCWSTR(class_name.as_ptr()),
            windows::core::PCWSTR(title.as_ptr()),
            WS_OVERLAPPEDWINDOW & !WS_MAXIMIZEBOX & !WS_THICKFRAME,
            ((sw - w) / 2) as i32,
            ((sh - h) / 2) as i32,
            w,
            h,
            None,
            None,
            Some(hinst.into()),
            None,
        )
        .map_err(|e| format!("CreateWindow: {e}"))?;

        let list_cls: Vec<u16> = "LISTBOX".encode_utf16().chain([0]).collect();
        let lb = CreateWindowExW(
            WS_EX_CLIENTEDGE,
            windows::core::PCWSTR(list_cls.as_ptr()),
            None,
            WS_CHILD | WS_VISIBLE | WS_VSCROLL | LBS_NOTIFY | LBS_NOINTEGRALHEIGHT,
            10,
            10,
            w - 36,
            h - 70,
            Some(hwnd),
            Some(HMENU(9)),
            Some(hinst.into()),
            None,
        )
        .map_err(|e| format!("listbox: {e}"))?;
        for e in entries {
            let mut s: Vec<u16> = e.label.encode_utf16().collect();
            s.push(0);
            SendMessageW(lb, LB_ADDSTRING, WPARAM(0), s.as_ptr() as _);
        }
        SendMessageW(lb, LB_SETCURSEL, WPARAM(0), LPARAM(0));

        let ok_cls: Vec<u16> = "BUTTON".encode_utf16().chain([0]).collect();
        let ok_txt: Vec<u16> = "Compartilhar".encode_utf16().chain([0]).collect();
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            windows::core::PCWSTR(ok_cls.as_ptr()),
            windows::core::PCWSTR(ok_txt.as_ptr()),
            WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON,
            w - 150,
            h - 58,
            120,
            34,
            Some(hwnd),
            Some(HMENU(10)),
            Some(hinst.into()),
            None,
        )
        .map_err(|e| format!("botão: {e}"))?;

        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
        SetFocus(lb);

        let mut msg = MSG::default();
        loop {
            let r = GetMessageW(&mut msg, None, 0, 0);
            if r.0 <= 0 {
                break;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    match rx.recv() {
        Ok(Some(p)) => Ok(p),
        _ => Err("cancelado".into()),
    }
}

unsafe extern "system" fn wnd_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wp: windows::Win32::Foundation::WPARAM,
    lp: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::*;
    match msg {
        WM_CLOSE => {
            finish(hwnd, None);
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        WM_COMMAND => {
            let code = (wp.0 >> 16) as u16;
            let from = (wp.0 & 0xffff) as u32;
            if code == BN_CLICKED && from == 10 || code == LBN_DBLCLK && from == 9 {
                let lb = GetDlgItem(hwnd, 9);
                let sel = SendMessageW(lb, LB_GETCURSEL, WPARAM(0), LPARAM(0)).0;
                if sel >= 0 {
                    let picked = ENTRIES.with(|e| {
                        let entries = *e.borrow();
                        entries.get(sel as usize).map(|e| e.pick.clone())
                    });
                    finish(hwnd, picked.flatten());
                }
                let _ = DestroyWindow(hwnd);
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

unsafe fn finish(_hwnd: windows::Win32::Foundation::HWND, p: Option<Pick>) {
    TX.with(|t| {
        if let Some(tx) = t.borrow_mut().take() {
            let _ = tx.send(p);
        }
    });
}

unsafe fn collect_entries() -> Vec<Entry> {
    let mut v: Vec<Entry> = vec![];
    use windows::Win32::Graphics::Gdi as gdi;
    let lparam = LPARAM(&mut v as *mut Vec<Entry> as isize);
    let _ = gdi::EnumDisplayMonitors(None, None, Some(monitor_enum), lparam);
    let _ = windows::Win32::UI::WindowsAndMessaging::EnumWindows(Some(win_enum), lparam);
    v
}

unsafe extern "system" fn monitor_enum(
    hmon: windows::Win32::Graphics::Gdi::HMONITOR,
    _hdc: windows::Win32::Graphics::Gdi::HDC,
    rect: *mut windows::Win32::Foundation::RECT,
    l: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::BOOL {
    use windows::Win32::Graphics::Gdi as gdi;
    let v = &mut *(l.0 as *mut Vec<Entry>);
    let w = (*rect).right - (*rect).left;
    let h = (*rect).bottom - (*rect).top;
    let mut info: gdi::MONITORINFOEXW = std::mem::zeroed();
    info.cbSize = std::mem::size_of::<gdi::MONITORINFOEXW>() as u32;
    if gdi::GetMonitorInfoW(hmon, &mut info as *mut _ as *mut gdi::MONITORINFO).as_bool() {
        let device = wide_to_string(info.szDevice.as_ptr());
        let n = v.iter().filter(|e| e.pick.monitor != 0).count();
        v.push(Entry {
            label: format!("🖥  Tela {n} inteira — {w}×{h} ({device})"),
            pick: Pick {
                monitor: hmon.0 as usize,
                hwnd: 0,
                title: format!("Tela {device}"),
                process: String::new(),
                pid: 0,
                width: w,
                height: h,
            },
        });
    }
    windows::Win32::Foundation::BOOL(1)
}

unsafe extern "system" fn win_enum(
    hwnd: windows::Win32::Foundation::HWND,
    l: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::BOOL {
    use windows::Win32::Foundation::*;
    use windows::Win32::Graphics::Dwm::DwmGetWindowAttribute;
    use windows::Win32::UI::WindowsAndMessaging::*;
    let v = &mut *(l.0 as *mut Vec<Entry>);
    if IsWindowVisible(hwnd).0 == 0 {
        return BOOL(1);
    }
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return BOOL(1);
    }
    if (GetWindowLongPtrW(hwnd, GWL_STYLE) as usize as u32) & WS_MINIMIZE.0 != 0 {
        return BOOL(1);
    }
    if (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as usize as u32) & WS_EX_TOOLWINDOW.0 != 0 {
        return BOOL(1);
    }
    if GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT) != 0 {
        return BOOL(1); // filha de outra janela — a dona já entra na lista
    }
    let mut cloaked: u32 = 0;
    if DwmGetWindowAttribute(
        hwnd,
        windows::Win32::Graphics::Dwm::DWMWA_CLOAKED,
        &mut cloaked as *mut u32 as *mut _,
        std::mem::size_of::<u32>() as u32,
    )
    .is_ok()
        && cloaked != 0
    {
        return BOOL(1); // UWP suspensa etc.
    }

    let mut buf = vec![0u16; (len + 1) as usize];
    GetWindowTextW(hwnd, buf.as_mut_ptr(), len + 1);
    let title = wide_to_string(buf.as_ptr());

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let process = process_name(pid);

    let mut rect = RECT::default();
    let _ = GetWindowRect(hwnd, &mut rect);
    v.push(Entry {
        label: format!("🪟  [{process}] {title}"),
        pick: Pick {
            monitor: 0,
            hwnd: hwnd.0 as isize,
            title,
            process,
            pid,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
        },
    });
    BOOL(1)
}

unsafe fn process_name(pid: u32) -> String {
    use windows::Win32::System::Threading::*;
    let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
        return "?".into();
    };
    let mut buf = [0u16; 260];
    let mut n = buf.len() as u32;
    if QueryFullProcessImageNameW(
        h,
        PROCESS_NAME_WIN32,
        windows::core::PWSTR(buf.as_mut_ptr()),
        &mut n,
    )
    .is_ok()
    {
        let full = wide_to_string(buf.as_ptr());
        full.rsplit(['\\', '/']).next().unwrap_or("?").to_string()
    } else {
        "?".into()
    }
}

fn wide_to_string(p: *const u16) -> String {
    let mut len = 0usize;
    unsafe {
        while *p.add(len) != 0 {
            len += 1;
        }
    }
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(p, len) })
}
