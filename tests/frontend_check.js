const fs=require('fs'),vm=require('vm'),assert=require('assert');
// Lancer depuis la racine : node tests/frontend_check.js
const path=require('path'),root=path.join(__dirname,'..');
const file=path.join(root,'static','app.js'),cfg=JSON.parse(fs.readFileSync(path.join(root,'data','normes_bilans.json'),'utf8'));let source=fs.readFileSync(file,'utf8'),config,form,posted=[];
const element=()=>({value:'',addEventListener(){},classList:{toggle(){},add(){}},isConnected:true});
const context={document:{querySelector:q=>q==='#toast'?element():null,querySelectorAll:()=>[],addEventListener(){}},window:{matchMedia:()=>({matches:true,addEventListener(){}}),addEventListener(){}},location:{hash:'#/patient/1/maj'},console,performance:{now:()=>0},Date,JSON,Map,Set,FormData:class{},MutationObserver:class{observe(){}},setInterval(){},setTimeout(){},clearTimeout(){},confirm:()=>true};
context.capture=c=>{config=c;form={elements:new Proxy({},{get(o,k){return o[k]||(o[k]=element());}}),querySelector:()=>null,closest:()=>null};return form;};
context.request=async(path,options)=>{posted.push({path,options});return cfg;};
context.globalThis=context;vm.createContext(context);
const boot=source.indexOf("window.addEventListener('hashchange', render);");assert(boot>0);
source=source.slice(0,boot)+"formModal=globalThis.capture;api=globalThis.request;refresh=async()=>{};globalThis.test={S,labKinetic,labKineticV1,postOpForm,postOpLabel,simpleBilanForm,clinicalCompactHtml,crhBilanLines,renamePatientDocument,deletePatientDocument,setClock:iso=>{clock.epoch_ms=Date.parse(iso+'T12:00:00Z');clock.synced=0;clock.offset_minutes=0;}};})();";
vm.runInContext(source,context,{filename:file});const api=context.test;api.S.patient={id:1,age:40};api.S.entries={bilan:[],clinique:[]};api.setClock('2026-11-07');
const lab=(id,date,values)=>({id,date,details:JSON.stringify({schema:'bilan-simple-v2',values})});
(async()=>{
 const entries=[lab(1,'2026-11-01',{PusProfondPrelevement:'Ancien type',PusProfondResultat:'Ancien résultat'}),lab(2,'2026-11-02',{PusProfondPrelevement:'Aspiration',PusProfondResultat:'Nouveau résultat',PusSuperficielPrelevement:'Ecouvillon',PusSuperficielResultat:'Résultat superficiel'})];
 let html=api.labKinetic(entries);assert(html.includes('pus-results-box')&&html.includes('Nouveau résultat')&&html.includes('Résultat superficiel'));
 assert(!html.includes('Ancien résultat')&&!html.includes('Ancien type')&&!html.includes('→')&&!html.includes('simple-dates'));
 const emptyNew=api.labKinetic([...entries,lab(3,'2026-11-03',{PusProfondPrelevement:'Nouveau prélèvement'})]);assert(emptyNew.includes('Nouveau prélèvement')&&!emptyNew.includes('Nouveau résultat'));
 html=api.labKinetic([...entries,lab(4,'2026-11-04',{Ph:'1.2',Ca:'2.4',Triglycerides:'1.0',Na:'140'})]);assert(html.includes('Ph :')&&html.includes('Ca :')&&!html.includes('Bilan lipidique'));
 const crh=api.crhBilanLines(entries).join('\n');assert(crh.includes('Nouveau résultat')&&!crh.includes('Ancien résultat')&&!crh.includes('→'));
 await api.simpleBilanForm();const pairs=[...config.extra.matchAll(/class="pus-form-fields">([\s\S]*?)<\/div>/g)];assert.equal(pairs.length,2);
 for(const pair of pairs){assert(pair[1].includes('Type de prélèvement')&&pair[1].includes('Résultat'));assert.equal([...pair[1].matchAll(/name="sv\d+"/g)].length,2);}
 assert(!config.extra.includes('placeholder='));assert(config.extra.includes('mmol/L'));
 api.postOpForm();assert.strictEqual(config.values.base_j,0);assert(config.fields.some(f=>f.name==='gesture'));
 await config.onSubmit({date:'2026-11-07',base_j:'0',gesture:'appendicectomie'});
 const saved=posted[posted.length-1].options.body;assert(saved.content==='J0 post appendicectomie');
 const entry={id:1,category:'Gestes faits',date:'2026-11-07',content:saved.content,details:saved.details};
 assert.equal(api.postOpLabel(entry),'J0 post appendicectomie');api.setClock('2026-11-08');assert.equal(api.postOpLabel(entry),'J1 post appendicectomie');
 api.setClock('2026-11-10');assert.equal(api.postOpLabel(entry),'J3 post appendicectomie');
 await config.onSubmit({date:'2026-11-07',base_j:'3',gesture:'drainage'});const second=posted[posted.length-1].options.body;assert.equal(api.postOpLabel({...entry,details:second.details}),'J6 post drainage');
 let denied=false;try{await config.onSubmit({date:'2026-12-01',base_j:'0',gesture:'x'});}catch{denied=true;}assert(denied);
 api.setClock('2024-03-01');assert.equal(api.postOpLabel({category:'Gestes faits',details:JSON.stringify({schema:'postop-counter-v1',base_j:0,base_date:'2024-02-28',gesture:'test'})}),'J2 post test');
 await api.renamePatientDocument(1,{id:9,title:'Ancien'});await config.onSubmit({title:'Nouveau'});assert(posted.some(p=>p.path.endsWith('/documents/9')&&p.options.method==='PUT'));
 await api.deletePatientDocument(1,{id:9,title:'Titre'},{isConnected:true});assert(posted.some(p=>p.path.endsWith('/documents/9')&&p.options.method==='DELETE'));
 console.log('PASS : pus type/résultat côte à côte, dernier résultat seul sans cinétique ni reprise du résultat ancien, champs/unités, CRH séparé, compteur J0/J1/J3, J initial réglable, année bissextile, date future refusée. Vrai bloc JS, DOM/réseau simulés.');
})().catch(e=>{console.error(e);process.exitCode=1;});
