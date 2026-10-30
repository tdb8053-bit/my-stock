const TWSE = Object.freeze({
  BASE:'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX',
  ETF_TYPE:'0099P',
  CACHE_SECONDS:300
});

function findLatestEtfClose_(today) {
  for (let offset=0; offset<10; offset++) {
    const d=new Date(today.getTime());
    d.setDate(d.getDate()-offset);
    const key=Utilities.formatDate(d,'Asia/Taipei','yyyyMMdd');
    try {
      const table=fetchEtfTable_(key);
      if(Object.keys(table.map).length) return table;
    } catch (_) {}
  }
  throw new Error('目前無法從證交所取得最近 ETF 收盤資料。');
}

function fetchEtfTable_(dateKey) {
  const cache=CacheService.getScriptCache();
  const cacheKey='twse-etf-'+dateKey;
  const saved=cache.get(cacheKey);
  if(saved) return JSON.parse(saved);
  const url=TWSE.BASE+'?date='+encodeURIComponent(dateKey)+'&type='+TWSE.ETF_TYPE+'&response=json';
  const response=UrlFetchApp.fetch(url,{muteHttpExceptions:true,headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0'}});
  if(response.getResponseCode()!==200) throw new Error('證交所回應 HTTP '+response.getResponseCode());
  const payload=JSON.parse(response.getContentText('UTF-8'));
  if(payload.stat!=='OK') throw new Error('證交所該日沒有 ETF 收盤資料。');
  const table=(payload.tables||[]).find(t=>Array.isArray(t.fields)&&Array.isArray(t.data)&&t.fields.includes('證券代號')&&t.fields.includes('收盤價'));
  if(!table) throw new Error('證交所 ETF 回應欄位格式改變。');
  const codeAt=table.fields.indexOf('證券代號'), closeAt=table.fields.indexOf('收盤價');
  const map={};
  table.data.forEach(row=>{const code=String(row[codeAt]||'').trim(),close=parseMarketNumber_(row[closeAt]);if(code&&close!=null)map[code]={close:close};});
  const result={date:payload.date||dateKey,map:map};
  cache.put(cacheKey,JSON.stringify(result),TWSE.CACHE_SECONDS);
  return result;
}

function fetchIndexClose_(dateKey) {
  const cache=CacheService.getScriptCache();
  const key='twse-weighted-index-'+dateKey;
  const saved=cache.get(key);
  if(saved)return JSON.parse(saved);
  const url=TWSE.BASE+'?date='+encodeURIComponent(dateKey)+'&type=IND&response=json';
  const response=UrlFetchApp.fetch(url,{muteHttpExceptions:true,headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0'}});
  if(response.getResponseCode()!==200)throw new Error('證交所指數回應 HTTP '+response.getResponseCode());
  const payload=JSON.parse(response.getContentText('UTF-8'));
  const table=(payload.tables||[]).find(t=>Array.isArray(t.fields)&&Array.isArray(t.data)&&t.fields.includes('指數')&&t.fields.includes('收盤指數'));
  const nameAt=table?table.fields.indexOf('指數'):-1,closeAt=table?table.fields.indexOf('收盤指數'):-1,changeAt=table?table.fields.indexOf('漲跌百分比(%)'):-1;
  const row=table&&table.data.find(r=>String(r[nameAt]||'').trim()==='發行量加權股價指數');
  const result={date:payload.date||dateKey,close:row?parseMarketNumber_(row[closeAt]):null,changePercent:row?parseMarketNumber_(row[changeAt]):null};
  cache.put(key,JSON.stringify(result),TWSE.CACHE_SECONDS);
  return result;
}

function parseMarketNumber_(value) {
  if(value==null||value===''||value==='--'||value==='－')return null;
  const n=Number(String(value).replace(/,/g,''));
  return Number.isFinite(n)?n:null;
}
