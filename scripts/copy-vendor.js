// Copies the OCR engine and language data into app/ so the app works with no internet.
const fs = require('fs');
const path = require('path');

const nm = path.join(__dirname, '..', 'node_modules');
const app = path.join(__dirname, '..', 'app');

const copies = [
  ['tesseract.js/dist/tesseract.min.js', 'vendor/tesseract.min.js'],
  ['tesseract.js/dist/worker.min.js', 'vendor/worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'vendor/core/tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'vendor/core/tesseract-core-simd-lstm.wasm.js'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'lang/eng.traineddata.gz'],
  ['@tesseract.js-data/tam/4.0.0_best_int/tam.traineddata.gz', 'lang/tam.traineddata.gz'],
];

for (const [from, to] of copies) {
  const dest = path.join(app, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(nm, from), dest);
  console.log('copied', to);
}
