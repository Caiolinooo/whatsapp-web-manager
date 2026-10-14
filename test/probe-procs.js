const { execFileSync } = require('child_process');

const script = `
Get-NetTCPConnection -LocalPort 3789 -ErrorAction SilentlyContinue |
  Select-Object -First 5 OwningProcess, State |
  ForEach-Object { 'port ' + $_.OwningProcess + ' ' + $_.State }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.CommandLine }
`;

const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
});
console.log(out);
