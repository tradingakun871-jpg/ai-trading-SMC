import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { classify, combine, isTracked, tradeLevels } from './lib/news-engine.js';

const app=express();
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const PORT=process.env.PORT||3000;
const ATR_FALLBACK=Number(process.env.ATR_FALLBACK||80);
let cache={updatedAt:null,price:null,events:[],groups:[],history:[]};

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
  const r=await fetch('https://api.goldprice.dev/v1/spot',{headers:{accept:'application/json'}});
  if(!r.ok) throw new Error('gold '+r.status);
  const j=await r.json(); const x=(j.symbols||[]).find(s=>s.symbol==='XAU'); if(!x) throw new Error('XAU missing');
  return {price:Number(x.price),isStale:!!x.is_stale,computedAt:x.computed_at,source:'goldprice.dev'};
}
async function refresh(){
  try{
    const [ff,price]=await Promise.all([
      fetch('https://r.jina.ai/https://www.forexfactory.com/calendar?day=today',{headers:{Accept:'text/plain'}}).then(r=>r.text()),
      getGold()
    ]);
    const events=parseRows(ff).map(e=>({...e,...classify(e.title,e.actual,e.forecast)}));
    const byTime=new Map(); for(const e of events){if(!byTime.has(e.time))byTime.set(e.time,[]);byTime.get(e.time).push(e)}
    const groups=[...byTime.entries()].map(([time,list])=>{const combined=combine(list);return {time,events:list,...combined,...tradeLevels(combined.signal,price.price,ATR_FALLBACK)}});
    const completed=groups.filter(g=>g.events.some(e=>e.actual&&e.forecast));
    for(const g of completed){
      const key=`${new Date().toISOString().slice(0,10)}|${g.time}|${g.signal}|${g.score}`;
      if(!cache.history.some(h=>h.key===key)) cache.history.unshift({key,createdAt:new Date().toISOString(),time:g.time,score:g.score,signal:g.signal,price:price.price,entry:g.entry,sl:g.sl,tp1:g.tp1,tp2:g.tp2,events:g.events});
    }
    cache={...cache,updatedAt:new Date().toISOString(),price,events,groups,history:cache.history.slice(0,100)};
  }catch(e){console.error('refresh failed',e);}
}

app.use(express.static(path.join(__dirname,'public')));
app.get('/health',(req,res)=>res.json({ok:true,updatedAt:cache.updatedAt}));
app.get('/api/live',async(req,res)=>{if(!cache.updatedAt) await refresh();res.json({ok:true,version:'V2 AUTO RAILWAY',source:'Forex Factory + goldprice.dev',atrPips:ATR_FALLBACK,...cache});});
app.get('/api/history',(req,res)=>res.json({ok:true,events:cache.history}));
app.listen(PORT,()=>{console.log('XAU News Hack Railway on',PORT);refresh();setInterval(refresh,30000);});
