# Thendral Text-to-Speech

iPhone app: https://thamizhthendralaravinth-star.github.io/Text-to-speech-app/ (open in Safari → Share → Add to Home Screen)

Windows app: https://github.com/thamizhthendralaravinth-star/Text-to-speech-app/releases/latest

Take a photo of a textbook page and hear it read aloud. Everything runs on your device, with no internet needed after install.

- Photo → text, in English and Tamil (Tesseract OCR is bundled inside the app)
- Reads aloud using your device's voices, highlighting each sentence as it goes
- Speed controls: − / + buttons and 0.75× · 1× · 1.25× · 1.5× presets, which take effect while it is reading
- Each page is saved with its photo, text, speed and voice, and resumes where you stopped

## iPhone (Home Screen app)
1. Settings → Pages → Source: **GitHub Actions** (the "Publish iPhone app" workflow then runs on every push).
2. On the iPhone, open the published link in **Safari** and wait a few seconds so the app stores itself for offline use.
3. Tap Share → **Add to Home Screen** → Add. It opens full-screen and works in flight mode.
4. Pages recorded by the Windows app: save the `.thendral.json`, `.mp3` and `.jpg` files to Files, then Library → **Import from folder** and select all three.

## Windows
Go to Actions → **Build Windows app** → Run workflow, then download `Thendral-Windows` (an installer and a portable .exe).
Pushing a tag such as `v1.0.0` also attaches the .exe files to a GitHub Release.

## Develop
```
npm install
npm run serve      # http://localhost:8080
npm start          # desktop window
```
