const fileInput = document.querySelector('#fileInput');
const dropzone = document.querySelector('#dropzone');
const form = document.querySelector('#settingsForm');
const originalPreview = document.querySelector('#originalPreview');
const optimizedPreview = document.querySelector('#optimizedPreview');
const originalSize = document.querySelector('#originalSize');
const optimizedSize = document.querySelector('#optimizedSize');
const savings = document.querySelector('#savings');
const status = document.querySelector('#status');
const downloadButton = document.querySelector('#downloadButton');
const qualityOutput = document.querySelector('#qualityOutput');
const effortOutput = document.querySelector('#effortOutput');

let currentFile = null;
let optimizedBlob = null;
let optimizedFilename = 'squishy-output.avif';

form.quality.addEventListener('input', () => {
  qualityOutput.value = form.quality.value;
});

form.effort.addEventListener('input', () => {
  effortOutput.value = form.effort.value;
});

fileInput.addEventListener('change', () => {
  const [file] = fileInput.files;
  if (file) setFile(file);
});

dropzone.addEventListener('dragenter', () => dropzone.classList.add('dragging'));
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', () => dropzone.classList.remove('dragging'));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentFile) {
    setStatus('Choose an image first.');
    return;
  }

  await optimize();
});

downloadButton.addEventListener('click', () => {
  if (!optimizedBlob) return;

  const url = URL.createObjectURL(optimizedBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = optimizedFilename;
  link.click();
  URL.revokeObjectURL(url);
});

function setFile(file) {
  currentFile = file;
  optimizedBlob = null;
  optimizedPreview.removeAttribute('src');
  downloadButton.disabled = true;
  originalPreview.src = URL.createObjectURL(file);
  originalSize.textContent = formatBytes(file.size);
  optimizedSize.textContent = '-';
  savings.textContent = '-';
  setStatus('Ready to optimize.');
}

async function optimize() {
  setStatus('Optimizing...');
  form.querySelector('button[type="submit"]').disabled = true;

  try {
    const body = new FormData(form);
    body.set('image', currentFile);
    body.set('lossless', form.lossless.checked ? 'true' : 'false');

    const response = await fetch('/api/optimize', {
      method: 'POST',
      body
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Optimization failed');
    }

    optimizedFilename = payload.filename;
    optimizedBlob = base64ToBlob(payload.optimized.base64, payload.mime);
    optimizedPreview.src = URL.createObjectURL(optimizedBlob);
    optimizedSize.textContent = formatBytes(payload.optimized.bytes);
    savings.textContent = `${payload.savings.percent}%`;
    downloadButton.disabled = false;
    setStatus(`Created ${payload.filename}`);
  } catch (error) {
    setStatus(error.message);
  } finally {
    form.querySelector('button[type="submit"]').disabled = false;
  }
}

function base64ToBlob(base64, mime) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function setStatus(message) {
  status.textContent = message;
}
