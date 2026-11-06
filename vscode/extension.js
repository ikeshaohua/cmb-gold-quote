const vscode = require('vscode');
const {performance} = require('perf_hooks');
const {execFile} = require('child_process');
const path = require('path');

function directRequest(url, method, headers, body) {
  const env = {...process.env, ELECTRON_RUN_AS_NODE: '1'};
  for (const key of Object.keys(env)) {
    if (/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy|node_options)$/i.test(key)) delete env[key];
  }
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(__dirname, 'direct-request.js'), JSON.stringify({url, method, headers, body})],
      {env, timeout: 20000, maxBuffer: 2_000_000, windowsHide: true},
      (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout));
  });
}

function requestText(url, method, headers, body) {
  return directRequest(url, method, headers, body);
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('zhaohuang.open', () => {
    const panel = vscode.window.createWebviewPanel('zhaohuang', 'cmb gold quote', vscode.ViewColumn.Beside, {enableScripts:true, retainContextWhenHidden:true});
    let timer, alive = true, lastManualStart = -Infinity, lastFxManual = -Infinity, fxBusy = false, requestId = 0, appliedId = 0, quoteTime = '';
    async function refreshFx(manual = false) {
      if (!alive) return;
      const now = performance.now();
      if (manual && now - lastFxManual < 10000) { panel.webview.postMessage({fxMessage:'汇率刷新过快，请间隔至少 10 s'}); return; }
      if (fxBusy) { if (manual) panel.webview.postMessage({fxMessage:'汇率刷新失败，请稍后再试'}); return; }
      if (manual) lastFxManual = now;
      fxBusy = true;
      if (manual) panel.webview.postMessage({fxMessage:''});
      try {
        const html = await requestText('https://www.bankofchina.com/sourcedb/whpj/', 'GET', {'User-Agent':'Mozilla/5.0'});
        const row = html.match(/<tr\b[^>]*>\s*<td[^>]*>\s*美元\s*<\/td>([\s\S]*?)<\/tr>/i);
        if (!row) throw Error('未找到美元牌价');
        const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1].replace(/<[^>]*>/g,'').trim());
        const bid = Number(cells[0]), ask = Number(cells[2]);
        if (!(bid > 0) || !(ask >= bid) || !Number.isFinite(ask)) throw Error('美元牌价格式无效');
        if (alive) panel.webview.postMessage({fx:{rate:(bid+ask)/200,date:cells[5] || ''},fxMessage:manual?'汇率刷新成功':''});
      } catch (e) { if (alive) panel.webview.postMessage({fx:null,fxMessage:'汇率获取失败：'+String(e.message || e)}); }
      finally { fxBusy = false; }
    }
    async function refresh(manual = false) {
      if (!alive) return;
      if (manual) {
        const now = performance.now();
        if (now - lastManualStart < 1000) {
          panel.webview.postMessage({notice: '刷新过快，请间隔至少 1 s'});
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
        const data = JSON.parse(await requestText(url.href, 'POST', {'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json, text/plain, */*','Origin':'https://mbmodulecdn.cmbimg.com','Referer':'https://mbmodulecdn.cmbimg.com/','X-Requested-With':'cmb.pb','User-Agent':'Mozilla/5.0', 'Content-Length':Buffer.byteLength(body)}, body));
        if (data.success !== true) throw Error(data.msg || data.code || '接口返回失败');
        const d = data.data, q = d.FQAMBPRCZ1;
        if (!q) throw Error('未找到报价字段');
        if (!alive) return;
        const candidate = typeof d.NowTime === 'string' && /^\d{4}[/-]\d{2}[/-]\d{2} \d{2}:\d{2}:\d{2}$/.test(d.NowTime) ? d.NowTime.replace(/-/g, '/') : '';
        const useQuote = candidate && quoteTime ? candidate > quoteTime : id >= appliedId;
        if (useQuote) { appliedId = Math.max(appliedId, id); if (candidate) quoteTime = candidate; panel.webview.postMessage({q, d:{NowTime:d.NowTime, MarketDay:d.MarketDay, QuotedPrice:d.QuotedPrice}, seconds, manual}); }
        else panel.webview.postMessage({manualSuccess:manual, quoteSuccess:true});
      } catch (e) { if (alive && id >= appliedId) { appliedId = id; panel.webview.postMessage({error:String(e.message || e), seconds}); } else if (alive && manual) panel.webview.postMessage({notice:'本次刷新失败：'+String(e.message || e)}); }
    }
    panel.webview.onDidReceiveMessage(m => { if (m === 'refresh') refresh(true); if (m === 'refreshFx') refreshFx(true); if (m === 'ready') { refresh(); refreshFx(); } });
    panel.onDidDispose(() => { alive = false; clearTimeout(timer); });
    panel.webview.html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font:12px sans-serif;color:var(--vscode-foreground)}main{position:absolute;right:12px;bottom:12px;width:280px}button{position:absolute;right:0;top:24px;padding:7px 16px;background:transparent;color:inherit;border:1px solid;cursor:pointer}#fxrow{display:flex;align-items:center;gap:6px;margin:3px 0}#fxrefresh{position:static;flex:none;padding:3px 8px;font-size:12px;margin:0}#fxmessage{flex:1;min-width:0;overflow-wrap:anywhere}.price{font-size:27px}.change{font-size:16px;margin-left:7px}.muted{opacity:.7}.stats{display:flex;gap:45px;background:var(--vscode-editor-inactiveSelectionBackground);padding:5px 8px;margin:7px 0}.value{font-size:16px}.up{color:#e64c56}.down{color:#26a83e}p{margin:4px 0}</style><main><p id="message" role="status" style="min-height:1.6em;margin:0 0 4px"></p><button id="refresh">刷新</button><div><span class="price" id="buy">--</span><span class="change" id="change">--</span></div><div class="muted">实时买入价（¥/g）</div><div class="muted" id="usd">约 $--/oz（1 oz = 31.10 g）</div><div class="muted" id="exchange">参考汇率：$1 = ¥--</div><div class="muted" id="conversionForward">¥1/g ≈ $--/oz</div><div class="muted" id="conversionReverse">$1/oz ≈ ¥--/g</div><div id="fxrow"><button id="fxrefresh">刷新汇率</button><span id="fxmessage" role="status"></span></div><div class="stats"><div>今日涨跌幅<div class="value" id="percent">--</div></div><div>实时卖出价（¥/g）<div class="value" id="sell">--</div></div></div><p class="muted">报价时间：<span id="time">--</span></p><p class="muted" id="status">等待报价</p><p class="muted" id="elapsed">已运行 0 d 00 h 00 min 00 s</p></main><script>const api=acquireVsCodeApi(), start=Date.now();let state='等待报价', fx=null, buy=null, noticeTimer, persistentError='';let fxNoticeTimer;function message(text,kind,temporary){clearTimeout(noticeTimer);persistentError='';const node=document.getElementById('message');node.textContent=text;node.style.color=kind==='success'?'#26a83e':kind==='error'?'#e64c56':'var(--vscode-foreground)';if(text)noticeTimer=setTimeout(()=>{node.textContent=''},2000)}function fxMessage(text){clearTimeout(fxNoticeTimer);const node=document.getElementById('fxmessage');node.textContent=text;node.style.color=text==='汇率刷新成功'?'#26a83e':'#e64c56';if(text)fxNoticeTimer=setTimeout(()=>{node.textContent=''},2000)}const el=id=>document.getElementById(id);function duration(s){const pad=n=>String(n).padStart(2,'0');return Math.floor(s/86400)+' d '+pad(Math.floor(s/3600)%24)+' h '+pad(Math.floor(s/60)%60)+' min '+pad(s%60)+' s'}function tick(){el('status').textContent=state;el('elapsed').textContent='已运行 '+duration(Math.floor((Date.now()-start)/1000))}setInterval(tick,1000);function change(id,v,s=''){let n=Number(v),x=el(id);if(v==null||v===''||!Number.isFinite(n)){x.textContent='--';x.className=id==='change'?'change':'value';return}x.textContent=(n>0&&!String(v).startsWith('+')?'+':'')+v+s;x.className=(id==='change'?'change':'value')+' '+(n>0?'up':n<0?'down':'')}el('refresh').onclick=()=>api.postMessage('refresh');el('fxrefresh').onclick=()=>api.postMessage('refreshFx');function updateUsd(){el('exchange').textContent=fx?'参考汇率：$1 = ¥'+fx.rate.toFixed(2)+'（中行现汇买卖均价）':'参考汇率：$1 = ¥--';el('conversionForward').textContent=fx?'¥1/g ≈ $'+(31.1034768/fx.rate).toFixed(2)+'/oz':'¥1/g ≈ $--/oz';el('conversionReverse').textContent=fx?'$1/oz ≈ ¥'+(fx.rate/31.1034768).toFixed(4)+'/g':'$1/oz ≈ ¥--/g';const n=Number(buy);el('usd').textContent=fx&&buy!==null&&buy!==''&&Number.isFinite(n)&&n>0?'约 $'+(n*31.1034768/fx.rate).toFixed(2)+'/oz（1 oz = 31.10 g）':'约 $--/oz（1 oz = 31.10 g）'}window.addEventListener('message',e=>{let m=e.data;if('fxMessage' in m)fxMessage(m.fxMessage);if('fx' in m){fx=m.fx;updateUsd();return}if(m.fxMessage!==undefined)return;if(m.quoteSuccess){if(m.manualSuccess)message('刷新成功','success',true);else if(persistentError)message('','',false);return}if(m.manualSuccess){message('刷新成功','success',true);return}if(m.notice){message(m.notice,'error',true);return}if(m.error){message('刷新失败：'+m.error,'error',false);return}if(m.manual)message('刷新成功','success',true);else if(persistentError)message('','',false);buy=m.q.zBuyPrc??null;updateUsd();el('buy').textContent=buy??'--';el('sell').textContent=m.q.zSelPrc??'--';el('time').textContent=m.d.NowTime??'--';change('change',m.q.zDvlCur);change('percent',m.q.zPrcDif,'%');state=(m.d.MarketDay===true?'交易日':m.d.MarketDay===false?'非交易日':'交易日未知')+' · '+(m.d.QuotedPrice===true?'报价有效':m.d.QuotedPrice===false?'报价无效':'报价未知')+' · '+'每 '+m.seconds+' s 刷新';tick()});api.postMessage('ready');</script></html>`;
  }));
}
function deactivate() {}
module.exports = {activate, deactivate};
