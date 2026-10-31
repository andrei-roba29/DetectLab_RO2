/* Editable Romanian repertory inference rules. Dates are approximate and require expert review. */
(function(root){'use strict';
var config={includeEmptyCoord:false, excludedNamePatterns:['necropol','biserica','manastire','ruinele bisericii','schit','cripta'],
 periods:[
 {label:'Neolitic',start:-6000,end:-4500,type:'settlement',keywords:['neolitic'],source:'Romanian National History Museum, Romanian prehistory chronology (approximate; review)'},
 {label:'Eneolitic',start:-4500,end:-3500,type:'settlement',keywords:['eneolitic','cotofeni','cucuteni'],source:'Romanian National History Museum, Romanian prehistory chronology (approximate; review)'},
 {label:'Epoca bronzului',start:-3500,end:-1200,type:'settlement',keywords:['epoca bronzului','bronz'],source:'Romanian National History Museum, Romanian Bronze Age chronology (approximate; review)'},
 {label:'Hallstatt',start:-1200,end:-450,type:'settlement',keywords:['hallstatt'],source:'Romanian National History Museum, Iron Age chronology (approximate; review)'},
 {label:'Epoca fierului / Latène',start:-450,end:-106,type:'settlement',keywords:['latene','epoca fierului'],source:'Romanian National History Museum, Iron Age chronology (approximate; review)'},
 {label:'Dacic',start:-300,end:106,type:'settlement',keywords:['dacic','geto-dac'],source:'Romanian National History Museum, Dacian chronology (approximate; review)'},
 {label:'Roman',start:106,end:275,type:'settlement',keywords:['epoca romana','roman','castru'],source:'Romanian National History Museum, Roman Dacia chronology (approximate; review)'},
 {label:'Medieval',start:600,end:1500,type:'settlement',keywords:['medieval'],source:'Romanian National History Museum, medieval chronology (approximate; review)'}]};
function norm(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();}
function classify(name){var n=norm(name), sep=n.indexOf(' de la '), descriptive=sep<0?n:n.slice(0,sep), confidence=sep<0?'low':'medium'; if(config.excludedNamePatterns.some(function(k){return n.indexOf(norm(k))>=0;}))return {type:'excluded',periodLabel:null};
 for(var p of config.periods)for(var k of p.keywords){if(descriptive.indexOf(norm(k))>=0)return {periodLabel:p.label,periodStart:p.start,periodEnd:p.end,type:p.type,periodSource:'name-keyword',confidence:confidence};}
 return {periodLabel:null,periodStart:null,periodEnd:null,type:'settlement',periodSource:null,confidence:'none'};}
root.DetectLabRomaniaConfig=config;root.DetectLabRomaniaNames={normalise:norm,classify:classify};if(typeof module==='object'&&module.exports)module.exports={config:config,normalise:norm,classify:classify};
})(typeof self!=='undefined'?self:this);
