# Lance le serveur statique local avec npx serve sur le port 5000
# Usage: Ouvrir PowerShell dans ce dossier et exécuter: .\serve-local.ps1
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "npm n'est pas installé. Installez Node.js pour utiliser ce script." -ForegroundColor Yellow
    exit 1
}
npx serve . -l 5000
