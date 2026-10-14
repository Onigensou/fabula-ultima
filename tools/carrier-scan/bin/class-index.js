const fs=require('fs'),path=require('path');
const E='e:/Works/Game Development/FoundryVTT/Data/worlds/fabula-ultima-2/_authored-export';
const S=require('os').tmpdir();fs.writeFileSync(S+'/sweep.json',require('child_process').execFileSync(process.execPath,[path.join(__dirname,'carrier-scan.js'),'sweep','--kind','skill','--json'],{maxBuffer:1<<28}));
const folders={};for(const f of fs.readdirSync(E+'/folders'))(o=>folders[o._id]=o)(require(E+'/folders/'+f));
const fpath=id=>{const p=[];while(id&&folders[id]){p.unshift(folders[id].name);id=folders[id].folder;}return p.join(' / ');};
const sweep=require(S+'/sweep.json').bare;
const bareIds=new Set(sweep.map(b=>b.id+'|'+b.owner));
const out=[];
for(const f of fs.readdirSync(E+'/actors')){const a=require(E+'/actors/'+f);const fp=fpath(a.folder);
 if(!/^Classes/.test(fp))continue;
 for(const it of a.items||[]){const p=it.system?.props||{};const tpl=it.system?.template;
  // skills only: has skill_type
  if(p.skill_type===undefined)continue;
  out.push({cls:a.name,clsFolder:fp,id:it._id,name:it.name,type:p.skill_type,heroic:p.isHeroic===true||p.isHeroic==='true',bare:bareIds.has(it._id+'|'+a.name),itemFolder:it.folder?fpath(it.folder):''});}}
fs.writeFileSync(S+'/class-index.json',JSON.stringify(out,null,1));
const by={};for(const r of out){(by[r.cls]??={n:0,bare:0,bareNormal:0,heroicBare:0,names:[]});const b=by[r.cls];b.n++;if(r.bare){b.bare++;if(r.heroic)b.heroicBare++;else{b.bareNormal++;b.names.push(r.name+' ['+r.type+']');}}}
let tot=0,totN=0,classes=Object.keys(by).length;
for(const [c,b] of Object.entries(by).sort((x,y)=>y[1].bareNormal-x[1].bareNormal)){tot+=b.bare;totN+=b.bareNormal;console.log(`${c.padEnd(22)} docs=${String(b.n).padStart(3)} bare=${String(b.bare).padStart(3)} normalBare=${String(b.bareNormal).padStart(3)} heroicBare=${b.heroicBare}`);}
console.log('classes',classes,'docs',out.length,'bare',tot,'normalBare',totN);
