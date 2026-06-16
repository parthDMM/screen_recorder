# CaptureDesk Recorder

CaptureDesk Recorder is a local web tool for recording screen video, microphone audio, optional system audio, input-event logs, ZIP exports, and transcripts.

## Run

Double-click `Start_CaptureDesk.cmd`, or run:

```powershell
python server.py
```

Then open:

```text
http://127.0.0.1:8765/
```

## Free transcript options

No API key is required.

The app has two free transcript paths:

- **Live draft transcript:** runs in supported browsers while you record. This is useful for quick notes and does not require backend setup.
- **Recorded-video transcript:** uses local `faster-whisper` from Python after the recording is finished. This creates timestamped transcript segments and VTT files in the ZIP package.

This machine already has `faster-whisper` installed. If another machine does not, install it with:

```powershell
pip install faster-whisper
```

Local Whisper may download the selected model the first time it runs. The default model is `tiny` because it is fast and small. Use `base`, `small`, or `medium` in the app for better accuracy.

## Settings

The backend defaults to a 100 MB upload limit. Change it with:

```powershell
$env:CAPTUREDESK_MAX_UPLOAD_MB="250"
```

Local Whisper defaults to CPU mode with int8 compute. For a different setup:

```powershell
$env:CAPTUREDESK_WHISPER_DEVICE="cpu"
$env:CAPTUREDESK_WHISPER_COMPUTE_TYPE="int8"
```

## Notes

- Recording uses the raw display video track instead of a canvas copy. This is more stable and avoids the common frozen-video-with-live-audio failure mode caused by canvas rendering stalls.
- MP4 is preferred when the browser supports it. Browser-recorded MP4 can be fragmented like a live stream, so the backend remuxes it with PyAV into a seekable MP4 before export.
- System audio capture depends on the browser and the source chosen in the screen-share picker.
- Input logging records only events the CaptureDesk page receives while it has focus.
