import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { classify, combine, isTracked, tradeLevels } from './lib/news-engine.js';

const app=express();
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const PORT=process.env.PORT||3000;
const ATR_FALLBACK=Number(process.env.ATR_FALLBACK||80);
let cache={updatedAt:null,price:null,newsStatus:'INIT',events:[],groups:[],history:[]};

function clean(s=''){return String(s).replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[[^\]]*\]\([^)]*\)/g,'').replace(/\s+/g,' ').trim();}
function parseRows(md){
  const out=[];let tm='';
  for(const line of md.split('\n')){
    if(!line.startsWith('|')||!line.endsWith('|')||line.includes('| ---')) continue;
    const c=line.slice(1,-1).split('|').map(x=>x.trim()); if(c.length<9) continue;
    const first=clean(c[0]); if(first&&/^(\d{1,2}:\d{2}(am|pm)|All Day|Tentative)$/i.test(first)) tm=first;
    if(clean(c[1])!=='USD') continue;
    const impact=/red/i.test(c[2]||'')?'High':(/yel|orange/i.test(c[2]||'')?'Medium':'Low');
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
async function getForexFactory(){
  const urls=[
    'https://r.jina.ai/https://www.forexfactory.com/calendar?day=today',
    'https://r.jina.ai/https://www.forexfactory.com/calendar?embed=true'
  ];
  let lastErr;
  for(const url of urls){
    try{
      const r=await fetch(url,{headers:{Accept:'text/plain'}});
      if(!r.ok) throw new Error('FF reader '+r.status);
      const text=await r.text();
      if(text.length<1000) throw new Error('FF reader short response');
      return text;
    }catch(e){lastErr=e}
  }
  throw lastErr||new Error('FF unavailable');
}
function buildGroups(events,price){
  const byTime=new Map();
  for(const e of events){if(!byTime.has(e.time))byTime.set(e.time,[]);byTime.get(e.time).push(e)}
  return [...byTime.entries()].map(([time,list])=>{const combined=combine(list);return {time,events:list,...combined,...tradeLevels(combined.signal,price,ATR_FALLBACK)}});
}
async function refresh(){
  let price=cache.price;
  try{price=await getGold()}catch(e){console.error('price refresh failed',e)}

  let newsStatus='OK';
  let events=cache.events;
  let groups=cache.groups;
  try{
    const ff=await getForexFactory();
    events=parseRows(ff).map(e=>({...e,...classify(e.title,e.actual,e.forecast)}));
    groups=buildGroups(events,price?.price);
    const completed=groups.filter(g=>g.events.some(e=>e.actual&&e.forecast));
    for(const g of completed){
      const key=`${new Date().toISOString().slice(0,10)}|${g.time}|${g.signal}|${g.score}`;
      if(!cache.history.some(h=>h.key===key)) cache.history.unshift({key,createdAt:new Date().toISOString(),time:g.time,score:g.score,signal:g.signal,price:price?.price??null,entry:g.entry,sl:g.sl,tp1:g.tp1,tp2:g.tp2,events:g.events});
    }
  }catch(e){newsStatus='DEGRADED';console.error('news refresh failed',e)}

  cache={...cache,updatedAt:new Date().toISOString(),price,newsStatus,events,groups,history:cache.history.slice(0,100)};
}

app.use(express.static(path.join(__dirname,'public')));
app.get('/health',(req,res)=>res.status(cache.price?200:503).json({ok:!!cache.price,updatedAt:cache.updatedAt,newsStatus:cache.newsStatus,price:cache.price?.price||null,source:cache.price?.source||null}));
app.get('/api/live',async(req,res)=>{if(!cache.updatedAt) await refresh();res.json({ok:true,version:'V2 AUTO RAILWAY',source:'Forex Factory + multi-provider XAU spot',atrPips:ATR_FALLBACK,...cache});});
app.get('/api/history',(req,res)=>res.json({ok:true,events:cache.history}));
app.listen(PORT,()=>{console.log('XAU News Hack Railway on',PORT);refresh();setInterval(refresh,30000);});
