param(
    [Parameter(Mandatory = $true)]
    [string]$Url
)

$healthUrl = $Url.TrimEnd('/') + '/api/health'
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 1
        if ($response.StatusCode -eq 200) {
            Start-Process $Url
            exit 0
        }
    } catch {
        # The gateway may still be starting; retry until the timeout below.
    }
    Start-Sleep -Milliseconds 500
}

exit 1
