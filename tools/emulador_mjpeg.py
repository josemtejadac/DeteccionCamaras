"""Serve the screen of an Android emulator (LDPlayer) as MJPEG on localhost.

HubVision can then use it as a "Cámara WiFi (URL)" source:
    http://127.0.0.1:8090/video

It reads the emulator through ADB, so it does not depend on the browser capturing the emulator
window (which comes out black with some renderers). Two modes:
  - video (default): continuous H.264 screen recording decoded here. Smooth, needs `pip install av`.
  - capturas: one screenshot at a time. Slower (about 2-3 images per second) but needs no extra library.

It is meant to stay running in the background: it only records the emulator while HubVision is
asking for video, and it waits for the emulator / the port if they are not available yet.

Requirements: Python 3 with Pillow (pip install pillow), and ADB debugging enabled in LDPlayer
(Ajustes > Otros > Depuración ADB > Abrir conexión local).

Usage:
    python emulador_mjpeg.py [--modo video|capturas] [--adb RUTA] [--serial emulator-5554]
                             [--port 8090] [--fps 20] [--width 960] [--crop x,y,ancho,alto]
"""
import argparse
import queue
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

from PIL import Image

IDLE_SECONDS = 10  # stop recording the emulator when nobody has asked for video for this long
STALE_SECONDS = 8  # a frame older than this no longer counts as live video

# Without this flag, a program that runs without a window (pythonw) makes Windows open a new console
# window for every adb call, which flashes terminals on screen when it loops.
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


class Latest:
    """Most recent JPEG frame and demand bookkeeping, shared between threads."""

    def __init__(self):
        self.lock = threading.Lock()
        self.frame = None
        self.frame_ts = 0.0
        self.seq = 0
        self.demand_ts = 0.0  # last time a client asked for video
        self.recording_since = 0.0


state = Latest()


def touch():
    state.demand_ts = time.time()


def wanted():
    return time.time() - state.demand_ts <= IDLE_SECONDS


def publish(jpeg):
    with state.lock:
        state.frame = jpeg
        state.frame_ts = time.time()
        state.seq += 1


def to_jpeg(img):
    buf = BytesIO()
    img.save(buf, 'JPEG', quality=80)
    return buf.getvalue()


def screenshot(adb, serial):
    """One raw screenshot as an RGB image (the raw header is 12 or 16 bytes depending on Android)."""
    raw = subprocess.run(
        [adb, '-s', serial, 'exec-out', 'screencap'], capture_output=True, timeout=15, creationflags=NO_WINDOW
    ).stdout
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
        if not wanted():
            time.sleep(0.3)
            continue
        started = time.time()
        try:
            img = screenshot(adb, serial)
            if crop:
                x, y, cw, ch = crop
                img = img.crop((x, y, x + cw, y + ch))
            if width and img.width > width:
                img = img.resize((width, round(img.height * width / img.width)), Image.BILINEAR)
            publish(to_jpeg(img))
            state.recording_since = state.recording_since or started
            last_error = None
        except Exception as err:  # keep serving; the emulator may be restarting
            if str(err) != last_error:
                print('No se pudo capturar el emulador:', err)
                last_error = str(err)
            time.sleep(2)
        time.sleep(max(0, interval - (time.time() - started)))


def stop_guest_recorders(adb, serial):
    """Stop any screenrecord still running inside the emulator (they pile up and slow it down)."""
    try:
        subprocess.run(
            [adb, '-s', serial, 'shell', 'pkill', '-INT', 'screenrecord'],
            capture_output=True, timeout=8, creationflags=NO_WINDOW,
        )
    except Exception:
        pass


def video_loop(adb, serial, crop, width, fps):
    """Keep trying, but calmly: the emulator may be closed, and retrying fast would hog the PC."""
    last_error = None
    failures = 0
    while True:
        try:
            video_session(adb, serial, crop, width, fps)
        except Exception as err:
            if str(err) != last_error:
                print('Esperando al emulador:', err, flush=True)
                last_error = str(err)
        failures += 1
        time.sleep(min(3 * failures, 30))  # 3 s, 6 s, 9 s ... up to 30 s between attempts


def pump(proc, chunks):
    while True:
        chunk = proc.stdout.read1(65536)
        chunks.put(chunk or None)
        if not chunk:
            return


def video_session(adb, serial, crop, width, fps):
    import av  # imported here so the screenshots mode works without it

    native_w, native_h = screenshot(adb, serial).size
    out_w = width - width % 2
    out_h = round(out_w * native_h / native_w)
    out_h -= out_h % 2
    scale = out_w / native_w
    crop_scaled = tuple(round(v * scale) for v in crop) if crop else None
    min_gap = 1.0 / fps
    print('Video del emulador: %dx%d -> %dx%d' % (native_w, native_h, out_w, out_h), flush=True)

    command = [
        adb, '-s', serial, 'exec-out', 'screenrecord',
        '--output-format=h264', '--size', '%dx%d' % (out_w, out_h),
        '--bit-rate', '4000000', '--time-limit', '170', '-',
    ]
    quick_ends = 0
    while True:
        while not wanted():  # nobody is watching: leave the emulator alone
            time.sleep(0.3)
        stop_guest_recorders(adb, serial)
        proc = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=NO_WINDOW
        )
        began = time.time()
        state.recording_since = began
        chunks = queue.Queue()
        threading.Thread(target=pump, args=(proc, chunks), daemon=True).start()
        codec = av.CodecContext.create('h264', 'r')
        last_emit = 0.0
        try:
            while wanted():
                try:
                    chunk = chunks.get(timeout=1)
                except queue.Empty:
                    continue
                if chunk is None:  # screenrecord ended (its time limit): restart below
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
            print('Error en el video del emulador:', err, flush=True)
            time.sleep(2)
        finally:
            proc.kill()
            stop_guest_recorders(adb, serial)
        if time.time() - began < 5 and wanted():
            # The recording died right away (emulator closed or not ready): wait longer each time
            # instead of relaunching adb over and over.
            quick_ends += 1
            time.sleep(min(2 * quick_ends, 30))
        else:
            quick_ends = 0
            time.sleep(0.3)


def origin_allowed(origin):
    """Only HubVision (and local development) may read the video from a web page."""
    if origin.startswith('http://127.0.0.1') or origin.startswith('http://localhost'):
        return True
    if not origin.startswith('https://'):
        return False
    host = origin[len('https://'):].split(':')[0]
    return host == 'hubprovicamaras.pages.dev' or host.endswith('.hubprovicamaras.pages.dev')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_cors(self):
        origin = self.headers.get('Origin')
        if origin and origin_allowed(origin):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        # No Access-Control-Allow-Origin for other sites: their pages cannot read the video.
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
            self.single_frame()
        else:
            self.send_error(404)

    def single_frame(self):
        was_idle = not wanted()
        touch()
        with state.lock:
            frame, ts = state.frame, state.frame_ts
        fresh = frame is not None and time.time() - ts < STALE_SECONDS
        if fresh:
            self.send_response(200)
            self.send_cors()
            # How old this image is, so HubVision can show whether the picture it analyses is current.
            self.send_header('X-Frame-Age', str(int((time.time() - ts) * 1000)))
            self.send_header('Access-Control-Expose-Headers', 'X-Frame-Age')
            self.send_header('Content-Type', 'image/jpeg')
            self.send_header('Content-Length', str(len(frame)))
            self.end_headers()
            self.wfile.write(frame)
        elif was_idle or time.time() - state.recording_since < STALE_SECONDS:
            # Just woke up or still warming up: not a problem yet.
            self.send_response(204)
            self.send_cors()
            self.end_headers()
        else:
            self.send_response(503)  # recording, but the emulator is not producing new video
            self.send_cors()
            self.send_header('Content-Length', '0')
            self.end_headers()

    def stream(self):
        self.send_response(200)
        self.send_cors()
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
        self.end_headers()
        last_seq = -1
        last_sent = 0.0
        try:
            while True:
                touch()
                with state.lock:
                    seq, frame, ts = state.seq, state.frame, state.frame_ts
                live = frame is not None and time.time() - ts < STALE_SECONDS
                # The recording only produces frames when the screen changes: repeat the last one
                # every second so the browser does not think the stream stalled, but only while
                # the video is recent (a dead emulator must not look alive).
                stale_gap = time.time() - last_sent > 1.0
                if not live or (seq == last_seq and not stale_gap):
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


class ExclusiveServer(ThreadingHTTPServer):
    """On Windows, address reuse lets a second copy bind the same port; refuse that."""

    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        import socket

        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def port_in_use(port):
    import socket

    with socket.socket() as probe:
        probe.settimeout(1)
        return probe.connect_ex(('127.0.0.1', port)) == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--modo', choices=['video', 'capturas'], default='video')
    parser.add_argument('--adb', default=r'C:\LDPlayer\LDPlayer9\adb.exe', help='ruta de adb.exe de LDPlayer')
    parser.add_argument('--serial', default='emulator-5554', help='identificador del emulador en adb devices')
    parser.add_argument('--port', type=int, default=8090)
    parser.add_argument('--fps', type=float, default=20, help='imágenes por segundo máximas que se sirven (el emulador llega a unas 15-18)')
    parser.add_argument('--width', type=int, default=960, help='ancho máximo de la imagen servida')
    parser.add_argument('--crop', default='', help='recorte x,y,ancho,alto sobre la pantalla del emulador')
    args = parser.parse_args()

    crop = tuple(int(v) for v in args.crop.split(',')) if args.crop else None
    if crop and len(crop) != 4:
        sys.exit('--crop necesita 4 números: x,y,ancho,alto')

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

    try:
        subprocess.run([args.adb, 'start-server'], capture_output=True, timeout=20, creationflags=NO_WINDOW)
    except Exception:
        pass
    threading.Thread(target=target, args=(args.adb, args.serial, crop, args.width, fps), daemon=True).start()

    # Only this computer can connect: the video never leaves it.
    server = None
    while server is None:
        try:
            server = ExclusiveServer(('127.0.0.1', args.port), Handler)
        except OSError as err:
            if port_in_use(args.port):  # another copy is already serving: nothing to do
                print('Ya hay una copia en el puerto %d; esta se cierra.' % args.port, flush=True)
                return
            print('No se pudo abrir el puerto %d (%s). Reintentando…' % (args.port, err), flush=True)
            time.sleep(3)
    print('Modo %s. Emulador servido en http://127.0.0.1:%d/video' % (mode, args.port), flush=True)
    print('En HubVision: Cámara WiFi (URL) y pega esa dirección. Cierra esta ventana para detenerlo.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if mode == 'video':
            stop_guest_recorders(args.adb, args.serial)


if __name__ == '__main__':
    main()
