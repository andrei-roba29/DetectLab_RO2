/* Robust positive-site weighting, independent of source. Values are sampled environmental variables. */
(function(root){'use strict';
var DEFAULTS={enabled:true,minSites:20,maxIterations:5,stability:0.02,maxDownweightFraction:0.20,clusterMin:8,clusterFraction:0.15,tukeyCutoff:4.685,weightFloor:0.05};
function median(a){a=a.slice().sort((x,y)=>x-y);return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;}
function compute(rows,config){var c=Object.assign({},DEFAULTS,config||{}),n=rows.length;if(n<c.minSites)return {weights:Array(n).fill(1),flagged:[],status:'skipped-too-few',reason:'fewer-than-minimum'};
 var keys=Object.keys(rows[0]||{}),centres={},scales={};keys.forEach(k=>{var a=rows.map(r=>Number(r[k])).filter(Number.isFinite);centres[k]=median(a);scales[k]=Math.max(1e-9,1.4826*median(a.map(v=>Math.abs(v-centres[k]))));});
 var d=rows.map(r=>Math.sqrt(keys.reduce((s,k)=>s+Math.pow((Number(r[k])-centres[k])/scales[k],2),0)/Math.max(keys.length,1)));var md=median(d),mad=Math.max(1e-9,1.4826*median(d.map(x=>Math.abs(x-md))));var cutoff=md+c.tukeyCutoff*mad;var candidates=d.map((x,i)=>x>cutoff?i:-1).filter(i=>i>=0);
 if(candidates.length>=c.clusterMin&&candidates.length/n>c.clusterFraction)return {weights:Array(n).fill(1),flagged:[],possibleSecondPattern:candidates,status:'possible-second-pattern',distances:d};
 var cap=Math.floor(n*c.maxDownweightFraction);candidates.sort((a,b)=>d[b]-d[a]);candidates=candidates.slice(0,cap);var weights=Array(n).fill(1);candidates.forEach(i=>{var u=Math.min(1,d[i]/Math.max(cutoff,1e-9));weights[i]=Math.max(c.weightFloor,Math.pow(1-u*u,2));});return {weights:weights,flagged:candidates,status:candidates.length?'weighted':'unchanged',distances:d,config:c};}
var api={DEFAULTS:DEFAULTS,compute:compute};root.DetectLabApmRobust=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof self!=='undefined'?self:this);
