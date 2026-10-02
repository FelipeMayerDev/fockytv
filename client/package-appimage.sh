#!/usr/bin/env bash
# Empacota o fockytv-share num AppImage autocontido: binário + plugins
# GStreamer que o pipeline usa + libs fechadas por ldd recursivo (fora
# glibc/pilha gráfica, que vêm do host).
set -euo pipefail
cd "$(dirname "$0")"

OUT=FockyTV-Share-x86_64.AppImage
APPDIR=build-appdir
rm -rf "$APPDIR"

ELEMENTS=(pipewiresrc queue videorate capsfilter videoconvert videoscale videoflip compositor
          intervideosink intervideosrc ximagesink textoverlay v4l2src openh264enc videotestsrc
          h264parse rtph264pay opusenc rtpopuspay audioconvert appsrc whipsink
          webrtcbin nicesrc nicesink dtlssrtpenc dtlsenc srtpenc srtpdec
          rtpbin rtpsession rtprtxsend rtpstorage dtlssrtpdec)
# Encoders da escada (src/pipeline/encoder.rs): embute o que existir na
# máquina de build — o probe do cliente escolhe em runtime, e o que faltar
# aqui só reduz a escada (VA no host precisa do intel-media-driver installado
# no sistema de quem executa; libva/x264 vem dentro do AppImage por ldd).
# videotestsrc é obrigatório: é a fonte do probe E do FOCKYTV_TEST_VIDEO.
OPTIONAL=(vah264lpenc vah264enc nvh264enc x264enc)

echo "── build release"
cargo build --release

echo "── AppDir base"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/lib/gstreamer-1.0" "$APPDIR/usr/share/icons/hicolor/256x256/apps"
cp target/release/fockytv-share "$APPDIR/usr/bin/"
# config embutido (padrão de fábrica): o da raiz do repo, mesmo do app
# Electron; um config.json AO LADO do AppImage (ou FOCKYTV_CONFIG) ainda tem
# prioridade sobre ele
if [ -f ../config.json ]; then
    cp ../config.json "$APPDIR/usr/bin/config.json"
elif [ -f config.json ]; then
    cp config.json "$APPDIR/usr/bin/config.json"
fi
cp ../build/icon.png "$APPDIR/usr/share/icons/hicolor/256x256/apps/fockytv-share.png"
cp ../build/icon.png "$APPDIR/.DirIcon"
cp ../build/icon.png "$APPDIR/fockytv-share.png"

cat > "$APPDIR/fockytv-share.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=FockyTV Share
Comment=Compartilhar a tela no FockyTV
Exec=fockytv-share
Icon=fockytv-share
Terminal=false
Categories=Network;AudioVideo;
EOF

echo "── plugins gstreamer"
declare -A SEEN
copy_plugin() {
    local el="$1" so
    # ancorado com indentação: nos elementos o caminho é a linha "Filename"
    # dentro de "Plugin Details" (indentada) — e docs de propriedade podem
    # conter a palavra "Filename" (ex.: multipass-cache-file do x264enc)
    so=$(gst-inspect-1.0 "$el" 2>/dev/null | grep -m1 -oP '^\s+Filename\s+\K\S+' || true)
    if [ -z "$so" ]; then
        return 1
    fi
    [ -n "${SEEN[$so]:-}" ] && return 0
    SEEN[$so]=1
    cp -L "$so" "$APPDIR/usr/lib/gstreamer-1.0/"
}
for el in "${ELEMENTS[@]}"; do
    copy_plugin "$el" || { echo "elemento sem plugin: $el"; exit 1; }
done
for el in "${OPTIONAL[@]}"; do
    copy_plugin "$el" || echo "   opcional ausente (escada sem $el): $el"
done

# libs que vêm do host (glibc, toolchain runtime e pilha gráfica/Wayland)
skip() {
    case "$1" in
        */ld-linux*|*/libc.so*|*/libm.so*|*/libpthread*|*/libdl*|*/librt*|*/libresolv*|*/libanl*|*/libnsl*|*/libutil*|*/libBrokenLocale*)
            ;;
        */libgcc_s.so*|*/libstdc++.so*|*/libGL.so*|*/libEGL.so*|*/libOpenGL*|*/libglapi*|*/libvulkan*|*/libX*|*/libxcb*|*/libxkbcommon*|*/libwayland*|*/libdrm*|*/libgbm*|*/libICE*|*/libSM*|*/libepoxy*)
            ;;
        *)
            return 0
            ;;
    esac
    return 1
}

echo "── libs por ldd recursivo"
mkdir -p "$APPDIR/usr/lib"
copied=1
while [ "$copied" -gt 0 ]; do
    copied=0
    for f in "$APPDIR/usr/bin/"* "$APPDIR/usr/lib/"*.so* "$APPDIR/usr/lib/gstreamer-1.0/"*.so*; do
        # config.json também fica em usr/bin; ldd nele dispara o loader 32-bit.
        [ -x "$f" ] || case "$f" in *.so|*.so.*) ;; *) continue ;; esac
        while read -r lib; do
            [ -f "$lib" ] || continue
            base=$(basename "$lib")
            [ -e "$APPDIR/usr/lib/$base" ] && continue
            skip "$lib" && { cp -L "$lib" "$APPDIR/usr/lib/"; copied=$((copied+1)); }
        done < <(ldd "$f" 2>/dev/null | awk '{print $3}' | grep '\.so' || true)
    done
done
echo "   $(ls "$APPDIR/usr/lib" | wc -l) libs"

cat > "$APPDIR/AppRun" <<'EOF'
#!/usr/bin/env bash
HERE="$(dirname "$(readlink -f "$0")")"
export LD_LIBRARY_PATH="$HERE/usr/lib:$LD_LIBRARY_PATH"
export GST_PLUGIN_SYSTEM_PATH_1_0="$HERE/usr/lib/gstreamer-1.0"
export GST_PLUGIN_PATH_1_0="$HERE/usr/lib/gstreamer-1.0"
# O AppImage já limita os plugins ao conjunto embutido. Escanear no processo
# evita invocar um gst-plugin-scanner externo com loader/libc incompatíveis.
export GST_REGISTRY_FORK=no
exec "$HERE/usr/bin/fockytv-share" "$@"
EOF
chmod +x "$APPDIR/AppRun"

echo "── appimagetool"
if [ ! -x build/appimagetool-x86_64.AppImage ]; then
    mkdir -p build
    curl -sL -o build/appimagetool-x86_64.AppImage \
        https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
    chmod +x build/appimagetool-x86_64.AppImage
fi
if [ ! -d build/appimagetool-squashfs ]; then
    (cd build && ./appimagetool-x86_64.AppImage --appimage-extract >/dev/null && mv squashfs-root appimagetool-squashfs)
fi
rm -f "$OUT"
RUNTIME=build/runtime-x86_64
if [ ! -x "$RUNTIME" ]; then
    curl -fL --retry 3 --retry-delay 2 -o "$RUNTIME" \
        https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64
    chmod +x "$RUNTIME"
fi
build/appimagetool-squashfs/AppRun --runtime-file "$RUNTIME" "$APPDIR" "$OUT"
chmod +x "$OUT"
du -h "$OUT"
echo "OK: $OUT (coloque um config.json ao lado dele)"
