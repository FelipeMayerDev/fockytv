// audio-helper: captura de áudio por aplicativo no Windows (WASAPI process
// loopback, mesmo mecanismo do "Application Audio Capture" do OBS —
// Windows 10 build 20348+). Escreve em stdout um cabeçalho próprio e o PCM cru:
//
//   "FPCM" u32 sampleRate u32 channels  →  seguido de float32 interleaved.
//
// Modos:
//   --hwnd N          só o áudio do processo da janela N (include tree)
//   --exclude-name X  todo o sistema MENOS a árvore do processo X (ex.: Discord)
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
#include <tlhelp32.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <vector>

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
static IUnknown* g_ftm = nullptr;

struct IActivateAudioInterfaceAsyncOperation_ : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE GetActivateResult(HRESULT* hr, IUnknown** unk) = 0;
};

struct IActivateAudioInterfaceCompletionHandler_ : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation_* op) = 0;
};

typedef HRESULT (WINAPI *ActivateAudioInterfaceAsync_t)(
  LPCWSTR, REFIID, PROPVARIANT*, IActivateAudioInterfaceCompletionHandler_*,
  IActivateAudioInterfaceAsyncOperation_**);

// ── handler de ativação: só acorda o main quando o WASAPI termina ────────
static HANDLE g_done = nullptr;

struct Handler : public IActivateAudioInterfaceCompletionHandler_ {
  STDMETHODIMP QueryInterface(REFIID riid, void** out) override {
    if (!memcmp(&riid, &IID_IUnknown_, sizeof(IID)) ||
        !memcmp(&riid, &IID_AAIF_CompletionHandler, sizeof(IID)) ||
        !memcmp(&riid, &IID_IAgileObject_, sizeof(IID))) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler_*>(this);
      return S_OK;
    }
    if (g_ftm && !memcmp(&riid, &IID_IMarshal_, sizeof(IID)))
      return g_ftm->QueryInterface(riid, out);
    *out = nullptr;
    return E_NOINTERFACE;
  }
  // contagem fixa: o objeto vive na pilha do main() do começo ao fim
  STDMETHODIMP_(ULONG) AddRef() override { return 2; }
  STDMETHODIMP_(ULONG) Release() override { return 1; }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation_*) override {
    SetEvent(g_done);
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

int main(int argc, char** argv) {
    // stdout binário: sem isso o modo texto traduz \n e corrompe o PCM
    _setmode(_fileno(stdout), _O_BINARY);

    if (argc > 1 && !strcmp(argv[1], "--test")) return run_test();
    if (argc > 1 && !strcmp(argv[1], "--mic")) return run_mic();

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
      fwprintf(stderr, L"uso: --hwnd N | --exclude-name X | --mic | --test\n");
      return 1;
    }
    fwprintf(stderr, L"pid=%lu mode=%d\n", pid, (int)mode);

    if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 4;

    AUDIOCLIENT_ACTIVATION_PARAMS_ params = {};
    params.ActivationType = 1;   // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
    params.ProcessLoopbackParams.ProcessLoopbackMode = mode;
    params.ProcessLoopbackParams.TargetProcessId = pid;

    PROPVARIANT pv = {};
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof(params);
    pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    HMODULE mm = LoadLibraryW(L"mmdevapi.dll");
    if (!mm) return 5;
    auto activate = reinterpret_cast<ActivateAudioInterfaceAsync_t>(
      GetProcAddress(mm, "ActivateAudioInterfaceAsync"));
    if (!activate) return 5;

    g_done = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    Handler handler;
    // tem que existir ANTES do activate: é durante a chamada que o COM pede
    // IMarshal ao handler
    if (FAILED(CoCreateFreeThreadedMarshaler(
          static_cast<IActivateAudioInterfaceCompletionHandler_*>(&handler), &g_ftm))) {
      fwprintf(stderr, L"CoCreateFreeThreadedMarshaler falhou\n");
      return 13;
    }
    IActivateAudioInterfaceAsyncOperation_* op = nullptr;
    // VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK é um MACRO do SDK, e o que estava
    // aqui era o nome dele em vez do valor. Como caminho de dispositivo isso
    // não existe: GetActivateResult devolvia 0x80070002 (ERROR_FILE_NOT_FOUND).
    HRESULT hr = activate(L"VAD\\Process_Loopback",
                          __uuidof(IAudioClient), &pv, &handler, &op);
    if (FAILED(hr)) {
      fwprintf(stderr, L"ActivateAudioInterfaceAsync falhou hr=0x%08lX "
               L"(0x8000000E = handler sem marshaling free-threaded; "
               L"0x80070490/0x80004001 = Windows sem a API de process "
               L"loopback, precisa do build 20348+)\n", (unsigned long)hr);
      return 6;
    }
    if (WaitForSingleObject(g_done, 10000) != WAIT_OBJECT_0) {
      fwprintf(stderr, L"timeout na ativacao\n");
      return 7;
    }

    IAudioClient* client = nullptr;
    if (op) {
      HRESULT got = E_FAIL;
      IUnknown* unk = nullptr;
      if (SUCCEEDED(op->GetActivateResult(&got, &unk)) && SUCCEEDED(got) && unk) {
        unk->QueryInterface(__uuidof(IAudioClient), (void**)&client);
        unk->Release();
      } else {
        fwprintf(stderr, L"ativacao falhou hr=0x%08lX\n", (unsigned long)got);
      }
      op->Release();
    }
    if (!client) { fwprintf(stderr, L"ativacao falhou\n"); return 8; }

    // Formato fixo, não GetMixFormat: no endpoint de process loopback ele não
    // é suportado (devolve o do dispositivo, que pode vir PCM 16 bits) e o
    // resto do código escreve float32 — dava PCM lido como float, ou seja,
    // ruído. O WASAPI converte pro que pedirmos aqui.
    WAVEFORMATEX fmt = {};
    fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    fmt.nChannels = 2;
    fmt.nSamplesPerSec = 48000;
    fmt.wBitsPerSample = 32;
    fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
    // Duração do buffer DEVE ser 0 no process loopback (sample oficial da
    // Microsoft): com 1s a ativação passa, chega um pacote e nada mais —
    // exatamente o "só 100ms de silêncio" medido na máquina de teste.
    if (FAILED(client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                  AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                  0, 0, &fmt, nullptr)))
      return 10;

    HANDLE dataReady = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    client->SetEventHandle(dataReady);
    IAudioCaptureClient* cap = nullptr;
    if (FAILED(client->GetService(__uuidof(IAudioCaptureClient), (void**)&cap))) return 11;
    client->Start();

    uint32_t rate = fmt.nSamplesPerSec, ch = fmt.nChannels;
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
