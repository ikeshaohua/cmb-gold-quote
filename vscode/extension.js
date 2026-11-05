const vscode = require('vscode');
const https = require('https');
const http = require('http');

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('zhaohuang.open', () => {
    const panel = vscode.window.createWebviewPanel('zhaohuang', 'cmb gold quote', vscode.ViewColumn.Beside, {enableScripts:true, retainContextWhenHidden:true});
    let timer, alive = true, busy = false;
    async function refresh() {
      if (!alive || busy) return;
      busy = true;
      clearTimeout(timer);
      const c = vscode.workspace.getConfiguration('zhaohuang');
      const old = vscode.workspace.getConfiguration('keshGold');
      const setting = (key, legacy) => {
        const chosen = c.inspect(key), previous = old.inspect(legacy);
        const explicit = x => x && (x.workspaceFolderValue ?? x.workspaceValue ?? x.globalValue);
        return explicit(chosen) ?? explicit(previous) ?? c.get(key);
      };
      const seconds = Math.max(1, Number(setting('refreshseconds', 'refreshSeconds')) || 5);
      try {
        const url = new URL(setting('apiurl', 'apiUrl'));
        if (!['http:', 'https:'].includes(url.protocol)) throw Error('接口地址必须使用 HTTP 或 HTTPS');
        const body = new URLSearchParams({params: JSON.stringify(setting('requestparams', 'requestParams'))}).toString();
        const data = await new Promise((resolve, reject) => {
          const req = (url.protocol === 'https:' ? https : http).request(url, {method:'POST', timeout:15000, headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json, text/plain, */*','Origin':'https://mbmodulecdn.cmbimg.com','Referer':'https://mbmodulecdn.cmbimg.com/','X-Requested-With':'cmb.pb','User-Agent':'Mozilla/5.0', 'Content-Length':Buffer.byteLength(body)}}, res => {
            let text=''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => { try { if (res.statusCode !== 200) throw Error('HTTP ' + res.statusCode); resolve(JSON.parse(text)); } catch(e) { reject(e); } });
          });
          req.on('timeout', () => req.destroy(Error('请求超时'))); req.on('error', reject); req.end(body);
        });
        if (data.success !== true) throw Error(data.msg || data.code || '接口返回失败');
        const d = data.data, q = d[setting('quotekey', 'quoteKey')];
        if (!q) throw Error('未找到报价字段');
        panel.webview.postMessage({q, d:{NowTime:d.NowTime, MarketDay:d.MarketDay, QuotedPrice:d.QuotedPrice}, seconds});
      } catch (e) { panel.webview.postMessage({error:String(e.message || e), seconds}); }
      busy = false;
      if (alive) timer = setTimeout(refresh, seconds * 1000);
    }
    panel.webview.onDidReceiveMessage(m => { if (m === 'refresh') refresh(); });
    panel.onDidDispose(() => { alive = false; clearTimeout(timer); });
    panel.webview.html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font:12px sans-serif;color:var(--vscode-foreground)}main{position:absolute;right:12px;bottom:12px;width:280px}button{position:absolute;right:0;top:0;padding:7px 16px;background:transparent;color:inherit;border:1px solid;cursor:pointer}.price{font-size:27px}.change{font-size:16px;margin-left:7px}.muted{opacity:.7}.stats{display:flex;gap:45px;background:var(--vscode-editor-inactiveSelectionBackground);padding:5px 8px;margin:7px 0}.value{font-size:16px}.up{color:#e64c56}.down{color:#26a83e}p{margin:4px 0}</style><main><button id="refresh">刷新</button><div><span class="price" id="buy">--</span><span class="change" id="change">--</span></div><div class="muted">实时买入价（元/克）</div><div class="stats"><div>今日涨跌幅<div class="value" id="percent">--</div></div><div>实时卖出价（元/克）<div class="value" id="sell">--</div></div></div><p class="muted">报价时间：<span id="time">--</span></p><p class="muted" id="status">等待报价</p><p id="error"></p></main><script>const api=acquireVsCodeApi(), start=Date.now();let state='等待报价';const el=id=>document.getElementById(id);function duration(s){let a=[];for(const [n,u] of [[86400,'天'],[3600,'小时'],[60,'分'],[1,'秒']]){let x=Math.floor(s/n);s%=n;if(x)a.push(x+u)}return a.join('')||'0秒'}function tick(){el('status').textContent=state+' · 等待'+duration(Math.floor((Date.now()-start)/1000))}setInterval(tick,1000);function change(id,v,s=''){let n=Number(v),x=el(id);if(v==null||v===''||!Number.isFinite(n)){x.textContent='--';x.className=id==='change'?'change':'value';return}x.textContent=(n>0&&!String(v).startsWith('+')?'+':'')+v+s;x.className=(id==='change'?'change':'value')+' '+(n>0?'up':n<0?'down':'')}el('refresh').onclick=()=>api.postMessage('refresh');window.addEventListener('message',e=>{let m=e.data;if(m.error){el('error').textContent='刷新失败：'+m.error;return}el('error').textContent='';el('buy').textContent=m.q.zBuyPrc??'--';el('sell').textContent=m.q.zSelPrc??'--';el('time').textContent=m.d.NowTime??'--';change('change',m.q.zDvlCur);change('percent',m.q.zPrcDif,'%');state=(m.d.MarketDay===true?'交易日':m.d.MarketDay===false?'非交易日':'交易日未知')+' · '+(m.d.QuotedPrice===true?'报价有效':m.d.QuotedPrice===false?'报价无效':'报价未知')+' · '+m.seconds+'秒刷新';tick()});</script></html>`;
    refresh();
  }));
}
function deactivate() {}
module.exports = {activate, deactivate};
