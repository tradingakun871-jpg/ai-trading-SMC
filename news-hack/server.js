import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import { classify, combine, isTracked, tradeLevels } from './lib/news-engine.js';

const app=express();
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const PORT=process.env.PORT||3000;
const ATR_FALLBACK=Number(process.env.ATR_FALLBACK||80);
let cache={updatedAt:null,price:null,newsStatus:'INIT',actualSource:'NONE',events:[],groups:[],history:[]};

function clean(s=''){return String(s).replace(/\s+/g,' ').trim();}
function jakartaDate(d=new Date()){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
}
function jakartaTime(d){
  return new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Jakarta',hour:'numeric',minute:'2-digit',hour12:true}).format(d).replace(' ','').toLowerCase();
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

function parseForexFactoryHtml(html){
  const $=cheerio.load(html);
  const events=[];
  let lastTime='';
  $('.calendar__row').each((_,row)=>{
    const $r=$(row);
    const currency=clean($r.find('.calendar__currency').text());
    if(currency!=='USD') return;
    const time=clean($r.find('.calendar__time').text())||lastTime;
    if(time) lastTime=time;
    const title=clean($r.find('.calendar__event-title').text());
    if(!title||!isTracked(title)) return;
    const actual=clean($r.find('.calendar__actual').text());
    const forecast=clean($r.find('.calendar__forecast').text());
    const previous=clean($r.find('.calendar__previous').text());
    const cls=$r.find('.calendar__cell.calendar__impact > span').attr('class')||'';
    const impact=/impact-red/i.test(cls)?'High':/impact-ora/i.test(cls)?'Medium':/impact-yel/i.test(cls)?'Low':'Unknown';
    events.push({time,currency:'USD',impact,title,actual,forecast,previous});
  });
  return events;
}

async function getForexFactoryDirect(){
  const urls=['https://www.forexfactory.com/calendar?day=today','https://www.forexfactory.com/calendar'];
  let lastErr;
  for(const url of urls){
    try{
      const r=await fetch(url,{headers:{
        'accept':'text/html,application/xhtml+xml',
        'accept-language':'en-US,en;q=0.9',
        'cache-control':'no-cache',
        'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36'
      }});
      if(!r.ok) throw new Error('FF direct '+r.status);
      const html=await r.text();
      const events=parseForexFactoryHtml(html);
      if(events.length) return {events,status:'LIVE_FOREX_FACTORY',source:'FOREX_FACTORY_DIRECT'};
      throw new Error('FF direct no tracked rows');
    }catch(e){lastErr=e}
  }
  throw lastErr||new Error('FF direct unavailable');
}

async function getForexFactoryWeekly(){
  const r=await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json',{headers:{accept:'application/json'}});
  if(!r.ok) throw new Error('FF weekly '+r.status);
  const items=await r.json();
  const today=jakartaDate();
  const events=[];
  for(const e of items){
    if(e.country!=='USD') continue;
    const dt=new Date(e.date);
    if(!Number.isFinite(dt.getTime())||jakartaDate(dt)!==today) continue;
    const title=clean(e.title||'');
    if(!title||!isTracked(title)) continue;
    events.push({
      time:jakartaTime(dt),currency:'USD',impact:e.impact||'Unknown',title,
      actual:clean(e.actual||''),forecast:clean(e.forecast||''),previous:clean(e.previous||'')
    });
  }
  return {events,status:'FOREX_FACTORY_SCHEDULE_ONLY',source:'FOREX_FACTORY_WEEKLY'};
}

async function getForexFactory(){
  try{return await getForexFactoryDirect()}
  catch(e){console.error('Forex Factory direct failed',e.message);return await getForexFactoryWeekly()}
}

function buildGroups(events,price){
  const byTime=new Map();
  for(const e of events){if(!byTime.has(e.time))byTime.set(e.time,[]);byTime.get(e.time).push(e)}
  return [...byTime.entries()].map(([time,list])=>{
    const combined=combine(list);
    return {time,events:list,...combined,...tradeLevels(combined.signal,price,ATR_FALLBACK)};
  });
}

async function refresh(){
  let price=cache.price;
  try{price=await getGold()}catch(e){console.error('price refresh failed',e.message)}

  try{
    const ff=await getForexFactory();
    const events=ff.events.map(e=>({...e,...classify(e.title,e.actual,e.forecast)}));
    const groups=buildGroups(events,price?.price);
    const actualSource=events.some(e=>e.actual)?ff.source:'NONE';
    const completed=groups.filter(g=>g.events.some(e=>e.actual&&e.forecast));
    for(const g of completed){
      const key=`${jakartaDate()}|${g.time}|${g.signal}|${g.score}`;
      if(!cache.history.some(h=>h.key===key)){
        cache.history.unshift({key,createdAt:new Date().toISOString(),time:g.time,score:g.score,signal:g.signal,price:price?.price??null,entry:g.entry,sl:g.sl,tp1:g.tp1,tp2:g.tp2,actualSource,events:g.events});
      }
    }
    cache={...cache,updatedAt:new Date().toISOString(),price,newsStatus:ff.status,actualSource,events,groups,history:cache.history.slice(0,100)};
  }catch(e){
    console.error('news refresh failed',e.message);
    cache={...cache,updatedAt:new Date().toISOString(),price,newsStatus:'DEGRADED',actualSource:'NONE'};
  }
}

app.use(express.static(path.join(__dirname,'public')));
app.get('/health',(req,res)=>res.status(cache.price?200:503).json({ok:!!cache.price,updatedAt:cache.updatedAt,newsStatus:cache.newsStatus,actualSource:cache.actualSource,price:cache.price?.price||null,priceSource:cache.price?.source||null}));
app.get('/api/live',async(req,res)=>{if(!cache.updatedAt) await refresh();res.json({ok:true,version:'V2.2 FOREX FACTORY ONLY',source:'Forex Factory only for economic data',atrPips:ATR_FALLBACK,...cache});});
app.get('/api/history',(req,res)=>res.json({ok:true,events:cache.history}));
app.listen(PORT,()=>{console.log('XAU News Hack Railway on',PORT);refresh();setInterval(refresh,15000);});
