$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $Root "studio\server.py"
$Url = "http://127.0.0.1:8765/"
$HealthUrl = "${Url}api/bootstrap"

function Test-StudioRunning {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Resolve-Python {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) { return $python.Source }
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) { return $py.Source }
    throw "Python was not found. Install Python or add it to PATH."
}

if (-not (Test-Path -LiteralPath $Server)) {
    throw "Studio server not found: $Server"
}

if (-not (Test-StudioRunning)) {
    $Python = Resolve-Python
    Start-Process -FilePath $Python -ArgumentList @($Server, "--host", "127.0.0.1", "--port", "8765") -WorkingDirectory $Root -WindowStyle Hidden

    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-StudioRunning) {
            $ready = $true
            break
        }
    }

    if (-not $ready) {
        throw "Studio did not start within 10 seconds."
    }
}

Start-Process $Url
