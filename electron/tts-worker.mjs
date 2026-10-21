// Runs the Kokoro voice (native sherpa-onnx) off the main thread and returns one MP3 per page,
// with the start/end time of every sentence so the player can highlight along.
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { Mp3Encoder } from '@breezystack/lamejs';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const dir = workerData.modelDir;
const tts = new sherpa.OfflineTts({
  model: {
    kokoro: {
      model: `${dir}/model.int8.onnx`,
      voices: `${dir}/voices.bin`,
      tokens: `${dir}/tokens.txt`,
      dataDir: `${dir}/espeak-ng-data`,
    },
    numThreads: workerData.threads || 2,
    debug: false,
  },
  maxNumSentences: 1,
});
const SR = tts.sampleRate;

const toInt16 = (f32) => {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
};

parentPort.on('message', (job) => {
  try {
    // job: {id, units:[{text, speak, paraEnd}], sid, speed, pause, paraPause}
    const enc = new Mp3Encoder(1, SR, 64);
    const chunks = [];
    const timings = [];
    let t = 0;
    const push = (samples) => {
      const pcm = toInt16(samples);
      for (let i = 0; i < pcm.length; i += 1152) {
        const b = enc.encodeBuffer(pcm.subarray(i, i + 1152));
        if (b.length) chunks.push(Buffer.from(b));
      }
      t += samples.length / SR;
    };
    job.units.forEach((u, i) => {
      if (!u.speak || !u.text.trim()) { timings.push(null); return; }
      const start = t;
      const audio = tts.generate({ text: u.text, sid: job.sid, speed: job.speed });
      push(audio.samples);
      timings.push([Math.round(start * 1000) / 1000, Math.round(t * 1000) / 1000]);
      const gap = u.paraEnd ? job.paraPause : job.pause;
      if (gap > 0 && i < job.units.length - 1) push(new Float32Array(Math.round(SR * gap)));
      parentPort.postMessage({ id: job.id, type: 'progress', done: i + 1, total: job.units.length });
    });
    chunks.push(Buffer.from(enc.flush()));
    const mp3 = Buffer.concat(chunks);
    parentPort.postMessage({ id: job.id, type: 'done', mp3, timings, duration: t });
  } catch (err) {
    parentPort.postMessage({ id: job.id, type: 'error', message: String(err && err.message || err) });
  }
});
