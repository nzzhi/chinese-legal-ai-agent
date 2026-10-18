import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

const execute = promisify(execFile)
// ponytail: use installed Windows OCR; other platforms report a gap until a local engine is available.
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1') } | Select-Object -First 1
function Await($operation, $resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.GetAwaiter().GetResult()
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language('zh-Hans-CN')))
if (!$engine) { throw 'Chinese OCR is not installed' }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:CHINESE_OCR_FILE)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  if (([long]$decoder.PixelWidth * [long]$decoder.PixelHeight) -gt 20000000) { throw 'Image exceeds local OCR pixel budget' }
  if ($decoder.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $decoder.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'Image exceeds local OCR dimension limit' }
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  try {
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    @{ text = (($result.Lines | ForEach-Object { $_.Text }) -join [Environment]::NewLine) } | ConvertTo-Json -Compress
  } finally { $bitmap.Dispose() }
} finally { $stream.Dispose() }
`

/** Local recognition only. The retained image remains the original, not the recognized text. */
export async function imageText(file: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (process.platform !== 'win32') throw new Error('当前设备未提供离线中文图片识别，请登记图片关键文字')
  let stdout: string
  try {
    const result = await execute(join(process.env.WINDIR || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024, encoding: 'utf8', signal,
        env: { ...process.env, CHINESE_OCR_FILE: resolve(file) } })
    stdout = result.stdout
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error('图片文字未能识别；可能未安装中文引擎、图片损坏或尺寸过大，请裁剪或登记关键文字', { cause: error })
  }
  signal?.throwIfAborted()
  const { text } = z.strictObject({ text: z.string().max(20_000) }).parse(JSON.parse(stdout.replace(/^\uFEFF/u, '')))
  // Windows inserts spaces between Chinese words; retain digits and line boundaries, never repair recognized characters.
  return text.replace(/(?<=[\p{Script=Han}\p{P}]) +(?=[\p{Script=Han}\p{P}\d])/gu, '')
    .replace(/(?<=\d) +(?=[\p{Script=Han}\p{P}])/gu, '').trim()
}
