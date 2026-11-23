param([string]$Email = 'arrahim.dev@gmail.com')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run npm run setup first.' }
if ($Email -notmatch '^[a-zA-Z0-9._%+-]+@gmail\.com$') { throw 'Enter a Gmail address.' }
Write-Host 'Create a Gmail App Password with 2-Step Verification enabled: https://myaccount.google.com/apppasswords'
Write-Host 'Paste all 16 characters from Google. Spaces between groups are accepted. Press Ctrl+C to cancel.'
$appPassword = $null
while (-not $appPassword) {
    $securePassword = Read-Host 'Gmail App Password (hidden; not your normal Gmail password)' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try {
        # Browser copies can contain invisible direction marks as well as spaces.
        $candidatePassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer) -replace '[\s\p{Cf}]', ''
        if ($candidatePassword -match '^[a-zA-Z0-9]{16}$') {
            $appPassword = $candidatePassword
        } else {
            if ($candidatePassword.Length -ne 16) {
                Write-Host ('Not saved: received {0} characters after removing spaces; expected 16. Copy only the App Password from Google.' -f $candidatePassword.Length) -ForegroundColor Yellow
            } else {
                Write-Host 'Not saved: use the English letters and numbers in the Google App Password. Check that your keyboard is set to English.' -ForegroundColor Yellow
            }
        }
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
        $candidatePassword = $null
        $securePassword.Dispose()
    }
}
try {
    $content = [IO.File]::ReadAllText($envPath)
    $values = [ordered]@{ SMTP_HOST = 'smtp.gmail.com'; SMTP_PORT = '465'; SMTP_USER = $Email; SMTP_FROM = $Email; SMTP_PASSWORD = $appPassword }
    foreach ($key in $values.Keys) {
        $pattern = '(?m)^' + [regex]::Escape($key) + '=.*\r?$'
        $line = $key + '=' + $values[$key]
        if ([regex]::IsMatch($content, $pattern)) {
            $content = [regex]::Replace($content, $pattern, $line)
        } else {
            $content = $content.TrimEnd() + [Environment]::NewLine + $line + [Environment]::NewLine
        }
    }
    [IO.File]::WriteAllText($envPath, $content, (New-Object Text.UTF8Encoding($false)))
    Write-Host 'Gmail configured locally. Restart the API, then use Users & Permissions > Edit > Send verification email.'
} finally {
    $appPassword = $null
    $content = $null
    $values = $null
}
