'use strict';

const https = require('https');
const input = JSON.parse(process.argv[2]);
const url = new URL(input.url);
if (url.protocol !== 'https:' || !['mbmodule-openapi.paas.cmbchina.com', 'www.bankofchina.com'].includes(url.hostname)) {
  throw new Error('不允许的请求地址');
}
const request = https.request(url, {method: input.method, headers: input.headers, agent: false, timeout: 15000}, response => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', chunk => { body += chunk; if (body.length > 2_000_000) request.destroy(new Error('响应过大')); });
  response.on('end', () => {
    if (response.statusCode !== 200) { process.stderr.write('HTTP ' + response.statusCode); process.exitCode = 1; }
    else process.stdout.write(body);
  });
  response.on('error', err => { process.stderr.write(err.message); process.exitCode = 1; });
});
request.on('timeout', () => request.destroy(new Error('请求超时')));
request.on('error', err => { process.stderr.write(err.message); process.exitCode = 1; });
request.end(input.body || undefined);
