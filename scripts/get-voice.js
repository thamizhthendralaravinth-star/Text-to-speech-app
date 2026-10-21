// Downloads the Kokoro voice model (official sherpa-onnx release) into models/ for the Windows build.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const url = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-en-v0_19.tar.bz2';
const dir = path.join(__dirname, '..', 'models');
if (fs.existsSync(path.join(dir, 'kokoro-int8-en-v0_19', 'model.int8.onnx'))) { console.log('voice model already present'); process.exit(0); }
fs.mkdirSync(dir, { recursive: true });
execSync(`curl -SL -o kokoro.tar.bz2 ${url}`, { cwd: dir, stdio: 'inherit' });
execSync('tar xf kokoro.tar.bz2', { cwd: dir, stdio: 'inherit' });
fs.unlinkSync(path.join(dir, 'kokoro.tar.bz2'));
console.log('voice model ready');
