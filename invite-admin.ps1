<#
  Script PowerShell d'exemple : inviter un utilisateur Netlify et lui assigner le rôle 'admin'
  Requis : NETLIFY_TOKEN (personal access token) et SITE_ID
  Usage local :
    $env:NETLIFY_TOKEN = 'votre_token'
    .\invite-admin.ps1 -email 'admin@example.com' -siteId 'votre_site_id'
#>
param(
  [Parameter(Mandatory=$true)][string]$email,
  [Parameter(Mandatory=$true)][string]$siteId
)

if (-not $env:NETLIFY_TOKEN) {
  Write-Error "Veuillez définir la variable d'environnement NETLIFY_TOKEN avant d'exécuter le script."
  exit 1
}

$token = $env:NETLIFY_TOKEN
$inviteUrl = "https://api.netlify.com/api/v1/sites/$siteId/invite"
$body = @{email=$email} | ConvertTo-Json

Write-Host "Invitation en cours pour $email..."

$response = Invoke-RestMethod -Uri $inviteUrl -Method Post -Headers @{Authorization = "Bearer $token"; 'Content-Type' = 'application/json'} -Body $body -ErrorAction Stop

Write-Host "Invitation envoyée :" ($response | ConvertTo-Json -Depth 2)
Write-Host "Ensuite, dans Netlify UI -> Identity -> Users, éditez l'utilisateur et ajoutez le rôle 'admin' pour autoriser l'accès au dashboard."
