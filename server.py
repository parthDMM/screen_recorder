from __future__ import annotations

import json
import mimetypes
import os
import pathlib
import tempfile
import time
from email.parser import BytesParser
from email.policy import default
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


ROOT = pathlib.Path(__file__).resolve().parent
PORT = int(os.environ.get("CAPTUREDESK_PORT", "8765"))
MAX_UPLOAD_MB = int(os.environ.get("CAPTUREDESK_MAX_UPLOAD_MB", "100"))
LOCAL_WHISPER_MODELS = ["tiny", "base", "small", "medium", "large-v3"]
WHISPER_MODEL_CACHE: dict[str, object] = {}

try:
    from faster_whisper import WhisperModel
except ImportError:  # pragma: no cover - depends on local environment
    WhisperModel = None

try:
    import av
except ImportError:  # pragma: no cover - depends on local environment
    av = None


def json_bytes(payload: dict, status: int = 200) -> tuple[int, bytes, str]:
    return status, json.dumps(payload, indent=2).encode("utf-8"), "application/json"


def normalize_local_model(model: str) -> str:
    value = (model or "tiny").replace("local-", "").strip()
    if value not in LOCAL_WHISPER_MODELS:
        return "tiny"
    return value


def get_local_whisper_model(model_name: str):
    if WhisperModel is None:
        raise RuntimeError("Free local transcription needs faster-whisper. Install it with: pip install faster-whisper")

    if model_name not in WHISPER_MODEL_CACHE:
        device = os.environ.get("CAPTUREDESK_WHISPER_DEVICE", "cpu")
        compute_type = os.environ.get("CAPTUREDESK_WHISPER_COMPUTE_TYPE", "int8")
        WHISPER_MODEL_CACHE[model_name] = WhisperModel(model_name, device=device, compute_type=compute_type)

    return WHISPER_MODEL_CACHE[model_name]


def call_local_transcription(file_name: str, file_bytes: bytes, model: str) -> dict:
    model_name = normalize_local_model(model)
    suffix = pathlib.Path(file_name or "recording.webm").suffix or ".webm"
    temp_path = ""

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_file.write(file_bytes)
            temp_path = temp_file.name

        whisper_model = get_local_whisper_model(model_name)
        segments_iter, info = whisper_model.transcribe(temp_path, vad_filter=True)
        segments = [
            {
                "start": float(segment.start),
                "end": float(segment.end),
                "text": segment.text.strip(),
            }
            for segment in segments_iter
        ]
        text = " ".join(segment["text"] for segment in segments).strip()

        return {
            "engine": "local-faster-whisper",
            "model": model_name,
            "text": text,
            "segments": segments,
            "language": getattr(info, "language", None),
            "duration": getattr(info, "duration", None),
        }
    finally:
        if temp_path:
            pathlib.Path(temp_path).unlink(missing_ok=True)


def remux_seekable_mp4(file_name: str, file_bytes: bytes) -> tuple[str, bytes]:
    if av is None:
        raise RuntimeError("Seekable MP4 repair needs PyAV. Install it with: pip install av")

    suffix = pathlib.Path(file_name or "recording.mp4").suffix or ".mp4"
    input_path = ""
    output_path = ""
    input_container = None
    output_container = None

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as input_file:
            input_file.write(file_bytes)
            input_path = input_file.name

        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as output_file:
            output_path = output_file.name

        input_container = av.open(input_path)
        output_container = av.open(output_path, "w", format="mp4")
        stream_map = {}

        for input_stream in input_container.streams:
            if input_stream.type not in {"audio", "video"}:
                continue
            output_stream = output_container.add_stream_from_template(input_stream)
            stream_map[input_stream.index] = output_stream

        for packet in input_container.demux():
            output_stream = stream_map.get(packet.stream.index)
            if output_stream is None:
                continue
            packet.stream = output_stream
            output_container.mux(packet)

        output_container.close()
        output_container = None
        input_container.close()
        input_container = None

        repaired_name = f"{pathlib.Path(file_name).stem or 'recording'}-seekable.mp4"
        output_file_path = pathlib.Path(output_path)
        for attempt in range(20):
            try:
                return repaired_name, output_file_path.read_bytes()
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(0.1)
    finally:
        if output_container is not None:
            try:
                output_container.close()
            except Exception:
                pass
        if input_container is not None:
            try:
                input_container.close()
            except Exception:
                pass
        if input_path:
            pathlib.Path(input_path).unlink(missing_ok=True)
        if output_path:
            try:
                pathlib.Path(output_path).unlink(missing_ok=True)
            except PermissionError:
                pass


class CaptureDeskHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        path = path.split("?", 1)[0].split("#", 1)[0]
        if path == "/":
            path = "/index.html"
        return str(ROOT / path.lstrip("/"))

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_payload(self, status: int, payload: bytes, content_type: str, extra_headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path.startswith("/api/status"):
            status, payload, content_type = json_bytes(
                {
                    "ok": True,
                    "localWhisperAvailable": WhisperModel is not None,
                    "maxUploadMb": MAX_UPLOAD_MB,
                    "models": LOCAL_WHISPER_MODELS,
                    "engine": "local-faster-whisper",
                    "remuxAvailable": av is not None,
                }
            )
            self.send_payload(status, payload, content_type)
            return

        super().do_GET()

    def do_POST(self) -> None:
        if self.path.startswith("/api/transcribe"):
            handler = self.handle_transcribe
        elif self.path.startswith("/api/remux"):
            handler = self.handle_remux
        else:
            status, payload, content_type = json_bytes({"error": "Not found."}, 404)
            self.send_payload(status, payload, content_type)
            return

        try:
            handler()
        except Exception as error:  # noqa: BLE001 - returned to the browser as a user-facing backend error
            status, payload, content_type = json_bytes({"error": str(error)}, 500)
            self.send_payload(status, payload, content_type)

    def read_multipart_upload(self) -> tuple[dict[str, str], str, str, bytes] | None:
        content_length = int(self.headers.get("Content-Length", "0"))
        max_bytes = MAX_UPLOAD_MB * 1024 * 1024
        if content_length > max_bytes:
            status, payload, content_type = json_bytes(
                {"error": f"Upload is larger than {MAX_UPLOAD_MB} MB. Record a shorter clip or raise CAPTUREDESK_MAX_UPLOAD_MB."},
                413,
            )
            self.send_payload(status, payload, content_type)
            return None

        body = self.rfile.read(content_length)
        content_type_header = self.headers.get("Content-Type", "")
        message = BytesParser(policy=default).parsebytes(
            f"Content-Type: {content_type_header}\r\n\r\n".encode("utf-8") + body
        )
        fields: dict[str, str] = {}
        upload_file_name = ""
        upload_content_type = "application/octet-stream"
        upload_bytes = b""

        if not message.is_multipart():
            status, payload, content_type = json_bytes({"error": "Expected multipart form data."}, 400)
            self.send_payload(status, payload, content_type)
            return None

        for part in message.iter_parts():
            field_name = part.get_param("name", header="content-disposition")
            if not field_name:
                continue

            if field_name == "file":
                upload_file_name = part.get_filename() or "recording.webm"
                upload_content_type = part.get_content_type() or mimetypes.guess_type(upload_file_name)[0] or "application/octet-stream"
                upload_bytes = part.get_payload(decode=True) or b""
            else:
                fields[field_name] = (part.get_payload(decode=True) or b"").decode("utf-8", errors="replace")

        if not upload_bytes:
            status, payload, content_type = json_bytes({"error": "Missing file upload."}, 400)
            self.send_payload(status, payload, content_type)
            return None

        return fields, upload_file_name, upload_content_type, upload_bytes

    def handle_transcribe(self) -> None:
        upload = self.read_multipart_upload()
        if upload is None:
            return

        fields, upload_file_name, _upload_content_type, upload_bytes = upload

        model = fields.get("model", "tiny")
        result = call_local_transcription(upload_file_name, upload_bytes, model)
        status, payload, response_type = json_bytes(result)
        self.send_payload(status, payload, response_type)

    def handle_remux(self) -> None:
        upload = self.read_multipart_upload()
        if upload is None:
            return

        _fields, upload_file_name, _upload_content_type, upload_bytes = upload
        repaired_name, repaired_bytes = remux_seekable_mp4(upload_file_name, upload_bytes)
        self.send_payload(
            200,
            repaired_bytes,
            "video/mp4",
            {
                "Content-Disposition": f'attachment; filename="{repaired_name}"',
                "X-CaptureDesk-File-Name": repaired_name,
            },
        )


def main() -> int:
    os.chdir(ROOT)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), CaptureDeskHandler)
    print(f"CaptureDesk Recorder running at http://127.0.0.1:{PORT}/")
    if WhisperModel is not None:
        print("Transcription backend: free local faster-whisper enabled")
    else:
        print("Transcription backend: install faster-whisper to enable free recorded-video transcription")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping CaptureDesk Recorder.")
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
