// audio-helper: captura de áudio por aplicativo no Windows (WASAPI process
// loopback, mesmo mecanismo do "Application Audio Capture" do OBS —
// Windows 10 build 20348+). Escreve em stdout um cabeçalho próprio e o PCM cru:
//
//   "FPCM" u32 sampleRate u32 channels  →  seguido de float32 interleaved.
//
// Modos:
//   --hwnd N          só o áudio do processo da janela N (include tree)
//   --exclude-name X  todo o sistema MENOS a árvore do processo X (ex.: Discord)
//   --mix-except A,B  um loopback por processo que está tocando, pulando os
//                     nomes listados, tudo somado. É o único jeito de excluir
//                     MAIS DE UM app: o process loopback do WASAPI aceita uma
//                     árvore só, e o --exclude-name gasta essa vaga no Discord
//   --mic             microfone via WASAPI exclusivo event-driven (sala de
//                     músicos: 10ms de buffer, sem passar pelo mixer do SO)
//   --test            senoide 440 Hz (validação do pipeline fora do Windows)
//
// Sair basta fechar o stdout (quebra de pipe) ou matar o processo.
//
// Os headers do mingw não trazem a API de process loopback (ela é recente),
// então as estruturas e IIDs são declarados aqui à mão — valores do SDK
// (audioclientactivationparams.h / mmdeviceapi.h).

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <tlhelp32.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <vector>
#include <deque>
#include <string>

// ── o que falta nos headers do mingw ──────────────────────────────────────
enum PROCESS_LOOPBACK_MODE_ {
  PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE_ = 0,
  PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE_ = 1
};
// ORDEM IMPORTA: TargetProcessId vem PRIMEIRO no SDK. Estava invertido aqui,
// e como são dois DWORDs a struct tem o mesmo tamanho — compilava, ativava,
// entregava áudio, e o WASAPI lia o modo como PID e o PID como modo. Em
// exclude isso virava "exclua a árvore do processo 1": som do sistema inteiro,
// Discord junto. Era esse o vazamento. (audioclientactivationparams.h)
struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS_ {
  DWORD TargetProcessId;
  PROCESS_LOOPBACK_MODE_ ProcessLoopbackMode;
};
struct AUDIOCLIENT_ACTIVATION_PARAMS_ {
  int ActivationType;   // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK == 1
  AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS_ ProcessLoopbackParams;
};

static const IID IID_IUnknown_ =
  { 0x00000000, 0x0000, 0x0000, {0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46} };

// Subtipos de formato (ksmedia.h): PCM inteiro e IEEE float
static const GUID GUID_SUBTYPE_PCM_ =
  { 0x00000001, 0x0000, 0x0010, {0x80,0x00,0x00,0xaa,0x00,0x38,0x9b,0x71} };
static const GUID GUID_SUBTYPE_IEEE_FLOAT_ =
  { 0x00000003, 0x0000, 0x0010, {0x80,0x00,0x00,0xaa,0x00,0x38,0x9b,0x71} };

static const IID IID_AAIF_CompletionHandler =
  { 0x41D949AB, 0x9862, 0x444A, {0x80,0xF6,0xC2,0x61,0x33,0x4D,0xA5,0xEB} };

// A ActivateAudioInterfaceAsync exige um handler ágil: sem marshaling
// free-threaded ela recusa na cara dura com E_ILLEGAL_METHOD_CALL (0x8000000E)
// e nada nunca chega a ser capturado. O sample da MS ganha isso de graça via
// FtmBase da WRL; aqui, sem WRL, é o marshaler padrão do COM na mão.
static const IID IID_IAgileObject_ =
  { 0x94EA2B94, 0xE9CC, 0x49E0, {0xC0,0xFF,0xEE,0x64,0xCA,0x8F,0x5B,0x90} };
static const IID IID_IMarshal_ =
  { 0x00000003, 0x0000, 0x0000, {0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46} };

struct IActivateAudioInterfaceAsyncOperation_ : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE GetActivateResult(HRESULT* hr, IUnknown** unk) = 0;
};

struct IActivateAudioInterfaceCompletionHandler_ : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation_* op) = 0;
};

typedef HRESULT (WINAPI *ActivateAudioInterfaceAsync_t)(
  LPCWSTR, REFIID, PROPVARIANT*, IActivateAudioInterfaceCompletionHandler_*,
  IActivateAudioInterfaceAsyncOperation_**);

// ── handler de ativação: acorda quem pediu quando o WASAPI termina ───────
// Evento e marshaler são de instância: no --mix-except há uma ativação por
// processo capturado, e globais poriam uma corrida atrás da outra.
struct Handler : public IActivateAudioInterfaceCompletionHandler_ {
  HANDLE done = nullptr;
  IUnknown* ftm = nullptr;
  STDMETHODIMP QueryInterface(REFIID riid, void** out) override {
    if (!memcmp(&riid, &IID_IUnknown_, sizeof(IID)) ||
        !memcmp(&riid, &IID_AAIF_CompletionHandler, sizeof(IID)) ||
        !memcmp(&riid, &IID_IAgileObject_, sizeof(IID))) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler_*>(this);
      return S_OK;
    }
    if (ftm && !memcmp(&riid, &IID_IMarshal_, sizeof(IID)))
      return ftm->QueryInterface(riid, out);
    *out = nullptr;
    return E_NOINTERFACE;
  }
  // contagem fixa: o objeto vive na pilha do main() do começo ao fim
  STDMETHODIMP_(ULONG) AddRef() override { return 2; }
  STDMETHODIMP_(ULONG) Release() override { return 1; }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation_*) override {
    SetEvent(done);
    return S_OK;
  }
};

static DWORD pid_of_window(uint64_t hwnd) {
  DWORD pid = 0;
  GetWindowThreadProcessId(reinterpret_cast<HWND>(hwnd), &pid);
  return pid;
}

// Sobe a cadeia de pais: se algum ancestral é da família, pid é descendente
// (não é raiz). Limite de saltos contra ciclos de PPID órfãos.
static bool in_parent_tree (DWORD pid, const std::vector<std::pair<DWORD, DWORD>>& procs,
                            bool (*is_family)(DWORD, void*), void* ctx) {
  DWORD cur = pid;
  for (int hops = 0; hops < 32; hops++) {
    DWORD ppid = 0; bool found = false;
    for (auto& pr : procs) if (pr.first == cur) { ppid = pr.second; found = true; break; }
    if (!found || ppid == 0) return false;
    if (is_family(ppid, ctx)) return true;
    cur = ppid;
  }
  return false;
}

// PID raiz da árvore do processo pelo prefixo do nome (ex.: "Discord" casa
// "Discord", "DiscordPTB", "DiscordCanary"). A API de process loopback exclui
// UMA árvore: tem que ser o tronco — qualquer processo fora dela continua
// sendo capturado. Raiz = o processo cujo pai NÃO é da família.
static DWORD pid_of_name(const wchar_t* name) {
  struct Family { std::vector<DWORD> pids; };
  Family fam;
  std::vector<std::pair<DWORD, DWORD>> procs;   // (pid, ppid) de tudo
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W pe = { sizeof(pe) };
  if (Process32FirstW(snap, &pe)) do {
    wchar_t stem[MAX_PATH];
    wcsncpy(stem, pe.szExeFile, MAX_PATH - 1);
    stem[MAX_PATH - 1] = 0;
    wchar_t* dot = wcsrchr(stem, L'.');
    if (dot) *dot = 0;   // "Discord.exe" → "Discord"
    if (!_wcsnicmp(stem, name, wcslen(name))) fam.pids.push_back(pe.th32ProcessID);
    procs.push_back({ pe.th32ProcessID, pe.th32ParentProcessID });
  } while (Process32NextW(snap, &pe));
  CloseHandle(snap);

  auto cb = [](DWORD pid, void* ctx) -> bool {
    for (DWORD f : ((Family*)ctx)->pids) if (f == pid) return true;
    return false;
  };
  for (DWORD pid : fam.pids)
    if (!in_parent_tree(pid, procs, cb, &fam)) return pid;
  return fam.pids.empty() ? 0 : fam.pids[0];
}

static bool write_all(const void* buf, size_t len) {
  const char* p = static_cast<const char*>(buf);
  while (len > 0) {
    DWORD n = 0;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), p, (DWORD)len, &n, nullptr) || n == 0)
      return false;
    p += n;
    len -= n;
  }
  return true;
}

static int run_test() {
  uint32_t rate = 48000, ch = 2;
  char header[16];
  memcpy(header, "FPCM", 4);
  memcpy(header + 4, &rate, 4);
  memcpy(header + 8, &ch, 4);
  memset(header + 12, 0, 4);
  if (!write_all(header, 16)) return 1;
  float buf[960];   // 10ms estéreo
  unsigned phase = 0;
  for (;;) {
    for (int i = 0; i < 960; i += (int)ch) {
      float v = sinf(2.f * 3.14159265f * 440.f * phase / rate) * 0.2f;
      phase = (phase + 1) % rate;
      for (uint32_t c = 0; c < ch; c++) buf[i + (int)c] = v;
    }
    if (!write_all(buf, sizeof(buf))) return 1;
    Sleep(10);
  }
}

// ── modo --mic: microfone em baixa latência (sala de músicos) ─────────────
// WASAPI exclusivo + event-driven: o evento do driver entrega ~10ms por vez,
// sem o mixer compartilhado (que acrescenta 10–30ms e remonteia). Exclusivo é
// exigente com formato: tenta float32 → int32 → int24 → int16 (48k, 2 canais)
// e cai pro modo compartilhado se o device não abrir de jeito nenhum —
// capturar sempre é mais importante que os 20ms de diferença.
//
// Saída: mesmo protocolo FPCM float32 do loopback, então o main.js não muda.

struct WAVEFMT_EXT_ {   // WAVEFORMATEXTENSIBLE (struct própria: headers à parte)
  WAVEFORMATEX fmt;
  WORD samples;         // bits de alinhamento do container
  DWORD channelMask;
  GUID sub;
};

static void ext_init (WAVEFMT_EXT_& e, int bits, bool isFloat, int ch) {
  memset(&e, 0, sizeof(e));
  e.fmt.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  e.fmt.nChannels = ch;
  e.fmt.nSamplesPerSec = 48000;
  e.fmt.wBitsPerSample = bits;
  e.fmt.nBlockAlign = ch * bits / 8;
  e.fmt.nAvgBytesPerSec = 48000 * e.fmt.nBlockAlign;
  e.fmt.cbSize = 22;
  e.samples = bits;
  e.channelMask = ch == 2 ? 0x3 : 0x4;   // stereo/mono
  e.sub = isFloat ? GUID_SUBTYPE_IEEE_FLOAT_ : GUID_SUBTYPE_PCM_;
}

// converte um pacote do formato `bits` inteiro (ou float) pra float32 in-place
// no buffer de saída. `in` pode ser o próprio `out` quando não há conversão.
static void to_float (const BYTE* in, float* out, UINT32 frames, int ch, int bits, bool isFloat) {
  const size_t n = (size_t)frames * ch;
  if (isFloat && bits == 32) {
    if (in != reinterpret_cast<BYTE*>(out)) memcpy(out, in, n * 4);
    return;
  }
  for (size_t i = 0; i < n; i++) {
    if (bits == 16) out[i] = reinterpret_cast<const short*>(in)[i] / 32768.f;
    else if (bits == 32) out[i] = reinterpret_cast<const int*>(in)[i] / 2147483648.f;
    else {   // 24 empacotado
      const BYTE* b = in + i * 3;
      int32_t v = b[0] | (b[1] << 8) | (b[2] << 16);
      if (v & 0x800000) v |= ~0xFFFFFF;   // sinal
      out[i] = v / 8388608.f;
    }
  }
}

static int run_mic () {
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 4;

  IMMDeviceEnumerator* enumerator = nullptr;
  static const IID IID_IMMDeviceEnumerator_ =
    { 0xA95664D2, 0x9614, 0x4F35, {0xA7,0x46,0xDE,0x8D,0xB6,0x36,0x17,0xE6} };
  static const CLSID CLSID_MMDeviceEnumerator_ =
    { 0xBCDE0395, 0xE52F, 0x467C, {0x8E,0x3D,0xC4,0x57,0x92,0x91,0x69,0x2E} };
  if (FAILED(CoCreateInstance(CLSID_MMDeviceEnumerator_, nullptr, CLSCTX_ALL,
                              IID_IMMDeviceEnumerator_, (void**)&enumerator))) return 20;
  IMMDevice* dev = nullptr;
  if (FAILED(enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &dev))) return 21;
  IAudioClient* client = nullptr;
  if (FAILED(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client))) return 22;

  // candidato: bits, float? Tenta exclusivo 10ms com cada um.
  const int PERIOD = 480;   // frames @48k = 10ms
  const REFERENCE_TIME hns10ms = 100000;
  WAVEFMT_EXT_ cands[4];
  bool isFloatC[4] = { true, false, false, false };
  int bitsC[4] = { 32, 32, 24, 16 };
  for (int i = 0; i < 4; i++) ext_init(cands[i], bitsC[i], isFloatC[i], 2);

  int useBits = 32;
  bool useFloat = true, exclusive = false;
  WAVEFORMATEX* sharedFmt = nullptr;
  for (int i = 0; i < 4; i++) {
    HRESULT ok = client->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE,
                                           &cands[i].fmt, nullptr);
    if (SUCCEEDED(ok)) {
      useBits = bitsC[i]; useFloat = isFloatC[i]; exclusive = true;
      fwprintf(stderr, L"mic: exclusivo %s %d-bit\n", isFloatC[i] ? L"float" : L"int", bitsC[i]);
      if (FAILED(client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE,
                                    AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                    hns10ms, hns10ms, &cands[i].fmt, nullptr))) {
        exclusive = false;   // formato aceito mas não abriu: tenta o próximo
        continue;
      }
      break;
    }
  }
  if (!exclusive) {
    // compartilhado event-driven com o formato do mixer: bem mais latência que
    // o exclusivo, mas ainda pula a pipeline de voz do Chromium (AEC/NS/AGC)
    if (FAILED(client->GetMixFormat(&sharedFmt))) return 23;
    useBits = sharedFmt->wBitsPerSample;
    useFloat = sharedFmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT ||
               (sharedFmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
                !memcmp(&reinterpret_cast<WAVEFMT_EXT_*>(sharedFmt)->sub,
                        &GUID_SUBTYPE_IEEE_FLOAT_, sizeof(GUID)));
    fwprintf(stderr, L"mic: compartilhado %s %d-bit %luHz %dch\n",
             useFloat ? L"float" : L"int", useBits,
             (unsigned long)sharedFmt->nSamplesPerSec, (int)sharedFmt->nChannels);
    if (FAILED(client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                  AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                  0, 0, sharedFmt, nullptr))) return 24;
  }

  HANDLE dataReady = CreateEvent(nullptr, FALSE, FALSE, nullptr);
  client->SetEventHandle(dataReady);
  IAudioCaptureClient* cap = nullptr;
  if (FAILED(client->GetService(__uuidof(IAudioCaptureClient), (void**)&cap))) return 25;
  client->Start();

  UINT32 rate = exclusive ? 48000 : sharedFmt->nSamplesPerSec;
  UINT32 ch = exclusive ? 2 : sharedFmt->nChannels;
  char header[16];
  memcpy(header, "FPCM", 4);
  memcpy(header + 4, &rate, 4);
  memcpy(header + 8, &ch, 4);
  memset(header + 12, 0, 4);
  if (!write_all(header, 16)) return 12;

  // pacotes chegam no formato do device: converte pra float32 num buffer de
  // trabalho (0.5s de folga cobre qualquer rajada de evento)
  std::vector<BYTE> in(2 * rate * ch * (useBits / 8));
  std::vector<float> out(2 * rate * ch);
  unsigned long long total = 0;
  int waits = 0;
  for (;;) {
    DWORD w = WaitForSingleObject(dataReady, 2000);
    if (w == WAIT_TIMEOUT) {
      fwprintf(stderr, L"sem evento: total=%llu frames, %d timeouts\n", total, ++waits);
      if (waits > 15) return 14;
      continue;
    }
    waits = 0;
    BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
    while (SUCCEEDED(cap->GetNextPacketSize(&frames)) && frames > 0) {
      if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        memset(out.data(), 0, (size_t)frames * ch * 4);
      } else {
        memcpy(in.data(), data, (size_t)frames * ch * (useBits / 8));
        to_float(in.data(), out.data(), frames, ch, useBits, useFloat);
      }
      if (!write_all(out.data(), (size_t)frames * ch * 4)) goto done;
      total += frames;
      cap->ReleaseBuffer(frames);
    }
  }
done:
  client->Stop();
  if (sharedFmt) CoTaskMemFree(sharedFmt);
  return 0;
}


// ── ativação do process loopback (uma por cliente) ───────────────────────
// A dança inteira do ActivateAudioInterfaceAsync num lugar só: o --mix-except
// faz uma destas por processo capturado.
static IAudioClient* activate_loopback (DWORD pid, PROCESS_LOOPBACK_MODE_ mode) {
  static ActivateAudioInterfaceAsync_t activate = nullptr;
  if (!activate) {
    HMODULE mm = LoadLibraryW(L"mmdevapi.dll");
    if (!mm) return nullptr;
    activate = reinterpret_cast<ActivateAudioInterfaceAsync_t>(
      GetProcAddress(mm, "ActivateAudioInterfaceAsync"));
    if (!activate) return nullptr;
  }

  AUDIOCLIENT_ACTIVATION_PARAMS_ params = {};
  params.ActivationType = 1;   // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
  params.ProcessLoopbackParams.ProcessLoopbackMode = mode;
  params.ProcessLoopbackParams.TargetProcessId = pid;

  PROPVARIANT pv = {};
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  Handler handler;
  handler.done = CreateEvent(nullptr, FALSE, FALSE, nullptr);
  // tem que existir ANTES do activate: é durante a chamada que o COM pede
  // IMarshal ao handler
  if (FAILED(CoCreateFreeThreadedMarshaler(
        static_cast<IActivateAudioInterfaceCompletionHandler_*>(&handler), &handler.ftm))) {
    fwprintf(stderr, L"CoCreateFreeThreadedMarshaler falhou\n");
    CloseHandle(handler.done);
    return nullptr;
  }

  IActivateAudioInterfaceAsyncOperation_* op = nullptr;
  // VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK é um MACRO do SDK, e o que estava
  // aqui era o nome dele em vez do valor. Como caminho de dispositivo isso
  // não existe: GetActivateResult devolvia 0x80070002 (ERROR_FILE_NOT_FOUND).
  HRESULT hr = activate(L"VAD\\Process_Loopback",
                        __uuidof(IAudioClient), &pv, &handler, &op);
  IAudioClient* client = nullptr;
  if (FAILED(hr)) {
    fwprintf(stderr, L"ActivateAudioInterfaceAsync falhou hr=0x%08lX "
             L"(0x8000000E = handler sem marshaling free-threaded; "
             L"0x80070490/0x80004001 = Windows sem a API de process "
             L"loopback, precisa do build 20348+)\n", (unsigned long)hr);
  } else if (WaitForSingleObject(handler.done, 10000) != WAIT_OBJECT_0) {
    fwprintf(stderr, L"timeout na ativacao (pid=%lu)\n", (unsigned long)pid);
  } else if (op) {
    HRESULT got = E_FAIL;
    IUnknown* unk = nullptr;
    if (SUCCEEDED(op->GetActivateResult(&got, &unk)) && SUCCEEDED(got) && unk) {
      unk->QueryInterface(__uuidof(IAudioClient), (void**)&client);
      unk->Release();
    } else {
      fwprintf(stderr, L"ativacao falhou hr=0x%08lX\n", (unsigned long)got);
    }
  }
  if (op) op->Release();
  if (handler.ftm) handler.ftm->Release();
  CloseHandle(handler.done);
  return client;
}

// Initialize + evento + Start, com o formato fixo do loopback.
// NÃO usar GetMixFormat: no endpoint de process loopback ele devolve o do
// dispositivo (que pode vir PCM 16 bits) e o resto do código escreve float32
// — dava PCM lido como float, ou seja, ruído. O WASAPI converte pro que
// pedirmos aqui. E a duração do buffer DEVE ser 0 (sample oficial da
// Microsoft): com 1s a ativação passa, chega um pacote e nada mais.
static bool start_capture (IAudioClient* client, IAudioCaptureClient** cap, HANDLE* ev) {
  WAVEFORMATEX fmt = {};
  fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  fmt.nChannels = 2;
  fmt.nSamplesPerSec = 48000;
  fmt.wBitsPerSample = 32;
  fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
  if (FAILED(client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                0, 0, &fmt, nullptr))) return false;
  *ev = CreateEvent(nullptr, FALSE, FALSE, nullptr);
  client->SetEventHandle(*ev);
  if (FAILED(client->GetService(__uuidof(IAudioCaptureClient), (void**)cap))) return false;
  return SUCCEEDED(client->Start());
}

// ── modo --mix-except: um loopback por app, somados ──────────────────────
// O process loopback exclui UMA árvore. Pra deixar de fora Discord E FockyTV
// o caminho é o inverso: enumerar quem está tocando (sessões de áudio do
// endpoint de saída), abrir um loopback em modo *include* pra cada um que não
// está na lista de exceções, e misturar. É o irmão Windows do supervisor
// PipeWire do main.js, com a mesma forma: varredura de 1s + mixer de 10ms.

struct Proc { DWORD pid, ppid; std::wstring stem; };

static void procs_snapshot (std::vector<Proc>& out) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return;
  PROCESSENTRY32W pe = { sizeof(pe) };
  if (Process32FirstW(snap, &pe)) do {
    std::wstring stem = pe.szExeFile;
    size_t dot = stem.rfind(L'.');
    if (dot != std::wstring::npos) stem.resize(dot);   // "brave.exe" → "brave"
    out.push_back({ pe.th32ProcessID, pe.th32ParentProcessID, stem });
  } while (Process32NextW(snap, &pe));
  CloseHandle(snap);
}

static bool excluded (const std::wstring& stem, const std::vector<std::wstring>& names) {
  for (const auto& n : names)
    if (!n.empty() && !_wcsnicmp(stem.c_str(), n.c_str(), n.size())) return true;
  return false;
}

// PIDs com sessão de áudio ATIVA no endpoint padrão, menos os excluídos.
// Descendente de outro da lista não entra: o include é por árvore, e o mesmo
// áudio entraria duas vezes (uma vez por cliente).
static void playing_pids (const std::vector<std::wstring>& names, std::vector<DWORD>& out) {
  static const IID IID_IMMDeviceEnumerator_ =
    { 0xA95664D2, 0x9614, 0x4F35, {0xA7,0x46,0xDE,0x8D,0xB6,0x36,0x17,0xE6} };
  static const CLSID CLSID_MMDeviceEnumerator_ =
    { 0xBCDE0395, 0xE52F, 0x467C, {0x8E,0x3D,0xC4,0x57,0x92,0x91,0x69,0x2E} };

  IMMDeviceEnumerator* en = nullptr;
  if (FAILED(CoCreateInstance(CLSID_MMDeviceEnumerator_, nullptr, CLSCTX_ALL,
                              IID_IMMDeviceEnumerator_, (void**)&en))) return;
  IMMDevice* dev = nullptr;
  IAudioSessionManager2* mgr = nullptr;
  IAudioSessionEnumerator* se = nullptr;
  int count = 0;
  std::vector<Proc> procs;
  procs_snapshot(procs);
  const DWORD self = GetCurrentProcessId();

  if (SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eConsole, &dev)) &&
      SUCCEEDED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&mgr)) &&
      SUCCEEDED(mgr->GetSessionEnumerator(&se)) &&
      SUCCEEDED(se->GetCount(&count))) {
    for (int i = 0; i < count; i++) {
      IAudioSessionControl* ctl = nullptr;
      if (FAILED(se->GetSession(i, &ctl)) || !ctl) continue;
      IAudioSessionControl2* ctl2 = nullptr;
      AudioSessionState st = AudioSessionStateExpired;
      DWORD pid = 0;
      if (SUCCEEDED(ctl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&ctl2)) && ctl2) {
        ctl->GetState(&st);
        ctl2->GetProcessId(&pid);
        ctl2->Release();
      }
      ctl->Release();
      if (st != AudioSessionStateActive || !pid || pid == self) continue;
      std::wstring stem;
      for (const auto& pr : procs) if (pr.pid == pid) { stem = pr.stem; break; }
      if (excluded(stem, names)) continue;
      out.push_back(pid);
    }
  }
  if (se) se->Release();
  if (mgr) mgr->Release();
  if (dev) dev->Release();
  en->Release();

  // tira quem é descendente de outro já na lista (o include pega a árvore)
  for (size_t i = 0; i < out.size();) {
    DWORD cur = out[i];
    bool dup = false;
    for (int hops = 0; hops < 32 && !dup; hops++) {
      DWORD ppid = 0; bool found = false;
      for (const auto& pr : procs) if (pr.pid == cur) { ppid = pr.ppid; found = true; break; }
      if (!found || !ppid) break;
      for (DWORD other : out) if (other == ppid) dup = true;
      cur = ppid;
    }
    if (dup) out.erase(out.begin() + i); else i++;
  }
}

// uma fonte = um processo capturado; a thread só enche a fila, o mixer come
struct Source {
  DWORD pid = 0;
  IAudioClient* client = nullptr;
  IAudioCaptureClient* cap = nullptr;
  HANDLE ev = nullptr, thread = nullptr;
  volatile LONG stop = 0;
  CRITICAL_SECTION lock;
  std::deque<float> buf;
};

static DWORD WINAPI pump (LPVOID arg) {
  Source* s = static_cast<Source*>(arg);
  const size_t MAXQ = 48000 * 2 / 5;   // 200ms: atrasou, o velho se perde
  while (!InterlockedCompareExchange(&s->stop, 0, 0)) {
    if (WaitForSingleObject(s->ev, 200) != WAIT_OBJECT_0) continue;
    BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
    while (SUCCEEDED(s->cap->GetNextPacketSize(&frames)) && frames > 0) {
      if (FAILED(s->cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
      const size_t n = (size_t)frames * 2;
      EnterCriticalSection(&s->lock);
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) s->buf.insert(s->buf.end(), n, 0.f);
      else {
        const float* f = reinterpret_cast<const float*>(data);
        s->buf.insert(s->buf.end(), f, f + n);
      }
      if (s->buf.size() > MAXQ) s->buf.erase(s->buf.begin(), s->buf.end() - MAXQ);
      LeaveCriticalSection(&s->lock);
      s->cap->ReleaseBuffer(frames);
    }
  }
  return 0;
}

static void source_stop (Source* s) {
  InterlockedExchange(&s->stop, 1);
  if (s->thread) { WaitForSingleObject(s->thread, 1000); CloseHandle(s->thread); }
  if (s->client) { s->client->Stop(); s->client->Release(); }
  if (s->cap) s->cap->Release();
  if (s->ev) CloseHandle(s->ev);
  DeleteCriticalSection(&s->lock);
  delete s;
}

static int run_mix (const char* except_csv) {
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 4;

  std::vector<std::wstring> names;
  {
    wchar_t wide[512];
    MultiByteToWideChar(CP_UTF8, 0, except_csv, -1, wide, 512);
    std::wstring cur;
    for (const wchar_t* p = wide; ; p++) {
      if (*p == L',' || !*p) { if (!cur.empty()) names.push_back(cur); cur.clear(); if (!*p) break; }
      else cur.push_back(*p);
    }
  }
  for (const auto& n : names) fwprintf(stderr, L"mix: fora %ls\n", n.c_str());

  uint32_t rate = 48000, ch = 2;
  char header[16];
  memcpy(header, "FPCM", 4);
  memcpy(header + 4, &rate, 4);
  memcpy(header + 8, &ch, 4);
  memset(header + 12, 0, 4);
  if (!write_all(header, 16)) return 12;

  const UINT32 TICK = 480;                  // 10ms
  std::vector<Source*> srcs;
  std::vector<float> mix(TICK * ch);
  LARGE_INTEGER freq, now;
  QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&now);
  long long next = now.QuadPart;            // relógio do mixer, sem deriva
  long long scanAt = 0;

  for (;;) {
    // varredura: entra quem começou a tocar, sai quem parou/morreu
    QueryPerformanceCounter(&now);
    if (now.QuadPart >= scanAt) {
      scanAt = now.QuadPart + freq.QuadPart;   // 1s
      std::vector<DWORD> want;
      playing_pids(names, want);
      for (DWORD pid : want) {
        bool have = false;
        for (Source* s : srcs) if (s->pid == pid) { have = true; break; }
        if (have) continue;
        IAudioClient* client = activate_loopback(pid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE_);
        if (!client) continue;
        Source* s = new Source();
        s->pid = pid;
        s->client = client;
        InitializeCriticalSection(&s->lock);
        if (!start_capture(client, &s->cap, &s->ev)) {
          fwprintf(stderr, L"mix: pid=%lu nao abriu\n", (unsigned long)pid);
          source_stop(s);
          continue;
        }
        s->thread = CreateThread(nullptr, 0, pump, s, 0, nullptr);
        srcs.push_back(s);
        fwprintf(stderr, L"mix: capturando pid=%lu (%u fontes)\n",
                 (unsigned long)pid, (unsigned)srcs.size());
      }
      for (size_t i = 0; i < srcs.size();) {
        bool keep = false;
        for (DWORD pid : want) if (srcs[i]->pid == pid) { keep = true; break; }
        if (keep) { i++; continue; }
        fwprintf(stderr, L"mix: largando pid=%lu\n", (unsigned long)srcs[i]->pid);
        source_stop(srcs[i]);
        srcs.erase(srcs.begin() + i);
      }
    }

    // mistura 10ms de cada fonte; quem não tem áudio pronto entra como zero.
    // Sem fonte alguma sai silêncio — o relógio do RTP do outro lado segue
    // andando, e é isso que mantém a linha do tempo inteira.
    memset(mix.data(), 0, mix.size() * sizeof(float));
    for (Source* s : srcs) {
      EnterCriticalSection(&s->lock);
      const size_t n = mix.size() < s->buf.size() ? mix.size() : s->buf.size();
      for (size_t i = 0; i < n; i++) mix[i] += s->buf[i];
      s->buf.erase(s->buf.begin(), s->buf.begin() + n);
      LeaveCriticalSection(&s->lock);
    }
    for (float& v : mix) v = v > 1.f ? 1.f : (v < -1.f ? -1.f : v);
    if (!write_all(mix.data(), mix.size() * sizeof(float))) break;

    next += freq.QuadPart / 100;   // 10ms
    QueryPerformanceCounter(&now);
    long long waitMs = (next - now.QuadPart) * 1000 / freq.QuadPart;
    if (waitMs > 0) Sleep((DWORD)waitMs);
    else next = now.QuadPart;      // atrasou muito: reancora, não acumula
  }

  for (Source* s : srcs) source_stop(s);
  return 0;
}

int main(int argc, char** argv) {
    // stdout binário: sem isso o modo texto traduz \n e corrompe o PCM
    _setmode(_fileno(stdout), _O_BINARY);

    if (argc > 1 && !strcmp(argv[1], "--test")) return run_test();
    if (argc > 1 && !strcmp(argv[1], "--mic")) return run_mic();
    if (argc > 2 && !strcmp(argv[1], "--mix-except")) return run_mix(argv[2]);

    DWORD pid = 0;
    PROCESS_LOOPBACK_MODE_ mode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE_;
    if (argc > 2 && !strcmp(argv[1], "--hwnd")) {
      pid = pid_of_window(_strtoui64(argv[2], nullptr, 10));
      if (!pid) { fwprintf(stderr, L"janela sem processo\n"); return 2; }
    } else if (argc > 2 && !strcmp(argv[1], "--exclude-name")) {
      wchar_t name[256];
      MultiByteToWideChar(CP_UTF8, 0, argv[2], -1, name, 256);
      pid = pid_of_name(name);
      if (!pid) { fwprintf(stderr, L"processo nao encontrado\n"); return 3; }
      mode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE_;
    } else {
      fwprintf(stderr, L"uso: --hwnd N | --exclude-name X | --mix-except A,B | --mic | --test\n");
      return 1;
    }
    fwprintf(stderr, L"pid=%lu mode=%d\n", pid, (int)mode);

    if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 4;

    IAudioClient* client = activate_loopback(pid, mode);
    if (!client) { fwprintf(stderr, L"ativacao falhou\n"); return 8; }

    HANDLE dataReady = nullptr;
    IAudioCaptureClient* cap = nullptr;
    if (!start_capture(client, &cap, &dataReady)) return 10;

    uint32_t rate = 48000, ch = 2;
    char header[16];
    memcpy(header, "FPCM", 4);
    memcpy(header + 4, &rate, 4);
    memcpy(header + 8, &ch, 4);
    memset(header + 12, 0, 4);
    if (!write_all(header, 16)) return 12;

    // Silêncio TEM que ir como zeros: o consumidor toca pelo relógio, contando
    // frames. Pular os pacotes silenciosos (o normal quando o app alvo não está
    // tocando nada) encolhia a linha do tempo e picotava tudo depois.
    std::vector<float> zeros;
    unsigned long long total = 0;
    int waits = 0;
    for (;;) {
      DWORD w = WaitForSingleObject(dataReady, 2000);
      if (w == WAIT_TIMEOUT) {
        fwprintf(stderr, L"sem evento: total=%llu frames, %d timeouts\n", total, ++waits);
        if (waits > 15) return 14;   // 30s sem nada: desiste (log claro)
        continue;
      }
      waits = 0;
      BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
      while (SUCCEEDED(cap->GetNextPacketSize(&frames)) && frames > 0) {
        if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
        size_t bytes = (size_t)frames * ch * sizeof(float);
        bool ok;
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
          zeros.assign((size_t)frames * ch, 0.f);
          ok = write_all(zeros.data(), bytes);
        } else {
          ok = write_all(data, bytes);
        }
        total += frames;
        cap->ReleaseBuffer(frames);
        if (!ok) goto done;
      }
    }
done:
    client->Stop();
    return 0;
}
