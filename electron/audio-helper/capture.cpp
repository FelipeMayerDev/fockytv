// audio-helper: captura de áudio por aplicativo no Windows (WASAPI process
// loopback, mesmo mecanismo do "Application Audio Capture" do OBS — Windows
// 10 2004+). Escreve em stdout um cabeçalho próprio e o PCM cru:
//
//   "FPCM" u32 sampleRate u32 channels  →  seguido de float32 interleaved.
//
// Modos:
//   --hwnd N          só o áudio do processo da janela N (include tree)
//   --exclude-name X  todo o sistema MENOS a árvore do processo X (ex.: Discord)
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
#include <psapi.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cmath>

// ── o que falta nos headers do mingw ──────────────────────────────────────
enum PROCESS_LOOPBACK_MODE_ {
  PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE_ = 0,
  PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE_ = 1
};
struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS_ {
  PROCESS_LOOPBACK_MODE_ ProcessLoopbackMode;
  DWORD TargetProcessId;
};
struct AUDIOCLIENT_ACTIVATION_PARAMS_ {
  int ActivationType;   // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK == 1
  AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS_ ProcessLoopbackParams;
};

static const IID IID_IUnknown_ =
  { 0x00000000, 0x0000, 0x0000, {0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46} };

static const IID IID_AAIF_CompletionHandler =
  { 0x41D949AB, 0x9862, 0x444A, {0x80,0xF6,0xC2,0x61,0x33,0x4D,0xA5,0xEB} };

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
        !memcmp(&riid, &IID_AAIF_CompletionHandler, sizeof(IID))) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler_*>(this);
      return S_OK;
    }
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

// PID raiz do processo pelo nome (sem ".exe"), para o modo exclude.
static DWORD pid_of_name(const wchar_t* name) {
  DWORD pids[1024], needed = 0;
  if (!EnumProcesses(pids, sizeof(pids), &needed)) return 0;
  for (DWORD i = 0; i < needed / sizeof(DWORD); i++) {
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pids[i]);
    if (!h) continue;
    wchar_t base[MAX_PATH]; DWORD sz = MAX_PATH;
    DWORD hit = 0;
    if (QueryFullProcessImageNameW(h, 0, base, &sz)) {
      wchar_t* stem = wcsrchr(base, L'\\');
      stem = stem ? stem + 1 : base;
      wchar_t* dot = wcsrchr(stem, L'.');
      if (dot) *dot = 0;   // "Discord.exe" → "Discord"
      if (!_wcsicmp(stem, name)) hit = pids[i];
    }
    CloseHandle(h);
    if (hit) return hit;
  }
  return 0;
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

int main(int argc, char** argv) {
    // stdout binário: sem isso o modo texto traduz \n e corrompe o PCM
    _setmode(_fileno(stdout), _O_BINARY);

    if (argc > 1 && !strcmp(argv[1], "--test")) return run_test();

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
      fwprintf(stderr, L"uso: --hwnd N | --exclude-name X | --test\n");
      return 1;
    }

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
    IActivateAudioInterfaceAsyncOperation_* op = nullptr;
    if (FAILED(activate(L"VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK",
                        __uuidof(IAudioClient), &pv, &handler, &op)))
      return 6;
    if (WaitForSingleObject(g_done, 10000) != WAIT_OBJECT_0) return 7;

    IAudioClient* client = nullptr;
    if (op) {
      HRESULT got = E_FAIL;
      IUnknown* unk = nullptr;
      if (SUCCEEDED(op->GetActivateResult(&got, &unk)) && SUCCEEDED(got) && unk) {
        unk->QueryInterface(__uuidof(IAudioClient), (void**)&client);
        unk->Release();
      }
      op->Release();
    }
    if (!client) { fwprintf(stderr, L"ativacao falhou\n"); return 8; }

    WAVEFORMATEX* fmt = nullptr;
    if (FAILED(client->GetMixFormat(&fmt)) || !fmt) return 9;
    if (FAILED(client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                  AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                  10000000 /*1s*/, 0, fmt, nullptr)))
      return 10;

    HANDLE dataReady = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    client->SetEventHandle(dataReady);
    IAudioCaptureClient* cap = nullptr;
    if (FAILED(client->GetService(__uuidof(IAudioCaptureClient), (void**)&cap))) return 11;
    client->Start();

    uint32_t rate = fmt->nSamplesPerSec, ch = fmt->nChannels;
    char header[16];
    memcpy(header, "FPCM", 4);
    memcpy(header + 4, &rate, 4);
    memcpy(header + 8, &ch, 4);
    memset(header + 12, 0, 4);
    if (!write_all(header, 16)) return 12;

    for (;;) {
      WaitForSingleObject(dataReady, 2000);
      BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
      while (SUCCEEDED(cap->GetNextPacketSize(&frames)) && frames > 0) {
        if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
        if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT))
          if (!write_all(data, (size_t)frames * ch * sizeof(float))) goto done;
        cap->ReleaseBuffer(frames);
      }
    }
done:
    client->Stop();
    return 0;
}
