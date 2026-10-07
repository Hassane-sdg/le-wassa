# Backup all HTML files and remove NUL (0x00) bytes, then re-save as UTF8 without BOM
# Usage: Open PowerShell in this project folder and run: .\clean-nulls.ps1

$now = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = "backup_html_$now"
Write-Host "Creating backup directory: $backupDir"
New-Item -ItemType Directory -Path $backupDir | Out-Null

$files = Get-ChildItem -Path . -Filter *.html -Recurse
foreach ($f in $files) {
    $dest = Join-Path $backupDir $f.Name
    Copy-Item -Path $f.FullName -Destination $dest -Force
    Write-Host "Backed up: $($f.Name) -> $dest"

    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    $clean = $bytes | Where-Object { $_ -ne 0 }
    [System.IO.File]::WriteAllBytes($f.FullName, $clean)

    # Re-open as text and write UTF8 without BOM
    $text = Get-Content -Path $f.FullName -Raw
    Set-Content -Path $f.FullName -Value $text -Encoding UTF8
    Write-Host "Cleaned and saved: $($f.Name)"
}

Write-Host "Done. Backups are in $backupDir"
