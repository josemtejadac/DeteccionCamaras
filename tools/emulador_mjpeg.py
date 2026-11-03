"""Serve the screen of an Android emulator (LDPlayer) as MJPEG on localhost.

HubVision can then use it as a "Cámara WiFi (URL)" source:
    http://127.0.0.1:8090/video

It reads the emulator through ADB, so it does not depend on the browser capturing the emulator
window (which comes out black with some renderers). Two modes:
  - video (default): continuous H.264 screen recording decoded here. Smooth, needs `pip install av`.
  - capturas: one screenshot at a time. Slower (about 2-3 images per second) but needs no extra library.

Requirements: Python 3 with Pillow (pip install pillow), and ADB debugging enabled in LDPlayer
(Ajustes > Otros > Depuración ADB > Abrir conexión local).

Usage:
    python emulador_mjpeg.py [--modo video|capturas] [--adb RUTA] [--serial emulator-5554]
                             [--port 8090] [--fps 10] [--width 960] [--crop x,y,ancho,alto]
"""
import argparse
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

from PIL import Image


class Latest:
    """Most recent JPEG frame, shared between the capture thread and the HTTP handlers."""

    def __init__(self):
        self.lock = threading.Lock()
        self.frame = None
        self.seq = 0


state = Latest()


def publish(jpeg):
    with state.lock:
        state.frame = jpeg
        state.seq += 1


def to_jpeg(img):
    buf = BytesIO()
    img.save(buf, 'JPEG', quality=80)
    return buf.getvalue()


def screenshot(adb, serial):
    """One raw screenshot as an RGB image (the raw header is 12 or 16 bytes depending on Android)."""
    raw = subprocess.run([adb, '-s', serial, 'exec-out', 'screencap'], capture_output=True, timeout=15).stdout
    w = int.from_bytes(raw[0:4], 'little')
    h = int.from_bytes(raw[4:8], 'little')
    offset = len(raw) - w * h * 4
    if offset not in (12, 16):
        raise RuntimeError('Respuesta de screencap inesperada (' + str(len(raw)) + ' bytes)')
    return Image.frombuffer('RGBA', (w, h), raw[offset:], 'raw', 'RGBA', 0, 1).convert('RGB')


def screenshots_loop(adb, serial, crop, width, fps):
    interval = 1.0 / fps
    last_error = None
    while True:
        started = time.time()
        try:
            img = screenshot(adb, serial)
            if crop:
                x, y, cw, ch = crop
                img = img.crop((x, y, x + cw, y + ch))
            if width and img.width > width:
                img = img.resize((width, round(img.height * width / img.width)), Image.BILINEAR)
            publish(to_jpeg(img))
            last_error = None
        except Exception as err:  # keep serving; the emulator may be restarting
            if str(err) != last_error:
                print('No se pudo capturar el emulador:', err)
                last_error = str(err)
            time.sleep(2)
        time.sleep(max(0, interval - (time.time() - started)))


def video_loop(adb, serial, crop, width, fps):
    import av  # imported here so the screenshots mode works without it

    native_w, native_h = screenshot(adb, serial).size
    out_w = width - width % 2
    out_h = round(out_w * native_h / native_w)
    out_h -= out_h % 2
    scale = out_w / native_w
    crop_scaled = tuple(round(v * scale) for v in crop) if crop else None
    min_gap = 1.0 / fps
    print('Video del emulador: %dx%d -> %dx%d' % (native_w, native_h, out_w, out_h))

    command = [
        adb, '-s', serial, 'exec-out', 'screenrecord',
        '--output-format=h264', '--size', '%dx%d' % (out_w, out_h),
        '--bit-rate', '4000000', '--time-limit', '170', '-',
    ]
    while True:  # screenrecord stops after its time limit, so it is restarted
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        codec = av.CodecContext.create('h264', 'r')
        last_emit = 0.0
        try:
            while True:
                chunk = proc.stdout.read1(65536)
                if not chunk:
                    break
                for packet in codec.parse(chunk):
                    for frame in codec.decode(packet):
                        now = time.time()
                        if now - last_emit < min_gap:
                            continue
                        last_emit = now
                        img = frame.to_image()
                        if crop_scaled:
                            x, y, cw, ch = crop_scaled
                            img = img.crop((x, y, x + cw, y + ch))
                        publish(to_jpeg(img))
        except Exception as err:
            print('Error en el video del emulador:', err)
            time.sleep(2)
        finally:
            proc.kill()
        time.sleep(0.3)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        self.send_header('Cache-Control', 'no-store')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.end_headers()

    def do_GET(self):
        path = self.path.split('?')[0]
        if path in ('/', '/video', '/video.mjpg'):
            self.stream()
        elif path in ('/frame', '/frame.jpg'):
            with state.lock:
                frame = state.frame
            if frame is None:
                self.send_error(503, 'Sin imagen todavía')
                return
            self.send_response(200)
            self.send_cors()
            self.send_header('Content-Type', 'image/jpeg')
            self.send_header('Content-Length', str(len(frame)))
            self.end_headers()
            self.wfile.write(frame)
        else:
            self.send_error(404)

    def stream(self):
        self.send_response(200)
        self.send_cors()
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
        self.end_headers()
        last_seq = -1
        last_sent = 0.0
        try:
            while True:
                with state.lock:
                    seq, frame = state.seq, state.frame
                # The recording only produces frames when the screen changes: repeat the last one
                # every second so the browser does not think the stream stalled.
                stale = time.time() - last_sent > 1.0
                if frame is None or (seq == last_seq and not stale):
                    time.sleep(0.02)
                    continue
                last_seq = seq
                last_sent = time.time()
                self.wfile.write(b'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + str(len(frame)).encode() + b'\r\n\r\n')
                self.wfile.write(frame)
                self.wfile.write(b'\r\n')
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--modo', choices=['video', 'capturas'], default='video')
    parser.add_argument('--adb', default=r'C:\LDPlayer\LDPlayer9\adb.exe', help='ruta de adb.exe de LDPlayer')
    parser.add_argument('--serial', default='emulator-5554', help='identificador del emulador en adb devices')
    parser.add_argument('--port', type=int, default=8090)
    parser.add_argument('--fps', type=float, default=10, help='imágenes por segundo máximas que se sirven')
    parser.add_argument('--width', type=int, default=960, help='ancho máximo de la imagen servida')
    parser.add_argument('--crop', default='', help='recorte x,y,ancho,alto sobre la pantalla del emulador')
    args = parser.parse_args()

    crop = tuple(int(v) for v in args.crop.split(',')) if args.crop else None
    if crop and len(crop) != 4:
        sys.exit('--crop necesita 4 números: x,y,ancho,alto')

    subprocess.run([args.adb, 'start-server'], capture_output=True)

    mode = args.modo
    if mode == 'video':
        try:
            import av  # noqa: F401
        except ImportError:
            print('Falta la librería "av" (pip install av): se usan capturas sueltas, que son más lentas.')
            mode = 'capturas'
    if mode == 'video':
        target, fps = video_loop, args.fps
    else:
        target, fps = screenshots_loop, min(args.fps, 4)
    threading.Thread(target=target, args=(args.adb, args.serial, crop, args.width, fps), daemon=True).start()

    # Only this computer can connect: the video never leaves it.
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print('Modo %s. Emulador servido en http://127.0.0.1:%d/video' % (mode, args.port), flush=True)
    print('En HubVision: Cámara WiFi (URL) y pega esa dirección. Cierra esta ventana para detenerlo.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
