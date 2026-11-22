'use strict';

// OCR for scanned PDFs and photos, using an engine already on the machine:
//   windows   - the OCR engine built into Windows 10/11 (Windows.Media.Ocr),
//               called through Windows PowerShell; nothing to install.
//   tesseract - the `tesseract` command, if installed (Linux servers, CI).
// Choose with OCR_ENGINE=windows|tesseract|off (default: windows on Windows,
// otherwise tesseract when found). OCR_LANG sets the language
// (windows: e.g. "en-US" / "es-ES", default = user profile languages;
//  tesseract: e.g. "eng" / "eng+spa", default "eng").

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MAX_PAGES = Number(process.env.OCR_MAX_PAGES || 50);
const PAGE_TIMEOUT_MS = 90000;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); reject(err); } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

let detected = null;
async function detectEngine() {
  if (detected) return detected;
  const wanted = (process.env.OCR_ENGINE || '').toLowerCase();
  if (wanted === 'off') return (detected = { name: 'off', reason: 'OCR is switched off (OCR_ENGINE=off)' });
  if (wanted === 'windows' || (!wanted && process.platform === 'win32')) {
    if (process.platform !== 'win32') return (detected = { name: 'off', reason: 'Windows OCR only works on Windows' });
    return (detected = { name: 'windows', label: 'Windows built-in OCR' });
  }
  try {
    const { stdout, stderr } = await run('tesseract', ['--version'], { timeout: 10000 });
    const v = /tesseract\s+v?([\d.]+)/i.exec(stdout + stderr);
    return (detected = { name: 'tesseract', label: `Tesseract ${v ? v[1] : ''}`.trim() });
  } catch {
    return (detected = { name: 'off', reason: 'no OCR engine found (install Tesseract, or run the app on Windows 10/11)' });
  }
}

/* ---------------- Windows (Windows.Media.Ocr via Windows PowerShell 5.1) ---------------- */

// Passed with -EncodedCommand, so script execution policy doesn't apply.
// Input: env OCR_FILES (JSON array of image paths), OCR_LANG. Output: JSON on stdout.
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' })[0]
  function Await($op, [Type]$type) {
    $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    $t.Result
  }
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  if ($env:OCR_LANG) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($env:OCR_LANG)) }
  else { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if ($null -eq $engine) { throw 'No Windows OCR language is installed for this language (Settings > Time & language > Language: add a language with "Optical character recognition").' }
  $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  $pages = @()
  foreach ($path in (ConvertFrom-Json $env:OCR_FILES)) {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $w = $decoder.PixelWidth; $h = $decoder.PixelHeight
    $scale = [Math]::Min(1.0, $max / [Math]::Max($w, $h))
    if ($scale -lt 1.0) {
      $tf = New-Object Windows.Graphics.Imaging.BitmapTransform
      $tf.ScaledWidth = [uint32]($w * $scale); $tf.ScaledHeight = [uint32]($h * $scale)
      $bitmap = Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $tf, [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    } else {
      $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    }
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($line in $result.Lines) {
      $words = @()
      foreach ($word in $line.Words) {
        $r = $word.BoundingRect
        $words += ,@($word.Text, [Math]::Round($r.X / $scale, 1), [Math]::Round($r.Y / $scale, 1), [Math]::Round($r.Width / $scale, 1), [Math]::Round($r.Height / $scale, 1))
      }
      $lines += ,$words
    }
    $pages += @{ lines = $lines }
    $stream.Dispose()
  }
  ConvertTo-Json -Compress -Depth 10 @{ ok = $true; language = $engine.RecognizerLanguage.LanguageTag; pages = $pages }
} catch {
  ConvertTo-Json -Compress @{ ok = $false; error = $_.Exception.Message }
}
`;

async function ocrWindows(files) {
  const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    env: { ...process.env, OCR_FILES: JSON.stringify(files), OCR_LANG: process.env.OCR_LANG || '' },
    timeout: PAGE_TIMEOUT_MS * files.length,
  });
  return parseWindowsOutput(stdout);
}

// Exported for tests: PowerShell's JSON → pages of lines of words.
function parseWindowsOutput(stdout) {
  const json = stdout.slice(stdout.indexOf('{'));
  let res;
  try { res = JSON.parse(json); } catch { throw new Error(`Windows OCR returned unexpected output: ${stdout.slice(0, 200)}`); }
  if (!res.ok) {
    const msg = String(res.error || 'unknown error');
    if (/language mode|ConstrainedLanguage|Add-Type/i.test(msg)) throw new Error(`Windows OCR is blocked by this computer's PowerShell policy (${msg})`);
    throw new Error(`Windows OCR failed: ${msg}`);
  }
  // PowerShell collapses single-element arrays; normalise.
  const arr = (v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);
  return arr(res.pages).map((p) => arr(p.lines).map((line) => {
    const words = arr(line);
    const list = words.length && !Array.isArray(words[0]) ? [words] : words;
    return list.map(([text, x, y, w, h]) => ({ text: String(text), x, y, w, h }));
  }));
}

/* ---------------- Tesseract ---------------- */

async function ocrTesseract(files) {
  const lang = process.env.OCR_LANG || 'eng';
  const pages = [];
  for (const f of files) {
    let out;
    try {
      out = await run('tesseract', [f, 'stdout', '-l', lang, '--psm', '3', 'tsv'], { timeout: PAGE_TIMEOUT_MS });
    } catch (err) {
      throw new Error(`Tesseract failed: ${(err.stderr || err.message).split('\n').filter(Boolean).slice(-1)[0]}`);
    }
    const lines = new Map();
    for (const row of out.stdout.split('\n').slice(1)) {
      const c = row.split('\t');
      if (c.length < 12 || c[0] !== '5') continue; // level 5 = word
      const text = c.slice(11).join('\t').trim();
      if (!text || Number(c[10]) < 0) continue;
      const key = `${c[2]}.${c[3]}.${c[4]}`; // block.paragraph.line
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push({ text, x: +c[6], y: +c[7], w: +c[8], h: +c[9] });
    }
    pages.push([...lines.values()]);
  }
  return pages;
}

/* ---------------- shared ---------------- */

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// OCR lines/words (image pixels, y down) → positioned items like PDF text (y up).
function toItems(page, lines) {
  const items = [];
  for (const words of lines) {
    if (!words.length) continue;
    const size = median(words.map((w) => w.h)) || 10;
    const cy = words.reduce((s, w) => s + w.y + w.h / 2, 0) / words.length;
    for (const w of words) items.push({ page, x: w.x, endX: w.x + w.w, y: -cy, size, text: w.text, ocr: true });
  }
  return items;
}

const EXT = { jpeg: '.jpg', png: '.png', tiff: '.tif', bmp: '.bmp', gif: '.gif' };

// images: [{ page, format, data }] → { engine, items, pages, errors }
async function ocrImages(images) {
  const engine = await detectEngine();
  if (engine.name === 'off') return { engine: null, items: [], error: engine.reason };
  const usable = images.filter((im) => im.data && EXT[im.format]).slice(0, MAX_PAGES);
  const errors = images.filter((im) => im.error).map((im) => `page ${im.page}: ${im.error}`);
  if (images.length > MAX_PAGES) errors.push(`only the first ${MAX_PAGES} scanned pages were read (OCR_MAX_PAGES)`);
  if (!usable.length) return { engine: engine.label, items: [], error: errors.join('; ') || 'no readable page images' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-ocr-'));
  try {
    const files = usable.map((im, i) => {
      const f = path.join(dir, `page-${i + 1}${EXT[im.format]}`);
      fs.writeFileSync(f, im.data);
      return f;
    });
    const pages = engine.name === 'windows' ? await ocrWindows(files) : await ocrTesseract(files);
    const items = [];
    pages.forEach((lines, i) => items.push(...toItems(usable[i].page, lines)));
    return { engine: engine.label, pages: usable.map((im) => im.page), items, errors };
  } catch (err) {
    return { engine: engine.label, items: [], error: err.message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { ocrImages, detectEngine, toItems, parseWindowsOutput, WINDOWS_SCRIPT, _reset: () => { detected = null; } };
