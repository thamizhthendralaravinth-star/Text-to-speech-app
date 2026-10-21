# Thendral Text-to-Speech

Take a photo of a textbook page and hear it read aloud. Everything runs on your device, with no internet needed after install.

- Photo → text, in English and Tamil (Tesseract OCR is bundled inside the app)
- Reads aloud using your device's voices, highlighting each sentence as it goes
- Speed controls: − / + buttons and 0.75× · 1× · 1.25× · 1.5× presets, which take effect while it is reading
- Each page is saved with its photo, text, speed and voice, and resumes where you stopped

## iPhone (Home Screen app)
1. Push this repo to GitHub, then go to Settings → Pages → Source and choose **GitHub Actions**.
2. Open the published link in **Safari** on the iPhone and wait for "OFFLINE READY".
3. Tap Share → **Add to Home Screen**. From then on it works in flight mode.

## Windows
Go to Actions → **Build Windows app** → Run workflow, then download `Thendral-Windows` (an installer and a portable .exe).
Pushing a tag such as `v1.0.0` also attaches the .exe files to a GitHub Release.

## Develop
```
npm install
npm run serve      # http://localhost:8080
npm start          # desktop window
```
