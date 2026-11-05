const vscode = require('vscode');
const https = require('https');
const http = require('http');
const {performance} = require('perf_hooks');

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('zhaohuang.open', () => {
    const panel = vscode.window.createWebviewPanel('zhaohuang', 'cmb gold quote', vscode.ViewColumn.Beside, {enableScripts:true, retainContextWhenHidden:true});
    let timer, fxTimer, alive = true, lastManualStart = -Infinity, requestId = 0, appliedId = 0, quoteTime = '';
    async function refreshFx() {
      try {
        const fx = await new Promise((resolve, reject) => {
          const req = https.get('https://api.frankfurter.dev/v2/rate/USD/CNY', {timeout:15000}, res => {
            let text=''; res.setEncoding('utf8'); res.on('data', c => text += c);
            res.on('end', () => { try { if (res.statusCode !== 200) throw Error('HTTP ' + res.statusCode); resolve(JSON.parse(text)); } catch (e) { reject(e); } });
          });
          req.on('timeout', () => req.destroy(Error('请求超时'))); req.on('error', reject);
        });
        if (!(Number(fx.rate) > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(fx.date)) throw Error('汇率无效');
        if (alive) panel.webview.postMessage({fx: {rate: Number(fx.rate), date: fx.date}});
      } catch (_) { if (alive) panel.webview.postMessage({fx: null}); }
      if (alive) fxTimer = setTimeout(refreshFx, 30 * 60 * 1000);
    }
    async function refresh(manual = false) {
      if (!alive) return;
      if (manual) {
        const now = performance.now();
        if (now - lastManualStart < 1000) {
          panel.webview.postMessage({notice: '刷新过快，请间隔至少 1 秒'});
          return;
        }
        lastManualStart = now;
      }
      const id = ++requestId;
      const c = vscode.workspace.getConfiguration('zhaohuang');
      const old = vscode.workspace.getConfiguration('keshGold');
      const setting = (key, legacy) => {
        const chosen = c.inspect(key), previous = old.inspect(legacy);
        const explicit = x => x && (x.workspaceFolderValue ?? x.workspaceValue ?? x.globalValue);
        return explicit(chosen) ?? explicit(previous) ?? c.get(key);
      };
      const configuredSeconds = Number(setting('refreshseconds', 'refreshSeconds'));
      const seconds = Number.isFinite(configuredSeconds) ? Math.max(5, Math.floor(configuredSeconds)) : 5;
      if (!manual) { clearTimeout(timer); timer = setTimeout(() => refresh(), seconds * 1000); }
      try {
        const url = new URL('https://mbmodule-openapi.paas.cmbchina.com/product/v1/func/market-center');
        if (!['http:', 'https:'].includes(url.protocol)) throw Error('接口地址必须使用 HTTP 或 HTTPS');
        const body = new URLSearchParams({params: JSON.stringify([{prdType:'H',prdCode:''}])}).toString();
        const data = await new Promise((resolve, reject) => {
          const req = (url.protocol === 'https:' ? https : http).request(url, {method:'POST', timeout:15000, headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json, text/plain, */*','Origin':'https://mbmodulecdn.cmbimg.com','Referer':'https://mbmodulecdn.cmbimg.com/','X-Requested-With':'cmb.pb','User-Agent':'Mozilla/5.0', 'Content-Length':Buffer.byteLength(body)}}, res => {
            let text=''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => { try { if (res.statusCode !== 200) throw Error('HTTP ' + res.statusCode); resolve(JSON.parse(text)); } catch(e) { reject(e); } });
          });
          req.on('timeout', () => req.destroy(Error('请求超时'))); req.on('error', reject); req.end(body);
        });
        if (data.success !== true) throw Error(data.msg || data.code || '接口返回失败');
        const d = data.data, q = d.FQAMBPRCZ1;
        if (!q) throw Error('未找到报价字段');
        if (!alive) return;
        const candidate = typeof d.NowTime === 'string' && /^\d{4}[/-]\d{2}[/-]\d{2} \d{2}:\d{2}:\d{2}$/.test(d.NowTime) ? d.NowTime.replace(/-/g, '/') : '';
        const useQuote = candidate && quoteTime ? candidate > quoteTime : id >= appliedId;
        if (useQuote) { appliedId = Math.max(appliedId, id); if (candidate) quoteTime = candidate; panel.webview.postMessage({q, d:{NowTime:d.NowTime, MarketDay:d.MarketDay, QuotedPrice:d.QuotedPrice}, seconds, manual}); }
        else if (manual) panel.webview.postMessage({manualSuccess:true});
      } catch (e) { if (alive && id >= appliedId) { appliedId = id; panel.webview.postMessage({error:String(e.message || e), seconds}); } else if (alive && manual) panel.webview.postMessage({notice:'本次刷新失败：'+String(e.message || e)}); }
    }
    panel.webview.onDidReceiveMessage(m => { if (m === 'refresh') refresh(true); if (m === 'ready') { refresh(); refreshFx(); } });
    panel.onDidDispose(() => { alive = false; clearTimeout(timer); clearTimeout(fxTimer); });
    panel.webview.html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font:12px sans-serif;color:var(--vscode-foreground)}main{position:absolute;right:12px;bottom:12px;width:280px}button{position:absolute;right:0;top:24px;padding:7px 16px;background:transparent;color:inherit;border:1px solid;cursor:pointer}.price{font-size:27px}.change{font-size:16px;margin-left:7px}.muted{opacity:.7}.stats{display:flex;gap:45px;background:var(--vscode-editor-inactiveSelectionBackground);padding:5px 8px;margin:7px 0}.value{font-size:16px}.up{color:#e64c56}.down{color:#26a83e}p{margin:4px 0}</style><main><p id="message" role="status" style="min-height:1.6em;margin:0 0 4px"></p><button id="refresh">刷新</button><div><span class="price" id="buy">--</span><span class="change" id="change">--</span></div><div class="muted">实时买入价（元/克）</div><div class="muted" id="usd">约 -- 美元/盎司（1盎司=31.1034768克）</div><div class="muted" id="exchange">参考汇率：1美元 = -- 人民币</div><div class="stats"><div>今日涨跌幅<div class="value" id="percent">--</div></div><div>实时卖出价（元/克）<div class="value" id="sell">--</div></div></div><p class="muted">报价时间：<span id="time">--</span></p><p class="muted" id="status">等待报价</p><p class="muted" id="elapsed">已运行0天00时00分00秒</p></main><script>const api=acquireVsCodeApi(), start=Date.now();let state='等待报价', fx=null, buy=null, noticeTimer, persistentError='';function message(text,kind,temporary){clearTimeout(noticeTimer);if(kind==='error')persistentError=text;else if(kind==='success'||!text)persistentError='';const node=document.getElementById('message');node.textContent=text;node.style.color=kind==='success'?'#26a83e':kind==='error'?'#e64c56':'var(--vscode-foreground)';if(temporary)noticeTimer=setTimeout(()=>{node.textContent=persistentError;node.style.color=persistentError?'#e64c56':'var(--vscode-foreground)'},2000)}const el=id=>document.getElementById(id);function duration(s){const pad=n=>String(n).padStart(2,'0');return Math.floor(s/86400)+'天'+pad(Math.floor(s/3600)%24)+'时'+pad(Math.floor(s/60)%60)+'分'+pad(s%60)+'秒'}function tick(){el('status').textContent=state;el('elapsed').textContent='已运行'+duration(Math.floor((Date.now()-start)/1000))}setInterval(tick,1000);function change(id,v,s=''){let n=Number(v),x=el(id);if(v==null||v===''||!Number.isFinite(n)){x.textContent='--';x.className=id==='change'?'change':'value';return}x.textContent=(n>0&&!String(v).startsWith('+')?'+':'')+v+s;x.className=(id==='change'?'change':'value')+' '+(n>0?'up':n<0?'down':'')}el('refresh').onclick=()=>api.postMessage('refresh');function updateUsd(){el('exchange').textContent=fx?'参考汇率：1美元 = '+fx.rate+' 人民币':'参考汇率：1美元 = -- 人民币';const n=Number(buy);el('usd').textContent=fx&&buy!==null&&buy!==''&&Number.isFinite(n)&&n>0?'约 '+(n*31.1034768/fx.rate).toFixed(2)+' 美元/盎司（1盎司=31.1034768克）':'约 -- 美元/盎司（1盎司=31.1034768克）'}window.addEventListener('message',e=>{let m=e.data;if('fx' in m){fx=m.fx;updateUsd();return}if(m.manualSuccess){message('刷新成功','success',true);return}if(m.notice){message(m.notice,'notice',true);return}if(m.error){message('刷新失败：'+m.error,'error',false);return}if(m.manual)message('刷新成功','success',true);else if(persistentError)message('','',false);buy=m.q.zBuyPrc??null;updateUsd();el('buy').textContent=buy??'--';el('sell').textContent=m.q.zSelPrc??'--';el('time').textContent=m.d.NowTime??'--';change('change',m.q.zDvlCur);change('percent',m.q.zPrcDif,'%');state=(m.d.MarketDay===true?'交易日':m.d.MarketDay===false?'非交易日':'交易日未知')+' · '+(m.d.QuotedPrice===true?'报价有效':m.d.QuotedPrice===false?'报价无效':'报价未知')+' · '+m.seconds+'秒刷新';tick()});api.postMessage('ready');</script></html>`;
  }));
}
function deactivate() {}
module.exports = {activate, deactivate};
