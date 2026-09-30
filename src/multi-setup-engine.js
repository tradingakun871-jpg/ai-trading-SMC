const {analyze}=require('./smc-engine');
const SETUPS={
 SCALPING:{name:'SCALPING',biasTf:'H1',confirmTf:'M15',entryTf:'M5',biasCandidates:['H1']},
 INTRADAY:{name:'INTRADAY',biasTf:'H4',confirmTf:'H1',entryTf:'M15',biasCandidates:['H4']},
 SWING:{name:'SWING',biasTf:'D1',confirmTf:'H4',entryTf:'H1',biasCandidates:['D1']}
};
function runOne(symbol,data,pipSize,cfg){let biasBars=null,biasUsed=null;for(const tf of cfg.biasCandidates){if(data?.[tf]?.candles?.length>=20){biasBars=data[tf].candles;biasUsed=tf;break}}const confirm=data?.[cfg.confirmTf]?.candles,entry=data?.[cfg.entryTf]?.candles;if(!biasBars||!confirm?.length||!entry?.length)return{ok:false,setup:cfg.name,stage:'COLLECTING_HISTORY',biasTf:cfg.biasTf,confirmTf:cfg.confirmTf,entryTf:cfg.entryTf,missing:[...cfg.biasCandidates,cfg.confirmTf,cfg.entryTf].filter(tf=>!data?.[tf]?.candles?.length),signal:null};const r=analyze({symbol,m5:biasBars,m3:confirm,m1:entry,pipSize});return{...r,ok:true,setup:cfg.name,biasTf:biasUsed||cfg.biasTf,confirmTf:cfg.confirmTf,entryTf:cfg.entryTf,engine:`SMC V5 ${cfg.name} GOLDEN STRUCTURE RR1:2 MAXSL500`}}
function analyzeSetups({symbol,data,pipSize}){const out={};for(const [k,cfg] of Object.entries(SETUPS))out[k]=runOne(symbol,data,pipSize,cfg);return out}
module.exports={analyzeSetups,SETUPS};
