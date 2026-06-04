const $ = id => document.getElementById(id);

const els = {
  backendChip: $('backendChip'),
  formatChip: $('formatChip'),
  timer: $('timer'),
  sessionLine: $('sessionLine'),
  recordState: $('recordState'),
  recordStateText: $('recordStateText'),
  previewVideo: $('previewVideo'),
  previewEmpty: $('previewEmpty'),
  shareBtn: $('shareBtn'),
  recordBtn: $('recordBtn'),
  pauseBtn: $('pauseBtn'),
  resumeBtn: $('resumeBtn'),
  stopBtn: $('stopBtn'),
  downloadBtn: $('downloadBtn'),
  transcribeBtn: $('transcribeBtn'),
  micSelect: $('micSelect'),
  recordMic: $('recordMic'),
  recordSystemAudio: $('recordSystemAudio'),
  captureInputs: $('captureInputs'),
  redactKeys: $('redactKeys'),
  liveTranscript: $('liveTranscript'),
  qualitySelect: $('qualitySelect'),
  frameRateSelect: $('frameRateSelect'),
  transcriptModel: $('transcriptModel'),
  screenStat: $('screenStat'),
  recorderStat: $('recorderStat'),
  audioStat: $('audioStat'),
  frameStat: $('frameStat'),
  inputStat: $('inputStat'),
  packageStat: $('packageStat'),
  micMeter: $('micMeter'),
  outputLine: $('outputLine'),
  clearBtn: $('clearBtn'),
  recordedVideo: $('recordedVideo'),
  seekSlider: $('seekSlider'),
  seekNow: $('seekNow'),
  seekEnd: $('seekEnd'),
  fileList: $('fileList'),
  transcriptBox: $('transcriptBox'),
  copyTranscriptBtn: $('copyTranscriptBtn'),
  downloadTranscriptBtn: $('downloadTranscriptBtn'),
  logList: $('logList')
};

const INPUT_SCOPE = 'Keyboard and mouse logging records only events this browser page receives while it has focus during recording.';
const INPUT_COLUMNS = [
  'index',
  'timestamp',
  'elapsedMs',
  'elapsed',
  'category',
  'action',
  'key',
  'code',
  'printable',
  'repeat',
  'location',
  'button',
  'buttons',
  'pointerType',
  'clientX',
  'clientY',
  'screenX',
  'screenY',
  'deltaX',
  'deltaY',
  'altKey',
  'ctrlKey',
  'metaKey',
  'shiftKey',
  'target',
  'recorderState'
];

const state = {
  backend: {
    available: false,
    localWhisperAvailable: false,
    remuxAvailable: false
  },
  displayStream: null,
  micStream: null,
  recordingStream: null,
  mediaRecorder: null,
  chunks: [],
  startedAt: 0,
  pausedAt: 0,
  accumulatedPauseMs: 0,
  timerId: null,
  audioContext: null,
  mixedAudioContext: null,
  micAnalyser: null,
  micMeterId: null,
  frameWatchId: null,
  frameCallbackActive: false,
  totalFrames: 0,
  lastFrameAt: 0,
  lastFrameWarningAt: 0,
  inputEvents: [],
  inputLogActive: false,
  lastPointerMoveAt: 0,
  liveRecognition: null,
  liveTranscriptActive: false,
  liveTranscriptItems: [],
  liveTranscriptText: '',
  currentRecording: null,
  objectUrls: []
};

const crcTable = (() => {
  const table = new Uint32Array(256);

  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }

  return table;
})();

function setRecorderState(type, text) {
  els.recordState.className = 'record-state' + (type ? ` ${type}` : '');
  els.recordStateText.textContent = text;
}

function log(message, type = '') {
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + type;
  entry.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
  els.logList.prepend(entry);
}

function formatTime(totalSeconds) {
  const safe = Math.max(0, Number.isFinite(totalSeconds) ? totalSeconds : 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);

  if (hours) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatElapsedMs(ms) {
  const safe = Math.max(0, Math.round(ms || 0));
  return `${formatTime(safe / 1000)}.${String(safe % 1000).padStart(3, '0')}`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

function getRecordingElapsedMs(now = Date.now()) {
  if (!state.startedAt) return 0;
  const pauseDelta = state.pausedAt ? now - state.pausedAt : 0;
  return Math.max(0, now - state.startedAt - state.accumulatedPauseMs - pauseDelta);
}

function getBestMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];

  return candidates.find(type => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

function getExtension(mimeType) {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}

function safeName(value) {
  return String(value).replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function randomId() {
  return crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;

  const devices = await navigator.mediaDevices.enumerateDevices();
  const microphones = devices.filter(device => device.kind === 'audioinput');

  els.micSelect.innerHTML = microphones.length
    ? microphones.map((device, index) => `<option value="${device.deviceId}">${escapeHtml(device.label || `Microphone ${index + 1}`)}</option>`).join('')
    : '<option value="">No microphone found</option>';
}

async function checkBackend() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('Backend did not answer.');
    const data = await response.json();
    state.backend.available = true;
    state.backend.localWhisperAvailable = Boolean(data.localWhisperAvailable);
    state.backend.remuxAvailable = Boolean(data.remuxAvailable);
    els.backendChip.textContent = state.backend.localWhisperAvailable ? 'Free local transcription ready' : 'Install faster-whisper for free transcription';
    log(
      state.backend.localWhisperAvailable
        ? 'Free local Whisper transcription is ready.'
        : 'Install faster-whisper to enable free recorded-video transcription.',
      state.backend.localWhisperAvailable ? 'good' : 'warn'
    );
  } catch (error) {
    state.backend.available = false;
    state.backend.localWhisperAvailable = false;
    state.backend.remuxAvailable = false;
    els.backendChip.textContent = 'Transcript backend offline';
    log('Run server.py to enable recorded-video transcription.', 'warn');
  }
}

function updateFormatChip() {
  const mimeType = getBestMimeType();
  els.formatChip.textContent = mimeType ? `${getExtension(mimeType).toUpperCase()} recorder` : 'Recorder unsupported';
}

function setButtonsForShare(active) {
  els.recordBtn.disabled = !active || Boolean(state.mediaRecorder);
  els.stopBtn.disabled = !active && !state.mediaRecorder;
}

async function shareScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    log('This browser cannot share a screen source. Use current Chrome or Edge.', 'bad');
    return;
  }

  stopDisplayOnly();

  const frameRate = Number(els.frameRateSelect.value);

  try {
    state.displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: frameRate, max: frameRate },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: els.recordSystemAudio.checked ? {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      } : false
    });

    els.previewVideo.srcObject = state.displayStream;
    await els.previewVideo.play().catch(() => {});

    const videoTrack = state.displayStream.getVideoTracks()[0];
    const settings = videoTrack.getSettings?.() || {};
    els.screenStat.textContent = `${settings.width || '-'}x${settings.height || '-'} @ ${settings.frameRate || frameRate} FPS`;
    els.audioStat.textContent = state.displayStream.getAudioTracks().length ? 'System audio available' : 'No system audio';
    els.previewEmpty.classList.add('hidden');
    els.sessionLine.textContent = 'Screen source is live. Recording will use the raw display track for stability.';
    setButtonsForShare(true);
    setRecorderState('', 'Screen live');
    startFrameWatch();
    log('Screen source connected.', 'good');

    videoTrack.addEventListener('ended', async () => {
      log('Screen sharing ended from the browser picker.', 'warn');
      await stopRecording();
      stopDisplayOnly();
    });

    await refreshDevices().catch(() => {});
  } catch (error) {
    log(error.message || 'Screen sharing was blocked.', 'bad');
    setRecorderState('', 'Idle');
  }
}

function stopDisplayOnly() {
  if (state.displayStream) {
    state.displayStream.getTracks().forEach(track => track.stop());
  }

  state.displayStream = null;
  els.previewVideo.srcObject = null;
  els.previewEmpty.classList.remove('hidden');
  els.screenStat.textContent = 'Not shared';
  els.audioStat.textContent = 'Waiting';
  state.totalFrames = 0;
  state.lastFrameAt = 0;
  els.frameStat.textContent = '0';
  stopFrameWatch();
  setButtonsForShare(false);
}

async function ensureMicrophone() {
  stopMicrophone();

  if (!els.recordMic.checked) {
    els.audioStat.textContent = state.displayStream?.getAudioTracks().length ? 'System audio only' : 'No audio selected';
    return null;
  }

  try {
    const deviceId = els.micSelect.value;
    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? {
        deviceId: { exact: deviceId },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      } : true,
      video: false
    });
    startMicMeter(state.micStream);
    await refreshDevices().catch(() => {});
    return state.micStream;
  } catch (error) {
    log('Microphone was unavailable. The recording will continue with screen audio if present.', 'warn');
    els.audioStat.textContent = state.displayStream?.getAudioTracks().length ? 'System audio only' : 'No audio';
    return null;
  }
}

function stopMicrophone() {
  if (state.micStream) {
    state.micStream.getTracks().forEach(track => track.stop());
  }

  state.micStream = null;
  stopMicMeter();
}

function startMicMeter(stream) {
  stopMicMeter();

  state.audioContext = state.audioContext || new AudioContext();
  state.micAnalyser = state.audioContext.createAnalyser();
  state.micAnalyser.fftSize = 256;
  state.audioContext.createMediaStreamSource(stream).connect(state.micAnalyser);

  const data = new Uint8Array(state.micAnalyser.frequencyBinCount);

  function loop() {
    if (!state.micAnalyser) return;
    state.micAnalyser.getByteFrequencyData(data);
    const average = data.reduce((sum, value) => sum + value, 0) / data.length;
    els.micMeter.style.width = `${Math.min(100, average * 1.55)}%`;
    state.micMeterId = requestAnimationFrame(loop);
  }

  loop();
}

function stopMicMeter() {
  if (state.micMeterId) cancelAnimationFrame(state.micMeterId);
  state.micMeterId = null;
  state.micAnalyser = null;
  els.micMeter.style.width = '0';
}

function startFrameWatch() {
  stopFrameWatch();
  state.totalFrames = 0;
  state.lastFrameAt = Date.now();
  state.lastFrameWarningAt = 0;

  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    state.frameCallbackActive = true;
    const update = () => {
      if (!state.frameCallbackActive || !state.displayStream) return;
      state.totalFrames += 1;
      state.lastFrameAt = Date.now();
      els.frameStat.textContent = String(state.totalFrames);
      els.previewVideo.requestVideoFrameCallback(update);
    };
    els.previewVideo.requestVideoFrameCallback(update);
  }

  state.frameWatchId = setInterval(() => {
    const quality = els.previewVideo.getVideoPlaybackQuality?.();
    if (quality?.totalVideoFrames) {
      state.totalFrames = quality.totalVideoFrames;
      els.frameStat.textContent = String(state.totalFrames);
      state.lastFrameAt = Date.now();
    }

    if (state.mediaRecorder?.state === 'recording' && state.lastFrameAt) {
      const stalledMs = Date.now() - state.lastFrameAt;
      if (stalledMs > 6000 && Date.now() - state.lastFrameWarningAt > 10000) {
        state.lastFrameWarningAt = Date.now();
        log('Preview video has not advanced for several seconds. The recorder is using the raw screen track, but the selected source may be stalled.', 'warn');
      }
    }
  }, 1000);
}

function stopFrameWatch() {
  state.frameCallbackActive = false;
  if (state.frameWatchId) clearInterval(state.frameWatchId);
  state.frameWatchId = null;
}

async function buildRecordingStream() {
  if (!state.displayStream) throw new Error('Share a screen source first.');

  await ensureMicrophone();

  const videoTracks = state.displayStream.getVideoTracks();
  if (!videoTracks.length) throw new Error('The selected source has no video track.');

  const finalStream = new MediaStream([videoTracks[0]]);
  const audioTracks = [
    ...state.displayStream.getAudioTracks(),
    ...(state.micStream ? state.micStream.getAudioTracks() : [])
  ];

  if (audioTracks.length) {
    state.mixedAudioContext = new AudioContext();
    const destination = state.mixedAudioContext.createMediaStreamDestination();

    for (const track of audioTracks) {
      const source = state.mixedAudioContext.createMediaStreamSource(new MediaStream([track]));
      source.connect(destination);
    }

    for (const track of destination.stream.getAudioTracks()) {
      finalStream.addTrack(track);
    }
  }

  state.recordingStream = finalStream;
  els.audioStat.textContent = audioTracks.length ? `${audioTracks.length} source${audioTracks.length === 1 ? '' : 's'} mixed` : 'No audio';
  return finalStream;
}

async function startRecording() {
  try {
    const mimeType = getBestMimeType();
    if (!mimeType) throw new Error('MediaRecorder is not available in this browser.');

    state.chunks = [];
    state.startedAt = Date.now();
    state.pausedAt = 0;
    state.accumulatedPauseMs = 0;
    state.currentRecording = null;

    const stream = await buildRecordingStream();
    const options = {
      mimeType,
      videoBitsPerSecond: Number(els.qualitySelect.value)
    };

    state.mediaRecorder = new MediaRecorder(stream, options);
    state.mediaRecorder.ondataavailable = event => {
      if (event.data?.size) state.chunks.push(event.data);
    };
    state.mediaRecorder.onerror = event => {
      log(event.error?.message || 'Recorder error occurred.', 'bad');
    };
    state.mediaRecorder.onstop = finalizeRecording;
    state.mediaRecorder.start(1000);

    startInputCapture();
    startLiveTranscript();
    state.timerId = setInterval(updateTimer, 250);

    els.shareBtn.disabled = true;
    els.recordBtn.disabled = true;
    els.pauseBtn.disabled = false;
    els.resumeBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.downloadBtn.disabled = true;
    els.transcribeBtn.disabled = true;
    els.recorderStat.textContent = 'Recording';
    els.packageStat.textContent = 'Recording';
    setRecorderState('active', 'Recording');
    log(`Recording started as ${getExtension(mimeType).toUpperCase()} using the raw display track.`, 'good');
  } catch (error) {
    log(error.message || 'Unable to start recording.', 'bad');
    state.mediaRecorder = null;
  }
}

function updateTimer() {
  els.timer.textContent = formatTime(getRecordingElapsedMs() / 1000);
}

function pauseRecording() {
  if (state.mediaRecorder?.state !== 'recording') return;

  appendInputEvent({ category: 'session', action: 'recording_paused' }, { force: true });
  state.mediaRecorder.pause();
  state.pausedAt = Date.now();
  els.pauseBtn.disabled = true;
  els.resumeBtn.disabled = false;
  els.recorderStat.textContent = 'Paused';
  setRecorderState('paused', 'Paused');
  log('Recording paused.', 'warn');
}

function resumeRecording() {
  if (state.mediaRecorder?.state !== 'paused') return;

  state.mediaRecorder.resume();
  if (state.pausedAt) {
    state.accumulatedPauseMs += Date.now() - state.pausedAt;
    state.pausedAt = 0;
  }
  appendInputEvent({ category: 'session', action: 'recording_resumed' }, { force: true });
  els.pauseBtn.disabled = false;
  els.resumeBtn.disabled = true;
  els.recorderStat.textContent = 'Recording';
  setRecorderState('active', 'Recording');
  log('Recording resumed.', 'good');
}

function stopRecording() {
  return new Promise(resolve => {
    if (state.timerId) clearInterval(state.timerId);
    state.timerId = null;
    stopLiveTranscript();
    stopInputCapture();

    if (!state.mediaRecorder || state.mediaRecorder.state === 'inactive') {
      resolve();
      return;
    }

    const recorder = state.mediaRecorder;
    const originalStop = recorder.onstop;
    recorder.onstop = async event => {
      if (typeof originalStop === 'function') await originalStop(event);
      resolve();
    };
    recorder.stop();
  });
}

async function stopAll() {
  await stopRecording();
  stopRecordingTracks();
  stopMicrophone();
  stopDisplayOnly();

  if (state.mixedAudioContext) {
    state.mixedAudioContext.close().catch(() => {});
    state.mixedAudioContext = null;
  }

  els.shareBtn.disabled = false;
  els.pauseBtn.disabled = true;
  els.resumeBtn.disabled = true;
  els.stopBtn.disabled = true;
  els.timer.textContent = '00:00';
  els.recorderStat.textContent = 'Idle';
  setRecorderState('', 'Idle');
}

function stopRecordingTracks() {
  if (state.recordingStream) {
    state.recordingStream.getTracks().forEach(track => {
      if (track.kind === 'audio') track.stop();
    });
  }

  state.recordingStream = null;
}

async function finalizeRecording() {
  const mimeType = state.chunks[0]?.type || getBestMimeType() || 'video/webm';
  const blob = new Blob(state.chunks, { type: mimeType });

  if (!blob.size) {
    log('Recording was empty. Try again and let it run for a few seconds.', 'bad');
    resetAfterFinalize();
    return;
  }

  const endedAt = new Date();
  const durationSeconds = Math.max(0, Math.round(getRecordingElapsedMs(endedAt.getTime()) / 1000));
  const extension = getExtension(mimeType);
  const baseName = safeName(`capturedesk-${new Date(state.startedAt).toISOString().replace(/[:.]/g, '-')}`);
  const videoName = `${baseName}.${extension}`;
  const url = URL.createObjectURL(blob);
  state.objectUrls.push(url);

  const inputEvents = state.inputEvents.map(event => ({ ...event }));
  const inputSummary = summarizeInputEvents(inputEvents);
  const liveTranscript = {
    text: state.liveTranscriptText.trim(),
    items: state.liveTranscriptItems.map(item => ({ ...item }))
  };

  const recording = {
    id: randomId(),
    baseName,
    videoName,
    mimeType,
    extension,
    blob,
    url,
    sizeBytes: blob.size,
    durationSeconds,
    startedAt: new Date(state.startedAt).toISOString(),
    endedAt: endedAt.toISOString(),
    frameCount: state.totalFrames,
    inputEvents,
    inputSummary,
    liveTranscript,
    transcript: liveTranscript.text ? {
      source: 'browser-live-draft',
      text: liveTranscript.text,
      segments: []
    } : null
  };

  state.currentRecording = recording;
  const readyForDownload = await ensureSeekableDownload(recording);
  log('Packaging recording files into a ZIP archive...', 'warn');

  if (readyForDownload) {
    try {
      await rebuildPackage(recording);
    } catch (error) {
      recording.downloadReady = false;
      log(error.message || 'ZIP package could not be created.', 'bad');
    }
  } else {
    recording.downloadReady = false;
    log('Download/export is disabled until a seekable MP4 can be created. Start CaptureDesk with server.py and record again.', 'bad');
  }

  attachRecordingToPlayer(recording);
  renderTranscript(recording);
  renderFileList(recording);
  resetAfterFinalize();
  els.downloadBtn.disabled = !recording.downloadReady || !recording.zipUrl;
  els.transcribeBtn.disabled = !recording.downloadReady || !recording.blob;
  els.copyTranscriptBtn.disabled = !getTranscriptText(recording);
  els.downloadTranscriptBtn.disabled = !getTranscriptText(recording);
  els.packageStat.textContent = recording.zipBlob ? formatBytes(recording.zipBlob.size) : 'Needs seekable remux';
  els.outputLine.textContent = `${videoName} - ${formatBytes(blob.size)} - ${formatTime(durationSeconds)}`;
  log(`Recording ready: ${videoName}`, 'good');
}

function resetAfterFinalize() {
  state.mediaRecorder = null;
  state.chunks = [];
  stopRecordingTracks();
  stopMicrophone();

  els.shareBtn.disabled = false;
  els.recordBtn.disabled = !state.displayStream;
  els.pauseBtn.disabled = true;
  els.resumeBtn.disabled = true;
  els.stopBtn.disabled = !state.displayStream;
  els.recorderStat.textContent = 'Idle';
  setRecorderState(state.displayStream ? '' : '', state.displayStream ? 'Screen live' : 'Idle');
}

function attachRecordingToPlayer(recording) {
  prepareSeekablePreview(els.recordedVideo, recording.durationSeconds);
  els.recordedVideo.src = recording.url;
  els.recordedVideo.load();
  els.seekSlider.max = String(recording.durationSeconds || 0);
  els.seekSlider.value = '0';
  els.seekSlider.disabled = !recording.durationSeconds;
  els.seekNow.textContent = '00:00';
  els.seekEnd.textContent = formatTime(recording.durationSeconds);
}

function prepareSeekablePreview(video, knownDuration) {
  video.onloadedmetadata = () => {
    if ((!Number.isFinite(video.duration) || video.duration === Infinity) && knownDuration > 0) {
      const muted = video.muted;
      video.muted = true;
      video.currentTime = 1e101;
      video.ontimeupdate = () => {
        video.ontimeupdate = null;
        video.currentTime = 0;
        video.muted = muted;
      };
    }
  };
}

function updateSeekFromVideo() {
  if (!state.currentRecording) return;
  els.seekNow.textContent = formatTime(els.recordedVideo.currentTime || 0);
  if (!els.seekSlider.matches(':focus')) {
    els.seekSlider.value = String(els.recordedVideo.currentTime || 0);
  }
}

function seekPlayer(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    els.recordedVideo.currentTime = seconds;
    els.seekNow.textContent = formatTime(seconds);
  }
}

function renderFileList(recording) {
  if (!recording.downloadReady) {
    els.fileList.innerHTML = `
      <div class="file-item">
        <div>
          <strong>Download blocked</strong>
          <div class="file-meta">The MP4 is still stream-style. Restart with server.py so CaptureDesk can create a seekable MP4 before export.</div>
        </div>
      </div>
    `;
    return;
  }

  const files = [
    recording.zipUrl ? {
      label: 'ZIP package',
      name: recording.zipName,
      url: recording.zipUrl,
      size: recording.zipBlob?.size
    } : null,
    {
      label: 'Video file',
      name: recording.videoName,
      url: recording.url,
      size: recording.sizeBytes
    }
  ].filter(Boolean);

  els.fileList.innerHTML = files.map(file => `
    <div class="file-item">
      <div>
        <a href="${file.url}" download="${escapeHtml(file.name)}">${escapeHtml(file.label)}</a>
        <div class="file-meta">${escapeHtml(file.name)} - ${formatBytes(file.size)}</div>
      </div>
    </div>
  `).join('');
}

async function ensureSeekableDownload(recording) {
  const isMp4 = recording.mimeType.includes('mp4') || recording.extension === 'mp4';

  if (!isMp4) {
    recording.downloadReady = true;
    log('Browser did not produce MP4, so seekable MP4 remux was skipped.', 'warn');
    return true;
  }

  if (!state.backend.available || !state.backend.remuxAvailable) {
    await checkBackend();
  }

  if (!state.backend.available || !state.backend.remuxAvailable) {
    recording.downloadReady = false;
    recording.seekableRemux = false;
    log('Seekable MP4 remux backend is unavailable. The page preview can seek, but downloaded MP4 would behave like a stream.', 'bad');
    return false;
  }

  try {
    log('Converting fragmented recording into a seekable MP4 timeline...', 'warn');
    const form = new FormData();
    form.append('file', recording.blob, recording.videoName);

    const response = await fetch('/api/remux', {
      method: 'POST',
      body: form
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Seekable MP4 remux failed.');
    }

    const fixedBlob = await response.blob();
    const fixedName = response.headers.get('X-CaptureDesk-File-Name') || `${recording.baseName}-seekable.mp4`;
    const fixedUrl = URL.createObjectURL(fixedBlob);
    state.objectUrls.push(fixedUrl);

    recording.originalVideoName = recording.videoName;
    recording.originalSizeBytes = recording.sizeBytes;
    recording.videoName = fixedName;
    recording.blob = fixedBlob;
    recording.url = fixedUrl;
    recording.mimeType = 'video/mp4';
    recording.extension = 'mp4';
    recording.sizeBytes = fixedBlob.size;
    recording.seekableRemux = true;
    recording.downloadReady = true;
    log('Seekable MP4 timeline created.', 'good');
    return true;
  } catch (error) {
    recording.seekableRemux = false;
    recording.downloadReady = false;
    log(error.message || 'Seekable MP4 remux failed. Export was blocked to avoid another stream-style download.', 'bad');
    return false;
  }
}

function getTranscriptText(recording = state.currentRecording) {
  return recording?.transcript?.text?.trim() || recording?.liveTranscript?.text?.trim() || '';
}

function renderTranscript(recording = state.currentRecording) {
  if (!recording) return;

  const transcript = recording.transcript;
  const text = getTranscriptText(recording);

  if (!text) {
    els.transcriptBox.innerHTML = '<p>No transcript yet. Use Transcribe after the recording is ready.</p>';
    return;
  }

  if (transcript?.segments?.length) {
    els.transcriptBox.innerHTML = transcript.segments.map(segment => `
      <div class="segment">
        <button type="button" data-seek="${Number(segment.start || 0)}">${formatTime(Number(segment.start || 0))}</button>
        <div class="segment-text">${escapeHtml(segment.text || '')}</div>
      </div>
    `).join('');

    for (const button of els.transcriptBox.querySelectorAll('[data-seek]')) {
      button.addEventListener('click', () => seekPlayer(button.dataset.seek));
    }
  } else {
    els.transcriptBox.innerHTML = `<p>${escapeHtml(text).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
  }
}

async function transcribeCurrentRecording() {
  const recording = state.currentRecording;
  if (!recording?.blob) {
    log('No recording is ready to transcribe.', 'warn');
    return;
  }

  if (!state.backend.available || !state.backend.localWhisperAvailable) {
    log('Recorded-video transcription needs the free local faster-whisper package. Live draft transcript can still work in supported browsers.', 'warn');
    return;
  }

  els.transcribeBtn.disabled = true;
  els.transcribeBtn.textContent = 'Transcribing';
  log('Sending recorded video to the transcription backend...', 'warn');

  try {
    const form = new FormData();
    form.append('file', recording.blob, recording.videoName);
    form.append('model', els.transcriptModel.value);

    const response = await fetch('/api/transcribe', {
      method: 'POST',
      body: form
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Transcription failed.');
    }

    recording.transcript = {
      source: `${data.engine || 'local-whisper'}:${data.model || els.transcriptModel.value}`,
      text: data.text || '',
      segments: Array.isArray(data.segments) ? data.segments : [],
      raw: data.raw || null,
      generatedAt: new Date().toISOString()
    };

    await rebuildPackage(recording);
    renderTranscript(recording);
    renderFileList(recording);
    els.copyTranscriptBtn.disabled = !getTranscriptText(recording);
    els.downloadTranscriptBtn.disabled = !getTranscriptText(recording);
    els.packageStat.textContent = recording.zipBlob ? formatBytes(recording.zipBlob.size) : 'Video only';
    log('Transcript created and ZIP package updated.', 'good');
  } catch (error) {
    log(error.message || 'Unable to transcribe the recording.', 'bad');
  } finally {
    els.transcribeBtn.disabled = false;
    els.transcribeBtn.textContent = 'Transcribe';
  }
}

function startLiveTranscript() {
  state.liveTranscriptText = '';
  state.liveTranscriptItems = [];

  if (!els.liveTranscript.checked) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    log('Live draft transcript is not supported in this browser. Use server transcription after recording.', 'warn');
    return;
  }

  try {
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    recognition.onresult = event => {
      let finalText = '';
      let interimText = '';

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript || '';

        if (result.isFinal) {
          finalText += text.trim() + ' ';
          state.liveTranscriptItems.push({
            elapsedMs: getRecordingElapsedMs(),
            text: text.trim()
          });
        } else {
          interimText += text;
        }
      }

      if (finalText) state.liveTranscriptText += finalText;

      if (!state.currentRecording) {
        const visibleText = (state.liveTranscriptText + interimText).trim();
        if (visibleText) {
          els.transcriptBox.innerHTML = `<p>${escapeHtml(visibleText)}</p>`;
        }
      }
    };

    recognition.onerror = event => {
      if (event.error !== 'no-speech') {
        log(`Live draft transcript stopped: ${event.error}`, 'warn');
      }
    };

    recognition.onend = () => {
      if (state.liveTranscriptActive && state.mediaRecorder?.state === 'recording') {
        recognition.start();
      }
    };

    state.liveRecognition = recognition;
    state.liveTranscriptActive = true;
    recognition.start();
    log('Live draft transcript started. Final transcript should use the backend for recorded-video audio.', 'good');
  } catch (error) {
    log('Live draft transcript could not start.', 'warn');
  }
}

function stopLiveTranscript() {
  state.liveTranscriptActive = false;
  if (state.liveRecognition) {
    state.liveRecognition.stop();
  }
  state.liveRecognition = null;
}

function startInputCapture() {
  state.inputEvents = [];
  state.lastPointerMoveAt = 0;
  state.inputLogActive = els.captureInputs.checked;
  updateInputStat();

  if (!state.inputLogActive) return;

  appendInputEvent({
    category: 'session',
    action: 'input_capture_started',
    redactedPrintableKeys: els.redactKeys.checked,
    captureScope: INPUT_SCOPE
  }, { force: true });
}

function stopInputCapture() {
  if (!state.inputLogActive) return;

  appendInputEvent({
    category: 'session',
    action: 'input_capture_stopped'
  }, { force: true });
  state.inputLogActive = false;
}

function inputCaptureIsLive() {
  return state.inputLogActive && state.mediaRecorder?.state === 'recording';
}

function appendInputEvent(entry, options = {}) {
  if (!options.force && !inputCaptureIsLive()) return;
  if (!state.inputLogActive && !options.force) return;

  const now = Date.now();
  const elapsedMs = getRecordingElapsedMs(now);
  const event = {
    index: state.inputEvents.length + 1,
    timestamp: new Date(now).toISOString(),
    elapsedMs,
    elapsed: formatElapsedMs(elapsedMs),
    recorderState: state.mediaRecorder?.state || 'inactive',
    ...entry
  };

  state.inputEvents.push(event);
  updateInputStat();
}

function updateInputStat() {
  const total = state.inputEvents.length;
  const keyboard = state.inputEvents.filter(event => event.category === 'keyboard').length;
  const mouse = state.inputEvents.filter(event => event.category === 'mouse').length;
  els.inputStat.textContent = total ? `${total} (${keyboard} key / ${mouse} mouse)` : '0';
}

function describeEventTarget(target) {
  if (!(target instanceof Element)) return '';

  const parts = [target.tagName.toLowerCase()];
  if (target.id) parts.push(`#${target.id}`);
  const classes = Array.from(target.classList || []).slice(0, 2);
  if (classes.length) parts.push(`.${classes.join('.')}`);
  return parts.join('');
}

function getModifierState(event) {
  return {
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey
  };
}

function handleKeyboardEvent(event) {
  const printable = event.key?.length === 1;
  const redact = printable && els.redactKeys.checked;

  appendInputEvent({
    category: 'keyboard',
    action: event.type,
    key: redact ? '[printable]' : event.key,
    code: redact ? '[redacted]' : event.code,
    printable,
    repeat: event.repeat,
    location: event.location,
    ...getModifierState(event),
    target: describeEventTarget(event.target)
  });
}

function handlePointerEvent(event) {
  if (event.type === 'pointermove') {
    const now = performance.now();
    if (now - state.lastPointerMoveAt < 140) return;
    state.lastPointerMoveAt = now;
  }

  appendInputEvent({
    category: 'mouse',
    action: event.type,
    pointerType: event.pointerType || 'mouse',
    button: event.button,
    buttons: event.buttons,
    clientX: Math.round(event.clientX),
    clientY: Math.round(event.clientY),
    screenX: Math.round(event.screenX),
    screenY: Math.round(event.screenY),
    ...getModifierState(event),
    target: describeEventTarget(event.target)
  });
}

function handleWheelEvent(event) {
  appendInputEvent({
    category: 'mouse',
    action: event.type,
    pointerType: 'mouse',
    clientX: Math.round(event.clientX),
    clientY: Math.round(event.clientY),
    screenX: Math.round(event.screenX),
    screenY: Math.round(event.screenY),
    deltaX: Math.round(event.deltaX),
    deltaY: Math.round(event.deltaY),
    ...getModifierState(event),
    target: describeEventTarget(event.target)
  });
}

function summarizeInputEvents(events) {
  const summary = {
    total: events.length,
    session: 0,
    keyboard: 0,
    mouse: 0,
    keydown: 0,
    keyup: 0,
    pointerdown: 0,
    pointerup: 0,
    pointermove: 0,
    click: 0,
    dblclick: 0,
    contextmenu: 0,
    wheel: 0
  };

  for (const event of events) {
    if (event.category in summary) summary[event.category] += 1;
    if (event.action in summary) summary[event.action] += 1;
  }

  return summary;
}

function csvEscape(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildInputCsv(events) {
  const rows = [INPUT_COLUMNS.join(',')];
  for (const event of events) {
    rows.push(INPUT_COLUMNS.map(column => csvEscape(event[column])).join(','));
  }
  return rows.join('\r\n');
}

function buildMetadata(recording) {
  return {
    app: 'CaptureDesk Recorder',
    generatedAt: new Date().toISOString(),
    video: {
      fileName: recording.videoName,
      mimeType: recording.mimeType,
      sizeBytes: recording.sizeBytes,
      durationSeconds: recording.durationSeconds,
      startedAt: recording.startedAt,
      endedAt: recording.endedAt,
      frameCount: recording.frameCount,
      seekableRemux: Boolean(recording.seekableRemux),
      originalVideoName: recording.originalVideoName || null
    },
    capture: {
      screen: els.screenStat.textContent,
      audio: els.audioStat.textContent,
      quality: els.qualitySelect.options[els.qualitySelect.selectedIndex]?.textContent || els.qualitySelect.value,
      frameRate: `${els.frameRateSelect.value} FPS`,
      inputScope: INPUT_SCOPE
    },
    inputSummary: recording.inputSummary,
    transcript: recording.transcript ? {
      source: recording.transcript.source,
      generatedAt: recording.transcript.generatedAt || null,
      segmentCount: recording.transcript.segments?.length || 0
    } : null
  };
}

function buildReportHtml(recording) {
  const metadata = buildMetadata(recording);
  const transcriptText = getTranscriptText(recording);
  const rows = [
    ['Video', recording.videoName],
    ['Format', recording.mimeType],
    ['Size', formatBytes(recording.sizeBytes)],
    ['Duration', formatTime(recording.durationSeconds)],
    ['Started', new Date(recording.startedAt).toLocaleString()],
    ['Ended', new Date(recording.endedAt).toLocaleString()],
    ['Seekable remux', recording.seekableRemux ? 'Yes' : 'No'],
    ['Input events', `${recording.inputSummary.total} total`],
    ['Transcript', transcriptText ? `${transcriptText.length} characters` : 'Not generated']
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>CaptureDesk Report - ${escapeHtml(recording.videoName)}</title>
  <style>
    body{font-family:Arial,sans-serif;margin:32px;color:#111827;line-height:1.5}
    h1{margin:0 0 8px}
    table{border-collapse:collapse;width:100%;max-width:900px;margin-top:20px}
    th,td{border:1px solid #d1d5db;padding:10px;text-align:left;vertical-align:top}
    th{width:190px;background:#f3f4f6}
    pre{white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;padding:14px}
  </style>
</head>
<body>
  <h1>CaptureDesk Recording Report</h1>
  <p>Generated locally by CaptureDesk Recorder.</p>
  <table>${rows.map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`).join('')}</table>
  <h2>Transcript</h2>
  <pre>${escapeHtml(transcriptText || 'No transcript generated.')}</pre>
  <h2>Metadata</h2>
  <pre>${escapeHtml(JSON.stringify(metadata, null, 2))}</pre>
</body>
</html>`;
}

function buildVtt(transcript) {
  if (!transcript?.segments?.length) return '';

  const lines = ['WEBVTT', ''];
  transcript.segments.forEach((segment, index) => {
    lines.push(String(index + 1));
    lines.push(`${toVttTime(segment.start || 0)} --> ${toVttTime(segment.end || (Number(segment.start || 0) + 2))}`);
    lines.push(String(segment.text || '').trim());
    lines.push('');
  });
  return lines.join('\n');
}

function toVttTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

async function rebuildPackage(recording) {
  if (recording.zipUrl) {
    URL.revokeObjectURL(recording.zipUrl);
  }

  const transcriptText = getTranscriptText(recording);
  const metadataJson = JSON.stringify(buildMetadata(recording), null, 2);
  const inputJson = JSON.stringify({
    scope: INPUT_SCOPE,
    summary: recording.inputSummary,
    events: recording.inputEvents
  }, null, 2);
  const liveJson = JSON.stringify(recording.liveTranscript || { text: '', items: [] }, null, 2);
  const reportHtml = buildReportHtml(recording);
  const vtt = buildVtt(recording.transcript);

  const folder = `${recording.baseName}/`;
  const files = [
    { name: `${folder}${recording.videoName}`, blob: recording.blob },
    { name: `${folder}${recording.baseName}-metadata.json`, blob: textBlob(metadataJson, 'application/json') },
    { name: `${folder}${recording.baseName}-report.html`, blob: textBlob(reportHtml, 'text/html') },
    { name: `${folder}${recording.baseName}-input-events.json`, blob: textBlob(inputJson, 'application/json') },
    { name: `${folder}${recording.baseName}-input-events.csv`, blob: textBlob(buildInputCsv(recording.inputEvents), 'text/csv') },
    { name: `${folder}${recording.baseName}-live-draft-transcript.json`, blob: textBlob(liveJson, 'application/json') },
    { name: `${folder}${recording.baseName}-transcript.txt`, blob: textBlob(transcriptText || '', 'text/plain') }
  ];

  if (vtt) {
    files.push({ name: `${folder}${recording.baseName}-transcript.vtt`, blob: textBlob(vtt, 'text/vtt') });
  }

  const zipBlob = await createZipBlob(files);
  const zipUrl = URL.createObjectURL(zipBlob);
  state.objectUrls.push(zipUrl);
  recording.zipBlob = zipBlob;
  recording.zipUrl = zipUrl;
  recording.zipName = `${recording.baseName}-package.zip`;
}

function textBlob(value, type) {
  return new Blob([value], { type: `${type};charset=utf-8` });
}

async function createZipBlob(files) {
  const encoder = new TextEncoder();
  const fileParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const nameBytes = encoder.encode(file.name.replaceAll('\\', '/'));
    const checksum = crc32(data);
    const { time, date } = getDosDateTime(new Date());
    const localHeader = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04,
      ...zipUint16(20),
      ...zipUint16(0),
      ...zipUint16(0),
      ...zipUint16(time),
      ...zipUint16(date),
      ...zipUint32(checksum),
      ...zipUint32(data.length),
      ...zipUint32(data.length),
      ...zipUint16(nameBytes.length),
      ...zipUint16(0)
    ]);
    const centralHeader = new Uint8Array([
      0x50, 0x4b, 0x01, 0x02,
      ...zipUint16(20),
      ...zipUint16(20),
      ...zipUint16(0),
      ...zipUint16(0),
      ...zipUint16(time),
      ...zipUint16(date),
      ...zipUint32(checksum),
      ...zipUint32(data.length),
      ...zipUint32(data.length),
      ...zipUint16(nameBytes.length),
      ...zipUint16(0),
      ...zipUint16(0),
      ...zipUint16(0),
      ...zipUint16(0),
      ...zipUint32(0),
      ...zipUint32(offset)
    ]);

    fileParts.push(localHeader, nameBytes, data);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endHeader = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06,
    ...zipUint16(0),
    ...zipUint16(0),
    ...zipUint16(files.length),
    ...zipUint16(files.length),
    ...zipUint32(centralSize),
    ...zipUint32(centralOffset),
    ...zipUint16(0)
  ]);

  return new Blob([...fileParts, ...centralParts, endHeader], { type: 'application/zip' });
}

function crc32(data) {
  let crc = 0xffffffff;

  for (let i = 0; i < data.length; i += 1) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function zipUint16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function zipUint32(value) {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  ];
}

function getDosDateTime(value) {
  const year = Math.max(1980, value.getFullYear());
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate()
  };
}

function triggerDownload(url, name) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function downloadCurrentZip() {
  const recording = state.currentRecording;
  if (!recording?.zipUrl) return;
  triggerDownload(recording.zipUrl, recording.zipName);
}

async function copyTranscript() {
  const text = getTranscriptText();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  log('Transcript copied to clipboard.', 'good');
}

function downloadTranscript() {
  const recording = state.currentRecording;
  const text = getTranscriptText(recording);
  if (!text) return;

  const url = URL.createObjectURL(textBlob(text, 'text/plain'));
  state.objectUrls.push(url);
  triggerDownload(url, `${recording.baseName}-transcript.txt`);
}

function clearOutput() {
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls = [];
  state.currentRecording = null;
  els.recordedVideo.removeAttribute('src');
  els.recordedVideo.load();
  els.seekSlider.value = '0';
  els.seekSlider.max = '0';
  els.seekSlider.disabled = true;
  els.seekNow.textContent = '00:00';
  els.seekEnd.textContent = '00:00';
  els.fileList.innerHTML = '';
  els.transcriptBox.innerHTML = '<p>No transcript yet.</p>';
  els.outputLine.textContent = 'Recordings and transcript files appear here.';
  els.downloadBtn.disabled = true;
  els.transcribeBtn.disabled = true;
  els.copyTranscriptBtn.disabled = true;
  els.downloadTranscriptBtn.disabled = true;
  els.packageStat.textContent = 'Not ready';
  log('Output cleared.', 'warn');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function wireEvents() {
  els.shareBtn.addEventListener('click', shareScreen);
  els.recordBtn.addEventListener('click', startRecording);
  els.pauseBtn.addEventListener('click', pauseRecording);
  els.resumeBtn.addEventListener('click', resumeRecording);
  els.stopBtn.addEventListener('click', stopAll);
  els.downloadBtn.addEventListener('click', downloadCurrentZip);
  els.transcribeBtn.addEventListener('click', transcribeCurrentRecording);
  els.clearBtn.addEventListener('click', clearOutput);
  els.copyTranscriptBtn.addEventListener('click', copyTranscript);
  els.downloadTranscriptBtn.addEventListener('click', downloadTranscript);
  els.seekSlider.addEventListener('input', event => seekPlayer(event.target.value));
  els.recordedVideo.addEventListener('timeupdate', updateSeekFromVideo);
  els.recordedVideo.addEventListener('loadedmetadata', () => {
    const duration = state.currentRecording?.durationSeconds || els.recordedVideo.duration || 0;
    els.seekSlider.max = String(duration);
    els.seekEnd.textContent = formatTime(duration);
  });
  els.micSelect.addEventListener('change', () => {
    if (state.mediaRecorder?.state === 'recording') log('Microphone changes apply to the next recording.', 'warn');
  });
  window.addEventListener('beforeunload', event => {
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  for (const type of ['keydown', 'keyup']) {
    window.addEventListener(type, handleKeyboardEvent, true);
  }
  for (const type of ['pointerdown', 'pointerup', 'pointermove', 'click', 'dblclick', 'contextmenu']) {
    window.addEventListener(type, handlePointerEvent, true);
  }
  window.addEventListener('wheel', handleWheelEvent, true);
}

async function init() {
  wireEvents();
  updateFormatChip();

  if (!window.MediaRecorder || !navigator.mediaDevices?.getDisplayMedia) {
    log('This browser does not support the recording APIs needed by this tool.', 'bad');
    els.shareBtn.disabled = true;
    els.recordBtn.disabled = true;
    setRecorderState('', 'Unsupported');
    return;
  }

  await refreshDevices().catch(() => {
    log('Device list will fill in after permissions are granted.', 'warn');
  });
  await checkBackend();
  navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshDevices().catch(() => {}));
  log('Recorder initialized. Input logging is page-focused only.', 'good');
}

init();
