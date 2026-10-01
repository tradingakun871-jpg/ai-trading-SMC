export function num(v){
  if(v==null) return null;
  const s=String(v).replace(/\[[^\]]*\]\([^)]*\)/g,'').replace(/[*_%,$]/g,'').trim();
  if(!s || s==='—' || s==='-') return null;
  const m=s.match(/-?[0-9]+(?:\.[0-9]+)?/); if(!m) return null;
  let n=parseFloat(m[0]);
  if(/K\b/i.test(s)) n*=1e3; else if(/M\b/i.test(s)) n*=1e6; else if(/B\b/i.test(s)) n*=1e9;
  return n;
}
export function category(title=''){
  const t=title.toLowerCase();
  if(/core cpi/.test(t)) return 'CORE CPI';
  if(/\bcpi\b/.test(t)) return 'CPI';
  if(/non-farm|nonfarm/.test(t)) return 'NFP';
  if(/unemployment rate/.test(t)) return 'UNEMPLOYMENT';
  if(/average hourly earnings/.test(t)) return 'AHE';
  if(/core ppi/.test(t)) return 'CORE PPI';
  if(/\bppi\b/.test(t)) return 'PPI';
  if(/\bpce\b/.test(t)) return 'PCE';
  if(/\bgdp\b/.test(t) && !/price index/.test(t)) return 'GDP';
  if(/retail sales/.test(t)) return 'RETAIL SALES';
  if(/ism manufacturing pmi/.test(t)) return 'ISM MANUFACTURING PMI';
  if(/ism services pmi/.test(t)) return 'ISM SERVICES PMI';
  if(/fomc|federal funds rate|interest rate decision/.test(t)) return 'FOMC';
  return null;
}
const W={"CORE CPI":1.6,"CPI":1.5,"NFP":1.6,"UNEMPLOYMENT":1.4,"AHE":1.25,"CORE PPI":1.2,"PPI":1.1,"PCE":1.35,"GDP":1.0,"RETAIL SALES":1.1,"ISM MANUFACTURING PMI":1.25,"ISM SERVICES PMI":1.25,"FOMC":1.7};
const TH={"CORE CPI":0.1,"CPI":0.1,"NFP":50000,"UNEMPLOYMENT":0.1,"AHE":0.1,"CORE PPI":0.1,"PPI":0.1,"PCE":0.1,"GDP":0.2,"RETAIL SALES":0.2,"ISM MANUFACTURING PMI":1.0,"ISM SERVICES PMI":1.0,"FOMC":0.25};
export function isTracked(title){return !!category(title)}
export function classify(title,actual,forecast){
  const cat=category(title), a=num(actual), f=num(forecast);
  if(!cat||a==null||f==null) return {category:cat,usdBias:'WAIT',xauBias:'WAIT',strength:'WAIT',signal:'WAIT',surprise:null,eventScore:null,weight:W[cat]||0};
  const diff=a-f; let signed=diff;
  if(cat==='UNEMPLOYMENT') signed=-diff;
  const threshold=TH[cat]||0.1;
  const abs=Math.abs(signed);
  const eventScore=Math.max(-100,Math.min(100,(signed/threshold)*50));
  const usdBias=signed>0?'BULLISH':signed<0?'BEARISH':'NEUTRAL';
  const xauBias=signed>0?'SELL':signed<0?'BUY':'WAIT';
  const strength=abs>=threshold*2?'STRONG':abs>=threshold?'MEDIUM':'WEAK';
  const signal=xauBias==='WAIT'?'WAIT':(strength==='STRONG'?'STRONG ':'')+xauBias;
  return {category:cat,usdBias,xauBias,strength,signal,surprise:diff,eventScore,weight:W[cat]||1};
}
export function combine(events){
  const valid=events.filter(e=>Number.isFinite(e.eventScore)&&e.weight>0);
  if(!valid.length) return {score:50,usdBias:'WAIT',xauBias:'WAIT',signal:'WAIT',confidence:'WAIT',components:0};
  const sum=valid.reduce((a,e)=>a+e.eventScore*e.weight,0);
  const w=valid.reduce((a,e)=>a+e.weight,0);
  const raw=sum/w;
  const score=Math.max(0,Math.min(100,50+raw/2));
  let signal='WAIT',usdBias='NEUTRAL',xauBias='WAIT',confidence='LOW';
  if(score>=72){signal='STRONG SELL';usdBias='BULLISH';xauBias='SELL';confidence='HIGH'}
  else if(score>=58){signal='SELL';usdBias='BULLISH';xauBias='SELL';confidence='MEDIUM'}
  else if(score<=28){signal='STRONG BUY';usdBias='BEARISH';xauBias='BUY';confidence='HIGH'}
  else if(score<=42){signal='BUY';usdBias='BEARISH';xauBias='BUY';confidence='MEDIUM'}
  return {score:Number(score.toFixed(1)),usdBias,xauBias,signal,confidence,components:valid.length};
}
export function tradeLevels(signal,price,atr,{pip=0.10,slPips=100,rr1=1,rr2=2,lot=0.01}={}){
  const p=Number(price);
  if(!Number.isFinite(p)||!signal||signal==='WAIT') return {entry:null,slPips:null,sl:null,tp1:null,tp2:null,lot,riskUsd:null,tp1Usd:null,tp2Usd:null};
  const side=signal.includes('BUY')?'BUY':'SELL';
  const d=slPips*pip;
  const usdPerPipAtLot=0.10*(lot/0.01);
  const riskUsd=slPips*usdPerPipAtLot;
  const tp1Usd=riskUsd*rr1;
  const tp2Usd=riskUsd*rr2;
  const common={entry:p,slPips,lot,riskUsd:+riskUsd.toFixed(2),tp1Usd:+tp1Usd.toFixed(2),tp2Usd:+tp2Usd.toFixed(2)};
  return side==='BUY'
    ? {...common,sl:+(p-d).toFixed(3),tp1:+(p+d*rr1).toFixed(3),tp2:+(p+d*rr2).toFixed(3)}
    : {...common,sl:+(p+d).toFixed(3),tp1:+(p-d*rr1).toFixed(3),tp2:+(p-d*rr2).toFixed(3)};
}
