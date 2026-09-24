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
          intervideosink intervideosrc ximagesink textoverlay v4l2src openh264enc
          h264parse rtph264pay opusenc rtpopuspay audioconvert appsrc whipsink
          webrtcbin nicesrc nicesink dtlssrtpenc dtlsenc srtpenc srtpdec
          rtpbin rtpsession rtprtxsend rtpstorage dtlssrtpdec)

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
for el in "${ELEMENTS[@]}"; do
    so=$(gst-inspect-1.0 "$el" 2>/dev/null | grep -oP 'Filename\s+\K\S+' || true)
    [ -n "$so" ] || { echo "elemento sem plugin: $el"; exit 1; }
    [ -n "${SEEN[$so]:-}" ] && continue
    SEEN[$so]=1
    cp -L "$so" "$APPDIR/usr/lib/gstreamer-1.0/"
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
