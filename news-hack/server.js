import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { classify, combine, isTracked, tradeLevels, category } from './lib/news-engine.js';

const app=express();
app.use(express.json({limit:'256kb'}));
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const PORT=process.env.PORT||3000;
const ATR_FALLBACK=Number(process.env.ATR_FALLBACK||80);
const TE_API_KEY=process.env.TE_API_KEY||'';
const NEWS_PUSH_TOKEN=process.env.NEWS_PUSH_TOKEN||'';
let pushedActuals=[];
let macroCache={at:0,events:[]};
let cache={updatedAt:null,price:null,newsStatus:'INIT',actualSource:'NONE',events:[],groups:[],history:[]};

function clean(s=''){return String(s).replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[[^\]]*\]\([^)]*\)/g,'').replace(/\s+/g,' ').trim();}
function parseRows(md){
  const out=[];let tm='';
  for(const line of md.split('\n')){
    if(!line.startsWith('|')||!line.endsWith('|')||line.includes('| ---')) continue;
    const c=line.slice(1,-1).split('|').map(x=>x.trim()); if(c.length<9) continue;
    const first=clean(c[0]); if(first&&/^(\d{1,2}:\d{2}(am|pm)|All Day|Tentative)$/i.test(first)) tm=first;
    if(clean(c[1])!=='USD') continue;
    const impact=/red/i.test(c[2]||'')?'High':(/yel|orange|medium/i.test(c[2]||'')?'Medium':'Low');
    const title=clean(c[3]); if(!title||!isTracked(title)) continue;
    out.push({time:tm,currency:'USD',impact,title,actual:clean(c[6]||''),forecast:clean(c[7]||''),previous:clean(c[8]||'')});
  }
  return out;
}
async function getGold(){
  const providers=[
    async()=>{const r=await fetch('https://api.gold-api.com/price/XAU',{headers:{accept:'application/json'}});if(!r.ok)throw new Error('gold-api '+r.status);const j=await r.json();if(!Number.isFinite(Number(j.price)))throw new Error('gold-api price missing');return {price:Number(j.price),isStale:false,computedAt:j.updatedAt||j.updated_at||new Date().toISOString(),source:'gold-api.com'}},
    async()=>{const r=await fetch('https://xaus.com/api/v1/spot',{headers:{accept:'application/json'}});if(!r.ok)throw new Error('xaus '+r.status);const j=await r.json();const p=Number(j?.xau?.price??j?.spot_usd_oz);if(!Number.isFinite(p))throw new Error('xaus price missing');return {price:p,isStale:j?.data_state?.status==='stale',computedAt:j.updated_at||j?.data_state?.as_of||new Date().toISOString(),source:'xaus.com'}},
    async()=>{const r=await fetch('https://goldprice.dev/v1/prices?symbol=XAU-USD-SPOT',{headers:{accept:'application/json'}});if(!r.ok)throw new Error('goldprice.dev '+r.status);const j=await r.json();const x=(j.symbols||[]).find(s=>s.symbol==='XAU'||s.symbol==='XAU-USD-SPOT')||j.symbols?.[0];if(!x||!Number.isFinite(Number(x.price)))throw new Error('goldprice.dev price missing');return {price:Number(x.price),isStale:!!x.is_stale,computedAt:x.computed_at,source:'goldprice.dev'}}
  ];
  let lastErr; for(const fn of providers){try{return await fn()}catch(e){lastErr=e}}
  throw lastErr||new Error('all gold providers failed');
}
function jakartaDate(d=new Date()){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
}
function jakartaTime(d){
  return new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Jakarta',hour:'numeric',minute:'2-digit',hour12:true}).format(d).replace(' ','').toLowerCase();
}
async function getForexFactory(){
  const readers=[
    'https://r.jina.ai/https://www.forexfactory.com/calendar?day=today',
    'https://r.jina.ai/https://www.forexfactory.com/calendar?embed=true'
  ];
  for(const url of readers){
    try{
      const r=await fetch(url,{headers:{Accept:'text/plain'}});
      if(!r.ok) continue;
      const text=await r.text();
      if(text.length>1000) return {text,status:'LIVE_ACTUAL'};
    }catch{}
  }

  const r=await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json',{headers:{Accept:'application/json'}});
  if(!r.ok) throw new Error('FF weekly '+r.status);
  const items=await r.json();
  const today=jakartaDate();
  const rows=[];
  for(const e of items){
    if(e.country!=='USD') continue;
    const dt=new Date(e.date);
    if(!Number.isFinite(dt.getTime())||jakartaDate(dt)!==today) continue;
    const impact=e.impact==='High'?'red':e.impact==='Medium'?'orange':'low';
    rows.push(`| ${jakartaTime(dt)} | USD | ${impact} | ${String(e.title||'').replaceAll('|','/')} | | | ${e.actual||''} | ${e.forecast||''} | ${e.previous||''} |`);
  }
  return {text:rows.join('\n'),status:'SCHEDULE_ONLY'};
}
function normalizeProviderEvent(x,source){
  const title=clean(x.Event||x.event||x.name||x.title||x.indicator_name||x.indicator||'');
  const actual=clean(x.Actual??x.actual??x.value??x.released_value??'');
  const forecast=clean(x.Forecast??x.forecast??x.consensus??'');
  const previous=clean(x.Previous??x.previous??x.prior??x.previous_value??'');
  const when=x.Date||x.date||x.announcement_datetime_utc||x.announcement_datetime||x.released_at||x.timestamp||null;
  const dt=when?new Date(when):null;
  return {title,actual,forecast,previous,category:category(title),when:dt&&Number.isFinite(dt.getTime())?dt:null,source};
}
async function getTradingEconomicsActuals(){
  if(!TE_API_KEY) return [];
  const today=jakartaDate();
  const url=`https://api.tradingeconomics.com/calendar/country/united%20states/${today}/${today}?c=${encodeURIComponent(TE_API_KEY)}&f=json`;
  const r=await fetch(url,{headers:{accept:'application/json'}});
  if(!r.ok) throw new Error('TE '+r.status);
  const j=await r.json();
  return (Array.isArray(j)?j:[]).map(x=>normalizeProviderEvent(x,'TRADING_ECONOMICS')).filter(x=>x.category&&x.actual);
}
async function getFxMacroActuals(){
  const now=Date.now();
  if(now-macroCache.at<5*60*1000) return macroCache.events;
  const r=await fetch('https://api.fxmacrodata.com/v1/announcements/usd/latest',{headers:{accept:'application/json'}});
  if(!r.ok) throw new Error('FXMacro '+r.status);
  const j=await r.json();
  const raw=Array.isArray(j)?j:(Array.isArray(j.data)?j.data:Object.values(j.data||{}));
  const events=raw.map(x=>normalizeProviderEvent(x,'FXMACRODATA')).filter(x=>x.category&&x.actual);
  macroCache={at:now,events};
  return events;
}
function mergeActuals(events,providerEvents){
  const today=jakartaDate();
  return events.map(e=>{
    if(e.actual) return e;
    const cat=category(e.title);
    if(!cat) return e;
    const candidates=providerEvents.filter(p=>p.category===cat&&(!p.when||jakartaDate(p.when)===today));
    const p=candidates.sort((a,b)=>(b.when?.getTime()||0)-(a.when?.getTime()||0))[0];
    if(!p||!p.actual) return e;
    return {...e,actual:p.actual,forecast:e.forecast||p.forecast,previous:e.previous||p.previous,actualProvider:p.source};
  });
}
function applyPushedActuals(events){
  const today=jakartaDate();
  pushedActuals=pushedActuals.filter(x=>x.date===today);
  return events.map(e=>{
    if(e.actual) return e;
    const cat=category(e.title);
    const p=pushedActuals.filter(x=>x.category===cat).sort((a,b)=>b.ts-a.ts)[0];
    return p?{...e,actual:p.actual,forecast:e.forecast||p.forecast,previous:e.previous||p.previous,actualProvider:'PUSH_BRIDGE'}:e;
  });
}
function buildGroups(events,price){
  const byTime=new Map();
  for(const e of events){if(!byTime.has(e.time))byTime.set(e.time,[]);byTime.get(e.time).push(e)}
  return [...byTime.entries()].map(([time,list])=>{const combined=combine(list);return {time,events:list,...combined,...tradeLevels(combined.signal,price,ATR_FALLBACK)}});
}
async function refresh(){
  let price=cache.price;
  try{price=await getGold()}catch(e){console.error('price refresh failed',e)}

  let newsStatus=cache.newsStatus;
  let actualSource='NONE';
  let events=cache.events;
  let groups=cache.groups;
  try{
    const ff=await getForexFactory();
    newsStatus=ff.status;
    events=parseRows(ff.text);
    events=applyPushedActuals(events);
    if(events.some(e=>e.actualProvider==='PUSH_BRIDGE')) actualSource='PUSH_BRIDGE';

    if(events.some(e=>!e.actual)){
      try{
        const te=await getTradingEconomicsActuals();
        if(te.length){events=mergeActuals(events,te);if(events.some(e=>e.actualProvider==='TRADING_ECONOMICS')) actualSource='TRADING_ECONOMICS'}
      }catch(e){console.error('TE actual refresh failed',e.message)}
    }
    if(events.some(e=>!e.actual)){
      try{
        const fxm=await getFxMacroActuals();
        if(fxm.length){events=mergeActuals(events,fxm);if(actualSource==='NONE'&&events.some(e=>e.actualProvider==='FXMACRODATA')) actualSource='FXMACRODATA_DELAYED'}
      }catch(e){console.error('FXMacro actual refresh failed',e.message)}
    }
    if(actualSource==='NONE'&&events.some(e=>e.actual)) actualSource=ff.status==='LIVE_ACTUAL'?'FOREX_FACTORY':'SCHEDULE_FEED';

    events=events.map(e=>({...e,...classify(e.title,e.actual,e.forecast)}));
    groups=buildGroups(events,price?.price);
    const completed=groups.filter(g=>g.events.some(e=>e.actual&&e.forecast));
    for(const g of completed){
      const key=`${new Date().toISOString().slice(0,10)}|${g.time}|${g.signal}|${g.score}`;
      if(!cache.history.some(h=>h.key===key)) cache.history.unshift({key,createdAt:new Date().toISOString(),time:g.time,score:g.score,signal:g.signal,price:price?.price??null,entry:g.entry,sl:g.sl,tp1:g.tp1,tp2:g.tp2,actualSource,events:g.events});
    }
  }catch(e){newsStatus='DEGRADED';console.error('news refresh failed',e)}

  cache={...cache,updatedAt:new Date().toISOString(),price,newsStatus,actualSource,events,groups,history:cache.history.slice(0,100)};
}

app.use(express.static(path.join(__dirname,'public')));
app.post('/api/news/actual',(req,res)=>{
  if(!NEWS_PUSH_TOKEN) return res.status(503).json({ok:false,error:'push bridge disabled'});
  const auth=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const a=Buffer.from(auth),b=Buffer.from(NEWS_PUSH_TOKEN);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) return res.status(401).json({ok:false,error:'unauthorized'});
  const {title,actual,forecast='',previous=''}=req.body||{};
  const cat=category(title||'');
  if(!cat||!clean(actual)) return res.status(400).json({ok:false,error:'tracked title and actual required'});
  pushedActuals.unshift({date:jakartaDate(),ts:Date.now(),title:clean(title),category:cat,actual:clean(actual),forecast:clean(forecast),previous:clean(previous)});
  pushedActuals=pushedActuals.slice(0,50);
  refresh();
  res.json({ok:true,category:cat,acceptedAt:new Date().toISOString()});
});
app.get('/health',(req,res)=>res.status(cache.price?200:503).json({ok:!!cache.price,updatedAt:cache.updatedAt,newsStatus:cache.newsStatus,actualSource:cache.actualSource,price:cache.price?.price||null,source:cache.price?.source||null,realTimeActualConfigured:!!TE_API_KEY,pushBridgeConfigured:!!NEWS_PUSH_TOKEN}));
app.get('/api/live',async(req,res)=>{if(!cache.updatedAt) await refresh();res.json({ok:true,version:'V2.1 AUTO RAILWAY',source:'Forex Factory/Fair Economy + Actual provider chain + multi-provider XAU spot',atrPips:ATR_FALLBACK,realTimeActualConfigured:!!TE_API_KEY,pushBridgeConfigured:!!NEWS_PUSH_TOKEN,...cache});});
app.get('/api/history',(req,res)=>res.json({ok:true,events:cache.history}));
app.listen(PORT,()=>{console.log('XAU News Hack Railway on',PORT);refresh();setInterval(refresh,30000);});
