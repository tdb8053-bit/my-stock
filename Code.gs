const APP = Object.freeze({
  SPREADSHEET_PROPERTY: 'ASSET_MANAGER_SPREADSHEET_ID',
  HISTORY_SHEET: '每日損益紀錄',
  TRANSACTIONS_SHEET: '交易記錄',
  SUMMARY_SHEET: '總覽',
  DIVIDEND_SHEET: '存股配息',
  WATCH_CODES: Object.freeze([
    '00980A','00982A','00981A','00983A','00984A','00985A','00986A','00982D','00983D','00989A','00988A','00991A','00990A','00987A','00992A','00994A','00995A','00993A','00984D','00996A','00400A','00401A','00997A','00999A','00403A','00402A','00404A','00405A','00406A','00407A','00408A','00410A','00409A','00412A','00415A'
  ])
});

function doGet() {
  const output=HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('資產總管')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
  const favicon=output.getContent().match(/<link rel="icon"[^>]*href="([^"]+)"/);
  // Apps Script only accepts hosted image URLs here; data:image URIs throw an exception.
  if(favicon && /^https:\/\/[^\s"']+\.(?:png|gif|ico|jpg|jpeg)(?:[?#][^\s"']*)?$/i.test(favicon[1])) {
    output.setFaviconUrl(favicon[1]);
  }
  return output;
}

function setupPrivateApp() {
  const id = PropertiesService.getScriptProperties().getProperty(APP.SPREADSHEET_PROPERTY);
  if (!id) throw new Error('請先在 Apps Script「專案設定 > 指令碼屬性」設定 ASSET_MANAGER_SPREADSHEET_ID。');
  const book = SpreadsheetApp.openById(id);
  [APP.SUMMARY_SHEET, APP.DIVIDEND_SHEET, APP.TRANSACTIONS_SHEET].forEach(name => {
    if (!book.getSheetByName(name)) throw new Error('新版試算表缺少工作表：' + name);
  });
  ensureHistorySheet_(book);
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'captureDailyPnl')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('captureDailyPnl').timeBased().everyDays(1).atHour(14).nearMinute(10).create();
  return {ok:true, spreadsheetName:book.getName(), historySheet:APP.HISTORY_SHEET, trigger:'每日約 14:10（台北時間）'};
}

function getPortfolioData() {
  try {
    const book = getBook_();
    const summarySheet = requiredSheet_(book, APP.SUMMARY_SHEET);
    const dividendSheet = requiredSheet_(book, APP.DIVIDEND_SHEET);
    const txSheet = requiredSheet_(book, APP.TRANSACTIONS_SHEET);
    const transactionOptions=readTransactionOptions_(txSheet);
    const realizedByCode=readRealizedPnlByCode_(txSheet,transactionOptions.headerRow);
    const sourceHoldings=readHoldings_(summarySheet);
    const holdings=sourceHoldings.map(item=>{
      if(!Object.prototype.hasOwnProperty.call(realizedByCode,item.code))return item;
      return Object.assign({},item,{realizedPnl:realizedByCode[item.code]+(numOrNull_(item.legacyRealizedPnl)||0)});
    });
    const summary=readSummary_(summarySheet);
    const representedCodes=new Set(sourceHoldings.map(item=>item.code));
    const realizedTotal=holdings.reduce((sum,item)=>sum+(numOrNull_(item.realizedPnl)||0),0)
      +Object.keys(realizedByCode).reduce((sum,code)=>sum+(representedCodes.has(code)?0:realizedByCode[code]),0);
    if(Object.keys(realizedByCode).length){
      const totalRow=summary.find(item=>/總已實現損益/.test(item.label));
      if(totalRow)totalRow.value=realizedTotal;
    }
    return {
      ok:true,
      summary:summary,
      assetTotal:numOrNull_(summarySheet.getRange('D5').getValue()),
      holdings:holdings,
      stockOptions:readStockOptions_(txSheet,holdings),
      dividends:readDividends_(dividendSheet),
      pnlHistory:readPnlHistory_(book),
      transactionOptions:transactionOptions,
      updatedAt:new Date().toISOString(),
      source:'新版資產總管試算表'
    };
  } catch (err) {
    return {ok:false,error:publicError_(err),updatedAt:new Date().toISOString()};
  }
}

function getWatchlistData() {
  try {
    const now = new Date();
    const latest = findLatestEtfClose_(now);
    let historical={date:'20260730',map:{}};
    try { historical=fetchEtfTable_('20260730'); } catch (_) {}
    let latestIndex={date:latest.date,close:null,changePercent:null};
    let historicalIndex={date:'20260730',close:null,changePercent:null};
    try { latestIndex=fetchIndexClose_(latest.date); } catch (_) {}
    try { historicalIndex=fetchIndexClose_('20260730'); } catch (_) {}
    const latestMap = latest.map;
    const historicalMap = historical.map;
    const items = APP.WATCH_CODES.map(code => {
      const oldPrice = historicalMap[code] == null ? null : historicalMap[code].close;
      const current = latestMap[code] == null ? null : latestMap[code].close;
      return {
        code,
        historicalClose:oldPrice,
        latestPrice:current,
        changePercent:oldPrice && current != null ? (current / oldPrice - 1) * 100 : null,
        asOf:latest.date,
        status:current == null ? '無最新報價' : (oldPrice == null ? '無歷史價' : '有報價')
      };
    }).filter(item => item.historicalClose != null && item.latestPrice != null && item.changePercent != null);
    return {
      ok:true, items,
      index:{code:'加權指數',historicalClose:historicalIndex.close,latestPrice:latestIndex.close,changePercent:historicalIndex.close&&latestIndex.close!=null?(latestIndex.close/historicalIndex.close-1)*100:null,status:latestIndex.close==null?'無報價':'有報價'},
      historicalDate:'2026-07-30', asOf:formatMarketDate_(latest.date),
      source:'臺灣證券交易所 ETF 每日收盤行情（盤後資料）', delayed:true,
      note:'非盤中即時報價；僅列出同時具有 2026/07/30 歷史收盤與最新收盤資料的代號。'
    };
  } catch (err) {
    return {ok:false,error:publicError_(err),items:[],asOf:null,source:'臺灣證券交易所',delayed:true};
  }
}

function submitTransaction(payload, requestId) {
  const id = String(requestId || '').trim();
  if (!/^[\w-]{12,80}$/.test(id)) throw new Error('交易識別碼格式錯誤。');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    const key = 'TX_' + id;
    const previous = props.getProperty(key);
    if (previous) {
      const state = JSON.parse(previous);
      if (state.status === 'written') return state.result;
      throw new Error('這筆送出狀態尚待核對，為避免重複記帳，請先重新整理並確認交易記錄。');
    }
    const tx = validateTransaction_(payload);
    const book=getBook_();
    const sheet = requiredSheet_(book, APP.TRANSACTIONS_SHEET);
    if(tx.side==='sell'){
      const holding=readHoldings_(requiredSheet_(book,APP.SUMMARY_SHEET)).find(item=>item.code===tx.code);
      if(!holding||Number(holding.shares||0)<tx.quantity)throw new Error('賣出股數超過試算表目前庫存，請先重新整理庫存。');
    }
    const headerRow = findHeaderRow_(sheet, ['股票名稱','交易日期','類別']);
    const row = findNextTransactionRow_(sheet, headerRow);
    prepareTransactionFormulaCells_(sheet, row, headerRow);
    props.setProperty(key, JSON.stringify({status:'pending',createdAt:new Date().toISOString()}));
    try {
      const values = new Array(11).fill('');
      values[0] = tx.code;
      values[1] = new Date(tx.date + 'T00:00:00+08:00');
      values[2] = (tx.type === 'margin' ? '融資' : '現股') + (tx.side === 'buy' ? '買進' : '賣出');
      if (tx.side === 'buy') {
        values[3] = tx.quantity;
        values[4] = tx.price;
        values[5] = tx.type === 'margin' ? tx.financing : '';
        values[6] = tx.amount;
      } else {
        values[7] = tx.quantity;
        values[9] = tx.type === 'margin' ? tx.repayment : '';
        values[10] = tx.amount - (tx.type === 'margin' ? tx.repayment : 0);
      }
      sheet.getRange(row, 1, 1, 8).setValues([values.slice(0,8)]);
      sheet.getRange(row, 10, 1, 2).setValues([[values[9],values[10]]]);
      sheet.getRange(row, 2).setNumberFormat('yyyy/mm/dd');
      SpreadsheetApp.flush();
      const result = {ok:true,requestId:id,row:row,message:'交易紀錄已寫入新版試算表。'};
      props.setProperty(key, JSON.stringify({status:'written',result:result,createdAt:new Date().toISOString()}));
      return result;
    } catch (err) {
      props.setProperty(key, JSON.stringify({status:'uncertain',createdAt:new Date().toISOString(),message:String(err)}));
      throw new Error('交易寫入結果待核對，請先查看交易記錄，不要直接重送。');
    }
  } finally {
    lock.releaseLock();
  }
}

function getSubmissionStatus(requestId) {
  const id = String(requestId || '').trim();
  if (!/^[\w-]{12,80}$/.test(id)) return {status:'not_found'};
  const raw = PropertiesService.getScriptProperties().getProperty('TX_' + id);
  if (!raw) return {status:'not_found'};
  const value = JSON.parse(raw);
  return {status:value.status,result:value.result || null,message:value.message || null};
}

function captureDailyPnl() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const todayKey=Utilities.formatDate(new Date(),'Asia/Taipei','yyyyMMdd');
    let marketDate;
    try { marketDate=findLatestEtfClose_(new Date()).date; }
    catch (_) { return {ok:false,skipped:true,reason:'無法確認最新交易日，略過今日快照。'}; }
    if(marketDate!==todayKey)return {ok:true,skipped:true,reason:'今日沒有證交所 ETF 收盤資料，略過非交易日快照。'};
    const book = getBook_();
    const summary = readSummary_(requiredSheet_(book, APP.SUMMARY_SHEET));
    const pnl = summary.find(x => /本期損益|期間損益/.test(x.label));
    if (!pnl || pnl.value == null) return {ok:false,skipped:true,reason:'總覽尚無可用的本期損益資料。'};
    const sheet = ensureHistorySheet_(book);
    const dateKey = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
    if (readPnlHistory_(book).some(point=>point.date===dateKey)) return {ok:true,duplicate:true,date:dateKey};
    sheet.appendRow([dateKey,new Date(),Number(pnl.value)]);
    return {ok:true,date:dateKey,pnl:Number(pnl.value)};
  } finally { lock.releaseLock(); }
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('資產總管網頁').addItem('初始化每日損益紀錄', 'setupPrivateApp').addToUi();
}

function getBook_() {
  const id = PropertiesService.getScriptProperties().getProperty(APP.SPREADSHEET_PROPERTY);
  if (!id) throw new Error('尚未設定新版試算表 ID。');
  return SpreadsheetApp.openById(id);
}
function requiredSheet_(book, name) {
  const sheet = book.getSheetByName(name);
  if (!sheet) throw new Error('找不到工作表：' + name);
  return sheet;
}
function readSummary_(sheet) {
  const values = sheet.getRange('A3:D10').getValues();
  const display = sheet.getRange('A3:D10').getDisplayValues();
  const result=[];
  values.forEach((row,i)=>{
    [[0,1],[2,3]].forEach(([labelCol,valueCol])=>{
      const label=String(row[labelCol]||'').trim();
      const value=numOrNull_(row[valueCol]);
      if(label||value!=null)result.push({label:label||('摘要 '+(i+1)),value,display:[display[i][labelCol],display[i][valueCol]].filter(Boolean).join('：')});
    });
  });
  return result;
}
function readHoldings_(sheet) {
  const last = sheet.getLastRow();
  if (last < 3) return [];
  const values = sheet.getRange(1,6,last,14).getValues(); // F:S
  const display = sheet.getRange(1,6,last,14).getDisplayValues();
  const realizedFormulas=sheet.getRange(1,16,last,1).getFormulas(); // P:P
  const out = [];
  values.forEach((row, idx) => {
    const code = String(row[0] || '').trim();
    if (!/^\d{4,6}[A-Z]?$/.test(code) || idx < 2) return;
    const changePercent=String(display[idx][3]||'').includes('%')?numOrNull_(display[idx][3]):numOrNull_(row[3]);
    const realizedFormula=String(realizedFormulas[idx][0]||'');
    const ledgerLinked=/交易記錄['"]?!\$?L\$?\d+/.test(realizedFormula);
    out.push({code,price:numOrNull_(row[1]),change:numOrNull_(row[2]),changePercent,shares:numOrNull_(row[4]),averageCost:numOrNull_(row[5]),marketValue:numOrNull_(row[8]),unrealizedPnl:numOrNull_(row[9]),realizedPnl:numOrNull_(row[10]),legacyRealizedPnl:ledgerLinked?0:numOrNull_(row[10]),todayPnl:numOrNull_(row[11]),dividends:numOrNull_(row[12]),totalReturn:numOrNull_(row[13])});
  });
  return out;
}
function readDividends_(sheet) {
  const totalCollected=numOrNull_(sheet.getRange('O2').getValue());
  const lastRow=sheet.getLastRow();
  if(lastRow<7)return {totalCollected,monthlyRows:[]};
  const rowCount=lastRow-6;
  const monthValues=sheet.getRange(7,1,rowCount,1).getValues();
  const monthDisplay=sheet.getRange(7,1,rowCount,1).getDisplayValues();
  const gValues=sheet.getRange(7,5,rowCount,1).getValues();
  const lValues=sheet.getRange(7,12,rowCount,1).getValues();
  const monthlyRows=[];
  for(let i=0;i<rowCount;i++){
    const month=normalizeDividendMonth_(monthValues[i][0],monthDisplay[i][0]);
    if(!month)continue;
    monthlyRows.push({month:month.label,monthKey:month.key,gVal:numOrNull_(gValues[i][0]),lVal:numOrNull_(lValues[i][0])});
  }
  monthlyRows.sort((a,b)=>a.monthKey-b.monthKey);
  return {totalCollected,monthlyRows};
}
function normalizeDividendMonth_(value,displayValue) {
  if(value instanceof Date){const year=Number(Utilities.formatDate(value,'Asia/Taipei','yyyy')),month=Number(Utilities.formatDate(value,'Asia/Taipei','M'));return {key:year*100+month,label:year+'/'+String(month).padStart(2,'0')};}
  const text=String(displayValue||value||'').trim();
  let match=text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if(!match)match=text.match(/^(\d{4})\s*[\/-]\s*(\d{1,2})$/);
  if(!match)return null;
  const year=Number(match[1]),month=Number(match[2]);
  if(month<1||month>12)return null;
  return {key:year*100+month,label:year+'/'+String(month).padStart(2,'0')};
}
function readPnlHistory_(book) {
  const sheet=book.getSheetByName(APP.HISTORY_SHEET);
  if (!sheet || sheet.getLastRow()<2) return [];
  const count=sheet.getLastRow()-1;
  const values=sheet.getRange(2,1,count,3).getValues();
  const display=sheet.getRange(2,1,count,3).getDisplayValues();
  const byDate=new Map();
  values.forEach((row,index)=>{
    const date=normalizeHistoryDate_(row[0],display[index][0]);
    const pnl=numOrNull_(row[2]);
    if(!date||pnl==null)return;
    byDate.set(date,{date,capturedAt:row[1] instanceof Date ? row[1].toISOString() : '',pnl});
  });
  return Array.from(byDate.values()).sort((a,b)=>a.date.localeCompare(b.date));
}
function normalizeHistoryDate_(value,displayValue) {
  if(value instanceof Date)return Utilities.formatDate(value,'Asia/Taipei','yyyy-MM-dd');
  const text=String(displayValue||value||'').trim();
  const match=text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if(!match)return null;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
  return year+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');
}
function readTransactionOptions_(sheet) {
  const header=findHeaderRow_(sheet,['股票名稱','交易日期','類別']);
  return {headerRow:header,firstDataRow:header+1,columns:sheet.getRange(header,1,1,13).getDisplayValues()[0]};
}
function readRealizedPnlByCode_(sheet,headerRow) {
  const first=headerRow+1,last=sheet.getLastRow();
  if(last<first)return {};
  const rows=sheet.getRange(first,1,last-first+1,13).getValues();
  const realized={};
  rows.forEach(row=>{
    const code=String(row[0]||'').trim().toUpperCase();
    const kind=String(row[2]||'').trim();
    if(!/^\d{4,6}[A-Z]?$/.test(code))return;
    if(kind==='現股賣出'||kind==='融資賣出'){
      // 交易記錄 L 欄是工作表自己的逐筆已實現損益公式；直接採用它，
      // 避免在網頁端另行推算成本均價而偏離帳本公式。
      const profit=numOrNull_(row[11]);
      if(profit!=null)realized[code]=(realized[code]||0)+profit;
    }
  });
  return realized;
}
function readStockOptions_(sheet,holdings) {
  const codes=new Set((holdings||[]).map(h=>String(h.code||'').trim()).filter(code=>/^\d{4,6}[A-Z]?$/.test(code)));
  const header=findHeaderRow_(sheet,['股票名稱','交易日期','類別']);
  const last=sheet.getLastRow();
  if(last>header)sheet.getRange(header+1,1,last-header,1).getDisplayValues().flat().forEach(value=>{
    const code=String(value||'').trim().toUpperCase();
    if(/^\d{4,6}[A-Z]?$/.test(code))codes.add(code);
  });
  return Array.from(codes).sort((a,b)=>a.localeCompare(b,'zh-TW',{numeric:true}));
}
function validateTransaction_(p) {
  if (!p || typeof p !== 'object') throw new Error('交易資料格式錯誤。');
  const code=String(p.code || '').trim();
  const side=String(p.side || '');
  const type=String(p.type || '');
  const date=String(p.date || '');
  const qty=Number(p.quantity), price=Number(p.price), amount=Number(p.amount);
  if (!/^\d{4,6}[A-Z]?$/.test(code)) throw new Error('請輸入有效股票代號。');
  if (!['buy','sell'].includes(side) || !['cash','margin'].includes(type)) throw new Error('交易方向或類別無效。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date+'T00:00:00+08:00'))) throw new Error('交易日期格式錯誤。');
  const parsedDate=new Date(date+'T00:00:00+08:00');
  if(Utilities.formatDate(parsedDate,'Asia/Taipei','yyyy-MM-dd')!==date)throw new Error('交易日期不存在。');
  if (!(qty>0) || !Number.isInteger(qty) || !(price>0) || !(amount>0) || ![qty,price,amount].every(Number.isFinite)) throw new Error('股數須為正整數，成交價與金額須大於零。');
  const financing=Number(p.financing || 0), repayment=Number(p.repayment || 0);
  if(!Number.isFinite(financing)||!Number.isFinite(repayment)||financing<0||repayment<0)throw new Error('融資與償還金額必須是大於或等於零的有效數字。');
  if (type==='margin' && side==='buy' && !(financing>0)) throw new Error('融資買進請填融資金額。');
  if (type==='margin' && side==='buy' && financing>amount) throw new Error('融資金額不可高於交易金額。');
  if (type==='margin' && side==='sell' && (!(repayment>=0)||repayment>amount)) throw new Error('償還融資不可高於交易金額。');
  return {code,side,type,date,quantity:qty,price,amount,financing,repayment};
}
function findHeaderRow_(sheet, required) {
  const rows=Math.min(30,Math.max(1,sheet.getLastRow()));
  const expected=['股票名稱','交易日期','類別','買進股數','成交價','融資金額','應付金額','賣出股數','賣出單價','償還融資','應收金額','損益','剩餘庫存'];
  const values=sheet.getRange(1,1,rows,Math.max(expected.length,sheet.getLastColumn())).getDisplayValues();
  for(let i=0;i<values.length;i++){
    const headers=values[i].slice(0,expected.length).map(value=>String(value||'').trim());
    if(required.every(label=>headers.some(cell=>cell.indexOf(label)>=0))&&expected.every((label,index)=>headers[index]===label))return i+1;
  }
  throw new Error('交易記錄完整 A:M 表頭與預期不符，為保護摘要與公式，未寫入資料。');
}
function findNextTransactionRow_(sheet,headerRow) {
  const first=headerRow+1,last=Math.max(headerRow,sheet.getLastRow());
  let lastInput=headerRow;
  if(last>=first){
    const rows=sheet.getRange(first,1,last-first+1,11).getDisplayValues();
    for(let i=rows.length-1;i>=0;i--){
      if(rows[i].some(value=>String(value||'').trim()!=='')){lastInput=first+i;break;}
    }
  }
  const row=Math.max(first,lastInput+1);
  const formulaLimit=findTransactionFormulaLimit_(sheet,headerRow);
  if(row>formulaLimit)throw new Error('交易記錄已超出目前試算表預留公式範圍（第 '+formulaLimit+' 列）。請先在試算表延伸交易計算公式，再重新送出。');
  return row;
}
function findTransactionFormulaLimit_(sheet,headerRow) {
  const formulaRows=Math.min(10,Math.max(1,headerRow-1));
  const formulas=sheet.getRange(1,1,formulaRows,Math.max(13,sheet.getLastColumn())).getFormulas().flat();
  let limit=headerRow;
  let hasOpenEndedTransactionRange=false;
  formulas.forEach(formula=>{
    const matches=String(formula||'').matchAll(/(\$?[A-Z]{1,3}\$?\d+):(\$?[A-Z]{1,3}\$?\d*)/g);
    for(const match of matches){
      const start=Number((match[1].match(/\d+/)||[])[0]);
      const endMatch=match[2].match(/\d+$/);
      if(start<headerRow+1)continue;
      if(endMatch)limit=Math.max(limit,Number(endMatch[0]));
      else hasOpenEndedTransactionRange=true;
    }
  });
  if(hasOpenEndedTransactionRange)limit=Math.max(limit,sheet.getMaxRows());
  if(limit===headerRow){
    [12,13].forEach(col=>{
      const cells=sheet.getRange(headerRow+1,col,Math.max(1,sheet.getLastRow()-headerRow),1).getFormulas().flat();
      cells.forEach((formula,index)=>{if(formula)limit=Math.max(limit,headerRow+1+index);});
    });
  }
  return limit;
}
function prepareTransactionFormulaCells_(sheet,row,headerRow) {
  const first=headerRow+1;
  if(!sheet.getRange(row,9).getFormulaR1C1())sheet.getRange(row,9).setFormulaR1C1('=IF(RC[-1]=0,"",(RC[1]+RC[2])/RC[-1])');
  if(!sheet.getRange(row,12).getFormulaR1C1()){
    const priorLast=row-1;
    const pnlFormula=row<=first
      ? '=IF(OR(RC[-9]="現股賣出",RC[-9]="融資賣出"),RC[-2]+RC[-1],"")'
      : '=IF(OR(RC[-9]="現股賣出",RC[-9]="融資賣出"),RC[-2]+RC[-1]-RC[-4]*IFERROR(SUMIFS(R'+first+'C7:R'+priorLast+'C7,R'+first+'C1:R'+priorLast+'C1,RC[-11])/SUMIFS(R'+first+'C4:R'+priorLast+'C4,R'+first+'C1:R'+priorLast+'C1,RC[-11]),0),"")';
    sheet.getRange(row,12).setFormulaR1C1(pnlFormula);
  }
  if(!sheet.getRange(row,13).getFormulaR1C1()){
    let templateRow=0;
    for(let candidate=Math.min(row-1,sheet.getLastRow());candidate>headerRow;candidate--){
      if(sheet.getRange(candidate,13).getFormulaR1C1()){templateRow=candidate;break;}
    }
    if(!templateRow)throw new Error('交易計算欄 M 找不到可沿用的庫存公式樣板，已停止寫入。');
    sheet.getRange(row,13).setFormulaR1C1(sheet.getRange(templateRow,13).getFormulaR1C1());
  }
}
function ensureHistorySheet_(book) {
  let sheet=book.getSheetByName(APP.HISTORY_SHEET);
  if(!sheet){sheet=book.insertSheet(APP.HISTORY_SHEET);sheet.getRange(1,1,1,3).setValues([['日期','記錄時間','本期損益']]);sheet.setFrozenRows(1);}
  return sheet;
}
function findNumeric_(row) { for(let i=row.length-1;i>=0;i--){const n=numOrNull_(row[i]);if(n!=null)return n;} return null; }
function numOrNull_(v) { if(typeof v==='number'&&Number.isFinite(v))return v; if(v===''||v==null)return null; const n=Number(String(v).replace(/[,$%\s]/g,''));return Number.isFinite(n)?n:null; }
function serializable_(v) { return v instanceof Date ? Utilities.formatDate(v,'Asia/Taipei','yyyy-MM-dd') : v; }
function formatMarketDate_(value) { const s=String(value||'');return /^\d{8}$/.test(s)?s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6):s; }
function publicError_(err) { return String(err && err.message || err || '未知錯誤').slice(0,240); }
