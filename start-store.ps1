$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
$deno = Get-Command deno -ErrorAction SilentlyContinue
if (-not $node -and -not $deno) {
    Write-Error "Install Node.js 18+ or Deno first."
    exit 1
}

$secureKey = Read-Host "Masukkan API KEY Premku; input disembunyikan" -AsSecureString
$secureSecret = Read-Host "Masukkan API SECRET Premku; input disembunyikan" -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
$serverProcess = $null
$instanceId = [Guid]::NewGuid().ToString("N")

try {
    $env:PREMKU_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
    $env:PREMKU_API_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer).Trim()
    if ([string]::IsNullOrWhiteSpace($env:PREMKU_API_KEY)) {
        Write-Error "API KEY tidak boleh kosong."
        exit 1
    }
    $env:PREMIUM_STORE_INSTANCE_ID = $instanceId
    if ($node) {
        $serverProcess = Start-Process -FilePath $node.Source -ArgumentList "server.js" `
            -WorkingDirectory $PSScriptRoot -PassThru
    } else {
        $serverProcess = Start-Process -FilePath $deno.Source `
            -ArgumentList @("run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "server.js") `
            -WorkingDirectory $PSScriptRoot -PassThru
    }
} finally {
    Remove-Item Env:\PREMKU_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\PREMKU_API_SECRET -ErrorAction SilentlyContinue
    Remove-Item Env:\PREMIUM_STORE_INSTANCE_ID -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
    $secureKey.Dispose()
    $secureSecret.Dispose()
}

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($serverProcess.HasExited) {
        Write-Error "Server toko berhenti saat startup. Periksa jendela server untuk pesan error."
        exit 1
    }
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/premium/health" -TimeoutSec 2
        if ($response.ready -and $response.instanceId -eq $instanceId) {
            $ready = $true
            break
        }
    } catch {
        Start-Sleep -Milliseconds 500
    }
}

if (-not $ready) {
    Stop-Process -Id $serverProcess.Id -ErrorAction SilentlyContinue
    Write-Error "Port 3000 dipakai server toko lain atau server baru tidak berhasil dimulai. Tutup jendela server lama, lalu jalankan start-store.cmd lagi."
    exit 1
}

Start-Process "http://localhost:3000"
Write-Host "Toko berjalan di http://localhost:3000. Tutup jendela server untuk menghentikannya."
