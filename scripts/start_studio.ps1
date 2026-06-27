$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $Root "studio\server.py"
$Python = "python"

if (-not (Test-Path -LiteralPath $Server)) {
    throw "Studio server not found: $Server"
}

& $Python $Server --host 127.0.0.1 --port 8765

