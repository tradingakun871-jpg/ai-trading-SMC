import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import { classify, combine, isTracked, tradeLevels } from './lib/news-engine.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ATR_FALLBACK = Number(process.env.ATR_FALLBACK || 80);
const WEEKLY_CACHE_MS = 15 * 60 * 1000;
const LIVE_REFRESH_MS = 15 * 1000;
const SNAPSHOT_KEEP_MS = 90 * 60 * 1000;

let cache = { updatedAt:null, price:null, newsStatus:'INIT', actualSource:'NONE', events:[], groups:[], history:[] };
let weeklyCache = { items:[], fetchedAt:0 };
let refreshBusy = false;
let priceSnapshots = [];
const individualLocks = new Map();

function clean(s=''){ return String(s).replace(/\s+/g,' ').trim(); }
function normTitle(s=''){ return clean(s).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function jakartaDate(d=new Date()){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
}
function jakartaTime(d){
  return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Jakarta',hour:'2-digit',minute:'2-digit',hour12:false}).format(d) + ' WIB';
}
function ffDayParam(d=new Date()){
  const p=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/London',year:'numeric',month:'short',day:'numeric'}).formatToParts(d);
  const g=t=>p.find(x=>x.type===t)?.value||'';
  return `${g('month').toLowerCase()}${Number(g('day'))}.${g('year')}`;
}
async function fetchTimeout(url,opts={},ms=8000){
  const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(),ms);
  try{return await fetch(url,{...opts,signal:ctl.signal});} finally{clearTimeout(t)}
}

function savePriceSnapshot(price){
  const p=Number(price);
  if(!Number.isFinite(p)) return;
  const now=Date.now();
  priceSnapshots.push({ts:now,price:p});
  priceSnapshots=priceSnapshots.filter(x=>now-x.ts<=SNAPSHOT_KEEP_MS);
}
function nearestReleaseSnapshot(eventTime,currentPrice){
  const target=new Date(eventTime||'').getTime();
  if(!Number.isFinite(target)) return Number(currentPrice)||null;
  const candidates=priceSnapshots.filter(x=>Math.abs(x.ts-target)<=10*60*1000);
  if(!candidates.length) return Number(currentPrice)||null;
  candidates.sort((a,b)=>{
    const aAfter=a.ts>=target?0:1, bAfter=b.ts>=target?0:1;
    if(aAfter!==bAfter) return aAfter-bAfter;
    return Math.abs(a.ts-target)-Math.abs(b.ts-target);
  });
  return candidates[0].price;
}
function individualKey(e){
  return `${e.eventTime||e.time||''}|${normTitle(e.title)}|${e.actual||''}|${e.forecast||''}`;
}
function getIndividualLock(e,currentPrice){
  if(!e.actual || !e.forecast || !e.signal || e.signal==='WAIT') return null;
  const key=individualKey(e);
  if(individualLocks.has(key)) return individualLocks.get(key);

  // One-off correction from the user's first observed ISM release level on 2026-10-01.
  if(e.eventTime==='2026-10-01T14:00:00.000Z' && normTitle(e.title)==='ism manufacturing pmi' && String(e.actual)==='54.5' && String(e.forecast)==='54.8'){
    const levels=tradeLevels(e.signal,4154,ATR_FALLBACK);
    const locked={...levels,locked:true,lockSource:'USER_FIRST_OBSERVED',lockedAt:'2026-10-01T14:00:00.000Z'};
    individualLocks.set(key,locked);
    return locked;
  }

  const releasePrice=nearestReleaseSnapshot(e.eventTime,currentPrice);
  if(!Number.isFinite(Number(releasePrice))) return null;
  const levels=tradeLevels(e.signal,Number(releasePrice),ATR_FALLBACK);
  const locked={...levels,locked:true,lockSource:'RELEASE_TIME_SNAPSHOT',lockedAt:new Date().toISOString(),releaseTime:e.eventTime||null};
  individualLocks.set(key,locked);
  return locked;
}

async function getGold(){
  const providers=[
    async()=>{const r=await fetchTimeout('https://api.gold-api.com/price/XAU',{headers:{accept:'application/json'}},5000);if(!r.ok)throw new Error('gold-api '+r.status);const j=await r.json();const p=Number(j.price);if(!Number.isFinite(p))throw new Error('gold-api price missing');return {price:p,isStale:false,computedAt:j.updatedAt||j.updated_at||new Date().toISOString(),source:'gold-api.com'}},
    async()=>{const r=await fetchTimeout('https://xaus.com/api/v1/spot',{headers:{accept:'application/json'}},5000);if(!r.ok)throw new Error('xaus '+r.status);const j=await r.json();const p=Number(j?.xau?.price??j?.spot_usd_oz);if(!Number.isFinite(p))throw new Error('xaus price missing');return {price:p,isStale:j?.data_state?.status==='stale',computedAt:j.updated_at||j?.data_state?.as_of||new Date().toISOString(),source:'xaus.com'}},
    async()=>{const r=await fetchTimeout('https://goldprice.dev/v1/prices?symbol=XAU-USD-SPOT',{headers:{accept:'application/json'}},5000);if(!r.ok)throw new Error('goldprice.dev '+r.status);const j=await r.json();const x=(j.symbols||[]).find(s=>s.symbol==='XAU'||s.symbol==='XAU-USD-SPOT')||j.symbols?.[0];if(!x||!Number.isFinite(Number(x.price)))throw new Error('goldprice.dev price missing');return {price:Number(x.price),isStale:!!x.is_stale,computedAt:x.computed_at,source:'goldprice.dev'}}
  ];
  let last; for(const fn of providers){try{return await fn()}catch(e){last=e}} throw last||new Error('all gold providers failed');
}

function parseForexFactoryHtml(html){
  const $=cheerio.load(html); const events=[]; let lastTime='';
  $('.calendar__row').each((_,row)=>{
    const $r=$(row); const currency=clean($r.find('.calendar__currency').text()); if(currency!=='USD')return;
    const time=clean($r.find('.calendar__time').text())||lastTime; if(time)lastTime=time;
    const title=clean($r.find('.calendar__event-title').text()); if(!title||!isTracked(title))return;
    const actual=clean($r.find('.calendar__actual').text());
    const forecast=clean($r.find('.calendar__forecast').text());
    const previous=clean($r.find('.calendar__previous').text());
    const cls=$r.find('.calendar__cell.calendar__impact > span').attr('class')||'';
    const impact=/impact-red/i.test(cls)?'High':/impact-ora/i.test(cls)?'Medium':/impact-yel/i.test(cls)?'Low':'Unknown';
    events.push({time,currency:'USD',impact,title,actual,forecast,previous});
  });
  return events;
}

async function getWeeklyItems(force=false){
  const now=Date.now();
  if(!force && weeklyCache.items.length && now-weeklyCache.fetchedAt<WEEKLY_CACHE_MS)return weeklyCache.items;
  try{
    const r=await fetchTimeout('https://nfs.faireconomy.media/ff_calendar_thisweek.json',{headers:{accept:'application/json','user-agent':'XAU-News-Hack/2.7'}},6000);
    if(!r.ok)throw new Error('FF weekly '+r.status);
    const items=await r.json(); if(!Array.isArray(items))throw new Error('FF weekly invalid');
    weeklyCache={items,fetchedAt:now}; return items;
  }catch(e){if(weeklyCache.items.length){console.error('FF weekly failed; using cache',e.message);return weeklyCache.items}throw e}
}

async function convertEventsToWib(events){
  try{
    const items=await getWeeklyItems(); const today=jakartaDate(); const map=new Map();
    for(const e of items){if(e.country!=='USD')continue;const dt=new Date(e.date);if(!Number.isFinite(dt.getTime())||jakartaDate(dt)!==today)continue;const title=clean(e.title||'');if(title)map.set(normTitle(title),{time:jakartaTime(dt),eventTime:dt.toISOString()})}
    return events.map(e=>{const m=map.get(normTitle(e.title));return m?{...e,time:m.time,eventTime:m.eventTime,timeZone:'Asia/Jakarta'}:{...e,time:'— WIB',eventTime:null,timeZone:'Asia/Jakarta',timeUnmapped:true}});
  }catch(e){console.error('WIB conversion failed',e.message);return events.map(x=>({...x,time:'— WIB',eventTime:null,timeZone:'Asia/Jakarta',timeUnmapped:true}))}
}

async function getForexFactoryJina(){
  const target=`https://forexfactory.com/calendar?day=${ffDayParam()}`;
  const r=await fetchTimeout(`https://r.jina.ai/${target}`,{headers:{'X-Return-Format':'html','Accept':'text/html'}},12000);
  if(!r.ok)throw new Error('FF Jina '+r.status);
  let events=parseForexFactoryHtml(await r.text()); if(!events.length)throw new Error('FF Jina no tracked rows');
  events=await convertEventsToWib(events);
  return {events,status:'LIVE_FOREX_FACTORY',source:'FOREX_FACTORY_JINA_NON_WWW'};
}
async function getForexFactoryDirect(){
  for(const url of [`https://forexfactory.com/calendar?day=${ffDayParam()}`,'https://forexfactory.com/calendar']){
    try{
      const r=await fetchTimeout(url,{headers:{accept:'text/html,application/xhtml+xml','accept-language':'en-US,en;q=0.9','user-agent':'Mozilla/5.0'}},7000);
      if(!r.ok)throw new Error('FF direct '+r.status);
      let events=parseForexFactoryHtml(await r.text()); if(!events.length)throw new Error('FF direct no rows');
      events=await convertEventsToWib(events); return {events,status:'LIVE_FOREX_FACTORY',source:'FOREX_FACTORY_DIRECT'};
    }catch(e){console.error('FF direct attempt failed',e.message)}
  }
  throw new Error('FF direct unavailable');
}
async function getForexFactoryWeekly(){
  const items=await getWeeklyItems(); const today=jakartaDate(); const events=[];
  for(const e of items){if(e.country!=='USD')continue;const dt=new Date(e.date);if(!Number.isFinite(dt.getTime())||jakartaDate(dt)!==today)continue;const title=clean(e.title||'');if(!title||!isTracked(title))continue;events.push({time:jakartaTime(dt),eventTime:dt.toISOString(),timeZone:'Asia/Jakarta',currency:'USD',impact:e.impact||'Unknown',title,actual:clean(e.actual||''),forecast:clean(e.forecast||''),previous:clean(e.previous||'')})}
  return {events,status:'FOREX_FACTORY_SCHEDULE_ONLY',source:'FOREX_FACTORY_WEEKLY'};
}
async function getForexFactory(){
  try{return await getForexFactoryJina()}catch(e1){console.error('Forex Factory Jina failed',e1.message);try{return await getForexFactoryDirect()}catch(e2){console.error('Forex Factory direct failed',e2.message);return await getForexFactoryWeekly()}}
}

function buildGroups(events,price){
  const byTime=new Map(); for(const e of events){if(!byTime.has(e.time))byTime.set(e.time,[]);byTime.get(e.time).push(e)}
  return [...byTime.entries()].map(([time,list])=>{const combined=combine(list);return {time,timeZone:'Asia/Jakarta',events:list,...combined,...tradeLevels(combined.signal,price,ATR_FALLBACK)}});
}

async function refresh(){
  if(refreshBusy)return; refreshBusy=true;
  try{
    let price=cache.price;
    try{price=await getGold();savePriceSnapshot(price?.price)}catch(e){console.error('price refresh failed',e.message)}
    const ff=await getForexFactory();
    const events=ff.events.map(e=>{
      const classified={...e,...classify(e.title,e.actual,e.forecast)};
      return {...classified,individualTrade:getIndividualLock(classified,price?.price)};
    });
    const groups=buildGroups(events,price?.price);
    const actualSource=events.some(e=>e.actual)?ff.source:'NONE';
    for(const g of groups.filter(g=>g.events.some(e=>e.actual&&e.forecast))){
      const key=`${jakartaDate()}|${g.time}|${g.signal}|${g.score}`;
      if(!cache.history.some(h=>h.key===key))cache.history.unshift({key,createdAt:new Date().toISOString(),time:g.time,timeZone:'Asia/Jakarta',score:g.score,signal:g.signal,price:price?.price??null,entry:g.entry,sl:g.sl,tp1:g.tp1,tp2:g.tp2,actualSource,events:g.events});
    }
    cache={...cache,updatedAt:new Date().toISOString(),price,newsStatus:ff.status,actualSource,events,groups,history:cache.history.slice(0,100)};
  }catch(e){console.error('news refresh failed',e.message);cache={...cache,updatedAt:new Date().toISOString(),newsStatus:'DEGRADED',actualSource:'NONE'}}finally{refreshBusy=false}
}

app.use(express.static(path.join(__dirname,'public')));
app.get('/health',(req,res)=>res.status(cache.price?200:503).json({ok:!!cache.price,updatedAt:cache.updatedAt,newsStatus:cache.newsStatus,actualSource:cache.actualSource,price:cache.price?.price||null,priceSource:cache.price?.source||null,timeZone:'Asia/Jakarta'}));
app.get('/api/live',async(req,res)=>{if(!cache.updatedAt)await refresh();res.json({ok:true,version:'V2.7 RELEASE-TIME LOCK',source:'Forex Factory live + release-time XAU snapshot',refreshSeconds:15,timeZone:'Asia/Jakarta',atrPips:ATR_FALLBACK,...cache})});
app.get('/api/history',(req,res)=>res.json({ok:true,timeZone:'Asia/Jakarta',events:cache.history}));
app.post('/api/refresh',async(req,res)=>{await refresh();res.json({ok:true,updatedAt:cache.updatedAt,newsStatus:cache.newsStatus,actualSource:cache.actualSource,timeZone:'Asia/Jakarta'})});

app.listen(PORT,()=>{
  console.log('XAU News Hack Railway on',PORT);
  getWeeklyItems(true).catch(e=>console.error('Initial weekly preload failed',e.message));
  refresh();
  setInterval(refresh,LIVE_REFRESH_MS);
});
