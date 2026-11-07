/* Chirurgie Viscérale A — CHU Oujda — Front-end (vanilla JS, SPA) */
(() => {
'use strict';

// ADAPTATIONS SERVICE V3
const LAB_NEW_NUMERIC=new Set(['Lymphocytes','Cholesterol','HDL','LDL','Triglycerides','Ph','Ca']);
const LAB_FIELD_LABELS={Cholesterol:'Cholestérol total',Triglycerides:'Triglycérides',Ph:'Phosphore (Ph)',Ca:'Calcium (Ca)',PusProfondPrelevement:'Type de prélèvement — pus profond',PusProfondResultat:'Résultat — pus profond',PusSuperficielPrelevement:'Type de prélèvement — pus superficiel',PusSuperficielResultat:'Résultat — pus superficiel'};
function drainDecode(entry){try{const p=JSON.parse(entry?.details||'');return p?.schema==='drain-series-v1'?p:null;}catch{return null;}}
function drainClinicalItem(entry){
 const p=drainDecode(entry),readings=[...p.readings].sort((a,b)=>a.date.localeCompare(b.date));
 return `<div class="drain-series-row" data-eid="clinique:${entry.id}"><div class="drain-kinetic"><strong>${esc(p.location)} :</strong> ${readings.map(r=>`<span class="drain-reading" title="${esc(fmtDate(r.date))}">${esc(r.quantity)} cc${r.aspect?' '+esc(r.aspect):''}</span>`).join('<span class="drain-arrow">→</span>')}<button type="button" class="drain-add no-print" data-drain-add="${entry.id}" title="Ajouter un relevé" aria-label="Ajouter un relevé au drain ${esc(p.location)}">+</button></div></div>`;
}
function drainChooser(legacy){
 const ov=modal(`<div class="dialog-head"><h2>Drains</h2><button type="button" class="btn" data-close>Fermer</button></div><div class="dialog-body"><button type="button" class="btn primary" data-create>Ajouter un drain</button>${legacy?'<p>La saisie précédente en texte libre reste conservée.</p><button type="button" class="btn" data-legacy>Modifier l’ancienne saisie</button>':''}</div>`,'form-dialog');
 ov.querySelector('[data-close]').onclick=closeModal;ov.querySelector('[data-create]').onclick=()=>drainForm();
 ov.querySelector('[data-legacy]')?.addEventListener('click',()=>entryForm('clinique',legacy,{legacyDrain:true}));
}
function drainForm(entry=null,append=false,readingId=null){
 const p=drainDecode(entry),readings=p?[...p.readings].sort((a,b)=>a.date.localeCompare(b.date)):[];
 const reading=p?(readings.find(r=>r.id===readingId)||readings[readings.length-1]):null;
 const positions=['Douglas','Sous-hépatique','Inter-anse','Gouttière pariéto-colique droite','Gouttière pariéto-colique gauche','Loge splénique','Autre'];
 const location=p?.location||'Douglas',known=positions.includes(location);
 const fields=[];
 if(!append)fields.push({name:'position',label:'Emplacement',type:'select',options:positions,required:true},{name:'custom_location',label:'Autre emplacement',full:true});
 fields.push({name:'date',label:'Date du relevé',type:'date',required:true},{name:'quantity',label:'Quantité (cc)',required:true,placeholder:'Ex. 100'},{name:'aspect',label:'Aspect',type:'datalist',options:['SH','Séreux','Sérohématique','Hématique','Bilieux','Purulent','Chyleux'],placeholder:'Ex. SH'});
 const picker=p&&!append?`<label class="field">Relevé à modifier<select data-reading-picker>${readings.map(r=>`<option value="${esc(r.id)}" ${r.id===reading.id?'selected':''}>${esc(fmtDate(r.date))} — ${esc(r.quantity)} cc ${esc(r.aspect)}</option>`).join('')}</select></label>`:'';
 const form=formModal({title:!p?'Ajouter un drain':append?'Ajouter un relevé — '+location:'Modifier le drain — '+location,submit:append?'Ajouter la valeur':'Enregistrer',fields,extra:picker,
 values:{position:known?location:'Autre',custom_location:known?'':location,date:append?today():reading?.date||today(),quantity:append?'':reading?.quantity||'',aspect:append?reading?.aspect||'':reading?.aspect||''},
 onSubmit:async v=>{
   const body={date:v.date,quantity:v.quantity,aspect:v.aspect};
   if(!append){body.location=v.position==='Autre'?v.custom_location.trim():v.position;if(!body.location)throw new Error('Précisez l’emplacement du drain.');}
   if(!p)await api(`/api/patients/${S.patient.id}/drains`,{method:'POST',body});
   else if(append)await api(`/api/drains/${entry.id}/releves`,{method:'POST',body});
   else await api(`/api/drains/${entry.id}/releves/${reading.id}`,{method:'PUT',body});
   await refresh();toast('Drain enregistré');
 },onDelete:p&&!append?async()=>{await api('/api/entries/'+entry.id,{method:'DELETE'});await refresh();}:null});
 if(!append){const sync=()=>form.querySelector('[data-f="custom_location"]').classList.toggle('hidden',form.elements.position.value!=='Autre');form.elements.position.onchange=sync;sync();}
 form.querySelector('[data-reading-picker]')?.addEventListener('change',e=>drainForm(entry,false,e.target.value));
}
async function renamePatientDocument(pid,doc){
 formModal({title:'Modifier le titre du document',fields:[{name:'title',label:'Titre',required:true,full:true}],values:{title:doc.title},onSubmit:async v=>{await api(`/api/patients/${pid}/documents/${doc.id}`,{method:'PUT',body:{title:v.title}});await loadPatientDocuments(pid);toast('Titre modifié');}});
}
async function deletePatientDocument(pid,doc,button){
 if(!confirm('Supprimer définitivement ce document : '+doc.title+' ?'))return;
 button.disabled=true;
 try{await api(`/api/patients/${pid}/documents/${doc.id}`,{method:'DELETE'});await loadPatientDocuments(pid);toast('Document supprimé');}catch(e){toast(e.message,true);}finally{if(button.isConnected)button.disabled=false;}
}



// SORTIE DATES ET CRH V1
function crhIsoDate(d){return /^\d{4}-\d{2}-\d{2}$/.test(String(d||''));}
function crhStayEntries(entries,p){
 const start=crhIsoDate(p.date_entree)?p.date_entree:null,end=crhIsoDate(p.sortie_date)?p.sortie_date:null;
 return (entries||[]).filter(e=>{
  const date=crhIsoDate(e.date)?e.date:crhIsoDate(String(e.created_at||'').slice(0,10))?String(e.created_at).slice(0,10):null;
  return !date||(!start||date>=start)&&(!end||date<=end);
 });
}
function crhOrdered(entries){return [...entries].sort((a,b)=>(a.date||'').localeCompare(b.date||'')||(a.id||0)-(b.id||0));}
function crhText(e){return e.category==='Gestes faits'?postOpLabel(e):String(e.content||'').trim();}
function crhBilanPayload(e){
 try{const p=JSON.parse(e.details||'');if(!p?.values)return null;
  if(p.schema==='bilan-simple-v2')return p.values;
  if(p.schema==='bilan-v1')return Object.fromEntries(Object.entries(p.values).map(([k,row])=>[k,row?.value||'']));
 }catch{}return null;
}
function crhBilanLines(entries){
 const fields=LAB_DISPLAY_GROUPS;
 const grouped=new Map(),free=[],other=[];
 for(const e of crhOrdered(entries)){
  const values=crhBilanPayload(e);if(!values){free.push(e);continue;}
  const numeric=Object.fromEntries(Object.entries(values).filter(([k,v])=>k!=='Autre'&&!PUS_KEYS.has(k)&&String(v??'').trim()));
  if(Object.keys(numeric).length)grouped.set(e.date||'',{...(grouped.get(e.date||'')||{}),...numeric});
  if(values.Autre)other.push({date:e.date,text:values.Autre,id:e.id});
 }
 const dates=[...grouped.keys()].sort(),lines=[];
 if(dates.length){
  const last=dates[dates.length-1];
  const labels=dates.map((d,i)=>i===dates.length-1?fmtDate(d):crhIsoDate(d)&&d.slice(0,7)===last.slice(0,7)?d.slice(8):fmtDate(d));
  lines.push('Bilan biologique du '+labels.join('=>')+' :');
  for(const[label,keys]of fields){if(!dates.some(date=>keys.some(k=>grouped.get(date)[k])))continue;
    lines.push(label+' : '+dates.map(date=>keys.map(k=>grouped.get(date)[k]||'—').join('/')).join(' → '));
  }
 }
 for(const e of free)lines.push('Bilan biologique du '+(fmtDate(e.date)||'date non renseignée')+' :\n'+crhText(e));
 for(const e of other.sort((a,b)=>(b.date||'').localeCompare(a.date||'')||(b.id||0)-(a.id||0)))lines.push('Autre — '+(fmtDate(e.date)||'date non renseignée')+' :\n'+e.text);
 for(const [label,type,result] of PUS_KINDS){
   const sample=[...crhOrdered(entries)].reverse().find(e=>{const v=crhBilanPayload(e);return v&&(v[type]||v[result]);});
   if(sample){const v=crhBilanPayload(sample);lines.push(label+' — '+fmtDate(sample.date)+' : '+(v[type]||'—')+' ; '+(v[result]||'—'));}
 }
 return lines;
}
function buildCrhDraft(p,E,options={}){
 // SORTIE V3 : titre, identité, dates et médecin responsable sont placés dans le tableau d'en-tête du CRH Word.
 const lines=['Identité :', [p.age!=null?'Patient de '+p.age+' ans':'Âge non renseigné',p.mutuelle?'Couverture : '+p.mutuelle:''].filter(Boolean).join('. ')+'.',
 '', 'Motif :',p.motif||'Non renseigné', '', 'ATCDs :'];
 const atcd=(E.atcd||[]).map(crhText).filter(Boolean);lines.push(atcd.length?atcd.join('\n'):'Non renseignés');
 const clinical=crhStayEntries(E.clinique,p);
 lines.push('', 'Examen clinique / surveillance :');
 if(clinical.length){for(const e of crhOrdered(clinical)){lines.push((e.category||'Clinique')+(e.date?' — '+fmtDate(e.date):'')+' :',crhText(e));if(e.details&&!drainDecode(e))lines.push(e.details);}}
 else lines.push('Non renseigné');
 const bilans=E.bilan||[];
 if(bilans.length)lines.push('',...crhBilanLines(bilans));
 const exams=E.examen || []; // CRH : tous les examens, sans filtre de séjour.
 if(exams.length){lines.push('', 'Examens complémentaires :');for(const e of crhOrdered(exams)){
  lines.push([e.title||e.category||'Examen',fmtDate(e.date)].filter(Boolean).join(' — ')+' :');
  if(e.content)lines.push(e.content);if(e.details)lines.push(e.details);
 }}
 const avis=crhStayEntries(E.avis,p);
 if(avis.length){lines.push('', 'Avis spécialisés :');for(const e of crhOrdered(avis))lines.push((e.category||'Avis')+(e.date?' — '+fmtDate(e.date):'')+' :',crhText(e));}
 lines.push('', 'Prise en charge :', crhCareText(options));
 const observations=crhStayEntries(E.observation,p);
 lines.push('', 'Évolution / observations :');
 if(observations.length){for(const e of crhOrdered(observations))lines.push((fmtDate(e.date)||'Date non renseignée')+(e.title?' — '+e.title:'')+' :',crhText(e));}
 else lines.push('Évolution non renseignée — à compléter.');
 lines.push('',p.status==='sorti'?'Sortie :':'Projet de sortie :');
 lines.push([p.sortie_date?'Le '+fmtDate(p.sortie_date):'',p.sortie_mode||'',p.sortie_destination||''].filter(Boolean).join(' — ')||'À compléter');
 if(p.sortie_ordonnance)lines.push('', 'Ordonnance de sortie renseignée :',p.sortie_ordonnance);
 return lines.join('\n');
}
// SORTIE V3 : prise en charge = surveillance (par défaut) ou intervention(s) reprises des CRO.
function crhCareText(options){
 if(options.care!=='intervention')return 'Le patient a bénéficié d’une surveillance clinico-biologique.';
 const ops=(options.operations||[]).filter(o=>String(o.name||'').trim());
 const label=o=>String(o.name).trim()+(o.date?' le '+fmtDate(o.date):' (date à compléter)');
 if(!ops.length)return 'Le patient a bénéficié d’une intervention : intitulé et date à compléter.';
 if(ops.length===1)return 'Le patient a bénéficié de : '+label(ops[0])+'.';
 return 'Le patient a bénéficié de :\n'+ops.map(o=>'- '+label(o)).join('\n');
}
// CRH V4.2 : filtre strict des interventions du séjour.
function crhOperationInStay(operation,p){
 const valid=d=>{if(!crhIsoDate(d))return false;const t=new Date(d+'T00:00:00Z');return Number.isFinite(t.getTime())&&t.toISOString().slice(0,10)===d;};
 const start=p.date_entree,now=today(),end=valid(p.sortie_date)?(p.sortie_date<now?p.sortie_date:now):now;
 return valid(start)&&valid(operation.date)&&operation.date>=start&&operation.date<=end;
}

function initSortieCrh(form,p,E){
 const summary=form.elements.sortie_resume;if(!summary)return;
 let sourceEntries=E,lastDraft=null,reports=[],careTouched=false;
 const controls=document.createElement('div');controls.className='crh-tools';
 controls.innerHTML=`<div class="fgrid" style="margin:8px 0"><div class="field"><label>Prise en charge</label><select id="crh-care"><option value="surveillance">Surveillance sans intervention</option><option value="intervention">Intervention</option></select></div><div class="field" id="crh-cro-field"><label>Intervention enregistrée (onglet CRO)</label><select id="crh-cro"></select></div><div class="field" id="crh-name-field"><label>Type d’intervention</label><input id="crh-operation-name" placeholder="Intitulé de l’intervention"></div><div class="field" id="crh-date-field"><label>Date de l’intervention</label><input type="date" id="crh-operation-date"></div></div><button type="button" class="btn" id="crh-prefill">Préremplir depuis MAJ + observations</button><p id="crh-prefill-status" style="font-size:11px;color:#64748b;margin:8px 0">Brouillon à relire ; aucune bonne évolution ni donnée manquante n’est inventée.</p>`;
 summary.parentElement.insertBefore(controls,summary);
 const care=$('#crh-care',controls),cro=$('#crh-cro',controls),name=$('#crh-operation-name',controls),date=$('#crh-operation-date',controls),status=$('#crh-prefill-status',controls),button=$('#crh-prefill',controls);
 const currentPatient=()=>({...p,date_entree:form.elements.date_entree?.value||'',sortie_date:form.elements.sortie_date.value,sortie_mode:form.elements.sortie_mode.value,sortie_destination:form.elements.sortie_destination.value,sortie_ordonnance:form.elements.sortie_ordonnance.value});
 const stayReports=()=>crhOrdered(reports.filter(r=>crhOperationInStay(r,currentPatient())));
 const opOf=r=>({name:r.type_name||r.intitule||'',date:crhIsoDate(r.date)?r.date:''});
 const options=()=>{
  if(care.value!=='intervention')return {care:'surveillance'};
  const operations=(cro.value==='__all'?stayReports().map(opOf):[{name:name.value,date:date.value}]).filter(o=>String(o.name||'').trim()&&crhOperationInStay(o,currentPatient()));
  return operations.length?{care:'intervention',operations}:{care:'surveillance'};
 };
 const refreshCro=()=>{
  const list=stayReports(),previous=cro.value;
  cro.innerHTML='<option value="">— Saisie manuelle —</option>'+list.map(r=>`<option value="${r.id}">${esc((fmtDate(r.date)||'Date inconnue')+' — '+(r.type_name||r.intitule||'Intervention'))}</option>`).join('')+(list.length>1?`<option value="__all">Toutes les interventions (${list.length})</option>`:'');
  if([...cro.options].some(o=>o.value===previous))cro.value=previous;
 };
 const fillFromCro=()=>{const r=stayReports().find(r=>String(r.id)===cro.value);if(r){const o=opOf(r);name.value=o.name;date.value=o.date;}};
 const update=force=>{
  if(force||!summary.value.trim()||summary.value===lastDraft){lastDraft=buildCrhDraft(currentPatient(),sourceEntries,options());summary.value=lastDraft;status.textContent='Brouillon prérempli : vérifier les dates, la prise en charge et l’évolution avant validation.';}
  else status.textContent='Texte personnalisé conservé. Utilisez Préremplir pour le remplacer après confirmation.';
 };
 const toggle=()=>{const visible=care.value==='intervention';$('#crh-cro-field',controls).style.display=visible&&stayReports().length?'':'none';
  const manual=visible&&cro.value!=='__all';for(const id of ['crh-name-field','crh-date-field'])$('#'+id,controls).style.display=manual?'':'none';};
 care.onchange=()=>{careTouched=true;toggle();update(false);};
 cro.onchange=()=>{fillFromCro();toggle();update(false);};
 name.oninput=()=>update(false);date.onchange=()=>update(false);
 for(const field of ['date_entree','sortie_date','sortie_mode','sortie_destination','sortie_ordonnance'])form.elements[field]?.addEventListener('change',()=>{refreshCro();toggle();update(false);});
 button.onclick=async()=>{
  if(summary.value.trim()&&summary.value!==lastDraft&&!confirm('Remplacer le résumé personnalisé par un nouveau brouillon depuis le dossier ?'))return;
  button.disabled=true;
  try{const data=await api('/api/patients/'+p.id);if(!form.isConnected)return;sourceEntries=data.entries;p.sexe=data.patient.sexe||'';try{reports=(await api('/api/patients/'+p.id+'/cro')).reports||[];}catch{}refreshCro();toggle();update(true);}
  catch(error){status.textContent=error.message;}finally{if(button.isConnected)button.disabled=false;}
 };
 refreshCro();toggle();if(!summary.value.trim())update(true);
 // Si une intervention est enregistrée dans l'onglet CRO, elle est proposée automatiquement.
 api('/api/patients/'+p.id+'/cro').then(r=>{
  if(!form.isConnected)return;reports=r.reports||[];refreshCro();
  const list=stayReports();
  if(list.length&&!careTouched){care.value='intervention';cro.value=list.length>1?'__all':String(list[list.length-1].id);fillFromCro();}
  toggle();update(false);
 }).catch(()=>{});
}

// AUTRES ET CENTRAGE ONGLETS V1
// MENU TABLEAU VISITE ET STAFFER V1

function viewPatientsAStaffer(){
  $('#app').innerHTML=topbar()+`<main class="patient" style="grid-template-rows:auto 1fr"><div class="tabsbar"><button class="btn-back" id="staffer-back">${I.back} Retour à l’accueil</button></div><section class="panel"><div class="panel-head"><h3>Patients à staffer</h3></div><div class="empty">Espace réservé — fonctionnalités à définir.</div></section></main>`;
  bindChrome();
  $('#staffer-back').onclick=()=>{location.hash='#/home';};
}

// ONGLETS ET LOGS ADMIN V1

// TELECHARGEMENT IMAGERIE V3
async function downloadImaging(pid,v,button){
 if(button)button.disabled=true;
 try{
  if(v.category==='fichier'){
    const access=await api('/api/patients/'+pid+'/imaging/'+v.id+'/ticket',{method:'POST'});
    const link=document.createElement('a');link.href=API+'/api/patients/'+pid+'/imaging/'+v.id+'/media?ticket='+encodeURIComponent(access.ticket)+'&download=1';
    link.download='';document.body.appendChild(link);link.click();link.remove();
  }else{
    let url;try{url=new URL(v.content);}catch{}if(!url||!['http:','https:'].includes(url.protocol))throw new Error('Lien non pris en charge.');
    const host=url.hostname.toLowerCase();
    if(['youtube.com','www.youtube.com','m.youtube.com','youtu.be','www.youtu.be'].includes(host))throw new Error('Téléchargement non disponible pour un lien YouTube.');
    const response=await fetch(url.href,{credentials:'omit'});if(!response.ok)throw new Error('Téléchargement refusé par le serveur externe.');
    const blob=await response.blob(),local=URL.createObjectURL(blob),link=document.createElement('a');link.href=local;link.download=url.pathname.split('/').pop()||'imagerie';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(local),60000);
  }
 }catch(error){toast(v.category==='fichier'?error.message:'Téléchargement du lien externe indisponible : '+error.message,true);}
 finally{if(button?.isConnected)button.disabled=false;}
}


// MINIATURES IMAGERIES V2
function imagingCardTitle(p){
 const base=imagingHeading(p);
 return p.type==='Autre'?base:[base,imagingSummary(p)].filter(Boolean).join(' — ');
}
async function loadImagingThumbnail(pid,v,button){
 if(button.dataset.thumbLoaded)return;button.dataset.thumbLoaded='1';
 try{
  let src,kind;
  if(v.category==='fichier'){
    const ticket=await api('/api/patients/'+pid+'/imaging/'+v.id+'/ticket',{method:'POST'});
    if(!button.isConnected)return;
    src=API+'/api/patients/'+pid+'/imaging/'+v.id+'/media?ticket='+encodeURIComponent(ticket.ticket);kind=ticket.media_type;
  }else{
    let url;try{url=new URL(v.content);}catch{}if(!url||!['http:','https:'].includes(url.protocol))throw new Error('Lien non pris en charge');
    const host=url.hostname.toLowerCase();
    if(['youtube.com','www.youtube.com','m.youtube.com','youtu.be','www.youtu.be'].includes(host)){
      const id=host.includes('youtu.be')?url.pathname.split('/').filter(Boolean)[0]:(url.searchParams.get('v')||url.pathname.split('/').filter(Boolean).pop());
      if(!/^[A-Za-z0-9_-]{11}$/.test(id||''))throw new Error('Lien YouTube invalide');
      src='https://i.ytimg.com/vi/'+id+'/hqdefault.jpg';kind='image';
    }else if(/\.(jpe?g|png)$/i.test(url.pathname)){src=url.href;kind='image';}
    else if(/\.(mp4|webm|mov|m4v|ogg)$/i.test(url.pathname)){src=url.href;kind='video';}
    else throw new Error('Pas de miniature intégrée pour ce lien');
  }
  if(!button.isConnected)return;
  const media=document.createElement(kind==='image'?'img':'video');media.className='imaging-thumbnail-media';
  if(kind==='image'){media.alt=imagingCardTitle(imagingInfo(v));media.loading='lazy';media.referrerPolicy='no-referrer';}
  else{
    media.muted=true;media.playsInline=true;media.preload='metadata';media.controls=false;media.tabIndex=-1;
    media.addEventListener('loadedmetadata',()=>{try{if(Number.isFinite(media.duration)&&media.duration>0)media.currentTime=Math.min(.1,media.duration/2);}catch{}},{once:true});
  }
  media.onerror=()=>{if(button.isConnected)button.innerHTML='<span class="imaging-thumbnail-fallback">▶</span><small>Miniature indisponible — cliquer pour lire</small>';};
  media.src=src;button.replaceChildren(media);
  const play=document.createElement('span');play.className='imaging-thumbnail-play';play.textContent='▶';button.appendChild(play);
 }catch(error){if(button.isConnected){button.innerHTML='<span class="imaging-thumbnail-fallback">▶</span><small>Aperçu indisponible — cliquer pour ouvrir</small>';}}
}
function prepareImagingThumbnails(box,pid,vids){
 const buttons=[...box.querySelectorAll('[data-imaging-thumbnail]')];
 const load=button=>{const v=vids.find(v=>String(v.id)===button.dataset.imagingThumbnail);if(v)loadImagingThumbnail(pid,v,button);};
 if('IntersectionObserver' in window){
   const observer=new IntersectionObserver(entries=>{entries.forEach(e=>{if(e.isIntersecting){observer.unobserve(e.target);load(e.target);}});},{root:null,rootMargin:'150px'});
   buttons.forEach(button=>observer.observe(button));
   setTimeout(()=>{if(!box.isConnected)observer.disconnect();},60000);
 }else buttons.forEach(load);
}


// VIDEOS IMAGERIES V1
function imagingInfo(v){
 try{const p=JSON.parse(v.details||'');if(p?.schema==='imaging-v1')return p;}catch{}
 return {schema:'imaging-v1',type:['TDM','IRM'].includes(v.title)?v.title:'Autre',custom_title:['TDM','IRM'].includes(v.title)?'':v.title||'',plane:'Autre',phase:'Autre',custom_plane:'',custom_phase:'',notes:v.details||''};
}
function imagingHeading(p){return p.type==='Autre'?p.custom_title||'Autre':p.type;}
function imagingSummary(p){
 return [p.plane==='Autre'?p.custom_plane||'':p.plane||'',p.phase==='Autre'?p.custom_phase||'':p.phase||''].filter(value=>String(value).trim()).join(' · ');
}
function imagingForm(entry){
 const p=entry?imagingInfo(entry):{type:'',custom_title:'',plane:'',phase:'',custom_plane:'',custom_phase:'',notes:''};
 const uploaded=entry?.category==='fichier';
 const fields=[
 {name:'imaging_type',label:'Type d’imagerie',type:'select',options:[['','— Choisir —'],'TDM','IRM','Bili-IRM','Autre'],required:true},
 {name:'custom_title',label:'Titre — type Autre',full:true},
 {name:'date',label:'Date',type:'date',required:true},
 {name:'plane',label:'Coupe',type:'select',options:[['','— Choisir —'],'Axiale','Sagittale','Coronale','Autre'],required:false},
 {name:'custom_plane',label:'Précision de coupe (facultative)',full:true},
 {name:'phase',label:'Temps',type:'select',options:[['','— Choisir —'],'Sans injection','Artériel','Veineux','Portal','Tardif','Autre'],required:false},
 {name:'custom_phase',label:'Précision du temps (facultative)',full:true},
 ...(!uploaded?[{name:'content',label:'Lien URL de la vidéo',full:true,placeholder:'https://… (ou importer un fichier ci-dessous)'}]:[]),
 {name:'file',label:entry?'Remplacer par une autre vidéo / image (facultatif)':'Ou importer une vidéo / image',type:'file',accept:'video/*,image/jpeg,image/png',full:true},
 {name:'notes',label:'Description',type:'textarea',full:true}];
 const form=formModal({title:entry?'Modifier l’imagerie':'Ajouter une imagerie',fields,
 values:{imaging_type:p.type,custom_title:p.custom_title,date:entry?.date||today(),plane:p.plane,custom_plane:p.custom_plane,phase:p.phase,custom_phase:p.custom_phase,notes:p.notes,content:entry?.content||''},
 onSubmit:async v=>{
  if(v.imaging_type!=='Autre'&&(!v.plane||!v.phase))throw new Error('Renseignez coupe et temps pour TDM/IRM.');
  if(v.imaging_type==='Autre'&&!v.custom_title.trim())throw new Error('Précisez le titre du type Autre.');
  const info={schema:'imaging-v1',type:v.imaging_type,custom_title:v.imaging_type==='Autre'?v.custom_title.trim():'',plane:v.plane,custom_plane:v.plane==='Autre'?v.custom_plane.trim():'',phase:v.phase,custom_phase:v.phase==='Autre'?v.custom_phase.trim():'',notes:v.notes||''};
  const title=imagingHeading(info),details=JSON.stringify(info);
  const pid=S.patient.id;
  if(v.file){
   const fd=new FormData();fd.append('file',v.file);fd.append('title',title);fd.append('date',v.date);fd.append('details',details);
   await api(entry?'/api/patients/'+pid+'/imaging/'+entry.id+'/replace':'/api/patients/'+pid+'/upload',{method:'POST',body:fd});
  }else{
   const content=uploaded?entry.content:(v.content||'').trim();
   if(!content)throw new Error('Ajoutez un lien ou importez un fichier.');
   if(!uploaded){let url;try{url=new URL(content);}catch{}if(!url||!['http:','https:'].includes(url.protocol))throw new Error('Lien HTTP ou HTTPS valide requis.');}
   const body={kind:'video',category:entry?.category||'',title,date:v.date,content,details};
   if(entry)await api('/api/entries/'+entry.id,{method:'PUT',body});else await api('/api/patients/'+pid+'/entries',{method:'POST',body});
  }
  toast('Imagerie enregistrée');await refresh();
 },onDelete:entry?async()=>{await api('/api/entries/'+entry.id,{method:'DELETE'});await refresh();}:null});
 const toggle=()=>{
  const other=form.elements.imaging_type.value==='Autre';
  for(const[name,visible]of [['custom_title',other],['plane',true],['phase',true],['custom_plane',form.elements.plane.value==='Autre'],['custom_phase',form.elements.phase.value==='Autre']]){
   const row=form.querySelector('[data-f="'+name+'"]');if(row)row.style.display=visible?'':'none';
  }
  form.elements.plane.required=!other;form.elements.phase.required=!other;
 };
 form.elements.imaging_type.onchange=toggle;form.elements.plane.onchange=toggle;form.elements.phase.onchange=toggle;toggle();
}
function renderImagingTab(box,E,p){
 const vids=sortByDate(E.video||[]);
 box.innerHTML=`<div class="panel"><div class="panel-head"><h3>Videos imageries</h3><button class="btn primary" data-add="video">+ Ajouter une imagerie</button></div><div class="videos">${vids.map(v=>{
  const info=imagingInfo(v);
  return `<article class="card imaging-card" data-imaging-card="${v.id}" data-imaging-type="${esc(info.type)}"><div class="imaging-card-head"><h4>${esc(imagingCardTitle(info))}</h4><button type="button" class="maj-edit-pencil no-print" data-imaging-edit="${v.id}" title="Modifier l’imagerie" aria-label="Modifier l’imagerie">✎</button></div><div class="imaging-subtitle">${fmtDate(v.date)}</div><button type="button" class="imaging-thumbnail" data-imaging-thumbnail="${v.id}" aria-label="Ouvrir ${esc(imagingCardTitle(info))}"><span class="imaging-thumbnail-fallback">▶</span><small>Chargement de la miniature…</small></button>${info.notes?`<p class="imaging-description">${esc(info.notes)}</p>`:''}</article>`;
 }).join('')||'<div class="empty">Aucune imagerie</div>'}</div></div>`;
 box.querySelectorAll('[data-imaging-card]').forEach(card=>card.onclick=event=>{
  if(event.target.closest('[data-imaging-edit]'))return;
  const v=vids.find(v=>String(v.id)===card.dataset.imagingCard);if(v)openImagingPlayer(p.id,v);
 });
 box.querySelectorAll('[data-imaging-edit]').forEach(button=>button.onclick=event=>{
  event.stopPropagation();const v=vids.find(v=>String(v.id)===button.dataset.imagingEdit);if(v)imagingForm(v);
 });
 prepareImagingThumbnails(box,p.id,vids);
}


// ------------------------------------------------- LECTEUR VIDÉO IMAGERIE V2
// Lecteur dédié au défilement des coupes : curseur de position fluide (rAF), glisser-déposer
// sur la barre ou sur l'image, pas à pas image par image, molette, clavier, vitesse, boucle, plein écran.
function fmtClock(sec){
 if(!isFinite(sec)||sec<0)sec=0;
 const m=Math.floor(sec/60),s=Math.floor(sec%60),cs=Math.floor((sec-Math.floor(sec))*100);
 return (m<10?'0':'')+m+':'+(s<10?'0':'')+s+'.'+(cs<10?'0':'')+cs;
}
function buildImagingPlayer(src,opts={}){
 const FRAME=opts.frame||1/25;
 const root=document.createElement('div');root.className='cva-player';root.tabIndex=0;root.setAttribute('role','group');root.setAttribute('aria-label','Lecteur vidéo');
 root.innerHTML=`<div class="cva-player-stage"><video playsinline preload="auto"></video><div class="cva-player-hint" hidden></div><div class="cva-player-loading" hidden><span class="cva-spinner"></span></div></div>
  <div class="cva-player-bar">
   <div class="cva-scrub" aria-label="Position de lecture" role="slider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="-1"><div class="cva-scrub-track"><div class="cva-scrub-buffer"></div><div class="cva-scrub-fill"></div><div class="cva-scrub-thumb"></div></div><div class="cva-scrub-tip" hidden>00:00.00</div></div>
   <div class="cva-player-ctrls">
    <button type="button" class="cva-btn" data-act="start" title="Début (Origine)" aria-label="Aller au début">&#9198;</button>
    <button type="button" class="cva-btn" data-act="back" title="Image précédente (←)" aria-label="Image précédente">&#9664;&#8201;&#9646;</button>
    <button type="button" class="cva-btn cva-btn-play" data-act="play" title="Lecture / pause (Espace)" aria-label="Lecture">&#9654;</button>
    <button type="button" class="cva-btn" data-act="fwd" title="Image suivante (→)" aria-label="Image suivante">&#9646;&#8201;&#9654;</button>
    <button type="button" class="cva-btn" data-act="end" title="Fin" aria-label="Aller à la fin">&#9197;</button>
    <span class="cva-time"><span data-cur>00:00.00</span> / <span data-dur>00:00.00</span></span>
    <span class="cva-spacer"></span>
    <label class="cva-speed">Vitesse <select data-speed><option value="0.1">0,1×</option><option value="0.25">0,25×</option><option value="0.5">0,5×</option><option value="1" selected>1×</option><option value="1.5">1,5×</option><option value="2">2×</option></select></label>
    <button type="button" class="cva-btn" data-act="loop" title="Lecture en boucle" aria-pressed="false" aria-label="Boucle">&#8635;</button>
    <button type="button" class="cva-btn" data-act="mute" title="Son" aria-label="Son">&#128266;</button>
    <button type="button" class="cva-btn" data-act="full" title="Plein écran (F)" aria-label="Plein écran">&#x26F6;</button>
   </div>
   <div class="cva-player-help">Glissez le curseur ou l’image pour faire défiler les coupes · ←/→ image par image · Maj+←/→ 1 s · molette sur l’image · Espace lecture/pause</div>
  </div>`;
 const video=root.querySelector('video'),stage=root.querySelector('.cva-player-stage'),scrub=root.querySelector('.cva-scrub'),track=root.querySelector('.cva-scrub-track'),fill=root.querySelector('.cva-scrub-fill'),buffer=root.querySelector('.cva-scrub-buffer'),thumb=root.querySelector('.cva-scrub-thumb'),tip=root.querySelector('.cva-scrub-tip'),cur=root.querySelector('[data-cur]'),dur=root.querySelector('[data-dur]'),playBtn=root.querySelector('[data-act="play"]'),loading=root.querySelector('.cva-player-loading'),hint=root.querySelector('.cva-player-hint');
 video.src=src;video.muted=true;
 let raf=0,dragging=false,wasPlaying=false,pendingSeek=null,duration=0,hintTimer=0;
 const showHint=(text)=>{hint.textContent=text;hint.hidden=false;clearTimeout(hintTimer);hintTimer=setTimeout(()=>{hint.hidden=true;},700);};
 const clamp=(t)=>Math.min(Math.max(0,t),duration||0);
 const paint=()=>{
  const d=duration||video.duration||0,t=video.currentTime||0,pct=d?(t/d*100):0;
  fill.style.width=pct+'%';thumb.style.left=pct+'%';cur.textContent=fmtClock(t);scrub.setAttribute('aria-valuenow',String(Math.round(pct)));
  if(d&&video.buffered.length){let end=0;for(let i=0;i<video.buffered.length;i++){if(video.buffered.start(i)<=t+0.5)end=Math.max(end,video.buffered.end(i));}buffer.style.width=Math.min(100,end/d*100)+'%';}
 };
 const loop=()=>{paint();raf=requestAnimationFrame(loop);};
 const startLoop=()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(loop);};
 const stopLoop=()=>{cancelAnimationFrame(raf);raf=0;paint();};
 const seekTo=(t,silent)=>{
  t=clamp(t);
  if(video.seeking){pendingSeek=t;}
  else{pendingSeek=null;try{video.currentTime=t;}catch{}}
  if(!silent){paint();}
 };
 video.addEventListener('seeked',()=>{if(pendingSeek!=null){const t=pendingSeek;pendingSeek=null;try{video.currentTime=t;}catch{}}paint();});
 const step=(frames)=>{if(!video.paused)video.pause();seekTo(video.currentTime+frames*FRAME);};
 const togglePlay=()=>{if(video.paused){if(duration&&video.currentTime>=duration-FRAME/2)seekTo(0);video.play().catch(()=>{});}else video.pause();};
 video.addEventListener('loadedmetadata',()=>{duration=video.duration;dur.textContent=fmtClock(duration);paint();});
 video.addEventListener('durationchange',()=>{duration=video.duration;dur.textContent=fmtClock(duration);});
 video.addEventListener('play',()=>{playBtn.innerHTML='&#10074;&#10074;';playBtn.setAttribute('aria-label','Pause');startLoop();});
 video.addEventListener('pause',()=>{playBtn.innerHTML='&#9654;';playBtn.setAttribute('aria-label','Lecture');stopLoop();});
 video.addEventListener('ended',()=>{stopLoop();});
 video.addEventListener('timeupdate',()=>{if(!raf)paint();});
 video.addEventListener('progress',paint);
 video.addEventListener('waiting',()=>{loading.hidden=false;});
 ['canplay','playing','seeked'].forEach(ev=>video.addEventListener(ev,()=>{loading.hidden=true;}));
 video.addEventListener('volumechange',()=>{root.querySelector('[data-act="mute"]').innerHTML=video.muted?'&#128263;':'&#128266;';});
 // Barre de position : glisser-déposer fluide (souris, doigt, stylet).
 const ratioFromEvent=(e)=>{const r=track.getBoundingClientRect();return r.width?Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)):0;};
 const dragMove=(e)=>{const ratio=ratioFromEvent(e);const t=ratio*(duration||0);seekTo(t,true);fill.style.width=ratio*100+'%';thumb.style.left=ratio*100+'%';cur.textContent=fmtClock(t);tip.textContent=fmtClock(t);tip.style.left=ratio*100+'%';};
 scrub.addEventListener('pointerdown',(e)=>{if(e.button!==undefined&&e.button!==0)return;e.preventDefault();dragging=true;wasPlaying=!video.paused;if(wasPlaying)video.pause();scrub.classList.add('dragging');tip.hidden=false;try{scrub.setPointerCapture(e.pointerId);}catch{}dragMove(e);});
 scrub.addEventListener('pointermove',(e)=>{if(dragging)dragMove(e);else if(duration){const ratio=ratioFromEvent(e);tip.hidden=false;tip.textContent=fmtClock(ratio*duration);tip.style.left=ratio*100+'%';}});
 const dragEnd=(e)=>{if(!dragging)return;dragging=false;scrub.classList.remove('dragging');tip.hidden=true;try{scrub.releasePointerCapture(e.pointerId);}catch{}if(wasPlaying)video.play().catch(()=>{});};
 scrub.addEventListener('pointerup',dragEnd);scrub.addEventListener('pointercancel',dragEnd);
 scrub.addEventListener('pointerleave',()=>{if(!dragging)tip.hidden=true;});
 // Glisser horizontalement sur l'image : défilement des coupes (1 largeur d'écran = toute la vidéo) ; clic simple : lecture/pause.
 let stageDrag=null;
 stage.addEventListener('pointerdown',(e)=>{if(e.button!==undefined&&e.button!==0)return;stageDrag={x:e.clientX,t:video.currentTime,moved:false,id:e.pointerId,playing:!video.paused};});
 stage.addEventListener('pointermove',(e)=>{
  if(!stageDrag||stageDrag.id!==e.pointerId)return;
  const dx=e.clientX-stageDrag.x;
  if(!stageDrag.moved&&Math.abs(dx)<6)return;
  if(!stageDrag.moved){stageDrag.moved=true;if(stageDrag.playing)video.pause();try{stage.setPointerCapture(e.pointerId);}catch{}stage.classList.add('scrubbing');}
  const width=stage.getBoundingClientRect().width||1;
  seekTo(stageDrag.t+dx/width*(duration||0));
 });
 const stageEnd=(e)=>{if(!stageDrag||stageDrag.id!==e.pointerId)return;const d=stageDrag;stageDrag=null;stage.classList.remove('scrubbing');try{stage.releasePointerCapture(e.pointerId);}catch{}if(!d.moved){togglePlay();}else if(d.playing){video.play().catch(()=>{});}};
 stage.addEventListener('pointerup',stageEnd);stage.addEventListener('pointercancel',stageEnd);
 stage.addEventListener('wheel',(e)=>{if(!duration)return;e.preventDefault();const frames=(e.deltaY>0?1:-1)*(e.shiftKey?10:1);step(frames);showHint((frames>0?'+':'')+frames+' image'+(Math.abs(frames)>1?'s':''));},{passive:false});
 stage.addEventListener('dblclick',()=>toggleFull());
 const toggleFull=()=>{const el=root;if(document.fullscreenElement){document.exitFullscreen?.();}else if(el.requestFullscreen){el.requestFullscreen().catch(()=>{});}else if(video.webkitEnterFullscreen){video.webkitEnterFullscreen();}};
 root.querySelector('.cva-player-ctrls').addEventListener('click',(e)=>{
  const b=e.target.closest('button[data-act]');if(!b)return;
  const act=b.dataset.act;
  if(act==='play')togglePlay();else if(act==='back')step(-1);else if(act==='fwd')step(1);
  else if(act==='start'){video.pause();seekTo(0);}else if(act==='end'){video.pause();seekTo(duration);}
  else if(act==='loop'){video.loop=!video.loop;b.setAttribute('aria-pressed',String(video.loop));b.classList.toggle('on',video.loop);}
  else if(act==='mute'){video.muted=!video.muted;}
  else if(act==='full')toggleFull();
  root.focus({preventScroll:true});
 });
 root.querySelector('[data-speed]').onchange=(e)=>{video.playbackRate=Number(e.target.value)||1;};
 root.addEventListener('keydown',(e)=>{
  if(e.target.tagName==='SELECT')return;
  const k=e.key;
  if(k===' '||k==='k'){e.preventDefault();togglePlay();}
  else if(k==='ArrowLeft'){e.preventDefault();if(e.shiftKey){video.pause();seekTo(video.currentTime-1);}else step(-1);}
  else if(k==='ArrowRight'){e.preventDefault();if(e.shiftKey){video.pause();seekTo(video.currentTime+1);}else step(1);}
  else if(k==='Home'){e.preventDefault();video.pause();seekTo(0);}
  else if(k==='End'){e.preventDefault();video.pause();seekTo(duration);}
  else if(k==='f'||k==='F'){e.preventDefault();toggleFull();}
  else if(k==='l'||k==='L'){root.querySelector('[data-act="loop"]').click();}
  else if(k==='+'||k==='='){const sel=root.querySelector('[data-speed]');if(sel.selectedIndex<sel.options.length-1){sel.selectedIndex++;sel.onchange({target:sel});showHint(sel.options[sel.selectedIndex].text);}}
  else if(k==='-'){const sel=root.querySelector('[data-speed]');if(sel.selectedIndex>0){sel.selectedIndex--;sel.onchange({target:sel});showHint(sel.options[sel.selectedIndex].text);}}
 });
 root.destroy=()=>{cancelAnimationFrame(raf);try{video.pause();}catch{}video.removeAttribute('src');video.load();};
 root.video=video;
 setTimeout(()=>root.focus({preventScroll:true}),50);
 return root;
}

function stopImagingPlayer(){
 const player=document.querySelector('#imaging-player-content .cva-player');
 if(player&&player.destroy){player.destroy();return;}
 const video=document.querySelector('#imaging-player-content video');
 if(video){video.pause();video.removeAttribute('src');video.load();}
}
async function openImagingPlayer(pid,v){
 closeModal();const info=imagingInfo(v);
 const overlay=modal(`<div class="dialog-head"><h2>${esc(imagingCardTitle(info))}</h2><div class="imaging-reader-actions"><button type="button" class="btn" id="imaging-download">Télécharger</button><button type="button" class="icon-btn" id="imaging-close" aria-label="Fermer">✕</button></div></div><p class="imaging-player-meta">${fmtDate(v.date)}</p><div class="imaging-player-content" id="imaging-player-content"><div class="empty">Ouverture…</div></div>${info.notes?`<p class="imaging-player-description">${esc(info.notes)}</p>`:''}`,'imaging-player-dialog');
 $('#imaging-close',overlay).onclick=closeModal;
 const download=$('#imaging-download',overlay);download.onclick=()=>downloadImaging(pid,v,download);
 if(v.category!=='fichier'){try{const host=new URL(v.content).hostname.toLowerCase();if(['youtube.com','www.youtube.com','m.youtube.com','youtu.be','www.youtu.be'].includes(host)){download.disabled=true;download.title='Téléchargement indisponible pour un lien YouTube';}}catch{}}
const container=$('#imaging-player-content',overlay);
 try{
  if(v.category==='fichier'){
   const access=await api('/api/patients/'+pid+'/imaging/'+v.id+'/ticket',{method:'POST'});if(!container.isConnected)return;
   const src=API+'/api/patients/'+pid+'/imaging/'+v.id+'/media?ticket='+encodeURIComponent(access.ticket);
   if(access.media_type==='image'){
    const image=document.createElement('img');image.src=src;image.alt=imagingHeading(info);image.className='imaging-player-image';container.replaceChildren(image);
   }else{
    const player=buildImagingPlayer(src);player.classList.add('imaging-player-video');
    player.video.onerror=()=>{if(container.isConnected&&!container.querySelector('.imaging-format-note')){const note=document.createElement('p');note.className='imaging-format-note';note.textContent='Vidéo non lisible : vérifier son format/codecs ou rouvrir le lecteur si l’accès a expiré.';container.appendChild(note);}};
    container.replaceChildren(player);
   }
  }else{
   let url;try{url=new URL(v.content);}catch{}if(!url||!['http:','https:'].includes(url.protocol))throw new Error('Lien non pris en charge.');
   const host=url.hostname.toLowerCase();
   if(['youtube.com','www.youtube.com','m.youtube.com','youtu.be','www.youtu.be'].includes(host)){
    const id=host.includes('youtu.be')?url.pathname.split('/').filter(Boolean)[0]:(url.searchParams.get('v')||url.pathname.split('/').filter(Boolean).pop());
    if(!/^[\w-]{11}$/.test(id||''))throw new Error('Lien YouTube invalide.');
    const frame=document.createElement('iframe');frame.src='https://www.youtube-nocookie.com/embed/'+id;frame.title=imagingHeading(info);frame.className='imaging-youtube-frame';frame.allowFullscreen=true;frame.setAttribute('allow','fullscreen; picture-in-picture');container.replaceChildren(frame);
   }else if(/\.(mp4|webm|mov|m4v|ogg)$/i.test(url.pathname)){
    const player=buildImagingPlayer(url.href);player.classList.add('imaging-player-video');container.replaceChildren(player);
   }else{
    container.innerHTML='<p>Ce lien ne permet pas un aperçu intégré.</p>';const link=document.createElement('a');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Ouvrir le lien externe';container.appendChild(link);
   }
  }
 }catch(error){if(container.isConnected)container.innerHTML='<div class="empty">'+esc(error.message)+'</div>';}
}


// TTT PRESENTATION V3
let tttPresentationRanks=new Map();
function tttRank(entry){
 if(tttPresentationRanks.has(entry.title))return tttPresentationRanks.get(entry.title);
 const categories={'solutés':0,'solutes':0,'sérums':0,'serums':0,'antalgique':1,'antibiotique':2,'anticoagulant':3,'anticoagulation':3,'insuline':4};
 return categories[String(entry.category||'').trim().toLowerCase()]??5;
}
function tttCompare(a,b){return tttRank(a)-tttRank(b)||Number(!!a.done)-Number(!!b.done)||(b.date||'').localeCompare(a.date||'')||(b.id||0)-(a.id||0);}
async function sortTreatmentTableWhenReady(box,E){
 try{
  const catalogue=await getTreatmentCatalogue();
  tttPresentationRanks=new Map(catalogue.map(row=>[row.nom,Number.isFinite(row.rang)?row.rang:5]));
  if(!box.isConnected)return;
  const body=box.querySelector('tbody');if(!body)return;
  const nodes=new Map([...body.querySelectorAll('[data-eid]')].map(node=>[node.dataset.eid,node]));
  [...(E.traitement||[])].sort(tttCompare).forEach(entry=>{const node=nodes.get('traitement:'+entry.id);if(node)body.appendChild(node);});
 }catch(error){toast(error.message,true);}
}
async function previewTreatmentSheet(pid){
 closeModal();
 const overlay=modal(`<div class="dialog-head"><h2>Fiche de traitement</h2><div class="ttt-preview-actions"><button type="button" class="btn" id="ttt-preview-download" disabled>Télécharger Word</button><button type="button" class="icon-btn" id="ttt-preview-close" aria-label="Fermer">✕</button></div></div><div class="ttt-preview-content"><div class="empty">Génération de la fiche…</div></div>`,'ttt-preview-dialog');
 $('#ttt-preview-close',overlay).onclick=closeModal;
 const container=$('.ttt-preview-content',overlay),download=$('#ttt-preview-download',overlay);
 try{
  const result=await api('/api/patients/'+pid+'/fiche-traitement/preview');if(!container.isConnected)return;
  const frame=document.createElement('iframe');frame.title='Aperçu de la fiche de traitement';frame.className='ttt-preview-frame';frame.setAttribute('sandbox','');frame.srcdoc=result.html;container.replaceChildren(frame);
  download.disabled=false;
  download.onclick=()=>{
   try{
    const raw=atob(result.docx_base64),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    const blob=new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=result.filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
   }catch(error){toast(error.message,true);}
  };
 }catch(error){if(container.isConnected)container.innerHTML='<div class="empty">'+esc(error.message)+'</div>';}
}


// TRAITEMENTS TTT V1
let treatmentCatalogueCache=null,treatmentCatalogueAt=0;
// Catalogue géré dans Paramètres : rechargé au plus toutes les 30 secondes.
async function getTreatmentCatalogue(){if(!treatmentCatalogueCache||Date.now()-treatmentCatalogueAt>30000){treatmentCatalogueCache=(await api('/api/ttt/catalogue')).traitements;treatmentCatalogueAt=Date.now();}return treatmentCatalogueCache;}
function tttDetails(entry){try{const p=JSON.parse(entry?.details||'');return p?.schema==='ttt-catalogue-v1'?p:null;}catch{return null;}}
function tttNotes(entry){return tttDetails(entry)?.notes||(!tttDetails(entry)?entry.details||'':'');}

// Recherche dans le catalogue existant : sélection obligatoire, pas de saisie libre.
function treatmentSearchKey(value){
 return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('fr').replace(/\s+/g,' ').trim();
}
function bindTreatmentSearch(form){
 const select=form.elements.title;
 const choices=[...select.options].filter(o=>o.value).map(o=>({value:o.value,label:o.textContent}));
 const wrapper=document.createElement('div');wrapper.className='ttt-search-combo';
 const input=document.createElement('input');input.type='search';input.autocomplete='off';input.placeholder='Écrire pour rechercher un traitement…';
 input.setAttribute('aria-label','Rechercher et sélectionner un traitement');input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','false');
 const list=document.createElement('div');list.className='ttt-search-results';list.setAttribute('role','listbox');list.hidden=true;
 list.id='ttt-search-'+Math.random().toString(36).slice(2);input.setAttribute('aria-controls',list.id);
 input.value=choices.find(o=>o.value===select.value)?.label||'';
 select.before(wrapper);wrapper.append(input,list);select.hidden=true;select.style.display='none';
 let filtered=[],active=-1;
 const close=()=>{list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;};
 const choose=option=>{
  select.value=option.value;input.value=option.label;select.dispatchEvent(new Event('change',{bubbles:true}));close();input.focus();
 };
 const mark=()=>{list.querySelectorAll('[role=option]').forEach((el,i)=>{el.classList.toggle('active',i===active);el.setAttribute('aria-selected',String(i===active));if(i===active){input.setAttribute('aria-activedescendant',el.id);el.scrollIntoView({block:'nearest'});}});};
 const draw=(all=false)=>{
  const query=all?'':treatmentSearchKey(input.value);
  filtered=choices.filter(o=>treatmentSearchKey(o.label).includes(query));active=-1;
  list.replaceChildren();
  if(!filtered.length){const empty=document.createElement('div');empty.className='ttt-search-empty';empty.textContent='Aucun traitement trouvé';list.append(empty);}
  filtered.forEach((option,i)=>{const button=document.createElement('button');button.type='button';button.setAttribute('role','option');button.setAttribute('aria-selected','false');button.id=list.id+'-'+i;button.textContent=option.label;
   button.addEventListener('pointerdown',event=>event.preventDefault());button.onclick=()=>choose(option);list.append(button);
  });
  list.hidden=false;input.setAttribute('aria-expanded','true');input.removeAttribute('aria-activedescendant');
 };
 input.addEventListener('focus',()=>draw(!!select.value));
 input.addEventListener('click',()=>{if(list.hidden)draw(!!select.value);});
 input.addEventListener('input',()=>{select.value='';draw();});
 input.addEventListener('keydown',event=>{
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
   event.preventDefault();if(list.hidden)draw(!!select.value);
   if(filtered.length){active=event.key==='ArrowDown'?(active+1)%filtered.length:active<0?filtered.length-1:(active-1+filtered.length)%filtered.length;mark();}
  }else if(event.key==='Enter'&&!list.hidden){event.preventDefault();if(filtered.length&&(active>=0||filtered.length===1))choose(filtered[active>=0?active:0]);}
  else if(event.key==='Escape'&&!list.hidden){event.preventDefault();event.stopPropagation();close();}
  else if(event.key==='Tab')close();
 });
 input.addEventListener('blur',()=>setTimeout(()=>{if(!wrapper.contains(document.activeElement))close();},0));
 form.closest('.overlay')?.addEventListener('pointerdown',event=>{if(!wrapper.contains(event.target))close();});
 if(!document.getElementById('ttt-search-style')){
  const style=document.createElement('style');style.id='ttt-search-style';style.textContent=`.ttt-search-combo{position:relative;width:100%}.ttt-search-combo>input{width:100%}.ttt-search-results{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:20;max-height:220px;overflow-y:auto;background:#fff;border:1px solid var(--line,#cbd5e1);border-radius:9px;box-shadow:0 6px 18px #0f2d4f22}.ttt-search-results[hidden]{display:none}.ttt-search-results button{display:block;width:100%;border:0;border-bottom:1px solid #edf1f5;background:#fff;padding:10px;text-align:left;font-size:14px;white-space:normal;overflow-wrap:anywhere}.ttt-search-results button:hover,.ttt-search-results button.active{background:var(--teal-tint,#d3ece9)}.ttt-search-empty{padding:12px;color:#64748b;font-size:13px}@media(max-width:820px){.ttt-search-results{max-height:32dvh}.ttt-search-results button{min-height:44px;font-size:15px}}`;document.head.append(style);
 }
}

async function treatmentForm(entry){
 let rows;try{rows=await getTreatmentCatalogue();}catch(error){toast(error.message,true);return;}
 const names=rows.map(r=>r.nom),matched=rows.find(r=>r.nom===entry?.title),stored=entry?tttDetails(entry):null;
 let plannedDays=stored?.jours??matched?.jours??6;
 const options=[['','— Choisir un traitement —'],...names.map(n=>[n,n])];
 if(entry?.title&&!names.includes(entry.title))options.push([entry.title,entry.title+' (traitement existant)']);
 const form=formModal({title:entry?'Modifier le traitement':'Ajouter un traitement',
   fields:[{name:'title',label:'Traitement',type:'select',options,required:true,full:true},{name:'date',label:'Date de début',type:'date',required:true,full:true},{name:'prises',label:'Prises planifiées par jour (0 = cases laissées vides)',type:'number',required:true,full:true},{name:'done',label:'Statut',type:'checkbox',hint:'Traitement arrêté',full:true},{name:'notes',label:'Remarques',type:'textarea',full:true}],
   values:{title:entry?.title||'',content:entry?.content||'',date:entry?.date||today(),prises:stored?.prises??matched?.prises??0,done:!!entry?.done,notes:entry?tttNotes(entry):''},
   extra:'<p class="ttt-note">Catalogue du service, géré dans Paramètres par l’administrateur et le modérateur. Vérifier le traitement, les unités et les prises avant validation. Les Δ de la fiche sont des prises planifiées, pas des administrations réalisées.</p>',
   onSubmit:async v=>{
     const takes=Number(v.prises),days=Number(plannedDays);
     if(!Number.isInteger(takes)||takes<0||takes>24||!Number.isInteger(days)||days<1||days>6)throw new Error('Vérifiez prises/jour (0–24) et jours de fiche (1–6).');
     const body={kind:'traitement',title:v.title,content:entry&&v.title===entry.title?entry.content||'':'',date:v.date,done:v.done,details:JSON.stringify({schema:'ttt-catalogue-v1',prises:takes,jours:days,notes:v.notes||''})};
     if(entry)await api('/api/entries/'+entry.id,{method:'PUT',body});else await api('/api/patients/'+S.patient.id+'/entries',{method:'POST',body});
     toast('Traitement enregistré');await refresh();
   },onDelete:entry?async()=>{await api('/api/entries/'+entry.id,{method:'DELETE'});await refresh();}:null
 });
 form.elements.title.onchange=()=>{
   const chosen=rows.find(r=>r.nom===form.elements.title.value);
   if(chosen){form.elements.prises.value=chosen.prises;plannedDays=chosen.jours??6;}
 };
 form.elements.prises.min='0';form.elements.prises.max='24';form.elements.prises.step='1';
 form.querySelector('.fgrid').style.gridTemplateColumns='minmax(0, 1fr)';
 bindTreatmentSearch(form);
}
function renderTreatmentTab(box,E,p){
 const list=[...(E.traitement||[])].sort(tttCompare);
 box.innerHTML=`<div class="panel"><div class="panel-head"><h3>Traitement</h3><div class="ttt-head-actions"><button class="btn" id="ttt-word" type="button" disabled>Fiche de traitement Word</button><button class="btn primary" data-add="traitement">+ Ajouter un traitement</button></div></div><div class="ttt-diseases"><label for="ttt-associated-diseases">Maladies associées</label><textarea id="ttt-associated-diseases" rows="1" maxlength="1000" placeholder="Ex. diabète, HTA…" disabled></textarea><button class="btn" type="button" id="ttt-save-diseases" disabled>Enregistrer</button></div><table class="tbl"><thead><tr><th>Statut</th><th>Traitement</th><th>Début</th></tr></thead><tbody>${list.map(t=>`<tr class="clickable" data-eid="traitement:${t.id}"><td><span class="chip ${t.done?'off':'on'}">${t.done?'Arrêté':'En cours'}</span></td><td><b>${esc(t.title)}</b>${tttNotes(t)?`<br><small>${esc(tttNotes(t))}</small>`:''}</td><td>${fmtDate(t.date)}</td></tr>`).join('')||'<tr><td colspan="3" class="empty">Aucun traitement</td></tr>'}</tbody></table></div>`;
 sortTreatmentTableWhenReady(box,E);
 bindTreatmentProfile(p.id,box);
}
async function bindTreatmentProfile(pid,box){
 const field=$('#ttt-associated-diseases',box),save=$('#ttt-save-diseases',box),word=$('#ttt-word',box);
 try{
   const p=await api('/api/patients/'+pid+'/ttt-profile');if(!box.isConnected||String(S.patient?.id)!==String(pid))return;
   field.value=p.associated_diseases||'';field.dataset.saved=field.value;field.disabled=false;save.disabled=false;word.disabled=false;
   const persist=async()=>{
     if(field.value!==field.dataset.saved){await api('/api/patients/'+pid+'/ttt-profile',{method:'PUT',body:{associated_diseases:field.value}});field.dataset.saved=field.value;}
   };
   save.onclick=async()=>{save.disabled=true;try{await persist();toast('Maladies associées enregistrées');}catch(e){toast(e.message,true);}finally{if(save.isConnected)save.disabled=false;}};
   word.onclick=async()=>{
     word.disabled=true;save.disabled=true;
     try{await persist();await previewTreatmentSheet(pid);}
     catch(e){toast(e.message,true);}
     finally{if(word.isConnected)word.disabled=false;if(save.isConnected)save.disabled=false;}
   };
 }catch(e){toast(e.message,true);if(field)field.placeholder='Impossible de charger les maladies associées';}
}


// OBSRV DOCUMENTS V1
let patientDocObjectUrl=null;
function releasePatientDocUrl(){if(patientDocObjectUrl){URL.revokeObjectURL(patientDocObjectUrl);patientDocObjectUrl=null;}}
function documentPanel(){return `<section class="panel obs-doc-panel"><div class="panel-head"><h3>Documents du patient</h3><button type="button" class="btn primary" id="upload-patient-doc">+ Importer</button></div><p class="obs-doc-note">Images, PDF et Word DOC/DOCX — 25 Mo maximum. Cliquez pour ouvrir l’aperçu.</p><div id="patient-doc-list"><div class="empty">Chargement…</div></div></section>`;}
function uploadPatientDocument(pid){
 formModal({title:'Importer un document',fields:[{name:'title',label:'Titre du document'},{name:'date',label:'Date du document',type:'date',required:true,default:today()},{name:'file',label:'Fichier',type:'file',accept:'.pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document',required:true}],
 onSubmit:async(v,form)=>{
   const file=form.elements.file.files[0];
   if(!file)throw new Error('Choisissez un document.');
   if(file.size>25*1024*1024)throw new Error('Le fichier dépasse 25 Mo.');
   const submit=form.querySelector('[type=submit]');if(submit)submit.disabled=true;
   try{
     const data=new FormData();data.append('file',file);data.append('title',v.title||file.name);data.append('date',v.date);
     await api('/api/patients/'+pid+'/documents',{method:'POST',body:data});
     toast('Document importé');await loadPatientDocuments(pid);
   }finally{if(submit)submit.disabled=false;}
 }});
}
async function loadPatientDocuments(pid){
 const list=$('#patient-doc-list');if(!list)return;
 const upload=$('#upload-patient-doc');if(upload)upload.onclick=()=>uploadPatientDocument(pid);
 try{
   const response=await api('/api/patients/'+pid+'/documents');
   if(!list.isConnected || String(S.patient?.id)!==String(pid))return;
   list.innerHTML=response.documents.length?response.documents.map(d=>`<article class="patient-doc-row"><button type="button" class="patient-doc-card" data-document-id="${d.id}"><span class="doc-format">${esc(d.extension.slice(1).toUpperCase())}</span><span><strong>${esc(d.title)}</strong><small>${fmtDate(d.document_date)} · ${Math.max(1,Math.round(d.size_bytes/1024))} Ko</small></span><span class="doc-open-label">Ouvrir</span></button><div class="patient-doc-actions"><button type="button" class="btn" data-doc-rename="${d.id}">Modifier le titre</button>${d.can_delete?`<button type="button" class="btn danger" data-doc-delete="${d.id}">Supprimer</button>`:'<span class="doc-delete-lock">Suppression réservée à l’administrateur après 24 h</span>'}</div></article>`).join(''):'<div class="empty">Aucun document importé</div>';
   const find=id=>response.documents.find(d=>String(d.id)===String(id));
   list.querySelectorAll('[data-document-id]').forEach(button=>button.onclick=()=>{const doc=find(button.dataset.documentId);if(doc)previewPatientDocument(pid,doc);});
   list.querySelectorAll('[data-doc-rename]').forEach(button=>button.onclick=()=>renamePatientDocument(pid,find(button.dataset.docRename)));
   list.querySelectorAll('[data-doc-delete]').forEach(button=>button.onclick=()=>deletePatientDocument(pid,find(button.dataset.docDelete),button));
 }catch(error){if(list.isConnected)list.innerHTML='<div class="empty">'+esc(error.message)+'</div>';}
}

async function patientDocumentResponse(path){
 const response=await fetch(API+path,{headers:{Authorization:'Bearer '+S.token},credentials:'same-origin'});
 if(response.status===401){logout(true);throw new Error('Session expirée.');}
 if(!response.ok){let message='Impossible d’ouvrir le document';try{message=(await response.json()).error||message;}catch{}throw new Error(message);}
 return response;
}
async function downloadPatientDocument(pid,doc,button){
 if(button)button.disabled=true;
 try{
   const response=await patientDocumentResponse('/api/patients/'+pid+'/documents/'+doc.id+'/original');
   const blob=await response.blob(),url=URL.createObjectURL(blob);
   const link=document.createElement('a');link.href=url;link.download=doc.original_name||doc.title||'document';
   document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
 }catch(error){toast(error.message,true);}finally{if(button)button.disabled=false;}
}
async function previewPatientDocument(pid,doc){
 if(doc.extension==='.doc'){await downloadPatientDocument(pid,doc);return;}
 releasePatientDocUrl();
 const overlay=modal(`<div class="dialog-head"><h2>${esc(doc.title)}</h2><div class="doc-preview-actions"><button type="button" class="btn" id="download-doc-original">Télécharger</button><button type="button" class="icon-btn" id="close-doc-preview" aria-label="Fermer">✕</button></div></div><div class="document-preview-content"><div class="empty">Ouverture du document…</div></div>`, 'document-preview-dialog');
 $('#close-doc-preview',overlay).onclick=closeModal;
 const download=$('#download-doc-original',overlay);download.onclick=()=>downloadPatientDocument(pid,doc,download);
 const container=$('.document-preview-content',overlay);
 try{
   if(doc.extension==='.pdf'){
     const info=await api('/api/patients/'+pid+'/documents/'+doc.id+'/pdf-info');
     if(!container.isConnected)return;
     if(!info.pages)throw new Error('Ce PDF ne contient aucune page.');
     container.innerHTML=`<div class="pdf-local-toolbar"><button type="button" class="btn" data-prev>Précédente</button><span data-page-label></span><button type="button" class="btn" data-next>Suivante</button><button type="button" class="btn" data-zoom-out>−</button><button type="button" class="btn" data-zoom-in>+</button><span data-zoom-label>100 %</span></div><div class="pdf-local-stage"><div class="empty">Chargement de la page…</div></div>`;
     const stage=$('.pdf-local-stage',container),prev=$('[data-prev]',container),next=$('[data-next]',container);
     let page=1,zoom=1,busy=false;
     const update=()=>{
       prev.disabled=busy||page<=1;next.disabled=busy||page>=info.pages;
       $('[data-page-label]',container).textContent='Page '+page+' / '+info.pages;
       $('[data-zoom-label]',container).textContent=Math.round(zoom*100)+' %';
       const image=$('img',stage);if(image)image.style.width=Math.round(zoom*100)+'%';
     };
     const show=async target=>{
       if(busy||!container.isConnected)return;busy=true;update();
       try{
         const response=await patientDocumentResponse('/api/patients/'+pid+'/documents/'+doc.id+'/pdf-page/'+target);
         const blob=await response.blob();if(!container.isConnected)return;
         releasePatientDocUrl();patientDocObjectUrl=URL.createObjectURL(blob);
         const image=document.createElement('img');image.className='pdf-local-image';image.alt=doc.title+' — page '+target;image.src=patientDocObjectUrl;
         stage.replaceChildren(image);page=target;
       }catch(error){if(container.isConnected)toast(error.message,true);}finally{busy=false;if(container.isConnected)update();}
     };
     prev.onclick=()=>show(page-1);next.onclick=()=>show(page+1);
     $('[data-zoom-out]',container).onclick=()=>{zoom=Math.max(.5,zoom-.25);update();};
     $('[data-zoom-in]',container).onclick=()=>{zoom=Math.min(3,zoom+.25);update();};
     await show(1);
   }else{
     const response=await patientDocumentResponse('/api/patients/'+pid+'/documents/'+doc.id+'/preview');
     const blob=await response.blob();if(!container.isConnected)return;
     patientDocObjectUrl=URL.createObjectURL(blob);
     if(['.png','.jpg','.jpeg','.gif','.webp'].includes(doc.extension)){
       const image=document.createElement('img');image.className='patient-doc-image';image.alt=doc.title;image.src=patientDocObjectUrl;container.replaceChildren(image);
     }else{
       const frame=document.createElement('iframe');frame.title=doc.title;frame.className='patient-doc-frame';frame.setAttribute('sandbox','');frame.src=patientDocObjectUrl;container.replaceChildren(frame);
     }
   }
 }catch(error){if(container.isConnected)container.innerHTML='<div class="empty">'+esc(error.message)+'</div>';}
}


// AUTRE HORS CINETIQUE V4
// CORRECTIF BILANS PAR DATE V3

function simpleDecode(e){try{const p=JSON.parse(e.details||'');return p?.schema==='bilan-simple-v2'&&p.values?p:null;}catch{return null;}}
function simpleNumeric(v,key){
  let s=String(v??'').trim().replace(',','.');
  if(['GB','Plq'].includes(key)&&/^\d+(?:\.\d+)?k$/i.test(s))return Number(s.slice(0,-1))*1000;
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s))return null;
  const n=Number(s);return Number.isFinite(n)?n:null;
}
function simpleResult(p,key){
  const raw=p.values[key]||'';if(!raw)return '<span class="lab-missing">—</span>';
  const r=p.references?.[key]||{}, n=simpleNumeric(raw,key);
  let suffix='',abnormal=false;
  if(n!==null&&r.active){
    abnormal=(r.min!==null&&r.min!==undefined&&n<r.min)||(r.max!==null&&r.max!==undefined&&(r.max_exclusive?n>=r.max:n>r.max));
    
  }
  const note=r.active?'Référence indicative : '+(r.min??'—')+' à '+(r.max??'—')+' '+(r.unit||'')+(r.note?' — '+r.note:''):(r.note||'Pas de référence automatique active pour ce paramètre ou ce profil.');
  return `<span class="${abnormal?'lab-abnormal':''}" title="${esc(note)}">${esc(raw+suffix)}</span>`;
}
function simpleDates(entries){
 const last=entries[entries.length-1]?.date||'';
 return entries.map((e,i)=>{
   const d=e.date||'';
   if(i===entries.length-1||d.length!==10)return fmtDate(d);
   if(d.slice(0,7)===last.slice(0,7))return d.slice(8,10);
   if(d.slice(0,4)===last.slice(0,4))return d.slice(8,10)+'/'+d.slice(5,7);
   return fmtDate(d);
 });
}

function simpleMergeDates(entries){
 const byDate=new Map();
 for(const e of labChronology(entries)){
   const p=simpleDecode(e);if(!p)continue;
   let merged=byDate.get(e.date);
   if(!merged){merged={...e,details:JSON.stringify({...p,values:{},references:{}})};byDate.set(e.date,merged);}
   const target=simpleDecode(merged);
   for(const [key,value]of Object.entries(p.values||{})){
     if(String(value??'').trim()){
       target.values[key]=key==='Autre'&&target.values[key]?target.values[key]+'\n\n'+value:value;
       if(p.references?.[key])target.references[key]=p.references[key];
     }
   }
   merged.id=e.id;merged.details=JSON.stringify(target);
 }
 return [...byDate.values()];
}

function labKinetic(entries){
 const simple=simpleMergeDates((entries||[]).filter(simpleDecode));
 const series=simple.filter(e=>Object.entries(simpleDecode(e).values).some(([key,value])=>key!=='Autre'&&!PUS_KEYS.has(key)&&String(value??'').trim()));
 const old=(entries||[]).filter(e=>!simpleDecode(e));
 const v1=old.filter(labDecode),text=old.filter(e=>!labDecode(e));
 let olderHtml=v1.length?labKineticV1(v1):'';
 let html='';
 olderHtml+=sortByDate(text).map(e=>`<div class="item" data-eid="bilan:${e.id}"><span class="k">${fmtDate(e.date)} :</span>\n${esc(e.content)}${meta(e)}</div>`).join('');
 if(series.length){
   const last=series[series.length-1];
   const dateHtml=simpleDates(series).map((label,i)=>i===series.length-1?`<span class="bilan-recent-yellow">${esc(label)}</span>`:esc(label)).join(' <span class="simple-arrow">→</span> ');
   html+=`<div class="item bilan-simple" data-eid="bilan:${last.id}"><div class="simple-dates">${dateHtml}</div>`;
   for(const [label,keys]of LAB_DISPLAY_GROUPS){
     if(keys.includes('Autre'))continue;
     if(!series.some(e=>keys.some(k=>simpleDecode(e).values[k])))continue;
     const values=series.map((e,i)=>{
       const p=simpleDecode(e);
       return keys.map(k=>{
         const rendered=simpleResult(p,k);
         return i===series.length-1&&p.values[k]?`<span class="bilan-recent-yellow">${rendered}</span>`:rendered;
       }).join('/');
     }).join(' <span class="simple-arrow">→</span> ');
     html+=`<div class="simple-line"><span class="simple-label">${esc(label)} :</span> ${values}</div>`;
   }
   html+='</div>';
 }
 const autres=simple.filter(e=>simpleDecode(e).values.Autre);
 if(autres.length){
   html+='<div class="simple-other-section">';
   for(const e of [...autres].reverse()){
     html+=`<div class="item" data-eid="bilan:${e.id}"><span class="k">Autre — ${esc(fmtDate(e.date))}</span><div style="white-space:pre-wrap;overflow-wrap:anywhere;margin-top:5px">${esc(simpleDecode(e).values.Autre)}</div></div>`;
   }
   html+='</div>';
 }
 return (html+olderHtml+pusLatestHtml(entries))||'<div class="empty">Aucun bilan</div>';
}
async function simpleBilanForm(entry){
 let cfg;try{cfg=await api('/api/bilans/reference');}catch(err){toast(err.message,true);return;}
 const p=entry?simpleDecode(entry):{values:{}};
 const references=p.references||cfg.parameters||{};
 const map=[];let index=0;
 const rows=labAccordionHtml(p.values,key=>{
   const n=index++;map.push([n,key]);const value=p.values[key]||'';
   const unit=references[key]?.unit||'',text=['ECBU','Autre',...PUS_KEYS].includes(key);
   const caption=(PUS_KEYS.has(key)?(key.endsWith('Prelevement')?'Type de prélèvement':'Résultat'):labInputLabel(key))+(unit?' ('+unit+')':'');
   return `<label class="simple-field ${text?'simple-field-text':''}">${esc(caption)}${text?`<textarea name="sv${n}" aria-label="${esc(caption)}">${esc(value)}</textarea>`:`<input name="sv${n}" inputmode="decimal" value="${esc(value)}" aria-label="${esc(caption)}" autocomplete="off">`}</label>`;
 });
 const samePatient=labChronology((S.entries.bilan||[]).filter(simpleDecode));
 const picker=entry?`<label class="simple-picker">Prélèvement à modifier<select id="simple-picker">${samePatient.map(e=>`<option value="${e.id}" ${e.id===entry.id?'selected':''}>${esc(fmtDate(e.date))} — n° ${e.id}</option>`).join('')}</select></label>`:'';
 const note=S.patient?.age==null||S.patient.age<(cfg.minimum_age||19)?'Âge absent ou hors profil adulte : pas de signalement automatique.':'Références indicatives adultes : la couleur ne remplace pas le compte rendu du laboratoire.';
 const form=formModal({title:entry?'Modifier le bilan':'Nouveau bilan',fields:[{name:'date',label:'Date du prélèvement',type:'date',required:true}],values:{date:entry?.date||today()},
   extra:picker+`<div class="simple-form">${rows}</div><p class="simple-note">${esc(note)} Recopier les valeurs dans les unités indiquées ; ne pas mélanger mmol/L, g/L ou mg/L. Les anciennes références enregistrées restent conservées.</p>`,
   onSubmit:async(v,form)=>{
     const values={};for(const[n,key]of map)values[key]=form.elements['sv'+n].value.trim();
     if(!Object.values(values).some(Boolean))throw new Error('Renseignez au moins un résultat.');
     const content=LAB_GROUPS.filter(([,keys])=>keys.some(k=>values[k])).map(([label,keys])=>label+' : '+keys.map(k=>values[k]||'—').join('/')).join('\n');
     const body={kind:'bilan',date:v.date,content,details:JSON.stringify({schema:'bilan-simple-v2',values})};
     const pid=S.patient.id;
     if(entry)await api('/api/entries/'+entry.id,{method:'PUT',body});
     else await api('/api/patients/'+pid+'/entries',{method:'POST',body});
     toast('Bilan enregistré');await refresh();
   },onDelete:entry?async()=>{await api('/api/entries/'+entry.id,{method:'DELETE'});await refresh();}:null
 });
 form.querySelector('#simple-picker')?.addEventListener('change',event=>{
    const e=samePatient.find(e=>String(e.id)===event.target.value);if(e){closeModal();simpleBilanForm(e);}
 });
 const dateGrid=form.querySelector('.fgrid');
 if(dateGrid)form.insertBefore(dateGrid,form.firstChild);
 form.closest('.dialog')?.classList.add('simple-bilan-dialog');
}



const LAB_GROUPS = [["Alb", ["Alb"]], ["GB", ["GB"]], ["Lymphocytes", ["Lymphocytes"]], ["Hb", ["Hb"]], ["Plq", ["Plq"]], ["TP", ["TP"]], ["CRP", ["CRP"]], ["Lipase", ["Lipase"]], ["BT/BD", ["BT", "BD"]], ["GGT/PAL", ["GGT", "PAL"]], ["ASAT/ALAT", ["ASAT", "ALAT"]], ["Urée/Créat", ["Uree", "Creat"]], ["Na/K", ["Na", "K"]], ["ECBU", ["ECBU"]], ["ACE", ["ACE"]], ["CA19-9", ["CA19-9"]], ["CA125", ["CA125"]], ["CA15-3", ["CA15-3"]], ["Bilan lipidique", ["Cholesterol", "HDL", "LDL", "Triglycerides"]], ["Ph/Ca", ["Ph", "Ca"]], ["Pus profond", ["PusProfondPrelevement", "PusProfondResultat"]], ["Pus superficiel", ["PusSuperficielPrelevement", "PusSuperficielResultat"]], ["Autre", ["Autre"]]];

const PUS_KINDS=[['Pus profond','PusProfondPrelevement','PusProfondResultat'],['Pus superficiel','PusSuperficielPrelevement','PusSuperficielResultat']];
const PUS_KEYS=new Set(PUS_KINDS.flatMap(([,a,b])=>[a,b]));
const LAB_FORM_SECTIONS=[['NFS',['GB','Lymphocytes','Hb','Plq']],['Hémostase',['TP']],['Biochimie',['Alb','CRP','Lipase','BT','BD','GGT','PAL','ASAT','ALAT','Uree','Creat','Na','K']],['Bilan lipidique',['Cholesterol','HDL','LDL','Triglycerides']],['Bilan phosphocalcique',['Ph','Ca']],['Microbiologie',['ECBU',...PUS_KEYS]],['Marqueurs tumoraux',['ACE','CA19-9','CA125','CA15-3']],['Autre',['Autre']]];
const LAB_DISPLAY_GROUPS=LAB_GROUPS.filter(([,keys])=>!keys.some(k=>PUS_KEYS.has(k))).flatMap(([label,keys])=>keys.some(k=>['Cholesterol','HDL','LDL','Triglycerides','Ph','Ca'].includes(k))?keys.map(key=>[{Cholesterol:'Cholestérol',Triglycerides:'Triglycérides'}[key]||key,[key]]):[[label,keys]]);
function labInputLabel(key){return LAB_FIELD_LABELS[key]||{Uree:'Urée',Creat:'Créatinine'}[key]||key;}
function labAccordionHtml(values,render){
 return LAB_FORM_SECTIONS.map(([label,keys],index)=>{
   const filled=keys.some(key=>String(typeof values[key]==='object'?values[key]?.value||'':values[key]??'').trim());
   const normal=keys.filter(k=>!PUS_KEYS.has(k)).map(render).join('');
   const pus=label==='Microbiologie'?PUS_KINDS.map(([name,type,result])=>`<div class="pus-form-pair"><div class="pus-form-pair-title">${esc(name)}</div><div class="pus-form-fields">${render(type)}${render(result)}</div></div>`).join(''):'';
   return `<details class="lab-section" ${filled||index===0?'open':''}><summary><span>${esc(label)}</span><span class="lab-section-chevron" aria-hidden="true">▸</span></summary><div class="lab-section-fields">${normal}${pus}</div></details>`;
 }).join('');
}
function pusLatestHtml(entries){
 const samples=[];
 for(const e of labChronology(entries||[])){
   const v2=simpleDecode(e),v1=labDecode(e);
   const values=v2?.values||(v1?Object.fromEntries(Object.entries(v1.values).map(([k,r])=>[k,r?.value||''])):null);
   if(values)samples.push({entry:e,values});
 }
 const rows=PUS_KINDS.map(([name,type,result])=>{
   const latest=[...samples].reverse().find(s=>String(s.values[type]||'').trim()||String(s.values[result]||'').trim());
   if(!latest)return '';
   return `<div class="pus-result-row" data-eid="bilan:${latest.entry.id}"><div class="pus-result-head"><strong>${esc(name)}</strong><small>${esc(fmtDate(latest.entry.date))}</small></div><div class="pus-result-fields"><span><small>Prélèvement</small>${latest.values[type]?esc(latest.values[type]):'<span class="lab-missing">—</span>'}</span><span><small>Résultat</small>${latest.values[result]?esc(latest.values[result]):'<span class="lab-missing">—</span>'}</span></div></div>`;
 }).join('');
 return rows?`<section class="item pus-results-box" aria-label="Résultats des prélèvements de pus">${rows}</section>`:'';
}
function clinicalCompactHtml(entries){
 let inserted=false;const drains=entries.filter(e=>e.category==='Drains'||drainDecode(e));
 return entries.map(c=>{
   if(c.category==='Drains'||drainDecode(c)){
     if(inserted)return '';inserted=true;
     return `<section class="item drains-compact-group"><div class="drains-compact-title">Drains</div>${drains.map(e=>drainDecode(e)?drainClinicalItem(e):`<div class="drain-series-row" data-eid="clinique:${e.id}">${esc(e.content)}</div>`).join('')}</section>`;
   }
   return `<div class="item center" data-eid="clinique:${c.id}"><span class="cat-tag">${esc(c.category)}</span><br>${c.category==='Gestes faits'?`<span data-postop-id="${c.id}">${esc(postOpLabel(c))}</span>`:esc(c.content)}<span class="meta">${fmtDate(c.date)}</span></div>`;
 }).join('');
}
function postopDetails(entry){try{const p=JSON.parse(entry?.details||'');return p?.schema==='postop-counter-v1'?p:null;}catch{return null;}}
function dayIndex(value){const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return null;const d=new Date(0);d.setUTCFullYear(+m[1],+m[2]-1,+m[3]);d.setUTCHours(0,0,0,0);return d.toISOString().slice(0,10)===value?d.getTime()/86400000:null;}
function postOpForm(entry=null){
 const p=postopDetails(entry),legacy=String(entry?.content||'').replace(/^\s*J\s*\d+\s*(?:post\s*)?/i,'').replace(/^post\s*/i,'').trim();
 const form=formModal({title:entry?'Modifier le geste fait':'Ajouter un geste fait',submit:'Enregistrer',
 fields:[{name:'date',label:'Date correspondant au J saisi',type:'date',required:true},{name:'base_j',label:'J à cette date',type:'number',required:true},{name:'gesture',label:'Geste fait',required:true,full:true}],
 values:{date:p?.base_date||entry?.date||today(),base_j:p?.base_j??0,gesture:p?.gesture||legacy},
 extra:'<p class="postop-preview" data-postop-preview></p><p class="simple-note">J augmente automatiquement chaque jour depuis la date choisie. Exemple : J0 post appendicectomie.</p>',
 onSubmit:async v=>{
   const base=Number(v.base_j),date=dayIndex(v.date),current=dayIndex(today()),gesture=String(v.gesture||'').trim().replace(/^J\s*\d+\s*(?:post\s*)?/i,'').replace(/^post\s*/i,'').trim();
   if(!Number.isInteger(base)||base<0||base>10000)throw new Error('J doit être un entier entre 0 et 10000.');
   if(date===null||date>current)throw new Error('Indiquez une date valide, non future.');
   if(!gesture)throw new Error('Précisez le geste fait.');
   const details={schema:'postop-counter-v1',base_j:base,base_date:v.date,gesture};
   const body={kind:'clinique',category:'Gestes faits',date:v.date,content:`J${base} post ${gesture}`,details:JSON.stringify(details)};
   if(entry)await api('/api/entries/'+entry.id,{method:'PUT',body});else await api(`/api/patients/${S.patient.id}/entries`,{method:'POST',body});
   await refresh();
 },onDelete:entry?async()=>{await api('/api/entries/'+entry.id,{method:'DELETE'});await refresh();}:null});
 form.elements.base_j.min='0';form.elements.base_j.step='1';
 const preview=()=>{const node=form.querySelector('[data-postop-preview]');if(node)node.textContent=`J${form.elements.base_j.value||0} post ${form.elements.gesture.value||'geste'}`;};
 ['base_j','gesture'].forEach(k=>form.elements[k].addEventListener('input',preview));preview();
}
function clinicalEntryChooser(){
 const ov=modal(`<div class="dialog-head"><h2>Ajouter un élément clinique</h2><button type="button" class="btn" data-close>Fermer</button></div><div class="dialog-body clinical-choice"><button type="button" class="btn" data-geste>Gestes faits</button><button type="button" class="btn" data-drains>Drains</button><button type="button" class="btn" data-constantes>Constantes</button><button type="button" class="btn" data-surveillance>Surveillance clinique</button></div>`,'form-dialog');
 ov.querySelector('[data-close]').onclick=closeModal;ov.querySelector('[data-geste]').onclick=()=>postOpForm();ov.querySelector('[data-drains]').onclick=()=>drainChooser();
 ov.querySelector('[data-constantes]').onclick=()=>entryForm('clinique',null,{category:'Constantes',clinicalGeneric:true});
 ov.querySelector('[data-surveillance]').onclick=()=>entryForm('clinique',null,{category:'Surveillance clinique',clinicalGeneric:true});
}

const LAB_MULTI = new Set(['Lipase','BT','BD','GGT','PAL','ASAT','ALAT']);
function labDecode(e) {
  try {const p=JSON.parse(e.details||'');return p?.schema==='bilan-v1' && p.values && typeof p.values==='object' ? p : null;}catch{return null;}
}
function labNumber(v) {
  const text=String(v??'').trim().replace(',','.');
  if(!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text))return null;
  const n=Number(text);return Number.isFinite(n)?n:null;
}
function labResult(row,key) {
  if(!row?.value)return '<span class="lab-missing">—</span>';
  const n=labNumber(row.value), lo=labNumber(row.min), hi=labNumber(row.max);
  const abnormal=!!row.unit && n!==null && ((lo!==null&&n<lo)||(hi!==null&&n>hi));
  let suffix='';
  
  return `<span class="${abnormal?'lab-abnormal':''}" title="${esc('Références : '+(row.min||'—')+' à '+(row.max||'—')+' '+(row.unit||''))}">${esc(row.value+suffix+(row.unit?' '+row.unit:''))}</span>`;
}
function labChronology(entries){return [...entries].sort((a,b)=>(a.date||'').localeCompare(b.date||'')||a.id-b.id);}
function labKineticV1(entries) {
  const all=labChronology(entries||[]), structured=all.filter(e=>labDecode(e)&&Object.entries(labDecode(e).values).some(([key,row])=>!PUS_KEYS.has(key)&&row?.value)), legacy=all.filter(e=>!labDecode(e));
  let html='';
  if(structured.length){
    html='<div class="lab-scroll"><table class="lab-kinetic"><thead><tr><th>Bilan</th>';
    structured.forEach((e,i)=>{html+=(i?'<th class="lab-arrow">→</th>':'')+`<th>${fmtDate(e.date)}<button type="button" class="lab-edit no-print" data-bilan-edit="${e.id}" aria-label="Modifier le bilan du ${esc(fmtDate(e.date))}" title="Modifier ce prélèvement">✎</button></th>`;});
    html+='</tr></thead><tbody>';
    for(const [label,keys] of LAB_DISPLAY_GROUPS){
      if(!structured.some(e=>keys.some(k=>labDecode(e).values[k]?.value)))continue;
      html+=`<tr><th>${esc(label)}</th>`;
      structured.forEach((e,i)=>{const p=labDecode(e);html+=(i?'<td class="lab-arrow">→</td>':'')+'<td>'+keys.map(k=>labResult(p.values[k],k)).join('<span class="lab-result-slash">/</span>')+'</td>';});
      html+='</tr>';
    }
    html+='</tbody></table></div><p class="lab-note">Valeurs anciennes → récentes. Références propres à chaque prélèvement. Unités affichées sans conversion.</p>';
  }
  if(legacy.length)html+='<details class="lab-legacy" '+(!structured.length?'open':'')+'><summary>Bilans anciens en texte libre ('+legacy.length+')</summary>'+legacy.map(e=>`<div class="item" data-eid="bilan:${e.id}"><span class="k">${fmtDate(e.date)} :</span><div style="white-space:pre-wrap">${esc(e.content)}</div></div>`).join('')+'</details>';
  return html||'<div class="empty">Aucun bilan</div>';
}
function bindLabTools(box){box.querySelectorAll('[data-bilan-edit]').forEach(b=>b.onclick=ev=>{ev.stopPropagation();const e=(S.entries.bilan||[]).find(e=>String(e.id)===b.dataset.bilanEdit);if(e)entryForm('bilan',e);});}
function structuredBilanForm(entry){
  const p=entry?labDecode(entry):{schema:'bilan-v1',values:{}};
  const fields=[{name:'date',label:'Date du prélèvement',type:'date',required:true}];
  let index=0;
  const mapping=[];
  const body=labAccordionHtml(p.values,key=>{
    const n=index++;mapping.push([n,key]);const row=p.values[key]||{},text=['ECBU','Autre',...PUS_KEYS].includes(key);
    const label=PUS_KEYS.has(key)?(key.endsWith('Prelevement')?'Type de prélèvement':'Résultat'):labInputLabel(key);
    return `<div class="lab-input-row ${text?'lab-text-field':''}"><label>${esc(label)}${text?`<textarea name="lv${n}" aria-label="${esc(label)}">${esc(row.value||'')}</textarea>`:`<input name="lv${n}" value="${esc(row.value||'')}" inputmode="decimal" aria-label="${esc(key)}">`}</label>${text?'':`<label>Unité<input name="lu${n}" value="${esc(row.unit||'')}" aria-label="Unité ${esc(key)}"></label><label>Norme min.<input name="ll${n}" value="${esc(row.min||'')}" inputmode="decimal" aria-label="Minimum ${esc(key)}"></label><label>Norme max.<input name="lh${n}" value="${esc(row.max||'')}" inputmode="decimal" aria-label="Maximum ${esc(key)}"></label>`}</div>`;
  });
  const form=formModal({title:entry?'Modifier le bilan':'Nouveau bilan',fields,values:{date:entry?.date||today()},
    extra:`${p.legacy_original?`<details><summary>Texte original — vérifier la conversion avant enregistrement</summary><pre style="white-space:pre-wrap">${esc(p.legacy_original)}</pre></details>`:''}<p class="lab-note">Renseignez les valeurs dans les unités du compte rendu. Les normes restent vides par défaut : sans référence, pas de coloration ni de multiples N. Pour un résultat non numérique (ex. &lt;5), aucune interprétation automatique. Les normes doivent être adaptées au laboratoire et au patient.</p><div class="lab-form-scroll lab-structured-accordions">${body}</div>`,
    onSubmit:async(v,form)=>{
      const values={};
      for(const [n,key] of mapping){
        const read=prefix=>form.elements[prefix+n]?.value.trim()||'';
        const row={value:read('lv'),unit:read('lu'),min:read('ll'),max:read('lh')};
        for(const name of ['min','max'])if(row[name]&&labNumber(row[name])===null)throw new Error('Référence invalide pour '+key);
        const lo=labNumber(row.min),hi=labNumber(row.max);
        if(lo!==null&&hi!==null&&lo>hi)throw new Error('Minimum supérieur au maximum pour '+key);
        if((row.min||row.max)&&!row.unit)throw new Error('Précisez l’unité pour '+key);
        values[key]=row;
      }
      if(!Object.values(values).some(r=>r.value))throw new Error('Renseignez au moins un résultat.');
      const content=LAB_GROUPS.filter(([,keys])=>keys.some(k=>values[k].value)).map(([label,keys])=>label+' : '+keys.map(k=>values[k].value||'—').join('/')).join('\n');
      const body={kind:'bilan',date:v.date,content,details:JSON.stringify({schema:'bilan-v1',values,...(p.legacy_original?{legacy_original:p.legacy_original}:{})})};
      if(entry)await api('/api/entries/'+entry.id,{method:'PUT',body});
      else await api('/api/patients/'+S.patient.id+'/entries',{method:'POST',body});
      toast('Bilan enregistré');await refresh();
    },
    onDelete:entry?async()=>{await api('/api/entries/'+entry.id,{method:'DELETE'});await refresh();}:null
  });
  form.closest('.dialog')?.classList.add('lab-dialog');
}


// COMPTEUR POSTOPERATOIRE AUTOMATIQUE
function postOpLabel(c) {
 const counter=postopDetails(c);
 if(counter){
   const start=dayIndex(counter.base_date),end=dayIndex(today());
   const j=Number(counter.base_j)+(start!==null&&end!==null?end-start:0);
   return `J${j} post ${counter.gesture}`;
 }

  if (c.category !== 'Gestes faits') return String(c.content || '');
  const dayNumber = value => {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const y=Number(match[1]), m=Number(match[2]), d=Number(match[3]);
    const t=new Date(0);t.setUTCFullYear(y,m-1,d);t.setUTCHours(0,0,0,0);
    if(t.getUTCFullYear()!==y || t.getUTCMonth()!==m-1 || t.getUTCDate()!==d)return null;
    return t.getTime()/86400000;
  };
  const start=dayNumber(c.date), end=dayNumber(today());
  if(start===null || end===null)return String(c.content || '') + ' — date du geste à renseigner';
  if(end<start)return String(c.content || '') + ' — geste prévu le ' + fmtDate(c.date);
  const text=String(c.content || '').replace(/^\s*J\s*\d+\s*(?:post\b\s*)?/i,'').replace(/^\s*post\b\s*/i,'').trim();
  return 'J' + Math.round(end-start) + ' post ' + text;
}
function refreshPostOpLabels(){
  if(!S.token || !S.entries)return;
  document.querySelectorAll('[data-postop-id]').forEach(el=>{
    const entry=(S.entries.clinique || []).find(c=>String(c.id)===el.dataset.postopId);
    if(entry)el.textContent=postOpLabel(entry);
  });
}
setInterval(refreshPostOpLabels,30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshPostOpLabels();});


async function downloadTableauWord() {
  const button = document.querySelector('[data-act="tableau"]');
  if (button) button.disabled = true;
  try {
    toast('Génération du tableau Word…');
    const response = await fetch(API + '/api/tableau/word', {headers:{Authorization:'Bearer ' + S.token}, credentials:'same-origin'});
    if (response.status === 401) {logout(true); throw new Error('Session expirée');}
    if (!response.ok) {
      let message = 'Impossible de générer le tableau';
      try {message = (await response.json()).error || message;} catch {}
      throw new Error(message);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const match = (response.headers.get('Content-Disposition') || '').match(/filename="?([^";]+)"?/);
    link.download = match ? match[1].trim() : 'Tableau_service.docx';
    document.body.appendChild(link);link.click();link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('Tableau Word téléchargé');
  } catch (error) {toast(error.message, true);}
  finally {if(button)button.disabled=false;}
}


// Base API : vide quand Flask sert le site ; remplacé par le proxy lors d'un déploiement de prévisualisation
const API = '__PORT_8000__'.startsWith('__') ? '' : '__PORT_8000__';

const S = { token: null, user: null, meta: null, patient: null, entries: null, expanded: new Set() };
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

// ------------------------------------------------------------------ utils
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let clock = {offset_minutes:0, epoch_ms:Date.now(), synced:performance.now()};
const clockDate = () => new Date(clock.epoch_ms + performance.now()-clock.synced + clock.offset_minutes*60000);
const today = () => clockDate().toISOString().slice(0,10);
async function syncClock() {clock={...await api('/api/clock'), synced:performance.now()};}
const fmtDate = (d) => { if (!d) return ''; const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : d; };
const fmtTs = (t) => { if (!t) return ''; const [d, h] = t.split(' '); return `${fmtDate(d)} ${h ? h.slice(0, 5) : ''}`; };
const bedLabel = (p) => p.room ? `${p.room}${p.position || ''}` : (p.hors_service ? 'Hors service' : '—');

function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = ''), 2600);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  let body = opts.body;
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const res = await fetch(API + path, { method: opts.method || 'GET', headers, body, credentials: 'same-origin' });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && path !== '/api/login') { logout(true); throw new Error(data.error || 'Session expirée'); }
  if (!res.ok) { const error = new Error(data.error || `Erreur ${res.status}`); error.status = res.status; error.data = data; throw error; }
  return data;
}

// ------------------------------------------------------------------ icons
const I = {
  menu: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  logout: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
  cross: '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" rx="2"/></svg>',
  bed: (s = 28) => `<svg width="${s}" height="${s * .75}" viewBox="0 0 32 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18M3 15h26v6M29 15v-3a3 3 0 0 0-3-3H14v6"/><circle cx="8.5" cy="10" r="2.3"/></svg>`,
  bigBed: '<svg width="124" height="90" viewBox="0 0 124 90" fill="none"><rect x="4" y="6" width="7" height="80" rx="3" fill="#1d62a0"/><rect x="113" y="50" width="7" height="36" rx="3" fill="#1d62a0"/><rect x="4" y="54" width="116" height="8" rx="3" fill="#1d62a0"/><circle cx="30" cy="31" r="10" fill="#1d62a0"/><rect x="16" y="42" width="30" height="10" rx="4" fill="#7ac4bf"/><path d="M50 30h52a14 14 0 0 1 14 14v8H50z" fill="#1d62a0"/></svg>',
  folder: '<svg width="44" height="40" viewBox="0 0 24 22" fill="none" stroke="#1b2b3c" stroke-width="1.6" stroke-linejoin="round"><path d="M2 5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v2"/><path d="M2 5v13a1 1 0 0 0 1 1h16l3-9H6l-3 8"/></svg>',
  hosp: '<svg width="36" height="32" viewBox="0 0 36 32" fill="none" stroke="#1d4673" stroke-width="2.2" stroke-linejoin="round"><path d="M4 30V12L18 3l14 9v18z"/><path d="M18 9v8M14 13h8" stroke-linecap="round"/><path d="M8 30v-6h20v6M8 24h20" /></svg>',
  plus: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M12 4v16M4 12h16"/></svg>',
  search: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  chev: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#9fb0c4" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>',
  down: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16M6 14l6 6 6-6"/></svg>',
  up: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V4M6 10l6-6 6 6"/></svg>',
  arrL: '<svg viewBox="0 0 52 30" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M50 15H4M16 3L4 15l12 12"/></svg>',
  arrR: '<svg viewBox="0 0 52 30" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 15h46M36 3l12 12-12 12"/></svg>',
  arrU: '<svg viewBox="0 0 30 52" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 50V4M3 16L15 4l12 12"/></svg>',
};

// ------------------------------------------------------------------ auth
function logout(silent) {
  if (S.token && !silent) api('/api/logout', { method: 'POST' }).catch(() => {});
  S.token = null; S.user = null; S.meta = null; S.patient = null; S.entries = null; store.set('cva_token', null);
  closeModal(); location.hash = '#/login'; render();
}

function viewLogin() {
  $('#app').innerHTML = `
  <main class="login">
    <img src="./static/logo.png" alt="Chirurgie Viscérale A — CHU Oujda" width="657" height="259">
    <section class="login-card" aria-labelledby="lg">
      <h1 id="lg">LOGIN</h1>
      <form id="login-form" autocomplete="on">
        <input class="pill" name="username" placeholder="Username" aria-label="Nom d'utilisateur" autocomplete="username" required>
        <input class="pill" name="password" type="password" placeholder="Password" aria-label="Mot de passe" autocomplete="current-password" required>
        <div class="login-err" id="login-err"></div>
        <button class="btn-login" type="submit">LOG IN</button>
      </form>
    </section>
    
  </main>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    $('#login-err').textContent = '';
    try {
      const r = await api('/api/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
      S.token = r.token; S.user = r.user; store.set('cva_token', r.token);
      location.hash = '#/home';
    } catch (err) { $('#login-err').textContent = err.message; }
  });
}

// ------------------------------------------------------------------ chrome
function topbar() {
  return `
  <header class="topbar no-print">
    <div class="left">
      <button class="icon-btn" id="menu-btn" aria-label="Menu">${I.menu}</button>
      <span class="clock" id="clock"></span>
    </div>
    <h1>Chirurgie viscérale A</h1>
    <div class="right">
      <button class="icon-btn m-only" id="search-toggle" aria-label="Rechercher un patient" aria-expanded="false">${I.search}</button>
      <div class="search-box">
        <input id="search" type="search" placeholder="Nom, IP ou motif" aria-label="Rechercher un patient" autocomplete="off">
        <div class="search-res hidden" id="search-res"></div>
      </div>
      <span class="username">${esc(S.user?.username || '')}</span>
      <button class="icon-btn" id="logout-btn" aria-label="Se déconnecter" title="Se déconnecter">${I.logout}</button>
    </div>
  </header>
  <nav class="menu-panel" id="menu">
    <div class="menu-user m-only"><b>${esc(S.user?.username || '')}</b><span id="menu-clock"></span></div>
    <button data-go="#/urgences" class="menu-urgences">Urgences viscérales</button>
    <button data-go="#/home">Plan du service</button>
    <button data-act="tableau">Tableau de Visite</button>
    <button data-act="admit">Admettre un patient</button>
    <button data-act="hs">Dossiers hors service</button>
    <button data-go="#/archives">Patients sortis (archives)</button>
    <button data-go="#/patients-a-staffer">Patients à staffer</button>
    ${S.user?.role === 'admin' ? '<div class="sep"></div><button data-go="#/cro-admin">Statistiques</button><button data-go="#/parametres">Paramètres</button><button data-go="#/users">Utilisateurs</button><button data-go="#/journal">Journal global</button><button data-act="clock">Date et heure</button>'
      : S.user?.role === 'moderateur' ? '<div class="sep"></div><button data-go="#/cro-admin">Statistiques</button><button data-go="#/parametres">Paramètres</button><button data-go="#/users">Utilisateurs</button><button data-go="#/journal">Journal global</button><button data-act="profile">Mon compte</button>'
      : '<button data-go="#/statistiques">Statistiques</button>'}
    <div class="sep"></div>
<button data-act="logout">Se déconnecter</button>
  </nav>
  <div class="menu-backdrop" aria-hidden="true"></div>`;
}

// MOBILE V6 : recherche repliable, plan vertical, consignes repliables, tableaux en cartes
const MOBILE_PLAN = window.matchMedia('(max-width: 900px), (pointer: coarse) and (max-height: 500px)');
const MOBILE_PHONE = window.matchMedia('(max-width: 820px), (pointer: coarse) and (max-height: 500px)');
function mobileSearch(open) {
  const tb = $('.topbar'); if (!tb) return;
  tb.classList.toggle('searching', !!open);
  $('#search-toggle')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) setTimeout(() => $('#search')?.focus(), 30);
}
function labelTables(root) {
  (root || document).querySelectorAll('table.tbl:not(.cro-matrix)').forEach(t => {
    const heads = [...t.querySelectorAll('thead th')].map(th => th.textContent.trim());
    if (!heads.length) return;
    t.classList.add('m-cards');
    t.querySelectorAll('tbody tr').forEach(tr => {
      [...tr.children].forEach((td, i) => { if (td.tagName === 'TD' && !td.hasAttribute('data-label') && !td.hasAttribute('colspan')) td.setAttribute('data-label', heads[i] || ''); });
    });
  });
}
(function watchTables() {
  let queued = false;
  const run = () => { queued = false; labelTables(document); };
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(run); } }).observe(document.documentElement, { childList: true, subtree: true });
})();
MOBILE_PLAN.addEventListener('change', () => { if ($('#map') && !$('#modal-root .overlay')) viewHome(); });

function bindChrome() {
  if(!isStaff())document.querySelectorAll('[data-go="#/journal"]').forEach(button=>button.remove());
  const tick = () => { const c = $('#clock'), mc = $('#menu-clock'); if (!c && !mc) return; const d = clockDate(); const txt = `${d.toLocaleDateString('fr-FR',{timeZone:'UTC'})}   ${d.toLocaleTimeString('fr-FR', {timeZone:'UTC', hour:'2-digit', minute:'2-digit'})} UTC${clock.offset_minutes ? ' (corrigé)' : ''}`; if (c) c.textContent = txt; if (mc) mc.textContent = txt; };
  tick(); clearInterval(bindChrome._i); bindChrome._i = setInterval(tick, 15000);
  $('#logout-btn').onclick = () => logout();
  const menu = $('#menu');
  $('#menu-btn').onclick = (e) => { e.stopPropagation(); mobileSearch(false); menu.classList.toggle('open'); };
  document.onclick = (e) => {
    if (!menu.contains(e.target)) menu.classList.remove('open');
    if (!e.target.closest('.search-box')) $('#search-res')?.classList.add('hidden');
    if (!e.target.closest('.search-box') && !e.target.closest('#search-toggle')) mobileSearch(false);
  };
  const st = $('#search-toggle');
  if (st) st.onclick = (e) => { e.stopPropagation(); menu.classList.remove('open'); mobileSearch(!$('.topbar').classList.contains('searching')); };
  menu.querySelectorAll('button').forEach(b => b.onclick = () => {
    menu.classList.remove('open');
    if (b.dataset.go) location.hash = b.dataset.go;
    if (b.dataset.act === 'admit') admitForm({});
    if (b.dataset.act === 'hs') openHorsService();
    if (b.dataset.act === 'logout') logout();
    if (b.dataset.act === 'tableau') downloadTableauWord();
    if (b.dataset.act === 'profile') profileForm();
    if (b.dataset.act === 'clock') clockForm();
  });
  const inp = $('#search'), res = $('#search-res');
  let t;
  inp.oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = inp.value.trim();
      if (q.length < 2) { res.classList.add('hidden'); return; }
      let r;
      try { r = await api('/api/search?q=' + encodeURIComponent(q)); } catch (ex) { res.innerHTML = '<div class="empty">' + esc(ex.message) + '</div>'; res.classList.remove('hidden'); return; }
      if (inp.value.trim() !== q) return;
      // Recherche sur toute la plateforme : hospitalisés, sortis (archives) et patients des urgences visibles.
      const hosp = r.patients.filter(p => p.status !== 'sorti'), sortis = r.patients.filter(p => p.status === 'sorti'), urg = r.urgences || [];
      const row = (p) => `<button data-id="${p.id}"><b>${esc(p.nom)} ${esc(p.prenom || '')}</b> <small>IP ${esc(p.ip)}${p.cin ? ' · CIN ' + esc(p.cin) : ''} · ${p.status === 'sorti' ? 'Sorti' + (p.sortie_date ? ' le ' + esc(fmtDate(p.sortie_date)) : '') : esc(bedLabel(p))}</small><br><small>${esc(p.motif || '')}</small></button>`;
      const urow = (u) => `<button data-urg="${u.id}"><b>${esc(u.nom)}</b> <small>${u.age != null ? esc(u.age) + ' ans · ' : ''}Urgences · ${esc(u.zone_label || u.zone)}</small><br><small>${esc(u.motif || 'Motif non renseigné')}</small></button>`;
      const group = (label, items, fn) => items.length ? `<div class="search-group">${label} (${items.length})</div>` + items.map(fn).join('') : '';
      res.innerHTML = (hosp.length || sortis.length || urg.length)
        ? group('Hospitalisés', hosp, row) + group('Urgences', urg, urow) + group('Sortis / archives', sortis, row)
        : '<div class="empty">Aucun résultat</div>';
      res.classList.remove('hidden');
      res.querySelectorAll('button[data-id]').forEach(b => b.onclick = () => { res.classList.add('hidden'); inp.value = ''; mobileSearch(false); location.hash = `#/patient/${b.dataset.id}/maj`; });
      res.querySelectorAll('button[data-urg]').forEach(b => b.onclick = async () => {
        res.classList.add('hidden'); inp.value = ''; mobileSearch(false);
        const id = +b.dataset.urg;
        if (!location.hash.startsWith('#/urgences')) { location.hash = '#/urgences'; await new Promise(r => setTimeout(r, 400)); }
        if (!URG.data) { try { await urgLoad(); } catch {} }
        urgOpenPatient(id);
      });
    }, 220);
  };
}

// ------------------------------------------------------------------ home
const LAYOUT = { tl: ['213', '212', '211', '210'], tr: ['209', '208', '207', '206'], bl: ['214', '215', '216', '217', '218'], br: ['201', '202', '203', '204', '205'] };

// CONSIGNES PLAN V4.5
function pendingConsignesBadge(value){
 const n=Math.max(0,Math.trunc(Number(value)||0));
 return n?`<span class="pending-consignes-badge" title="${n} consigne(s) non validée(s)" aria-label="${n} consigne(s) non validée(s)">${n}</span>`:'';
}


// PLAN V8 — lits directs, identité et motif, chambres face à face.
const PLAN_DISABLED = new Set(['201', '218']);
const PLAN_SINGLE = new Set(['201', '202', '203', '213', '218']);
function planPositions(n, mobile = false, side = '') {
  if (PLAN_SINGLE.has(String(n))) return ['F'];
  const first = mobile ? side === 'left' : Number(n) >= 206 && Number(n) <= 213;
  return first ? ['F', 'P'] : ['P', 'F'];
}
function planRoom(n, data, mobile = false, side = '') {
  const disabled = PLAN_DISABLED.has(String(n)), single = PLAN_SINGLE.has(String(n));
  const buttons = planPositions(n, mobile, side).map(pos => {
    const patient = single ? data.beds.F || data.beds.P : data.beds[pos];
    const label = single ? 'Lit unique' : pos === 'F' ? 'Fenêtre' : 'Porte';
    const identity = patient ? `${patient.nom || ''} ${patient.prenom || ''}`.trim() : '';
    const motif = patient ? patientMotifLabel(patient) : '';
    const detail = patient ? `${identity} — IP ${patient.ip} — ${motif}` : 'Lit libre — admettre';
    if(disabled) return `<button type="button" class="plan-bed" disabled aria-label="Chambre ${n}, indisponible"></button>`;
    return `<button type="button" class="plan-bed ${patient ? 'occupied' : ''}" data-plan-room="${n}" data-plan-pos="${pos}" title="${esc(detail)}" aria-label="Chambre ${n}, ${label}, ${esc(detail)}">
      ${pendingConsignesBadge(patient?.pending_consignes)}<span class="plan-bed-label">${I.bed(19)}${label}</span>
      ${patient ? `<span class="plan-identity">${esc(identity)}</span><span class="plan-motif">${esc(motif)}</span>` : '<span class="plan-free">Libre</span>'}</button>`;
  }).join('');
  return `<div class="room plan-room ${mobile ? 'vroom' : ''} ${disabled ? 'unavailable' : ''}" role="group" aria-label="Chambre ${n}"><span class="plan-number">CH ${n}</span><div class="plan-beds">${buttons}</div></div>`;
}
function bindPlanBeds(by) {
  $('#map').querySelectorAll('[data-plan-room]:not(:disabled)').forEach(button => button.onclick = () => {
    const n = button.dataset.planRoom, pos = button.dataset.planPos;
    if (PLAN_DISABLED.has(n)) return;
    const beds = by[n].beds, patient = PLAN_SINGLE.has(n) ? beds.F || beds.P : beds[pos];
    if (patient) location.hash = `#/patient/${patient.id}/maj`;
    else admitForm({room: n, position: pos});
  });
}
async function viewHome() {
  $('#app').innerHTML = topbar() + `<main class="home"><div class="map plan-v8" id="map"><div class="empty">Chargement du plan…</div></div></main>`;
  bindChrome();
  const r = await api('/api/rooms');
  if(!$('#map')) return;
  const by = Object.fromEntries(r.rooms.map(x => [x.room, x]));
  const conflicts = r.rooms.filter(x => PLAN_SINGLE.has(String(x.room)) && x.beds.F && x.beds.P);
  if (conflicts.length) {
    const note = document.createElement('div'); note.className = 'plan-conflicts';
    note.innerHTML = 'Anciens emplacements à régulariser (aucun dossier supprimé) : ' + conflicts.map(x => `CH ${x.room} : ` + [x.beds.F, x.beds.P].map(p => `<a href="#/patient/${p.id}/maj">${esc(p.nom)} ${esc(p.prenom)}</a>`).join(' / ')).join(' ; ');
    $('.home').prepend(note);
  }
  const hs = mobile => `<button class="hs-table ${mobile?'vhs':''}" id="hs-btn" aria-label="Dossiers hors service"><div class="tbl">${I.folder}${r.hors_service_count?`<span class="badge">${r.hors_service_count}</span>`:''}</div><span>Hors service</span></button>`;
  const legend = `<div class="legend"><span><b style="background:var(--teal-tint)"></b>Lit occupé</span><span><b style="background:#f3f5f9"></b>Lit libre</span></div>`;
  if (MOBILE_PLAN.matches) {
    const available = r.rooms.filter(x => !PLAN_DISABLED.has(String(x.room)));
    const capacity = available.reduce((n,x) => n + (PLAN_SINGLE.has(String(x.room)) ? 1 : 2), 0);
    const occupied = available.reduce((n,x) => n + (PLAN_SINGLE.has(String(x.room)) ? Number(!!(x.beds.F || x.beds.P)) : Number(!!x.beds.F) + Number(!!x.beds.P)), 0);
    const left = ['214','215','216','217','218','entry','201','202','203','204','205'];
    const right = ['213','212','211','210',null,'hs',null,'209','208','207','206'];
    const cell = (n,side) => n==='entry' ? `<div class="ventry"><span>Entrée</span>${I.arrL}</div>` : n==='hs' ? hs(true) : n ? planRoom(n,by[n],true,side) : '<div class="plan-spacer" aria-hidden="true"></div>';
    $('#map').classList.add('vmap');
    $('#map').innerHTML = `<div class="vplan-summary"><span><b>${occupied}</b>/${capacity} lits occupés</span></div><div class="vplan paired-plan">${left.map((n,i)=>`${cell(n,'left')}<div class="paired-corridor" aria-hidden="true">${i===5?I.arrU:''}</div>${cell(right[i],'right')}`).join('')}</div>${legend}`;
  } else {
    const cells = arr => arr.map(n=>n?planRoom(n,by[n]):'<div class="plan-spacer" aria-hidden="true"></div>').join('');
    $('#map').innerHTML = `<section class="wing top"><div class="rooms">${cells(['213','212','211','210',null])}</div>${hs(false)}<div class="rooms">${cells([null,'209','208','207','206'])}</div></section><div class="corridor-h" aria-hidden="true">${I.arrL}${I.arrR}</div><section class="bottom"><div class="rooms">${cells(LAYOUT.bl)}</div><div class="corridor-v" aria-hidden="true">${I.arrU}</div><div class="rooms">${cells(LAYOUT.br)}</div></section>${legend}`;
  }
  bindPlanBeds(by); $('#hs-btn').onclick = openHorsService;
}

// ------------------------------------------------------------------ modals
function closeModal() { stopImagingPlayer(); releasePatientDocUrl(); $('#modal-root').innerHTML = ''; document.onkeydown = null; }
function modal(html, cls = '') {
  $('#modal-root').innerHTML = `<div class="overlay" id="ov"><div class="dialog ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
  const ov = $('#ov');
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeModal(); });
  document.onkeydown = (e) => { if (e.key === 'Escape') closeModal(); };
  return ov;
}

function bedCard(p, label, isLoc, emptyAction) {
  if (!p) return `<button class="bed empty" data-empty="${esc(emptyAction)}">
      <div class="bed-ico">${label ? `<b>${esc(label)}</b>` : ''}${I.bigBed}</div>
      <div class="bed-info">Lit libre<br><small>Cliquer pour admettre un patient</small></div>
      <div class="bed-go"><div class="row">${I.plus}</div>Admettre</div></button>`;
  return `<button class="bed" data-pid="${p.id}">${pendingConsignesBadge(p.pending_consignes)}
      <div class="bed-ico ${isLoc ? 'loc' : ''}">${isLoc ? esc(label) : `<b>${esc(label)}</b>${I.bigBed}`}</div>
      <div class="bed-info">Patient : ${esc(p.nom)} ${esc(p.prenom)}<br>IP : ${esc(p.ip)}<br>Motif : ${esc(patientMotifLabel(p))}</div>
      <div class="bed-go"><div class="row">${I.bed(58)}${I.chev}</div>Cliquer pour voir<br>la fiche</div></button>`;
}

function bindBeds(ov) {
  ov.querySelectorAll('.bed[data-pid]').forEach(b => b.onclick = () => { closeModal(); location.hash = `#/patient/${b.dataset.pid}/maj`; });
  ov.querySelectorAll('.bed[data-empty]').forEach(b => b.onclick = () => {
    const [room, position] = b.dataset.empty.split('|');
    room === 'HS' ? admitForm({ hors_service: ' ' }) : admitForm({ room, position });
  });
  ov.querySelector('.btn-back').onclick = closeModal;
}

function openRoom(n, data) {
  const swapLink = (p) => p ? `<button type="button" class="btn swap-bed-link" data-swap="${p.id}">⇄ Déplacer / échanger ${esc(p.nom)}</button>` : '';
  const ov = modal(`
    <div class="dialog-head"><div><h2>CHAMBRE ${esc(n)} ${I.hosp}</h2><p>Détails de la chambre</p></div>
      <button class="btn-back">&lt; Retour à l'accueil</button></div>
    <div class="dialog-body">${bedCard(data.beds.F, 'F', false, `${n}|F`)}${bedCard(data.beds.P, 'P', false, `${n}|P`)}</div>
    ${data.beds.F || data.beds.P ? `<div class="room-actions">${swapLink(data.beds.F)}${swapLink(data.beds.P)}</div>` : ''}`);
  bindBeds(ov);
  ov.querySelectorAll('[data-swap]').forEach(b => b.onclick = () => {
    const p = [data.beds.F, data.beds.P].find(x => x && String(x.id) === b.dataset.swap);
    if (p) swapBedForm(p, () => { closeModal(); viewHome(); });
  });
}

async function openHorsService() {
  const r = await api('/api/hors-service');
  const ov = modal(`
    <div class="dialog-head"><div><h2>Hors Service ${I.hosp}</h2><p>Patients hébergés dans d'autres services</p></div>
      <button class="btn-back">&lt; Retour à l'accueil</button></div>
    <div class="dialog-body">${r.patients.map(p => bedCard(p, p.hors_service, true)).join('') || '<div class="empty">Aucun patient hors service.</div>'}
      ${bedCard(null, '', false, 'HS|')}</div>`);
  bindBeds(ov);
}

/* Formulaire générique : fields = [{name,label,type,options,full,required,placeholder}] */
function formModal({ title, fields, values = {}, submit = 'Enregistrer', onSubmit, onDelete, extra = '' }) {
  const fld = (f) => {
    const v = values[f.name] ?? f.default ?? '';
    let input;
    if (f.type === 'textarea') input = `<textarea name="${f.name}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''}>${esc(v)}</textarea>`;
    else if (f.type === 'select') input = `<select name="${f.name}" ${f.required ? 'required' : ''}>${f.options.map(o => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''} ${f.name === 'room' && PLAN_DISABLED.has(String(val)) && String(val) !== String(v) ? 'disabled' : ''}>${esc(lab)}</option>`; }).join('')}</select>`;
    else if (f.type === 'datalist') input = `<input name="${f.name}" list="dl-${f.name}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''}><datalist id="dl-${f.name}">${f.options.map(o => `<option value="${esc(o)}">`).join('')}</datalist>`;
    else if (f.type === 'checkbox') input = `<label style="display:flex;gap:8px;align-items:center;text-transform:none;font-size:15px;color:var(--ink);font-weight:500"><input type="checkbox" name="${f.name}" style="width:auto" ${v ? 'checked' : ''}> ${esc(f.hint || '')}</label>`;
    else if (f.type === 'file') input = `<input type="file" name="${f.name}" accept="${esc(f.accept || '')}">`;
    else input = `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''}>`;
    return `<div class="field ${f.full ? 'full' : ''}" data-f="${f.name}"><label>${esc(f.label)}</label>${input}</div>`;
  };
  const ov = modal(`
    <div class="dialog-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Fermer">✕</button></div>
    <form class="dialog-body" id="mform" novalidate>
      ${extra}
      <div class="fgrid">${fields.map(fld).join('')}</div>
      <div class="form-err" id="ferr"></div>
      <div class="form-actions">
        ${onDelete ? '<button type="button" class="btn danger" data-del>Supprimer</button>' : ''}
        <div class="r"><button type="button" class="btn" data-close>Annuler</button><button class="btn primary" type="submit">${esc(submit)}</button></div>
      </div>
    </form>`, 'form-dialog');
  ov.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
  const form = $('#mform');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const out = {};
    fields.forEach(f => {
      const el = form.elements[f.name];
      if (!el) return;
      out[f.name] = f.type === 'checkbox' ? el.checked : f.type === 'file' ? el.files[0] : el.value;
    });
    const miss = fields.find(f => f.required && !String(out[f.name] ?? '').trim());
    if (miss) { $('#ferr').textContent = `Champ obligatoire : ${miss.label}`; return; }
    try { await onSubmit(out, form); closeModal(); } catch (err) { $('#ferr').textContent = err.message; }
  };
  if (onDelete) ov.querySelector('[data-del]').onclick = async () => {
    if (!confirm('Confirmer la suppression ?')) return;
    try { await onDelete(); closeModal(); } catch (err) { $('#ferr').textContent = err.message; }
  };
  if (!MOBILE_PHONE.matches) setTimeout(() => form.querySelector('input:not([type=checkbox]),textarea,select')?.focus(), 50);
  return form;
}

// Emplacement : chambre+lit ou hors service
function locationFields(meta) {
  return [
    { name: 'loc_type', label: 'Emplacement', type: 'select', options: [['room', 'Chambre du service'], ['hs', 'Hors service (hébergé ailleurs)']] },
    { name: 'room', label: 'Chambre', type: 'select', options: [['', '—'], ...meta.rooms.map(r => [r, 'CH ' + r])] },
    { name: 'position', label: 'Lit', type: 'select', options: [['', '—'], ['F', 'F — côté fenêtre'], ['P', 'P — côté porte']] },
    { name: 'hors_service', label: 'Service d\'hébergement', type: 'datalist', full: true, placeholder: 'ex. Service Réanimation Brûlés BOX 2', options: ['Service Réanimation Brûlés', 'Service HGE', 'Réanimation chirurgicale', 'Réanimation médicale', 'Urgences', 'Cardiologie', 'Néphrologie'] },
  ];
}
function bindLocToggle(form, {existingId=null}={}) {
  const room = form.elements.room, position = form.elements.position, locationType = form.elements.loc_type;
  const ownId = existingId == null ? null : String(existingId);
  const originalRoom = room.value, originalPosition = position.value;
  let rows = null, loading = true;
  const occupied = (r,pos) => {
    const row = (rows || []).find(x => String(x.room) === String(r));
    const patient = row?.beds?.[pos];
    return !!patient && (ownId == null || String(patient.id) !== ownId);
  };
  const ownCurrent = r => ownId != null && String(r) === originalRoom;
  const freePositions = r => {
    if(!r) return [];
    if(PLAN_DISABLED.has(String(r)) && !ownCurrent(r)) return [];
    if(PLAN_SINGLE.has(String(r))) {
      return occupied(r,'F') || occupied(r,'P') ? [] : ['F'];
    }
    return ['F','P'].filter(pos => !occupied(r,pos));
  };
  const sync = () => {
    const hs = locationType.value === 'hs';
    ['room','position'].forEach(n => form.querySelector('[data-f='+n+']')?.classList.toggle('hidden',hs));
    form.querySelector('[data-f=hors_service]')?.classList.toggle('hidden',!hs);
    room.disabled = loading || hs; position.disabled = loading || hs;
    for(const option of room.options) {
      if(!option.value) continue;
      const unavailable = PLAN_DISABLED.has(String(option.value)) && !ownCurrent(option.value);
      const full = rows !== null && !freePositions(option.value).length;
      option.disabled = loading || unavailable || full;
      option.textContent = 'CH '+option.value+(unavailable?' — indisponible':full?' — occupée':'');
    }
    const selected = [...room.options].find(o => o.value === room.value);
    if(selected?.disabled && !loading) room.value = '';
    const free = rows === null ? [] : freePositions(room.value);
    for(const option of position.options) {
      if(!option.value) continue;
      option.disabled = loading || !free.includes(option.value);
      const label = option.value === 'F' ? (PLAN_SINGLE.has(room.value) ? 'Lit unique' : 'F — côté fenêtre') : 'P — côté porte';
      const invalid = room.value && PLAN_SINGLE.has(room.value) && option.value === 'P';
      option.textContent = label+(invalid?' — non disponible':room.value && occupied(room.value,option.value)?' — occupé':'');
    }
    if(!loading && rows !== null && !free.includes(position.value)) position.value = free.length === 1 ? free[0] : '';
    room.required = !hs; position.required = !hs;
  };
  const note = document.createElement('small'); note.className = 'meta'; note.dataset.bedAvailability = '1';
  note.textContent = 'Vérification des lits disponibles…';
  form.querySelector('[data-f=room]')?.appendChild(note);
  let timer = null;
  const refresh = async () => {
    if(!form.isConnected) { if(timer) clearInterval(timer); return; }
    try {
      const result = await api('/api/rooms');
      if(!form.isConnected) return;
      rows = result.rooms; loading = false;
      note.textContent = 'Lits occupés désactivés — disponibilité contrôlée à la validation.';
      sync();
    } catch(error) {
      if(!form.isConnected) return;
      if(rows === null) loading = true;
      note.textContent = 'Vérification des lits impossible : '+error.message;
      sync();
    }
  };
  room.addEventListener('change',sync); locationType.addEventListener('change',sync);
  form.addEventListener('submit',event => {
    if(locationType.value !== 'hs' && (loading || !freePositions(room.value).includes(position.value))) {
      event.preventDefault(); event.stopImmediatePropagation();
      note.textContent = 'Choisissez un lit disponible après vérification.';
      refresh();
    }
  },true);
  document.addEventListener('visibilitychange', function onVisible() {
    if(!form.isConnected) { document.removeEventListener('visibilitychange',onVisible); return; }
    if(!document.hidden) refresh();
  });
  sync(); refresh();
  timer = setInterval(refresh,15000);
}
function locPayload(v) {
  return v.loc_type === 'hs' ? { hors_service: v.hors_service.trim(), room: null, position: null } : { hors_service: '', room: v.room, position: v.position };
}

// ------------------------------------------------------------------ patient
const TABS = [["maj", "MAJ"], ["obsrv", "OBSERVATION + DOCS"], ["ttt", "TRAITEMENT"], ["cro", "CRO"], ["videos", "VIDEOS"], ["autres", "AUTRES"], ["sortie", "SORTIE"], ["logs", "LOGS"]];
function visiblePatientTabs(){return TABS.filter(([key])=>key!=='logs'||isStaff());}

const EXAM_TYPES = ['TDM', 'IRM', 'Bili-IRM', 'Échographie', 'Radiographie', 'Coloscopie', 'FOGD', 'Écho-endoscopie', 'CPRE', 'Anapath', 'Cytologie', 'Scintigraphie', 'Autre'];
const CLIN_CATS = ['Gestes faits', 'Surveillance clinique', 'Constantes', 'Drains'];
const ATCD_CATS = ['Médicaux', 'Chirurgicaux', 'Gynéco-obstétricaux', 'Toxiques', 'Allergies', 'Familiaux'];
const SPECIALITES = ['Anesthésie-Réanimation', 'Réanimation médicale', 'Réanimation chirurgicale', 'Médecine intensive', 'Médecine d’urgence', 'Médecine interne', 'Médecine générale', 'Cardiologie', 'Rythmologie', 'Cardiologie interventionnelle', 'Pneumologie', 'Gastro-entérologie', 'Hépatologie', 'Néphrologie', 'Endocrinologie', 'Diabétologie', 'Nutrition', 'Neurologie', 'Rhumatologie', 'Dermatologie', 'Allergologie', 'Immunologie clinique', 'Hématologie', 'Oncologie médicale', 'Radiothérapie', 'Maladies infectieuses', 'Gériatrie', 'Pédiatrie', 'Néonatologie', 'Psychiatrie', 'Pédopsychiatrie', 'Médecine physique et réadaptation', 'Médecine de la douleur', 'Soins palliatifs', 'Médecine du travail', 'Médecine du sport', 'Médecine légale', 'Santé publique', 'Chirurgie générale', 'Chirurgie viscérale et digestive', 'Chirurgie hépatobiliaire et pancréatique', 'Chirurgie colorectale', 'Chirurgie oncologique', 'Chirurgie thoracique', 'Chirurgie cardiovasculaire', 'Chirurgie vasculaire', 'Chirurgie orthopédique et traumatologique', 'Neurochirurgie', 'Chirurgie pédiatrique', 'Chirurgie plastique et reconstructrice', 'Chirurgie maxillo-faciale', 'Chirurgie orale', 'Urologie', 'Gynécologie-Obstétrique', 'Gynécologie', 'Obstétrique', 'Ophtalmologie', 'ORL', 'Radiologie', 'Radiologie interventionnelle', 'Médecine nucléaire', 'Anatomie et cytologie pathologiques', 'Biologie médicale', 'Microbiologie', 'Biochimie', 'Génétique médicale', 'Pharmacologie clinique', 'Autre'];

async function loadPatient(id) {
  const r = await api('/api/patients/' + id);
  S.patient = r.patient; S.entries = r.entries;
}

async function viewPatient(id, tab) {
  if(!visiblePatientTabs().some(([key])=>key===tab)){location.hash='#/patient/'+id+'/maj';return;}
  if (!S.patient || String(S.patient.id) !== String(id) || !$('#pmain')) {
    $('#app').innerHTML = topbar() + `<main class="patient"><div class="empty">Chargement du dossier…</div></main>`;
    bindChrome();
    await loadPatient(id);
  }
  const p = S.patient;
  $('#app').querySelector('main').outerHTML = `
  <main class="patient" id="pmain">
    <div class="tabsbar no-print">
      <button class="btn-back" id="home-btn">${I.back} Retour à l'accueil</button>
      <nav class="tabs" role="tablist">${visiblePatientTabs().map(([k, l]) => `<button class="tab ${k === tab ? 'active' : ''}" role="tab" aria-selected="${k === tab}" data-tab="${k}">${l}</button>`).join('')}</nav>
    </div>
    <div class="pbody">
      <aside class="consignes no-print">
        <div class="col-head"><button class="cons-toggle m-only" id="cons-toggle" aria-expanded="true" aria-label="Afficher ou masquer les consignes"><span class="cons-chev">▾</span></button>CONSIGNES <span class="cons-count m-only" id="cons-count"></span><button class="plus" id="add-cons" aria-label="Ajouter une consigne">${I.plus}</button></div>
        <div class="cons-list" id="cons-list"></div>
      </aside>
      <section class="main">
        <div class="idbar">
          <div class="ids">
            <span class="patient-name-group"><b>${esc(p.nom)} ${esc(p.prenom)}</b>${p.cin ? `<small class="patient-cin">CIN : ${esc(p.cin)}</small>` : ''}</span>
            <span>${p.age != null ? esc(p.age) + ' ans' : '— ans'}</span>
            <span>IP : ${esc(p.ip)}</span>
            <span>${esc(p.mutuelle || '—')}</span>
            <span>${esc(p.groupe || '—')}</span>
            ${p.status === 'sorti' ? '<span class="status-pill">Sorti</span>' : ''}
            <button class="plus edit no-print" id="edit-id" aria-label="Modifier l'identité et l'emplacement" title="Modifier identité / emplacement">${I.plus}</button>
          </div>
          <div class="roomno">${p.status === 'sorti' ? 'Sorti' : p.room ? esc(p.room + (p.position || '')) : `<small>${esc(p.hors_service)}</small>`}${p.status !== 'sorti' && (p.room || p.hors_service) ? `<button type="button" class="swap-bed-btn no-print" id="swap-bed" title="Changer de chambre ou échanger de lit" aria-label="Changer de chambre ou échanger de lit">⇄ Déplacer</button>` : ''}</div>
        </div>
        <div id="tab-content" style="min-height:0;display:grid"></div>
      </section>
    </div>
  </main>`;
  $('#home-btn').onclick = () => (location.hash = '#/home');
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => (location.hash = `#/patient/${p.id}/${b.dataset.tab}`));
  $('#add-cons').onclick = () => entryForm('consigne');
  $('#edit-id').onclick = editIdentity;
  const swapBtn = $('#swap-bed'); if (swapBtn) swapBtn.onclick = () => swapBedForm(p);
  renderConsignes();
  renderTab(tab);
  bindMobilePatient(p);
}
function bindMobilePatient(p) {
  const aside = $('#pmain .consignes'), tgl = $('#cons-toggle');
  if (aside && tgl) {
    const todo = (S.entries.consigne || []).filter(c => !c.done).length;
    const cnt = $('#cons-count'); if (cnt) { cnt.textContent = todo ? todo + ' à faire' : 'à jour'; cnt.classList.toggle('todo', !!todo); }
    const key = 'cva_cons_open_' + p.id, saved = sessionStorage.getItem(key);
    const apply = (open) => { aside.classList.toggle('m-collapsed', !open); tgl.setAttribute('aria-expanded', open ? 'true' : 'false'); };
    apply(saved === null ? todo > 0 : saved === '1');
    tgl.onclick = (e) => { e.stopPropagation(); const open = aside.classList.contains('m-collapsed'); apply(open); sessionStorage.setItem(key, open ? '1' : '0'); };
    aside.querySelector('.col-head').addEventListener('click', (e) => { if (MOBILE_PHONE.matches && !e.target.closest('.plus') && !e.target.closest('#cons-toggle')) tgl.click(); });
  }
  const act = $('#pmain .tab.active');
  if (act && MOBILE_PHONE.matches) { const nav = act.parentElement; nav.scrollLeft = act.offsetLeft - (nav.clientWidth - act.offsetWidth) / 2; }
}

async function refresh() {
  await loadPatient(S.patient.id);
  const tab = (location.hash.split('/')[3]) || 'maj';
  viewPatient(S.patient.id, tab);
}

// CONSIGNES DATE ORIGINE V1

// CONSIGNES AUTEURS V1 — visible pour tous les comptes connectés.
function consigneTraceHtml(c) {
 const creator=c.author_username||c.author||'Auteur non enregistré';
 const creation=c.created_at||c.date;
 let html=`<small>${esc(fmtDate(creation)||'date inconnue')} — ${esc(creator)}</small>`;
 if(c.done){
  const validation=c.validated_at?`${esc(fmtDate(c.validated_at))}`:'(date non enregistrée)';
  html+=`<small>${validation} — ${esc(c.validated_by_username||'Auteur non enregistré')}</small>`;
 }
 return html;
}

function renderConsignes() {
  const list = S.entries.consigne || [];
  const todo = list.filter(c => !c.done), done = list.filter(c => c.done);
  const row = (c) => `<div class="cons ${c.done ? 'done' : 'todo'}"><input type="checkbox" data-id="${c.id}" ${c.done ? 'checked' : ''} aria-label="Valider la consigne"><span class="txt" data-edit="${c.id}">${esc(c.content)}<small>${fmtDate(c.done ? (c.date || c.updated_at) : (c.created_at || c.date))}</small></span></div>`;
  $('#cons-list').innerHTML = (todo.map(row).join('') || '<div class="empty">Aucune consigne à faire</div>') + (done.length ? `<div class="cons-sep">VALIDÉES (${done.length})</div>` + done.map(row).join('') : '');
  $('#cons-list').querySelectorAll('input').forEach(i => i.onchange = async () => {
    await api('/api/entries/' + i.dataset.id, { method: 'PUT', body: { done: i.checked } });
    toast(i.checked ? 'Consigne validée' : 'Consigne remise à faire'); refresh();
  });
  $('#cons-list').querySelectorAll('[data-edit]').forEach(s => s.onclick = () => entryForm('consigne', list.find(c => String(c.id) === s.dataset.edit)));
}

const ENTRY_DEF = {
  consigne: { t: 'consigne', f: [{ name: 'content', label: 'Consigne', full: true, required: true, placeholder: 'ex. DEMANDER BILAN' }, { name: 'done', label: 'Statut', type: 'checkbox', hint: 'Déjà faite (validée)', full: true }] },
  atcd: { t: 'antécédents', f: [{ name: 'category', label: 'Catégorie', type: 'select', options: ATCD_CATS }, { name: 'content', label: 'Antécédent', type: 'textarea', full: true, required: true }] },
  clinique: { t: 'élément clinique', f: [{ name: 'category', label: 'Catégorie', type: 'select', options: CLIN_CATS }, { name: 'date', label: 'Date', type: 'date', default: today() }, { name: 'content', label: 'Contenu', type: 'textarea', full: true, required: true, placeholder: 'ex. TA 12/8 - FC 80 - T° 37.2 / Drain : 50 cc séreux' }] },
  bilan: { t: 'bilan', f: [{ name: 'date', label: 'Date du bilan', type: 'date', default: today(), required: true }, { name: 'content', label: 'Résultats (une ligne par paramètre)', type: 'textarea', full: true, required: true, placeholder: 'Alb : 34\nGB : 6660\nHB : 13.1\nPlq : 196k\nTP : 74\nCRP : 40' }] },
  examen: { t: 'examen complémentaire', f: [{ name: 'category', label: 'Type', type: 'select', options: EXAM_TYPES }, { name: 'date', label: 'Date', type: 'date', default: today(), required: true }, { name: 'title', label: 'Intitulé / lieu', full: true, placeholder: 'ex. TDM TAP — CHU Oujda' }, { name: 'content', label: 'Conclusion', type: 'textarea', full: true, required: true }, { name: 'details', label: 'Détails du compte rendu', type: 'textarea', full: true }] },
  avis: { t: 'avis spécialisé', f: [{ name: 'category', label: 'Spécialité', type: 'datalist', options: SPECIALITES, required: true }, { name: 'date', label: 'Date', type: 'date', default: today(), required: true }, { name: 'content', label: 'Avis', type: 'textarea', full: true, required: true }] },
  observation: { t: 'observation', f: [{ name: 'date', label: 'Date', type: 'date', default: today(), required: true }, { name: 'title', label: 'Titre (optionnel)', placeholder: 'ex. J2 post-op' }, { name: 'content', label: 'Observation', type: 'textarea', full: true, required: true }] },
  traitement: { t: 'traitement', f: [{ name: 'title', label: 'Médicament', required: true }, { name: 'category', label: 'Classe', type: 'datalist', options: ['Antibiotique', 'Antalgique', 'Anticoagulant', 'IPP', 'Antiémétique', 'Solutés', 'Insuline', 'Antihypertenseur', 'Autre'] }, { name: 'content', label: 'Posologie / voie', full: true, required: true, placeholder: 'ex. 1 g x 3/j IV' }, { name: 'date', label: 'Date de début', type: 'date', default: today() }, { name: 'done', label: 'Statut', type: 'checkbox', hint: 'Traitement arrêté' }, { name: 'details', label: 'Remarques', type: 'textarea', full: true }] },
  video: { t: 'vidéo', f: [{ name: 'title', label: 'Titre', required: true, placeholder: 'ex. Cholécystectomie cœlioscopique' }, { name: 'date', label: 'Date', type: 'date', default: today() }, { name: 'content', label: 'Lien (URL) de la vidéo', full: true, placeholder: 'https://… (ou importer un fichier ci-dessous)' }, { name: 'file', label: 'Ou importer un fichier (mp4, webm, mov, image)', type: 'file', accept: 'video/*,image/*', full: true }, { name: 'details', label: 'Description', type: 'textarea', full: true }] },
};

// EXAMENS CRH V4.4 : lieu séparé, stockage compatible dans details.
function examInfo(e){
 try{const v=JSON.parse(e.details||'');if(v?.schema==='exam-location-v1')return {place:String(v.place||''),report:String(v.report||'')};}catch{}
 return {place:'',report:String(e.details||'')};
}
// EXAM TITLE UNIQUE V1
function examBaseTitle(value,place){
 let title=String(value||'').trim();
 title=title.replace(/\s*(?:(?:le|du|en date du)\s+)?\b\d{1,2}[/.\-]\d{1,2}[/.\-](?:\d{4}|\d{2})(?!\d)/gi,' ');
 const location=String(place||'').trim().replace(/[\s:;,]+$/,'');
 if(location){
  const escaped=location.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  title=title.replace(new RegExp('\\s*(?:(?:au|à|a|chez)\\s+)?'+escaped+'[\\s:;,]*$','i'),'');
 }
 return title.replace(/[\s:;,]+$/,'').replace(/\s+(?:le|du|au|à|chez)$/i,'').replace(/\s+/g,' ').trim();
}
function examCrhHeading(e){
 const place=examInfo(e).place.trim().replace(/[\s:;,]+$/,'');
 const title=examBaseTitle(e.title||e.category||'Examen',place)||e.category||'Examen';
 return title+' du '+(fmtDate(e.date)||'date à préciser')+(place?' '+place:'');
}
function examForm(entry,preset={}){
 const existing=entry||preset,info=examInfo(existing);
 formModal({title:entry?'Modifier l’examen complémentaire':'Ajouter un examen complémentaire',
  fields:[{name:'category',label:'Type',type:'select',options:EXAM_TYPES},
   {name:'date',label:'Date',type:'date',required:true,default:today()},
   {name:'title',label:'Intitulé',full:true,placeholder:'Ex. TDM AP'},
   {name:'place',label:'Lieu',full:true,placeholder:'Ex. CHUO'},
   {name:'content',label:'Conclusion',type:'textarea',full:true,required:true},
   {name:'report',label:'Détails du compte rendu',type:'textarea',full:true}],
  values:{...existing,place:info.place,report:info.report},
  onSubmit:async v=>{
   const body={kind:'examen',category:v.category,date:v.date,title:String(v.title||'').trim(),content:v.content,
    details:JSON.stringify({schema:'exam-location-v1',place:String(v.place||'').trim(),report:v.report||''})};
   if(entry)await api('/api/entries/'+entry.id,{method:'PUT',body});
   else await api('/api/patients/'+S.patient.id+'/entries',{method:'POST',body});
   toast(entry?'Examen modifié':'Examen ajouté');await refresh();
  },
  onDelete:entry?async()=>{await api('/api/entries/'+entry.id,{method:'DELETE'});toast('Examen supprimé');await refresh();}:null
 });
}

function entryForm(kind, entry, preset = {}) {
  if(kind==='clinique'&&entry?.category==='Gestes faits'){postOpForm(entry);return;}
  if(kind==='clinique'&&!entry&&!preset.clinicalGeneric){clinicalEntryChooser();return;}
  if(kind==='clinique' && drainDecode(entry)){drainForm(entry);return;}
  if(kind==='examen'){examForm(entry,preset);return;}
  if(kind==='consigne'){consigneForm(entry);return;}
  if(kind==='video'){imagingForm(entry);return;}
  if(kind==='traitement'){treatmentForm(entry);return;}
  if (kind === 'bilan' && (!entry || simpleDecode(entry))) {simpleBilanForm(entry);return;}
  if (kind === 'bilan' && entry && labDecode(entry)) {structuredBilanForm(entry);return;}
  const def = ENTRY_DEF[kind];
  formModal({
    title: (entry ? 'Modifier ' : 'Ajouter ') + def.t,
    fields: def.f.filter(f => !(entry && f.type === 'file') && !(kind === 'atcd' && f.name === 'category')),
    values: entry || preset,
    onSubmit: async (v) => {
      if (kind === 'video' && v.file) {
        const fd = new FormData(); fd.append('file', v.file); fd.append('title', v.title); fd.append('date', v.date); fd.append('details', v.details || '');
        await api(`/api/patients/${S.patient.id}/upload`, { method: 'POST', body: fd });
      } else {
        delete v.file;
        if (kind === 'video' && !v.content) throw new Error('Ajoutez un lien ou un fichier.');
        if (entry) await api('/api/entries/' + entry.id, { method: 'PUT', body: v });
        else await api(`/api/patients/${S.patient.id}/entries`, { method: 'POST', body: { kind, ...v } });
      }
      toast(entry ? 'Modification enregistrée' : 'Ajout enregistré'); refresh();
    },
    onDelete: entry ? async () => { await api('/api/entries/' + entry.id, { method: 'DELETE' }); toast('Supprimé'); refresh(); } : null,
  });
  if(kind==='clinique'&&!preset.legacyDrain){
    const select=document.querySelector('#mform select[name="category"]');
    if(select)select.addEventListener('change',()=>{if(select.value==='Drains')drainChooser(entry);else if(select.value==='Gestes faits')postOpForm(entry);});
    if(select?.value==='Drains')drainChooser(entry);
  }
}

const plusBtn = (kind, label) => `<button class="plus" data-add="${kind}" aria-label="Ajouter ${label}">${I.plus}</button>`;
function bindItems(root) {
  root.querySelectorAll('[data-drain-add]').forEach(b=>b.onclick=event=>{event.stopPropagation();const entry=S.entries.clinique.find(e=>String(e.id)===b.dataset.drainAdd);if(entry)drainForm(entry,true);});
  root.querySelectorAll('[data-add]').forEach(b => b.onclick = (e) => { e.stopPropagation(); entryForm(b.dataset.add, null, b.dataset.preset ? JSON.parse(b.dataset.preset) : {}); });
  const isMaj = ((location.hash.split('/')[3]) || 'maj') === 'maj';
  root.querySelectorAll('[data-eid]').forEach(el => {
    const edit = () => {
      const [kind, id] = el.dataset.eid.split(':');
      const item = (S.entries[kind] || []).find(x => String(x.id) === id);
      if (item) entryForm(kind, item);
    };
    if (isMaj) {
      el.onclick = null;
      el.classList.add('maj-read-only');
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'maj-edit-pencil no-print';
      button.textContent = '✎'; button.title = 'Modifier cet élément';
      button.setAttribute('aria-label', 'Modifier cet élément');
      button.onclick = event => {event.stopPropagation(); edit();};
      el.prepend(button);
    } else {
      el.onclick = event => {
        if (event.target.closest('.tog, a, video')) return;
        edit();
      };
    }
  });
  if (isMaj) {
    const motif = root.querySelector('#motif-edit');
    if (motif) {
      motif.onclick = null;
      motif.classList.add('maj-read-only');
      const hint = motif.querySelector('small');
      if (hint) hint.textContent = hint.textContent.replace(/\s*·\s*cliquer pour modifier/, '');
      const button = document.createElement('button');
      button.type = 'button';button.className = 'maj-edit-pencil no-print';
      button.textContent = '✎';button.title = 'Modifier le motif';
      button.setAttribute('aria-label','Modifier le motif');
      button.onclick = event => {event.stopPropagation();editIdentity();};
      motif.prepend(button);
    }
  }
  root.querySelectorAll('.tog').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    const id = b.dataset.tog; S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id);
    renderTab((location.hash.split('/')[3]) || 'maj');
  });
}
const meta = (e) => `<span class="meta">${fmtDate(e.updated_at)}</span>`;
const sortByDate = (arr) => [...arr].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id);

function examItem(e) {
  const open = S.expanded.has(String(e.id));
  const report=examInfo(e).report;
  const head = esc(examCrhHeading(e));
  return `<div class="item exam" data-eid="examen:${e.id}">
    <span class="t">${head} :</span><span class="c">${esc(e.content)}</span>
    ${report ? (open
      ? `<div class="det"><span class="det-lbl">DÉTAILS :</span><br>${esc(report)}</div><button class="tog" data-tog="${e.id}" aria-label="Réduire">${I.up}</button>`
      : `<button class="tog" data-tog="${e.id}" aria-label="Voir les détails">${I.down}</button>`) : ''}
    ${meta(e)}</div>`;
}

function renderTab(tab) {
  if(!visiblePatientTabs().some(([key])=>key===tab))tab='maj';
  const box = $('#tab-content'), E = S.entries, p = S.patient;
  if (tab === 'maj') {
    const atcds = E.atcd || [];
    const atcdHtml = atcds.map(a => `<div class="item center" data-eid="atcd:${a.id}" style="border-bottom:none;padding:6px 14px">${esc(a.content)}</div>`).join('');
    const clin = [...(E.clinique || [])].sort((a, b) => {
      const rank = (e) => e.category === 'Gestes faits' ? 0 : e.category === 'Drains' ? 1 : 2;
      return rank(a) - rank(b)
        || (b.date || '').localeCompare(a.date || '')
        || b.id - a.id;
    });
    box.innerHTML = `<div class="cols">
      <div class="col"><div class="col-head">Motif ${plusBtn('atcd', 'un antécédent')}</div>
        <div class="col-body">
          <div class="motif-block" id="motif-edit"><div class="m">${esc(p.motif || '—')}</div>${p.motif_code ? `<small class="maj-motif-cim10" style="display:block;margin-top:3px;font-size:11px;font-weight:400;line-height:1.3;color:#8492a6">${esc(p.motif_code)}</small>` : ''}<small>Entrée le ${fmtDate(p.date_entree)} · cliquer pour modifier</small></div>
          <div class="atcd-cat" style="text-align:center;font-size:15px;text-transform:none;letter-spacing:0;color:var(--ink)">ATCDs :</div>
          ${atcdHtml || '<div class="empty">Aucun antécédent renseigné</div>'}
        </div></div>
      <div class="col"><div class="col-head">clinique ${plusBtn('clinique', 'un élément clinique')}</div>
        <div class="col-body">${clinicalCompactHtml(clin) || '<div class="empty">Gestes, surveillance, constantes, drains…</div>'}</div></div>
      <div class="col"><div class="col-head">Bilan ${plusBtn('bilan', 'un bilan')}</div>
        <div class="col-body">${labKinetic(E.bilan || [])}</div></div>
      <div class="col"><div class="col-head">Examen complémentaires ${plusBtn('examen', 'un examen')}</div>
        <div class="col-body">${sortByDate(E.examen || []).map(examItem).join('') || '<div class="empty">TDM, IRM, coloscopie, anapath…</div>'}</div></div>
      <div class="col"><div class="col-head">Avis ${plusBtn('avis', 'un avis')}</div>
        <div class="col-body">${sortByDate(E.avis || []).map(a => `<div class="item avis" data-eid="avis:${a.id}"><span class="t">${fmtDate(a.date)}<br>Avis ${esc(a.category)} :</span><span class="c">${esc(a.content)}</span>${meta(a)}</div>`).join('') || '<div class="empty">Aucun avis spécialisé</div>'}</div></div>
    </div>`;
    $('#motif-edit').onclick = editIdentity;
    addObservationImportButton(box, p.id);
  } else if (tab === 'obsrv') {
    box.innerHTML = '<div class="obs-doc-grid">' + `<div class="panel"><div class="panel-head"><h3>Observations médicales</h3><button class="btn primary" data-add="observation">+ Nouvelle observation</button></div>
      <div class="timeline">${sortByDate(E.observation || []).map(o => `<article class="card" data-eid="observation:${o.id}"><h4>${fmtDate(o.date)}${o.title ? ' — ' + esc(o.title) : ''}</h4><p>${esc(o.content)}</p><div class="meta">${fmtDate(o.updated_at)}</div></article>`).join('') || '<div class="empty">Aucune observation</div>'}</div></div>` + documentPanel() + '</div>';
    loadPatientDocuments(S.patient.id);
    bindObservationCopyButtons(box, E.observation || []);
  } else if (tab === 'ttt') {
    renderTreatmentTab(box,E,p);
  } else if (tab === 'videos') {
    renderImagingTab(box,E,p);
  } else if (tab === 'cro') {
    renderCroTab(box,p); return;
  } else if (tab === 'autres') {
    renderPatientRegime(box, p.id);
  } else if (tab === 'sortie') {
    renderSortie(box); return;
  } else if (tab === 'logs') {
    box.innerHTML = `<div class="panel"><div class="panel-head"><h3>Journal des modifications</h3></div><div class="empty">Chargement…</div></div>`;
    api(`/api/patients/${p.id}/logs`).then(r => {
      box.innerHTML = `<div class="panel"><div class="panel-head"><h3>Journal des modifications</h3><span class="meta">${r.logs.length} événement(s)</span></div>
      <table class="tbl"><thead><tr><th style="width:150px">Date / heure</th><th style="width:170px">Utilisateur</th><th style="width:240px">Action</th><th>Détail</th></tr></thead>
      <tbody>${r.logs.map(l => `<tr><td>${fmtTs(l.ts)}</td><td>${esc(l.user)}</td><td><b>${esc(l.action)}</b></td><td>${esc(l.detail)}</td></tr>`).join('')}</tbody></table></div>`;
    });
    return;
  }
  bindItems(box);
  bindLabTools(box);
}


// SORTIE V3 : ordonnance choisie dans une fenêtre à cases à cocher (liste gérée dans Paramètres).
function initSortieOrdonnance(form) {
  const storage = form.elements.sortie_ordonnance, root = form.querySelector('[data-list="sortie_ordonnance"]');
  const rows = [], legacy = [];
  storage.value.split('\n').filter(l => l.trim()).forEach(line => {
    const m = line.match(/^• (.*?) — Posologie : (.*?) — Durée : (.*)$/);
    if (m) rows.push({ nom: m[1], posologie: m[2], duree: m[3] }); else legacy.push(line);
  });
  root.innerHTML = `<div class="no-print" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"><button class="btn primary" type="button" data-pick>Choisir des médicaments</button>${S.user?.role === 'admin' ? '<button class="btn" type="button" data-manual>Saisie manuelle</button>' : ''}</div><div data-rows></div><p class="no-print" style="font-size:12px;color:#64748b">Vérifier et adapter chaque médicament, sa posologie et sa durée avant validation.</p>`;
  const list = root.querySelector('[data-rows]');
  const clean = v => String(v || '').replace(/[\r\n]+/g, ' ').trim();
  function sync() {
    storage.value = [...rows.map(r => `• ${clean(r.nom)} — Posologie : ${clean(r.posologie)} — Durée : ${clean(r.duree)}`), ...legacy].filter(Boolean).join('\n');
    storage.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function render() {
    list.innerHTML = rows.map((r, i) => `<div data-row="${i}" class="ordo-row">${[['nom', 'Médicament'], ['posologie', 'Posologie'], ['duree', 'Durée']].map(([key, label]) => `<label style="flex:1;min-width:170px">${label}<input data-key="${key}" type="text" ${key === 'nom' ? 'required' : ''} maxlength="500" value="${esc(r[key])}"></label>`).join('')}<button class="btn danger no-print" type="button" data-remove="${i}">Supprimer</button></div>`).join('') || '<p style="color:#64748b">Aucun médicament sélectionné.</p>';
    list.querySelectorAll('[data-key]').forEach(input => {
      const update = () => { rows[Number(input.closest('[data-row]').dataset.row)][input.dataset.key] = input.value; sync(); };
      input.addEventListener('input', update); input.addEventListener('change', update);
    });
    list.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => { rows.splice(Number(b.dataset.remove), 1); render(); sync(); });
  }
  // ORDONNANCE MANUELLE ADMIN V1
  const manualButton = root.querySelector('[data-manual]');
  if (manualButton) manualButton.onclick = () => {
    if (S.user?.role !== 'admin') return;
    rows.push({ nom: '', posologie: '', duree: '' });
    render(); sync(); list.lastElementChild?.querySelector('input')?.focus();
  };
  root.querySelector('[data-pick]').onclick = async () => {
    let meds;
    try { meds = (await api('/api/parametres/medicaments')).medicaments; } catch (e) { toast(e.message, true); return; }
    const key = m => [m.nom, m.posologie, m.duree].map(v => clean(v).toLowerCase()).join('|');
    const present = new Set(rows.map(key));
    const ov = modal(`<div class="dialog-head"><h2>Médicaments de l’ordonnance</h2><button class="icon-btn" data-close aria-label="Fermer">✕</button></div>
      <div class="dialog-body"><input data-filter type="search" placeholder="Filtrer la liste…" class="med-filter">
      <div class="med-pick">${meds.map(m => `<label class="med-item" data-text="${esc((m.nom + ' ' + m.posologie + ' ' + m.duree).toLowerCase())}"><input type="checkbox" value="${m.id}" ${present.has(key(m)) ? 'checked disabled' : ''}><span><b>${esc(m.nom)}</b><small>${esc([m.posologie, m.duree].filter(Boolean).join(' — '))}</small></span></label>`).join('') || '<div class="empty">Aucun médicament dans la liste. Ajoutez-en dans Paramètres.</div>'}</div>
      <div class="form-actions"><span class="meta" data-count>0 sélectionné</span><div class="r"><button type="button" class="btn" data-close>Annuler</button><button type="button" class="btn primary" data-ok>Valider</button></div></div></div>`, 'form-dialog');
    ov.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
    const boxes = [...ov.querySelectorAll('.med-pick input:not([disabled])')];
    const count = () => { const n = boxes.filter(b => b.checked).length; ov.querySelector('[data-count]').textContent = n + (n > 1 ? ' sélectionnés' : ' sélectionné'); };
    boxes.forEach(b => b.onchange = count);
    ov.querySelector('[data-filter]').oninput = (e) => { const q = e.target.value.trim().toLowerCase(); ov.querySelectorAll('.med-item').forEach(l => l.style.display = !q || l.dataset.text.includes(q) ? '' : 'none'); };
    ov.querySelector('[data-ok]').onclick = () => {
      const chosen = boxes.filter(b => b.checked).map(b => meds.find(m => String(m.id) === b.value)).filter(Boolean);
      chosen.forEach(m => rows.push({ nom: m.nom, posologie: m.posologie, duree: m.duree }));
      closeModal(); render(); sync();
      if (chosen.length) toast(chosen.length + ' médicament(s) ajouté(s)');
    };
  };
  form.addEventListener('submit', sync, true);
  render();
}

function sortieBody(form) {
  const body = Object.fromEntries(new FormData(form));
  if (body.sortie_mode !== 'Transfert') body.sortie_destination = '';
  return body;
}
const SORTIE_RDV_MESSAGE = 'Important : délivrer au patient tous les rendez-vous prévus (consultation avec nous, autres services, bilan et imagerie) et lui rappeler leurs dates et les consignes associées.';
function renderSortie(box) {
  const p = S.patient, sorti = p.status === 'sorti';
  const modes = ['', 'Domicile', 'Transfert', 'Contre avis médical', 'Évasion', 'Décès'];
  const currentMode = String(p.sortie_mode || '').startsWith('Transfert') ? 'Transfert' : (p.sortie_mode || '');
  if (currentMode && !modes.includes(currentMode)) modes.push(currentMode);
  box.innerHTML = `<div class="panel">
    <div class="panel-head"><h3>Fiche de sortie</h3><div style="display:flex;gap:8px"><button class="btn no-print" id="print">Imprimer CRH / ordonnance</button>${sorti ? '<button class="btn teal no-print" id="readmit">Réadmettre</button>' : ''}</div></div>
    ${sorti ? `<div class="banner ok">Sortie validée le ${fmtDate(p.sortie_date)} — ${esc(p.sortie_mode)}. Le lit a été libéré.</div>` : ''}
    <form id="sortie-form" class="sortie-grid">
      <div class="field"><label>Date d’entrée</label><input type="date" name="date_entree" value="${esc(p.date_entree || '')}"></div>
      <div class="field"><label>Date de sortie</label><input type="date" name="sortie_date" value="${esc(p.sortie_date || today())}"></div>
      <div class="field"><label>Mode de sortie</label><select name="sortie_mode">${modes.map(m => `<option ${m === currentMode ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></div>
      <div class="field full" style="grid-column:1/-1" data-dest><label>Destination</label><input name="sortie_destination" value="${esc(p.sortie_destination || '')}" placeholder="Service ou établissement d’accueil"></div>
      <input type="hidden" name="sortie_medecin" value="${esc(p.sortie_medecin || '')}">
      <div class="field" style="grid-column:1/-1"><label>Résumé d'hospitalisation / compte rendu</label><textarea name="sortie_resume" style="min-height:160px">${esc(p.sortie_resume || '')}</textarea></div>
      <div class="field" style="grid-column:1/-1"><label>Ordonnance de sortie</label><textarea name="sortie_ordonnance" hidden style="display:none">${esc(p.sortie_ordonnance || '')}</textarea><div data-list="sortie_ordonnance"></div></div>
      <p role="note" class="rdv-note" style="grid-column:1/-1">${esc(SORTIE_RDV_MESSAGE)}</p>
      <div class="form-err" id="serr" style="grid-column:1/-1"></div>
      <div class="form-actions no-print" style="grid-column:1/-1"><div class="r"><button class="btn" type="submit" data-v="0">Enregistrer le brouillon</button>${sorti ? '' : '<button class="btn primary" type="submit" data-v="1">Valider la sortie</button>'}</div></div>
    </form></div>`;
  const form = $('#sortie-form');
  const destToggle = () => { const on = form.elements.sortie_mode.value === 'Transfert'; form.querySelector('[data-dest]').classList.toggle('hidden', !on); };
  form.elements.sortie_mode.addEventListener('change', destToggle); destToggle();
  if (!p.sortie_medecin) api('/api/parametres/reglages').then(r => { if (form.isConnected && !form.elements.sortie_medecin.value) { form.elements.sortie_medecin.value = r.reglages.crh_medecin_responsable || ''; form.elements.sortie_medecin.dataset.auto = '1'; } }).catch(() => {});
  initSortieOrdonnance(form);
  initSortieCrh(form,p,S.entries);
  let valider = false;
  form.querySelectorAll('[data-v]').forEach(b => b.onclick = () => (valider = b.dataset.v === '1'));
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (valider && !confirm('Valider la sortie et libérer le lit ?')) return;
    const body = sortieBody(form); body.valider = valider;
    try { await api(`/api/patients/${p.id}/sortie`, { method: 'POST', body }); toast(valider ? 'Sortie validée' : 'Fiche enregistrée'); refresh(); }
    catch (err) { $('#serr').textContent = err.message; }
  };
  $('#print').onclick = () => window.print();
  const ra = $('#readmit');
  if (ra) ra.onclick = async () => {
    // RÉADMISSION V2 : nouveau motif obligatoire ; l'ancien motif est archivé automatiquement en antécédent.
    let motifs; try { motifs = await loadMotifs(); } catch (ex) { toast(ex.message, true); return; }
    const f = formModal({
      title: 'Réadmettre le patient', submit: 'Réadmettre', values: { loc_type: 'room', motif_choice: '', motif_libre: '', motif_code_libre: '' },
      extra: `<p class="urg-muted" style="margin:0 0 8px">Ancien motif : <b>${esc(p.motif || '—')}</b>${p.motif_code ? ' (' + esc(p.motif_code) + ')' : ''} — il sera ajouté aux antécédents avec le mois du séjour et les interventions renseignées dans les CRO de ce séjour.</p>`,
      fields: [...motifFields(motifs), ...locationFields(S.meta)],
      onSubmit: async (v) => {
        if (v.loc_type === 'hs' && !String(v.hors_service || '').trim()) throw new Error('Indiquez le service d\'hébergement.');
        if (v.loc_type === 'room' && (!v.room || !v.position)) throw new Error('Choisissez la chambre et le lit.');
        const { loc_type, ...rest } = motifPayload(v);
        await api(`/api/patients/${p.id}/readmettre`, { method: 'POST', body: { ...rest, ...locPayload(v) } });
        toast('Patient réadmis — ancien motif archivé en antécédent'); refresh();
      },
    });
    bindLocToggle(f); bindMotifToggle(f);
  };
}

// ------------------------------------------------------------------ other pages
async function viewArchives() {
  $('#app').innerHTML = topbar() + `<main class="patient" style="grid-template-rows:auto 1fr"><div class="tabsbar"><button class="btn-back" id="home-btn">${I.back} Retour à l'accueil</button><input id="aq" class="pill" style="box-shadow:none;border:1.5px solid var(--line);font-size:15px;padding:9px 18px;width:320px" placeholder="Filtrer par nom ou IP"></div><div class="panel" id="arch"></div></main>`;
  bindChrome();
  $('#home-btn').onclick = () => (location.hash = '#/home');
  const load = async (q = '') => {
    const r = await api('/api/archives?q=' + encodeURIComponent(q));
    $('#arch').innerHTML = `<div class="panel-head"><h3>Patients sortis</h3><span class="meta">${r.patients.length} dossier(s)</span></div>
      <table class="tbl"><thead><tr><th>Patient</th><th>IP</th><th>Motif</th><th>Date de sortie</th><th>Mode</th>${isAdmin() ? '<th class="no-print"></th>' : ''}</tr></thead>
      <tbody>${r.patients.map(p => `<tr class="clickable" data-id="${p.id}"><td><b>${esc(p.nom)} ${esc(p.prenom)}</b></td><td>${esc(p.ip)}</td><td>${esc(p.motif)}</td><td>${fmtDate(p.sortie_date)}</td><td>${esc(p.sortie_mode)}</td>${isAdmin() ? `<td class="no-print" style="text-align:right"><button type="button" class="btn danger" data-del-id="${p.id}" title="Supprimer définitivement ce dossier">Supprimer</button></td>` : ''}</tr>`).join('') || `<tr><td colspan="${isAdmin() ? 6 : 5}" class="empty">Aucun patient sorti</td></tr>`}</tbody></table>`;
    $('#arch').querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => (location.hash = `#/patient/${tr.dataset.id}/sortie`));
    $('#arch').querySelectorAll('[data-del-id]').forEach(b => b.onclick = async (e) => {
      e.stopPropagation();
      const p = r.patients.find(x => String(x.id) === b.dataset.delId);
      b.disabled = true;
      try { if (await adminDeletePatient(p)) await load($('#aq').value); } catch (ex) { toast(ex.message, true); } finally { if (b.isConnected) b.disabled = false; }
    });
  };
  let t; $('#aq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => load(e.target.value), 250); };
  load();
}

async function viewJournal() {
  if(!isStaff()){location.hash='#/home';toast('Journal réservé à l’administrateur et au modérateur.',true);return;}
  $('#app').innerHTML = topbar() + `<main class="patient" style="grid-template-rows:auto 1fr"><div class="tabsbar"><button class="btn-back" id="home-btn">${I.back} Retour à l'accueil</button></div><div class="panel" id="jr"></div></main>`;
  bindChrome();
  $('#home-btn').onclick = () => (location.hash = '#/home');
  const r = await api('/api/logs');
  $('#jr').innerHTML = `<div class="panel-head"><h3>Journal global (500 derniers événements)</h3></div>
    <table class="tbl"><thead><tr><th>Date / heure</th><th>Utilisateur</th><th>Patient</th><th>Action</th><th>Détail</th></tr></thead>
    <tbody>${r.logs.map(l => `<tr ${l.patient_id ? `class="clickable" data-id="${l.patient_id}"` : ''}><td>${fmtTs(l.ts)}</td><td>${esc(l.user)}</td><td>${l.nom ? esc(l.nom + ' ' + (l.prenom || '')) : '—'}</td><td><b>${esc(l.action)}</b></td><td>${esc(l.detail)}</td></tr>`).join('')}</tbody></table>`;
  $('#jr').querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => (location.hash = `#/patient/${tr.dataset.id}/logs`));
}


function clockForm(){formModal({title:'UTC et adaptation manuelle',values:clock,
 extra:'<p>UTC par défaut. Correction globale : 0 = UTC, +60 = UTC+1, -60 = UTC−1. Les anciens historiques ne sont pas modifiés.</p>',
 fields:[{name:'offset_minutes',label:'Correction en minutes',type:'number',required:true}],
 onSubmit:async v=>{await api('/api/clock',{method:'PUT',body:v});await syncClock();toast('Horloge mise à jour');setTimeout(render,0);}});}
function profileFields(){return [
 {name:'username',label:'Identifiant',required:true},{name:'full_name',label:'Nom complet',required:true},
 {name:'current_password',label:S.user.must_change_password?'Mot de passe actuel / temporaire':'Mot de passe actuel',type:'password',required:true},
 ...(!S.user.must_change_password && S.user.role==='moderateur' ? [{name:'password',label:'Nouveau mot de passe (facultatif, 8 caractères minimum)',type:'password'},{name:'confirm_password',label:'Confirmer le nouveau mot de passe',type:'password'}] : []),
 ...(S.user.must_change_password ? [{name:'password',label:'Nouveau mot de passe (8 caractères minimum)',type:'password',required:true},{name:'confirm_password',label:'Confirmer le nouveau mot de passe',type:'password',required:true}] : [])
];}
async function saveProfile(v){
 if((S.user.must_change_password || v.password) && v.password!==v.confirm_password)throw new Error('Les mots de passe ne correspondent pas.');
 if(!v.password)delete v.password;
 delete v.confirm_password;
 S.user=(await api('/api/me/profile',{method:'PUT',body:v})).user;
 toast('Compte mis à jour');location.hash='#/home';setTimeout(render,0);
}
function profileForm(){formModal({title:'Mon compte',fields:profileFields(),values:S.user,
 extra:S.user.role==='moderateur'?'<p>Modifiez votre identifiant, votre nom ou votre mot de passe. Laissez le nouveau mot de passe vide pour garder l’actuel. Votre mot de passe actuel est demandé pour confirmer.</p>':'<p>Après la première connexion, seul l’administrateur peut modifier votre mot de passe.</p>',onSubmit:saveProfile});}
function viewFirstLogin(){
 $('#app').innerHTML=`<main class="login"><section class="login-card"><h1>Première connexion</h1><p>Personnalisez votre compte. Vous ne pourrez plus modifier vous-même votre mot de passe après cette étape.</p><form id="first-login">${profileFields().map(f=>`<label>${esc(f.label)}<input class="pill" name="${f.name}" type="${f.type||'text'}" value="${f.type==='password'?'':esc(S.user[f.name])}" required></label>`).join('')}<div class="login-err" id="first-error"></div><button class="btn primary" type="submit">Enregistrer et continuer</button><button class="btn" type="button" id="first-logout">Se déconnecter</button></form></section></main>`;
 $('#first-logout').onclick=()=>logout();
 $('#first-login').onsubmit=async e=>{e.preventDefault();try{await saveProfile(Object.fromEntries(new FormData(e.target)));}catch(err){$('#first-error').textContent=err.message;}};
}

// CRO ET CONSIGNES V1
// ---------- Consignes structurées : Action - Catégorie - texte libre - date
const CONS_ACTIONS = ['Demander', 'Récupérer', 'Autre'];
const CONS_CATS = ['Bilan', 'Imagerie', 'Endoscopie', 'Avis', 'Anapath', 'Autre'];
const CONS_HINTS = { Bilan: 'ex. thyroïdien', Imagerie: 'ex. TDM AP', Endoscopie: 'ex. FOGD', Avis: 'ex. cardiologie', Anapath: 'ex. pièce de cholécystectomie', Autre: 'Texte de la consigne' };
// Pour Imagerie / Endoscopie, le texte libre (TDM AP, FOGD…) remplace le mot de la catégorie.
const CONS_REPLACED_BY_FREE_TEXT = new Set(['Imagerie', 'Endoscopie']);
function consigneDetails(entry) { try { const d = JSON.parse(entry?.details || ''); return d?.schema === 'consigne-v2' ? d : null; } catch { return null; } }
function composeConsigne(v) {
  const verb = v.action === 'Autre' ? String(v.action_libre || '').trim() : v.action;
  const libre = String(v.libre || '').trim();
  let cat = '';
  if (v.categorie && v.categorie !== 'Autre' && !(CONS_REPLACED_BY_FREE_TEXT.has(v.categorie) && libre)) cat = v.categorie.toLowerCase();
  const text = [verb, cat, libre].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}
function consigneForm(entry) {
  const d = consigneDetails(entry);
  const values = d ? { ...d, date: entry.date || (entry.created_at || '').slice(0, 10) || today(), done: entry.done }
    : entry ? { action: 'Autre', action_libre: '', categorie: 'Autre', libre: entry.content, date: entry.date || (entry.created_at || '').slice(0, 10) || today(), done: entry.done }
    : { action: 'Demander', categorie: 'Bilan', date: today() };
  const form = formModal({
    title: entry ? 'Modifier la consigne' : 'Ajouter une consigne',
    values,
    extra: '<div class="cons-preview"><span>Aperçu</span><b id="cons-preview-text">—</b><small id="cons-preview-date"></small></div>',
    fields: [
      { name: 'action', label: 'Action', type: 'select', options: CONS_ACTIONS, required: true },
      { name: 'action_libre', label: 'Action (texte libre)', placeholder: 'ex. Programmer, Vérifier…' },
      { name: 'categorie', label: 'Catégorie', type: 'select', options: CONS_CATS, required: true },
      { name: 'libre', label: 'Précision (facultatif)', placeholder: CONS_HINTS.Bilan },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'done', label: 'Statut', type: 'checkbox', hint: 'Déjà faite (validée)' },
    ],
    onSubmit: async (v) => {
      if (v.action === 'Autre' && !String(v.action_libre || '').trim() && !String(v.libre || '').trim()) throw new Error('Précisez l’action ou la consigne.');
      if (v.categorie === 'Autre' && !String(v.libre || '').trim()) throw new Error('Précisez la consigne (catégorie Autre).');
      const content = composeConsigne(v);
      if (!content) throw new Error('La consigne est vide.');
      const details = JSON.stringify({ schema: 'consigne-v2', action: v.action, action_libre: v.action === 'Autre' ? String(v.action_libre || '').trim() : '', categorie: v.categorie, libre: String(v.libre || '').trim() });
      const body = { content, details, date: v.date, category: v.categorie, done: v.done };
      if (entry) await api('/api/entries/' + entry.id, { method: 'PUT', body });
      else await api(`/api/patients/${S.patient.id}/entries`, { method: 'POST', body: { kind: 'consigne', ...body } });
      toast(entry ? 'Consigne modifiée' : 'Consigne ajoutée'); refresh();
    },
    onDelete: entry ? async () => { await api('/api/entries/' + entry.id, { method: 'DELETE' }); toast('Consigne supprimée'); refresh(); } : null,
  });
  const el = (n) => form.elements[n];
  const update = () => {
    form.querySelector('[data-f="action_libre"]').classList.toggle('hidden', el('action').value !== 'Autre');
    el('libre').placeholder = CONS_HINTS[el('categorie').value] || '';
    const v = { action: el('action').value, action_libre: el('action_libre').value, categorie: el('categorie').value, libre: el('libre').value };
    $('#cons-preview-text').textContent = composeConsigne(v) || '—';
    $('#cons-preview-date').textContent = fmtDate(el('date').value);
  };
  ['action', 'action_libre', 'categorie', 'libre', 'date'].forEach(n => { el(n).addEventListener('input', update); el(n).addEventListener('change', update); });
  update();
}

// ---------- CRO : configuration partagée
let croConfigCache = null;
async function croConfig(force) { if (force || !croConfigCache) croConfigCache = await api('/api/cro/config'); return croConfigCache; }
const CRO_COLORS = ['#3f7cc4', '#3f9c9d', '#e08a3c', '#8a63c9', '#d0566c', '#5c9e4b', '#c4a23f', '#4b6584', '#b5651d', '#2d98da', '#a55eea', '#26a69a'];
function croPageShell(title, inner) {
  // STATS_SMOOTH_V24 : conserver le chrome et les onglets entre les rubriques.
  if (title !== 'Statistiques') {
    $('#app').innerHTML = topbar() + `<main class="patient" style="grid-template-rows:auto 1fr"><div class="tabsbar"><button class="btn-back" id="home-btn">${I.back} Retour à l'accueil</button><h2 class="cro-page-title">${esc(title)}</h2></div><div class="cro-page">${inner}</div></main>`;
    bindChrome();
    $('#home-btn').onclick = () => (location.hash = '#/home');
    return;
  }
  const template = document.createElement('template');
  template.innerHTML = inner;
  template.content.querySelectorAll('.sv-tabs').forEach(nav => nav.remove());
  let holder = document.getElementById('sv-stable-navigation');
  let page = document.querySelector('.sv-stable-main > .cro-page');
  if (!holder || !page) {
    $('#app').innerHTML = topbar() + `<main class="patient sv-stable-main" style="grid-template-rows:auto auto minmax(0,1fr)"><div class="tabsbar"><button class="btn-back" id="home-btn">${I.back} Retour à l'accueil</button><h2 class="cro-page-title">Statistiques</h2></div><div id="sv-stable-navigation"></div><div class="cro-page"></div></main>`;
    bindChrome();
    $('#home-btn').onclick = () => (location.hash = '#/home');
    holder = document.getElementById('sv-stable-navigation');
    page = document.querySelector('.sv-stable-main > .cro-page');
    holder.innerHTML = statsV2Nav(statsV2State.tab);
    statsV2BindTabs(holder);
  }
  holder.querySelectorAll('[data-sv-tab]').forEach(button => {
    const active = button.dataset.svTab === statsV2State.tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  // Seul le panneau de contenu change ; barre, en-tête et leurs événements persistent.
  page.classList.remove('sv-page', 'sv-residents');
  page.replaceChildren(template.content);
  page.scrollTop = 0;
}

// ---------- Onglet CRO du patient
async function renderCroTab(box, p) {
  box.innerHTML = `<div class="panel"><div class="panel-head"><h3>Comptes rendus opératoires</h3><button class="btn primary" id="add-cro">+ Nouveau CRO</button></div><div id="cro-list"><div class="empty">Chargement…</div></div></div>`;
  $('#add-cro').onclick = () => croForm(p.id);
  try {
    const r = await api(`/api/patients/${p.id}/cro`);
    const list = $('#cro-list'); if (!list || String(S.patient?.id) !== String(p.id)) return;
    list.innerHTML = r.reports.length ? r.reports.map(c => `<article class="cro-card">
        <div class="cro-card-head"><div><span class="cro-date">${fmtDate(c.date)}</span><h4>${esc(c.intitule)}</h4></div>
          <button type="button" class="maj-edit-pencil" data-cro-edit="${c.id}" title="Modifier ce CRO" aria-label="Modifier ce CRO">✎</button></div>
        <div class="cro-line"><span class="cro-lbl">Type</span><span class="chip cro-type">${esc(c.type_name || '—')}</span></div>
        <div class="cro-line"><span class="cro-lbl">Résidents</span><span>${c.residents.length ? c.residents.map(x => `<span class="chip off">${esc(x.name)}</span>`).join(' ') : '<span class="meta">Aucun</span>'}</span></div>
        <div class="cro-line"><span class="cro-lbl">CRO écrit</span>${c.has_document ? `<span><button type="button" class="btn" data-cro-view="${c.id}">Voir le CRO</button> <button type="button" class="btn" data-cro-dl="${c.id}">Télécharger</button> <small class="meta">${esc(c.doc_name)}</small></span>` : '<span class="meta">Aucun document Word</span>'}</div>
        <div class="meta">Saisi par ${esc(c.author)} · ${fmtTs(c.updated_at)}</div></article>`).join('') : '<div class="empty">Aucun compte rendu opératoire pour ce patient.</div>';
    const find = (id) => r.reports.find(c => String(c.id) === id);
    list.querySelectorAll('[data-cro-edit]').forEach(b => b.onclick = () => croForm(p.id, find(b.dataset.croEdit)));
    list.querySelectorAll('[data-cro-view]').forEach(b => b.onclick = () => previewCroDocument(p.id, find(b.dataset.croView)));
    list.querySelectorAll('[data-cro-dl]').forEach(b => b.onclick = () => downloadCroDocument(p.id, find(b.dataset.croDl), b));
  } catch (err) { const list = $('#cro-list'); if (list) list.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

async function croForm(pid, report) {
  let cfg;
  try { cfg = await croConfig(true); } catch (err) { toast(err.message, true); return; }
  const types = [...cfg.types];
  if (report && report.type_id && !types.some(t => t.id === report.type_id)) types.push({ id: report.type_id, name: report.type_name + ' (désactivé)' });
  const residents = [...cfg.residents];
  (report?.residents || []).forEach(x => { if (!residents.some(r => r.id === x.id)) residents.push({ id: x.id, name: x.name + ' (désactivé)' }); });
  const chosen = new Set((report?.residents || []).map(x => x.id));
  const ov = modal(`
    <div class="dialog-head"><h2>${report ? 'Modifier le CRO' : 'Nouveau compte rendu opératoire'}</h2><button class="icon-btn" data-close aria-label="Fermer">✕</button></div>
    <form class="dialog-body" id="cro-form" novalidate>
      <div class="fgrid">
        <div class="field"><label>Date de l'intervention</label><input type="date" name="date" required value="${esc(report?.date || today())}"></div>
        <div class="field"><label>Type d'intervention</label><select name="type_id" required><option value="">Choisir un type…</option>${types.map(t => `<option value="${t.id}" ${report?.type_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
        <div class="field full"><label>Intitulé de l'intervention</label><input name="intitule" required maxlength="160" placeholder="ex. Cholécystectomie cœlioscopique pour lithiase vésiculaire" value="${esc(report?.intitule || '')}"></div>
        <div class="field full"><label>Résidents ayant assisté à l'intervention</label>
          <div class="cro-residents">${residents.length ? residents.map(r => `<label class="cro-check"><input type="checkbox" name="resident" value="${r.id}" ${chosen.has(r.id) ? 'checked' : ''}> ${esc(r.name)}</label>`).join('') : '<span class="meta">Aucun résident enregistré — l’administrateur peut en ajouter dans le menu CRO.</span>'}</div></div>
        <div class="field full"><label>${report?.has_document ? 'Remplacer le CRO écrit (Word .docx)' : 'CRO écrit (Word .docx)'}</label><input type="file" name="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document">
          ${report?.has_document ? `<small class="meta">Document actuel : ${esc(report.doc_name)}. Laisser vide pour le conserver.</small><label class="cro-check"><input type="checkbox" name="remove_document"> Retirer le document actuel</label>` : '<small class="meta">Facultatif — 25 Mo maximum.</small>'}</div>
      </div>
      <div class="form-err" id="ferr"></div>
      <div class="form-actions">
        ${report ? '<button type="button" class="btn danger" data-del>Supprimer</button>' : ''}
        <div class="r"><button type="button" class="btn" data-close>Annuler</button><button class="btn primary" type="submit">Enregistrer</button></div>
      </div>
    </form>`, 'form-dialog');
  ov.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
  const form = $('#cro-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#ferr'); err.textContent = '';
    const el = form.elements;
    if (!el.date.value) { err.textContent = 'Champ obligatoire : date.'; return; }
    if (!el.type_id.value) { err.textContent = 'Choisissez un type d’intervention.'; return; }
    if (!el.intitule.value.trim()) { err.textContent = 'Champ obligatoire : intitulé de l’intervention.'; return; }
    const file = el.file.files[0];
    if (file && !/\.docx$/i.test(file.name)) { err.textContent = 'Le CRO doit être un fichier Word .docx.'; return; }
    if (file && file.size > 25 * 1024 * 1024) { err.textContent = 'Le fichier dépasse 25 Mo.'; return; }
    const fd = new FormData();
    fd.append('date', el.date.value); fd.append('type_id', el.type_id.value); fd.append('intitule', el.intitule.value.trim());
    fd.append('resident_ids', JSON.stringify([...form.querySelectorAll('input[name=resident]:checked')].map(i => Number(i.value))));
    if (file) fd.append('file', file);
    if (el.remove_document?.checked) fd.append('remove_document', '1');
    const submit = form.querySelector('[type=submit]'); submit.disabled = true;
    try {
      await api(report ? `/api/patients/${pid}/cro/${report.id}` : `/api/patients/${pid}/cro`, { method: report ? 'PUT' : 'POST', body: fd });
      closeModal(); toast(report ? 'CRO modifié' : 'CRO enregistré');
      if (String(S.patient?.id) === String(pid)) renderCroTab($('#tab-content'), S.patient);
    } catch (ex) { err.textContent = ex.message; } finally { submit.disabled = false; }
  };
  if (report) ov.querySelector('[data-del]').onclick = async () => {
    if (!confirm('Supprimer ce CRO et son document Word ?')) return;
    try { await api(`/api/patients/${pid}/cro/${report.id}`, { method: 'DELETE' }); closeModal(); toast('CRO supprimé'); renderCroTab($('#tab-content'), S.patient); }
    catch (ex) { $('#ferr').textContent = ex.message; }
  };
}

async function downloadCroDocument(pid, c, button) {
  if (button) button.disabled = true;
  try {
    const response = await patientDocumentResponse(`/api/patients/${pid}/cro/${c.id}/download`);
    const blob = await response.blob(), url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = c.doc_name || 'CRO.docx';
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { toast(error.message, true); } finally { if (button) button.disabled = false; }
}
async function previewCroDocument(pid, c) {
  releasePatientDocUrl();
  const overlay = modal(`<div class="dialog-head"><h2>CRO — ${esc(c.intitule)} (${fmtDate(c.date)})</h2><div class="doc-preview-actions"><button type="button" class="btn" id="cro-dl">Télécharger</button><button type="button" class="icon-btn" id="cro-close" aria-label="Fermer">✕</button></div></div><div class="document-preview-content"><div class="empty">Ouverture du document…</div></div>`, 'document-preview-dialog');
  $('#cro-close', overlay).onclick = closeModal;
  const dl = $('#cro-dl', overlay); dl.onclick = () => downloadCroDocument(pid, c, dl);
  const container = $('.document-preview-content', overlay);
  try {
    const response = await patientDocumentResponse(`/api/patients/${pid}/cro/${c.id}/preview`);
    const blob = await response.blob(); if (!container.isConnected) return;
    patientDocObjectUrl = URL.createObjectURL(blob);
    const frame = document.createElement('iframe'); frame.title = c.intitule; frame.className = 'patient-doc-frame'; frame.setAttribute('sandbox', ''); frame.src = patientDocObjectUrl;
    container.replaceChildren(frame);
  } catch (error) { if (container.isConnected) container.innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
}

// ---------- Statistiques : rendus communs
function croPeriodBar(id) {
  return `<div class="cro-period" id="${id}"><label>Du <input type="date" name="from"></label><label>au <input type="date" name="to"></label>
    <button type="button" class="btn" data-range="month">Ce mois</button><button type="button" class="btn" data-range="year">Cette année</button><button type="button" class="btn" data-range="all">Tout</button></div>`;
}
function bindCroPeriod(id, onChange) {
  const bar = $('#' + id), from = bar.querySelector('[name=from]'), to = bar.querySelector('[name=to]');
  const fire = () => onChange(from.value, to.value);
  from.onchange = fire; to.onchange = fire;
  bar.querySelectorAll('[data-range]').forEach(b => b.onclick = () => {
    const d = today();
    if (b.dataset.range === 'month') { from.value = d.slice(0, 8) + '01'; to.value = d; }
    else if (b.dataset.range === 'year') { from.value = d.slice(0, 5) + '01-01'; to.value = d; }
    else { from.value = ''; to.value = ''; }
    fire();
  });
}
function croQuery(from, to) { const q = new URLSearchParams(); if (from) q.set('from', from); if (to) q.set('to', to); const s = q.toString(); return s ? '?' + s : ''; }

// ---------- Page Statistiques (administrateur + modérateur) : statistiques, types, résidents
const isStaff = () => ['admin', 'moderateur'].includes(S.user?.role);
async function viewCroAdmin() {
  if (!isStaff()) { location.hash = '#/statistiques'; return; }
  const admin = S.user.role === 'admin';
  croPageShell('Statistiques', `
    <section class="panel cro-panel"><div class="panel-head"><h3 id="cro-stats-title">Statistiques des résidents</h3><span class="meta" id="cro-total"></span></div>
      ${croPeriodBar('cro-admin-period')}<div id="cro-stats"><div class="empty">Chargement…</div></div></section>
    ${admin ? `<div class="cro-admin-grid">
      <section class="panel cro-panel"><div class="panel-head"><h3>Types d'intervention</h3><button class="btn primary" id="cro-add-type">+ Ajouter</button></div><div id="cro-types"></div></section>
      <section class="panel cro-panel"><div class="panel-head"><h3>Résidents</h3><button class="btn primary" id="cro-add-res">+ Ajouter</button></div><p class="meta">Associez chaque résident à son compte pour qu’il voie ses propres statistiques.</p><div id="cro-res"></div></section>
    </div>` : ''}`);
  // Filtre par type d'intervention, ajouté dans la barre de période
  $('#cro-admin-period').insertAdjacentHTML('afterbegin', '<label class="cro-type-filter">Type <select name="type"><option value="">Tous les types</option></select></label>');
  const typeSelect = $('#cro-admin-period [name=type]');
  let period = ['', ''];
  const loadStats = async () => {
    const box = $('#cro-stats'); if (!box) return;
    try {
      const q = new URLSearchParams(croQuery(...period).slice(1));
      if (typeSelect.value) q.set('type_id', typeSelect.value);
      const r = await api('/api/cro/stats' + (q.toString() ? '?' + q : ''));
      const keep = typeSelect.value;
      typeSelect.innerHTML = '<option value="">Tous les types</option>' + r.types.map(t => `<option value="${t.id}">${esc(t.name)}${t.active ? '' : ' (désactivé)'}</option>`).join('');
      typeSelect.value = keep;
      const type = r.types.find(t => String(t.id) === keep);
      $('#cro-stats-title').textContent = type ? `${type.name} : comparaison des résidents` : 'Statistiques des résidents';
      $('#cro-total').textContent = `${r.total_reports} CRO sur la période`;
      box.innerHTML = type ? croTypeStatsHtml(r, type) : croAdminStatsHtml(r.rows, r.residents);
    } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  };
  typeSelect.onchange = loadStats;
  bindCroPeriod('cro-admin-period', (f, t) => { period = [f, t]; loadStats(); });
  if (admin) { try { await loadCroConfigTables(loadStats); } catch (err) { toast(err.message, true); } }
  await loadStats();
}

async function loadCroConfigTables(loadStats) {
  const cfg = await api('/api/cro/config?all=1'); croConfigCache = null;
  const users = cfg.users || [];
  $('#cro-types').innerHTML = `<table class="tbl"><thead><tr><th>Type</th><th>CRO</th><th>Statut</th><th></th></tr></thead><tbody>${cfg.types.map(t => `<tr><td><b>${esc(t.name)}</b></td><td>${t.uses}</td><td><span class="chip ${t.active ? 'on' : 'off'}">${t.active ? 'Actif' : 'Désactivé'}</span></td>
    <td class="cro-actions"><button class="btn" data-t-edit="${t.id}">Modifier</button> <button class="btn" data-t-toggle="${t.id}">${t.active ? 'Désactiver' : 'Activer'}</button>${t.uses ? '' : ` <button class="btn danger" data-t-del="${t.id}">Supprimer</button>`}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Aucun type</td></tr>'}</tbody></table>`;
  $('#cro-res').innerHTML = `<table class="tbl"><thead><tr><th>Résident</th><th>Compte associé</th><th>CRO</th><th>Statut</th><th></th></tr></thead><tbody>${cfg.residents.map(r => `<tr><td><b>${esc(r.name)}</b></td><td>${r.user_id ? esc(r.user_name + ' (' + r.username + ')') : '<span class="meta">Aucun</span>'}</td><td>${r.uses}</td><td><span class="chip ${r.active ? 'on' : 'off'}">${r.active ? 'Actif' : 'Désactivé'}</span></td>
    <td class="cro-actions"><button class="btn" data-r-edit="${r.id}">Modifier</button> <button class="btn" data-r-toggle="${r.id}">${r.active ? 'Désactiver' : 'Activer'}</button>${r.uses ? '' : ` <button class="btn danger" data-r-del="${r.id}">Supprimer</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Aucun résident</td></tr>'}</tbody></table>`;
  const T = (id) => cfg.types.find(t => String(t.id) === id), R = (id) => cfg.residents.find(r => String(r.id) === id);
  const done = async (msg) => { toast(msg); await loadCroConfigTables(loadStats); await loadStats(); };
  const fail = (e) => toast(e.message, true);
  const userOptions = [['', 'Aucun compte'], ...users.map(u => [String(u.id), `${u.full_name} (${u.username})`])];
  const typeForm = (t) => formModal({ title: t ? 'Modifier le type' : 'Nouveau type d’intervention', values: t || {}, fields: [{ name: 'name', label: 'Nom du type', required: true, full: true }],
    onSubmit: async (v) => { await api(t ? '/api/cro/types/' + t.id : '/api/cro/types', { method: t ? 'PUT' : 'POST', body: v }); await done(t ? 'Type modifié' : 'Type ajouté'); } });
  const resForm = (r) => formModal({ title: r ? 'Modifier le résident' : 'Nouveau résident', values: r ? { ...r, user_id: r.user_id ? String(r.user_id) : '' } : {},
    fields: [{ name: 'name', label: 'Nom du résident', required: true, full: true, placeholder: 'ex. Dr Mohammed Zougagh' }, { name: 'user_id', label: 'Compte de connexion associé', type: 'select', options: userOptions, full: true }],
    onSubmit: async (v) => { await api(r ? '/api/cro/residents/' + r.id : '/api/cro/residents', { method: r ? 'PUT' : 'POST', body: v }); await done(r ? 'Résident modifié' : 'Résident ajouté'); } });
  $('#cro-add-type').onclick = () => typeForm(null);
  $('#cro-add-res').onclick = () => resForm(null);
  document.querySelectorAll('[data-t-edit]').forEach(b => b.onclick = () => typeForm(T(b.dataset.tEdit)));
  document.querySelectorAll('[data-r-edit]').forEach(b => b.onclick = () => resForm(R(b.dataset.rEdit)));
  document.querySelectorAll('[data-t-toggle]').forEach(b => b.onclick = async () => { const t = T(b.dataset.tToggle); try { await api('/api/cro/types/' + t.id, { method: 'PUT', body: { active: !t.active } }); await done('Type mis à jour'); } catch (e) { fail(e); } });
  document.querySelectorAll('[data-r-toggle]').forEach(b => b.onclick = async () => { const r = R(b.dataset.rToggle); try { await api('/api/cro/residents/' + r.id, { method: 'PUT', body: { active: !r.active } }); await done('Résident mis à jour'); } catch (e) { fail(e); } });
  document.querySelectorAll('[data-t-del]').forEach(b => b.onclick = async () => { const t = T(b.dataset.tDel); if (!confirm(`Supprimer le type « ${t.name} » ?`)) return; try { await api('/api/cro/types/' + t.id, { method: 'DELETE' }); await done('Type supprimé'); } catch (e) { fail(e); } });
  document.querySelectorAll('[data-r-del]').forEach(b => b.onclick = async () => { const r = R(b.dataset.rDel); if (!confirm(`Supprimer le résident « ${r.name} » ?`)) return; try { await api('/api/cro/residents/' + r.id, { method: 'DELETE' }); await done('Résident supprimé'); } catch (e) { fail(e); } });
}

// Regroupe les lignes par résident ; les résidents actifs sans intervention apparaissent avec 0 pour comparer.
function croByResident(rows, residents) {
  const by = {};
  (residents || []).forEach(r => { by[r.id] = { name: r.name, counts: {}, total: 0 }; });
  rows.forEach(r => { (by[r.resident_id] ||= { name: r.resident + (r.active ? '' : ' (désactivé)'), counts: {}, total: 0 }); by[r.resident_id].counts[r.type_name] = r.n; by[r.resident_id].total += r.n; });
  return Object.values(by).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'fr'));
}

function croTypeStatsHtml(r, type) {
  const residents = croByResident(r.rows, r.residents);
  if (!residents.length) return '<div class="empty">Aucun résident enregistré.</div>';
  const total = residents.reduce((s, x) => s + x.total, 0);
  if (!total) return `<div class="empty">Aucune ${esc(type.name)} enregistrée avec des résidents sur cette période.</div>`;
  const max = Math.max(...residents.map(x => x.total), 1);
  const bars = residents.map((x, i) => `<div class="cro-bar-row"><span class="cro-rank">${i + 1}</span><span class="cro-bar-name">${esc(x.name)}</span>
      <div class="cro-bar-track">${x.total ? `<div class="cro-bar" style="width:${(x.total / max) * 100}%"><span style="flex:1;background:${CRO_COLORS[0]}"></span></div>` : ''}</div><b class="cro-bar-total">${x.total}</b></div>`).join('');
  const table = `<table class="tbl cro-matrix"><thead><tr><th>Résident</th><th>${esc(type.name)}</th><th>Part du total</th></tr></thead>
    <tbody>${residents.map(x => `<tr><td><b>${esc(x.name)}</b></td><td>${x.total || '<span class="meta">0</span>'}</td><td>${Math.round((x.total / total) * 100)} %</td></tr>`).join('')}</tbody>
    <tfoot><tr><td><b>Total participations</b></td><td><b>${total}</b></td><td><b>100 %</b></td></tr></tfoot></table>`;
  return `<div class="cro-bars">${bars}</div><h4 class="cro-sub">Détail</h4>${table}<p class="meta">Une intervention avec plusieurs résidents compte pour chacun d’eux.</p>`;
}

function croAdminStatsHtml(rows, activeResidents) {
  const residents = croByResident(rows, activeResidents);
  if (!rows.length) return '<div class="empty">Aucune intervention enregistrée avec des résidents sur cette période.</div>';
  const types = [...new Set(rows.map(r => r.type_name))].sort((a, b) => a.localeCompare(b, 'fr'));
  const color = Object.fromEntries(types.map((t, i) => [t, CRO_COLORS[i % CRO_COLORS.length]]));
  const max = Math.max(...residents.map(r => r.total), 1);
  const bars = residents.map((r, i) => `<div class="cro-bar-row"><span class="cro-rank">${i + 1}</span><span class="cro-bar-name">${esc(r.name)}</span>
      <div class="cro-bar-track">${r.total ? `<div class="cro-bar" style="width:${(r.total / max) * 100}%">${types.filter(t => r.counts[t]).map(t => `<span style="flex:${r.counts[t]};background:${color[t]}" title="${esc(t)} : ${r.counts[t]}"></span>`).join('')}</div>` : ''}</div>
      <b class="cro-bar-total">${r.total}</b></div>`).join('');
  const legend = `<div class="cro-legend">${types.map(t => `<span><i style="background:${color[t]}"></i>${esc(t)}</span>`).join('')}</div>`;
  const totals = Object.fromEntries(types.map(t => [t, residents.reduce((s, r) => s + (r.counts[t] || 0), 0)]));
  const table = `<div class="cro-table-wrap"><table class="tbl cro-matrix"><thead><tr><th>Résident</th>${types.map(t => `<th>${esc(t)}</th>`).join('')}<th>Total</th></tr></thead>
    <tbody>${residents.map(r => `<tr><td><b>${esc(r.name)}</b></td>${types.map(t => `<td>${r.counts[t] || '<span class="meta">0</span>'}</td>`).join('')}<td><b>${r.total}</b></td></tr>`).join('')}</tbody>
    <tfoot><tr><td><b>Total participations</b></td>${types.map(t => `<td><b>${totals[t]}</b></td>`).join('')}<td><b>${residents.reduce((s, r) => s + r.total, 0)}</b></td></tr></tfoot></table></div>`;
  return `<div class="cro-bars">${bars}</div>${legend}<h4 class="cro-sub">Détail par type d'intervention</h4>${table}<p class="meta">Une intervention avec plusieurs résidents compte pour chacun d’eux. Choisissez un type ci-dessus pour comparer les résidents sur ce type uniquement.</p>`;
}

// ---------- Page non administrateur : mes statistiques
async function viewMyStats() {
  croPageShell('Mes statistiques opératoires', `<section class="panel cro-panel"><div class="panel-head"><h3 id="my-stats-title">Statistiques</h3><span class="meta" id="my-stats-total"></span></div>${croPeriodBar('my-period')}<div id="my-stats"><div class="empty">Chargement…</div></div></section>`);
  let period = ['', ''];
  const load = async () => {
    const box = $('#my-stats'); if (!box) return;
    try {
      const r = await api('/api/cro/my-stats' + croQuery(...period));
      if (!r.resident) { $('#my-period')?.classList.add('hidden'); box.innerHTML = '<div class="empty">Votre compte n’est pas encore associé à un résident. Demandez à l’administrateur de vous associer dans le menu CRO.</div>'; return; }
      $('#my-stats-title').textContent = r.resident.name;
      const total = r.by_type.reduce((s, x) => s + x.n, 0);
      $('#my-stats-total').textContent = `${total} intervention(s)`;
      const max = Math.max(...r.by_type.map(x => x.n), 1);
      box.innerHTML = total ? `<div class="cro-bars">${r.by_type.map((x, i) => `<div class="cro-bar-row"><span class="cro-bar-name">${esc(x.type_name)}</span><div class="cro-bar-track"><div class="cro-bar" style="width:${(x.n / max) * 100}%"><span style="flex:1;background:${CRO_COLORS[i % CRO_COLORS.length]}"></span></div></div><b class="cro-bar-total">${x.n}</b></div>`).join('')}</div>
        <h4 class="cro-sub">Mes interventions</h4>
        <table class="tbl"><thead><tr><th>Date</th><th>Patient</th><th>Intitulé</th><th>Type</th></tr></thead><tbody>${r.reports.map(c => `<tr class="clickable" data-id="${c.patient_id}"><td>${fmtDate(c.date)}</td><td>${esc(c.nom + ' ' + (c.prenom || ''))}</td><td>${esc(c.intitule)}</td><td>${esc(c.type_name || '—')}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">Aucune intervention sur cette période.</div>';
      box.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => (location.hash = `#/patient/${tr.dataset.id}/cro`));
    } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  };
  bindCroPeriod('my-period', (f, t) => { period = [f, t]; load(); });
  await load();
}
// FIN CRO ET CONSIGNES V1

// ROLES MODERATEUR ET MOTIFS V1
const ROLE_LABELS = { admin: 'Administrateur', moderateur: 'Modérateur', medecin: 'Médecin' };

// ---------- Utilisateurs (administrateur + modérateur)
async function viewUsers() {
  if (!isStaff()) { location.hash = '#/home'; return; }
  $('#app').innerHTML = topbar() + `<main class="patient" style="grid-template-rows:auto 1fr"><div class="tabsbar"><button class="btn-back" id="home-btn">${I.back} Retour à l'accueil</button></div><div class="panel" id="users"></div></main>`;
  bindChrome();
  $('#home-btn').onclick = () => (location.hash = '#/home');
  const r = await api('/api/users');
  const admin = S.user.role === 'admin';
  const roleOptions = r.roles.map(x => [x, ROLE_LABELS[x] || x]);
  $('#users').innerHTML = `<div class="panel-head"><h3>Utilisateurs de l'équipe</h3><button class="btn primary" id="add-user">+ Nouvel utilisateur</button></div>
    ${admin ? '' : '<p class="meta">En tant que modérateur, vous gérez les comptes des médecins. Vos propres coordonnées se modifient dans « Mon compte ». Les autres comptes modérateurs sont gérés par l’administrateur.</p>'}
    <table class="tbl"><thead><tr><th>Identifiant</th><th>Nom complet</th><th>Rôle</th><th>Statut</th><th></th></tr></thead>
    <tbody>${r.users.map(u => `<tr><td><b>${esc(u.username)}</b></td><td>${esc(u.full_name)}</td><td>${ROLE_LABELS[u.role] || esc(u.role)}</td><td><span class="chip ${u.active ? 'on' : 'off'}">${u.active ? 'Actif' : 'Désactivé'}</span></td>
      <td style="text-align:right;white-space:nowrap">${u.id === S.user.id && !admin ? '<button class="btn" data-my-account>Mon compte</button>' : !u.manageable ? '<span class="chip off">Géré par l’administrateur</span>'
        : `<button class="btn" data-edit-user="${u.id}">Modifier</button> <button class="btn" data-pw="${u.id}">Mot de passe</button> ${u.role === 'admin' ? '<span class="chip on">Compte protégé</span>'
        : `<button class="btn ${u.active ? 'danger' : ''}" data-toggle-user="${u.id}" data-a="${u.active ? 0 : 1}">${u.active ? 'Désactiver' : 'Activer'}</button> <button class="btn danger" data-delete-user="${u.id}">Supprimer</button>`}`}</td></tr>`).join('')}</tbody></table>`;
  const U = (id) => r.users.find(x => String(x.id) === id);
  document.querySelectorAll('[data-my-account]').forEach(b => b.onclick = profileForm);
  $('#add-user').onclick = () => {
    const form = formModal({
      title: 'Nouvel utilisateur', submit: 'Créer', values: { role: 'medecin' },
      extra: admin ? '<p class="meta" id="mod-hint">Un modérateur se connecte directement avec l’identifiant et le mot de passe définis ici ; il pourra ensuite les modifier dans « Mon compte ».</p>' : '',
      fields: [{ name: 'username', label: 'Identifiant', required: true }, { name: 'full_name', label: 'Nom complet', required: true },
        ...(roleOptions.length > 1 ? [{ name: 'role', label: 'Rôle', type: 'select', options: roleOptions }] : []),
        { name: 'password', label: 'Mot de passe (8 caractères minimum)', type: 'password', required: true }],
      onSubmit: async (v) => { if (v.password.length < 8) throw new Error('Le mot de passe doit contenir au moins 8 caractères.'); await api('/api/users', { method: 'POST', body: { role: 'medecin', ...v } }); toast('Utilisateur créé'); viewUsers(); },
    });
    const hint = form.closest('.dialog')?.querySelector('#mod-hint'), role = form.elements.role;
    if (hint && role) { const sync = () => hint.classList.toggle('hidden', role.value !== 'moderateur'); role.onchange = sync; sync(); }
  };
  document.querySelectorAll('[data-edit-user]').forEach(b => b.onclick = () => {
    const u = U(b.dataset.editUser);
    formModal({
      title: 'Modifier le compte', values: u,
      fields: [{ name: 'username', label: 'Identifiant', required: true }, { name: 'full_name', label: 'Nom complet', required: true },
        ...(u.role !== 'admin' && roleOptions.length > 1 ? [{ name: 'role', label: 'Rôle', type: 'select', options: roleOptions }] : [])],
      onSubmit: async (v) => { await api('/api/users/' + u.id, { method: 'PUT', body: v }); toast('Compte modifié'); viewUsers(); },
    });
  });
  document.querySelectorAll('[data-pw]').forEach(b => b.onclick = () => formModal({
    title: 'Nouveau mot de passe', fields: [{ name: 'password', label: 'Mot de passe (8 caractères minimum)', type: 'password', required: true }],
    onSubmit: async (v) => { await api('/api/users/' + b.dataset.pw, { method: 'PUT', body: v }); toast('Mot de passe modifié'); },
  }));
  document.querySelectorAll('[data-toggle-user]').forEach(b => b.onclick = async () => {
    try { await api('/api/users/' + b.dataset.toggleUser, { method: 'PUT', body: { active: b.dataset.a === '1' } }); viewUsers(); } catch (e) { toast(e.message, true); }
  });
  document.querySelectorAll('[data-delete-user]').forEach(b => b.onclick = async () => {
    const u = U(b.dataset.deleteUser);
    if (!confirm(`Supprimer ${u.full_name} (${u.username}) ? Les dossiers et historiques seront conservés.`)) return;
    try { await api('/api/users/' + u.id, { method: 'DELETE' }); toast('Utilisateur supprimé'); await viewUsers(); } catch (e) { toast(e.message, true); }
  });
}

// ---------- Paramètres : motifs d'hospitalisation
// PARAMETRES V2 : motifs, traitements (onglet TRAITEMENT), médicaments de l'ordonnance, médecin responsable du CRH.
async function viewParametres() {
  if (!isStaff()) { location.hash = '#/home'; return; }
  const sections = [['motifs', 'Motifs d’hospitalisation'], ['traitements', 'Traitements (onglet TRAITEMENT)'], ['medicaments', 'Médicaments de l’ordonnance'], ['crh', 'CRH'], ...(S.user?.role === 'admin' ? [['maintenance', 'Maintenance']] : [])];
  croPageShell('Paramètres', `<div class="param-tabs">${sections.map(([k, l], i) => `<button class="btn ${i ? '' : 'primary'}" data-ps="${k}">${l}</button>`).join('')}</div><div id="param-body"></div>`);
  const body = $('#param-body');
  const show = async (key) => {
    document.querySelectorAll('[data-ps]').forEach(b => b.classList.toggle('primary', b.dataset.ps === key));
    body.innerHTML = '<section class="panel cro-panel"><div class="empty">Chargement…</div></section>';
    try { await ({ motifs: paramMotifs, traitements: paramTraitements, medicaments: paramMedicaments, crh: paramCrh, maintenance: paramMaintenance })[key](body); }
    catch (e) { body.innerHTML = `<section class="panel cro-panel"><div class="empty">${esc(e.message)}</div></section>`; }
  };
  document.querySelectorAll('[data-ps]').forEach(b => b.onclick = () => show(b.dataset.ps));
  await show('motifs');
}
// WIKIPEDIA TOUS CHAPITRES V5.3
function wikiAllChaptersPanel(reload){
 const overlay=modal(`<div class="dialog-head"><h2>Wikipédia — 22 chapitres</h2><button type="button" class="btn" data-wclose>Fermer</button></div><div class="dialog-body wiki-catalogue-body"><p>La préparation télécharge les pages Wikipédia sans modifier vos motifs. Le serveur doit avoir accès à Internet.</p><p class="meta">Source secondaire, pas un export OMS certifié. Contrôlez le JSON avant remplacement.</p><div data-wstatus>Initialisation…</div><div class="wiki-catalogue-actions" data-wactions></div></div>`,'wiki-catalogue-dialog');
 overlay.querySelector('[data-wclose]').onclick=closeModal;
 const status=overlay.querySelector('[data-wstatus]'),actions=overlay.querySelector('[data-wactions]');
 const begin=async()=>{
  actions.innerHTML='';status.textContent='Démarrage…';
  try{const job=await api('/api/motifs/wikipedia/preparer',{method:'POST',body:{}});store.set('cim10_wiki_job',job.job_id);poll(job.job_id);}catch(e){if(overlay.isConnected)status.textContent=e.message;}
 };
 const poll=async jid=>{
  if(!overlay.isConnected)return;
  try{
   const state=await api('/api/motifs/wikipedia/'+jid);if(!overlay.isConnected)return;
   status.textContent=(state.done||0)+' / 22 — '+(state.message||'')+(state.count?' — '+state.count+' codes':'');
   if(state.state==='running'){setTimeout(()=>poll(jid),1800);return;}
   if(state.state==='error'){
    actions.innerHTML='<button class="btn" type="button" data-retry>Relancer la préparation</button>';
    actions.querySelector('[data-retry]').onclick=()=>{store.set('cim10_wiki_job',null);begin();};return;
   }
   if(state.state!=='ready')return;
   const info=document.createElement('p');info.className='meta';info.textContent=Object.entries(state.counts||{}).map(([c,n])=>'Chapitre '+c+' : '+n).join(' · ')+(state.warnings?' — '+state.warnings+' remarque(s) à lire dans le JSON.':'');status.appendChild(info);
   actions.innerHTML='<button class="btn" type="button" data-json>Vérifier / télécharger le JSON</button><button class="btn primary" type="button" data-import>Importer ce catalogue</button>';
   actions.querySelector('[data-json]').onclick=async e=>{const b=e.currentTarget;b.disabled=true;try{const data=await api('/api/motifs/wikipedia/'+jid+'/donnees');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='cim10_wikipedia_22_chapitres.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(e){toast(e.message,true);}finally{if(b.isConnected)b.disabled=false;}};
   actions.querySelector('[data-import]').onclick=()=>formModal({title:'Importer '+state.count+' codes Wikipédia',extra:'<p class="meta">Le remplacement supprime tous les motifs du catalogue actuel. Sauvegarde automatique. Les dossiers patients conservent leur libellé et leur code.</p>',fields:[{name:'mode',label:'Mode',type:'select',options:[['replace','Remplacer totalement le catalogue'],['add','Ajouter en conservant les codes existants']]},{name:'confirmation',label:'Pour remplacer : recopier SUPPRIMER TOUS LES MOTIFS',full:true}],onSubmit:async v=>{if(v.mode==='replace'&&v.confirmation!=='SUPPRIMER TOUS LES MOTIFS')throw new Error('Confirmation exacte requise.');const result=await api('/api/motifs/wikipedia/'+jid+'/importer',{method:'POST',body:v});store.set('cim10_wiki_job',null);toast(result.total+' codes traités, '+result.added+' ajoutés.');await reload();}});
  }catch(e){if(overlay.isConnected)status.textContent=e.message;}
 };
 const previous=store.get('cim10_wiki_job');if(previous)poll(previous);else begin();
}

async function paramMotifs(body){
 body.innerHTML=`<section class="panel cro-panel"><div class="panel-head"><h3>Motifs d’hospitalisation / CIM-10</h3><div class="motif-param-actions"><button class="btn" id="import-motifs-oms">Importer CIM-10 / variantes</button><button class="btn" id="wiki-all-motifs">Préparer les 22 chapitres Wikipédia</button><button class="btn danger" id="purge-all-motifs">Supprimer tous les motifs</button><button class="btn primary" id="add-motif">+ Ajouter un motif</button></div></div>
 <p class="meta">Catalogue local — données extraites de Wikipédia (préparation des 22 chapitres disponible), non certifiées OMS. Un import officiel OMS reste disponible séparément. Les variantes PMSI/GM/CM peuvent être importées avec leur provenance. Les dossiers conservent leur libellé/code historiques sauf demande explicite de mise à jour.</p>
 <div class="motif-param-filter"><input type="search" id="motif-filter" placeholder="Rechercher par libellé ou code CIM-10" aria-label="Filtrer le catalogue"><span id="motif-count"></span></div>
 <div id="motifs"><div class="empty">Chargement…</div></div></section>`;
 let rows=[];
 const draw=()=>{
  const q=motifSearchText($('#motif-filter').value),compact=q.replace(/\./g,'');
  const filtered=rows.filter(m=>!q||motifSearchText(m.name).includes(q)||motifSearchText(m.code).includes(q)||(compact&&motifSearchText(m.code).replace(/\./g,'').includes(compact)));
  $('#motif-count').textContent=filtered.length+' / '+rows.length+' motifs'+(filtered.length>200?' — 200 premiers affichés, affinez la recherche':'');
  $('#motifs').innerHTML=`<div class="motif-table-scroll"><table class="tbl"><thead><tr><th>Pathologie / motif</th><th>Code CIM-10</th><th>Patients</th><th></th></tr></thead><tbody>${filtered.slice(0,200).map(m=>`<tr><td>${esc(m.name)}${m.source ? `<small class="motif-source">${esc(m.source)}</small>` : ''}</td><td><span class="cim-code">${esc(m.code||'—')}</span></td><td>${m.uses}</td><td class="cro-actions"><button class="btn" data-edit-motif="${m.id}">Modifier</button><button class="btn danger" data-del-motif="${m.id}">Supprimer</button></td></tr>`).join('')||'<tr><td colspan="4">Aucun résultat</td></tr>'}</tbody></table></div>`;
  $('#motifs').querySelectorAll('[data-edit-motif]').forEach(b=>b.onclick=()=>edit(rows.find(m=>String(m.id)===b.dataset.editMotif)));
  $('#motifs').querySelectorAll('[data-del-motif]').forEach(b=>b.onclick=async()=>{const m=rows.find(m=>String(m.id)===b.dataset.delMotif);if(!confirm('Supprimer « '+m.name+' » du catalogue ? Les dossiers conservent leurs informations.'))return;try{await api('/api/motifs/'+m.id,{method:'DELETE'});await load();}catch(e){toast(e.message,true);}});
 };
 const load=async()=>{rows=(await api('/api/motifs')).motifs;motifCatalogue=rows;draw();};
 const edit=m=>formModal({title:m?'Modifier le motif':'Ajouter un motif',values:m||{},
  fields:[{name:'name',label:'Pathologie / motif',required:true,full:true},{name:'code',label:'Code CIM-10',placeholder:'Facultatif — ex. K35.9'},...(m?[{name:'apply_to_patients',label:'Dossiers hospitalisés',type:'checkbox',hint:'Actualiser aussi les dossiers utilisant ce motif (libellé et code)',full:true}]:[])],
  onSubmit:async v=>{await api('/api/motifs'+(m?'/'+m.id:''),{method:m?'PUT':'POST',body:v});toast('Motif enregistré');await load();}});
 $('#add-motif').onclick=()=>edit(null);$('#motif-filter').oninput=draw;
 $('#wiki-all-motifs').onclick=()=>wikiAllChaptersPanel(load);
 $('#purge-all-motifs').onclick=()=>formModal({title:'Supprimer tous les motifs',extra:'<p class="meta">Tous les motifs personnalisés ou importés du catalogue seront supprimés. Sauvegarde automatique. Les patients et leurs motifs enregistrés restent conservés.</p>',fields:[{name:'confirmation',label:'Recopier : SUPPRIMER TOUS LES MOTIFS',required:true,full:true}],onSubmit:async v=>{if(v.confirmation!=='SUPPRIMER TOUS LES MOTIFS')throw new Error('Confirmation incorrecte.');const r=await api('/api/motifs/supprimer-tout',{method:'POST',body:v});toast(r.deleted+' motifs supprimés, sauvegarde créée.');await load();}});
 $('#import-motifs-oms').onclick=()=>formModal({title:'Importer un catalogue CIM-10 / variantes nationales',
  extra:'<p class="meta">Import XML ClaML (OMS, PMSI, GM, CM) ou XML tabulaire ICD-10-CM. Périmètre : K00–K93, S30–S39 et codes ciblés de chirurgie générale (tumeurs et infections). Les libellés français sont privilégiés si présents ; aucune traduction automatique. Les dossiers patients existants ne sont pas modifiés.</p>',
  fields:[{name:'terminology',label:'Référentiel du fichier',type:'select',options:[['AUTO','Détection automatique'],['OMS','CIM-10 OMS'],['PMSI','CIM-10-FR / PMSI'],['GM','ICD-10-GM'],['CM','ICD-10-CM']],required:true},
   {name:'variant',label:'Identifiant de variante dans le XML (facultatif)',placeholder:'Ex. FM ; laisser vide si non nécessaire',full:true},
   {name:'replace_existing',label:'Codes déjà présents',type:'checkbox',hint:'Remplacer leur libellé et provenance dans le catalogue uniquement (pas les dossiers patients)',full:true},
   {name:'file',label:'Fichier XML (extraire le ZIP au préalable)',type:'file',accept:'.xml',required:true,full:true}],
  onSubmit:async(v,form)=>{
   const file=form.elements.file.files[0];if(file.size>80000000)throw new Error('Fichier limité à 80 Mo.');
   const fd=new FormData();fd.append('file',file);fd.append('terminology',v.terminology);fd.append('variant',v.variant||'');fd.append('replace_existing',v.replace_existing?'1':'0');
   const result=await api('/api/motifs/import-oms',{method:'POST',body:fd});
   toast(result.already_imported?'Fichier et options déjà importés':result.source+' : '+result.added+' ajoutés, '+result.updated+' actualisés, '+result.matched+' déjà présents. Langue(s) : '+result.languages.join(', '));
   await load();
  }});
 await load();
}

async function paramTraitements(body) {
  body.innerHTML = `<section class="panel cro-panel"><div class="panel-head"><h3>Traitements de l’onglet TRAITEMENT</h3><button class="btn primary" id="add-ttt">+ Ajouter un traitement</button></div>
    <p class="meta">Liste proposée dans l’onglet TRAITEMENT et ordre d’affichage sur la fiche de traitement (par groupe). Modifier ou supprimer un traitement ne change pas les traitements déjà prescrits aux patients.</p><div id="ttt-list"><div class="empty">Chargement…</div></div></section>`;
  let groupes = [];
  const fields = () => [
    { name: 'nom', label: 'Traitement (tel qu’affiché)', required: true, full: true, placeholder: 'Ex. Perfalgan 1 g/8H si douleur' },
    { name: 'rang', label: 'Groupe', type: 'select', options: groupes.map((g, i) => [String(i), g]) },
    { name: 'prises', label: 'Prises par jour (0 = cases vides)', type: 'number', required: true },
    { name: 'jours', label: 'Jours sur la fiche (1 à 6)', type: 'number', required: true },
  ];
  const bounds = (f) => { f.elements.prises.min = '0'; f.elements.prises.max = '24'; f.elements.jours.min = '1'; f.elements.jours.max = '6'; };
  const payload = (v) => ({ nom: v.nom, rang: Number(v.rang), prises: Number(v.prises), jours: Number(v.jours) });
  const load = async () => {
    const r = await api('/api/parametres/traitements'); groupes = r.groupes; treatmentCatalogueCache = null;
    $('#ttt-list').innerHTML = `<table class="tbl"><thead><tr><th>Traitement</th><th>Groupe</th><th>Prises/jour</th><th>Jours fiche</th><th>Prescrit</th><th></th></tr></thead><tbody>${r.traitements.map(t => `<tr><td><b>${esc(t.nom)}</b></td><td>${esc(groupes[t.rang] || '')}</td><td>${t.prises}</td><td>${t.jours}</td><td>${t.uses}</td>
      <td class="cro-actions"><button class="btn" data-t-edit="${t.id}">Modifier</button> <button class="btn danger" data-t-del="${t.id}">Supprimer</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Aucun traitement</td></tr>'}</tbody></table>`;
    const T = (id) => r.traitements.find(t => String(t.id) === id);
    document.querySelectorAll('[data-t-edit]').forEach(b => b.onclick = () => { const t = T(b.dataset.tEdit);
      bounds(formModal({ title: 'Modifier le traitement', values: { ...t, rang: String(t.rang) }, fields: fields(),
        extra: t.uses ? `<p class="meta">Ce traitement est prescrit ${t.uses} fois : les prescriptions existantes gardent leur nom actuel.</p>` : '',
        onSubmit: async (v) => { await api('/api/parametres/traitements/' + t.id, { method: 'PUT', body: payload(v) }); toast('Traitement modifié'); load(); } })); });
    document.querySelectorAll('[data-t-del]').forEach(b => b.onclick = async () => { const t = T(b.dataset.tDel); if (!confirm(`Supprimer « ${t.nom} » de la liste ?`)) return;
      try { await api('/api/parametres/traitements/' + t.id, { method: 'DELETE' }); toast('Traitement supprimé'); load(); } catch (e) { toast(e.message, true); } });
  };
  $('#add-ttt').onclick = () => bounds(formModal({ title: 'Nouveau traitement', values: { rang: '5', prises: 1, jours: 6 }, fields: fields(),
    onSubmit: async (v) => { await api('/api/parametres/traitements', { method: 'POST', body: payload(v) }); toast('Traitement ajouté'); load(); } }));
  await load();
}
async function paramMedicaments(body) {
  body.innerHTML = `<section class="panel cro-panel"><div class="panel-head"><h3>Médicaments de l’ordonnance de sortie</h3><button class="btn primary" id="add-med">+ Ajouter un médicament</button></div>
    <p class="meta">Liste proposée dans l’onglet SORTIE (bouton « Choisir des médicaments »). Un même médicament peut figurer plusieurs fois avec une posologie ou une durée différente.</p><div id="med-list"><div class="empty">Chargement…</div></div></section>`;
  const fields = [{ name: 'nom', label: 'Médicament', required: true, full: true, placeholder: 'Ex. Ixor 20 mg cp' }, { name: 'posologie', label: 'Posologie', placeholder: 'Ex. 1 cp/j le matin à jeun' }, { name: 'duree', label: 'Durée', placeholder: 'Ex. 1 mois' }];
  const load = async () => {
    const r = await api('/api/parametres/medicaments');
    $('#med-list').innerHTML = `<table class="tbl"><thead><tr><th>Médicament</th><th>Posologie</th><th>Durée</th><th></th></tr></thead><tbody>${r.medicaments.map(m => `<tr><td><b>${esc(m.nom)}</b></td><td>${esc(m.posologie)}</td><td>${esc(m.duree)}</td>
      <td class="cro-actions"><button class="btn" data-d-edit="${m.id}">Modifier</button> <button class="btn danger" data-d-del="${m.id}">Supprimer</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Aucun médicament</td></tr>'}</tbody></table>`;
    const D = (id) => r.medicaments.find(m => String(m.id) === id);
    document.querySelectorAll('[data-d-edit]').forEach(b => b.onclick = () => { const m = D(b.dataset.dEdit); formModal({ title: 'Modifier le médicament', values: m, fields,
      onSubmit: async (v) => { await api('/api/parametres/medicaments/' + m.id, { method: 'PUT', body: v }); toast('Médicament modifié'); load(); } }); });
    document.querySelectorAll('[data-d-del]').forEach(b => b.onclick = async () => { const m = D(b.dataset.dDel); if (!confirm(`Supprimer « ${m.nom} — ${m.posologie} — ${m.duree} » de la liste ?`)) return;
      try { await api('/api/parametres/medicaments/' + m.id, { method: 'DELETE' }); toast('Médicament supprimé'); load(); } catch (e) { toast(e.message, true); } });
  };
  $('#add-med').onclick = () => formModal({ title: 'Nouveau médicament', fields,
    onSubmit: async (v) => { await api('/api/parametres/medicaments', { method: 'POST', body: v }); toast('Médicament ajouté'); load(); } });
  await load();
}
async function paramMaintenance(body) {
  const [st, preview] = await Promise.all([api('/api/admin/storage').catch(e => ({ error: e.message })), api('/api/admin/reinitialisation')]);
  const counts = (preview.counts || []).map(([k, v]) => `<li><b>${v}</b> ${esc(k)}</li>`).join('');
  const stor = st.error ? `<p class="meta">Stockage : ${esc(st.error)}</p>` : `<p class="meta">Stockage des fichiers : <b>${st.backend === 'r2' ? 'Cloudflare R2 (' + esc(st.bucket || '') + ')' : 'disque local'}</b> — ${st.ok ? 'opérationnel' : 'erreur : ' + esc(st.error || '')}${st.db_backup && st.db_backup.enabled ? ` · sauvegarde de la base vers R2 toutes les ${st.db_backup.interval_minutes} min${st.db_backup.last ? ' (dernière : ' + esc(st.db_backup.last) + ')' : ''}` : ''}${st.local_files_pending_migration ? ` · <b>${st.local_files_pending_migration}</b> fichier(s) locaux à migrer vers R2` : ''}</p>`;
  body.innerHTML = `<section class="panel cro-panel"><div class="panel-head"><h3>Stockage et sauvegarde</h3></div>${stor}
    <div class="maint-actions">${st.backend === 'r2' ? `<button class="btn" id="maint-test">Tester R2 (écriture / lecture)</button><button class="btn" id="maint-backup">Sauvegarder la base maintenant</button>${st.local_files_pending_migration ? '<button class="btn" id="maint-migrate">Migrer les fichiers locaux vers R2</button>' : ''}` : ''}</div>
    <p class="meta" id="maint-out"></p></section>
    <section class="panel cro-panel maint-danger"><div class="panel-head"><h3>Réinitialiser la plateforme</h3></div>
    <p>Supprime <b>définitivement</b> tous les dossiers de test : patients hospitalisés, sortis et archivés, passages aux urgences, entrées, imageries, documents, comptes rendus opératoires et journal. Les comptes utilisateurs, les catalogues (motifs CIM-10, traitements, médicaments, types de CRO, résidents) et les réglages sont conservés. Les statistiques du service repartent de zéro.</p>
    <ul class="maint-counts">${counts || '<li>Aucune donnée.</li>'}</ul>
    <button class="btn danger" id="maint-reset">Réinitialiser la plateforme…</button></section>`;
  const out = $('#maint-out');
  const run = async (btn, fn) => { btn.disabled = true; out.textContent = 'En cours…'; try { out.textContent = await fn(); } catch (e) { out.textContent = e.message; } btn.disabled = false; };
  const t = $('#maint-test'); if (t) t.onclick = () => run(t, async () => { const r = await api('/api/admin/storage/test', { method: 'POST', body: {} }); return 'R2 OK : ' + (r.steps || []).join(' → '); });
  const b = $('#maint-backup'); if (b) b.onclick = () => run(b, async () => { const r = await api('/api/admin/storage/backup', { method: 'POST', body: {} }); return r.uploaded ? 'Sauvegarde envoyée vers R2 (' + Math.round((r.size || 0) / 1024) + ' Ko).' : 'Sauvegarde déjà à jour.'; });
  const m = $('#maint-migrate'); if (m) m.onclick = () => run(m, async () => { const r = await api('/api/admin/storage/migrer', { method: 'POST', body: {} }); return `Migration : ${r.uploaded ?? r.report?.uploaded ?? 0} fichier(s) envoyé(s).`; });
  $('#maint-reset').onclick = () => formModal({
    title: 'Réinitialiser la plateforme', submit: 'Tout supprimer définitivement',
    extra: '<p class="urg-muted" style="margin:0 0 8px">Action irréversible. Pensez à télécharger ce dont vous avez besoin avant. Saisissez votre mot de passe administrateur et le mot <b>REINITIALISER</b>.</p>',
    fields: [{ name: 'password', label: 'Mot de passe administrateur', type: 'password', required: true, full: true }, { name: 'confirmation', label: 'Saisissez REINITIALISER', required: true, full: true, placeholder: 'REINITIALISER' }],
    onSubmit: async (v) => {
      const r = await api('/api/admin/reinitialisation', { method: 'POST', body: { password: v.password, confirmation: v.confirmation } });
      toast(`Plateforme réinitialisée : ${r.removed_rows} enregistrement(s), ${r.removed_files} fichier(s) supprimés` + (r.files_error ? ' — ' + r.files_error : ''), !!r.files_error);
      paramMaintenance(body);
    },
  });
}
async function paramCrh(body) {
  const r = await api('/api/parametres/reglages');
  body.innerHTML = `<section class="panel cro-panel"><div class="panel-head"><h3>Compte rendu d’hospitalisation</h3></div>
    <form id="crh-settings" class="fgrid" style="max-width:720px"><div class="field full"><label>Médecin responsable par défaut</label><input name="crh_medecin_responsable" value="${esc(r.reglages.crh_medecin_responsable || '')}" placeholder="Ex. Pr Bouziane, Pr Jabi, Pr Guellil"></div>
    <p class="meta full" style="grid-column:1/-1">Repris dans le tableau d’en-tête du CRH. Il reste modifiable patient par patient dans l’onglet SORTIE.</p>
    <div style="grid-column:1/-1"><button class="btn primary" type="submit">Enregistrer</button></div></form></section>`;
  $('#crh-settings').onsubmit = async (e) => { e.preventDefault();
    try { await api('/api/parametres/reglages', { method: 'PUT', body: { crh_medecin_responsable: e.target.elements.crh_medecin_responsable.value } }); toast('Réglage enregistré'); } catch (err) { toast(err.message, true); } };
}

// ---------- Champs Nom unique + motif (liste + Autre)
// CIN CIM10 V5
let motifCatalogue=[];
const motifSearchText=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase().replace(/\s+/g,' ').trim();
function patientMotifLabel(p){return String(p.motif||'')+(p.motif_code?' ('+p.motif_code+')':'');}
async function loadMotifs(){motifCatalogue=(await api('/api/motifs')).motifs;return motifCatalogue;}
function motifFields(motifs){
 return [{name:'motif_choice',label:'Motif d’hospitalisation — recherche nom / code CIM-10',type:'select',full:true,
  options:[['','Choisir un motif…'],...motifs.map(m=>[String(m.id),m.name+(m.code?' ('+m.code+')':'')]),['__autre','Autre (saisie libre)']]},
 {name:'motif_libre',label:'Autre motif (texte libre)',full:true,placeholder:'Saisir le motif'},
 {name:'motif_code_libre',label:'Code CIM-10 (facultatif pour un motif libre)',placeholder:'Ex. K35.9'}];
}
function motifValues(current,motifs,storedId=null,storedCode=''){
 const name=String(current||'').trim();
 if(!name)return {motif_choice:'',motif_libre:'',motif_code_libre:''};
 const found=motifs.find(m=>String(m.id)===String(storedId)&&m.name===name&&String(m.code||'')===String(storedCode||''))||
  motifs.find(m=>motifSearchText(m.name)===motifSearchText(name)&&String(m.code||'')===String(storedCode||''));
 return found?{motif_choice:String(found.id),motif_libre:'',motif_code_libre:''}:{motif_choice:'__autre',motif_libre:name,motif_code_libre:storedCode||''};
}
function bindMotifToggle(form){
 const select=form.elements.motif_choice,field=form.querySelector('[data-f=motif_choice]');
 select.hidden=true;select.style.display='none';
 const wrap=document.createElement('div');wrap.className='motif-combo';
 const input=document.createElement('input');input.type='search';input.autocomplete='off';input.placeholder='Rechercher une pathologie ou un code CIM-10…';
 input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','false');
 input.setAttribute('aria-label','Rechercher un motif par nom ou code CIM-10');
 const list=document.createElement('div');list.className='motif-combo-list';list.setAttribute('role','listbox');list.hidden=true;
 list.id='motif-list-'+Math.random().toString(36).slice(2);input.setAttribute('aria-controls',list.id);
 wrap.append(input,list);field.append(wrap);let filtered=[],active=-1;
 const sync=()=>{
  const other=select.value==='__autre';
  for(const name of ['motif_libre','motif_code_libre'])form.querySelector('[data-f='+name+']').classList.toggle('hidden',!other);
 };
 const selectedLabel=()=>select.value==='__autre'?'Autre (saisie libre)':motifCatalogue.find(m=>String(m.id)===select.value)?.name||'';
 const close=()=>{list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;};
 const choose=m=>{
  select.value=String(m.id);input.value=m.id==='__autre'?'Autre (saisie libre)':m.name+(m.code?' ('+m.code+')':'');
  select.dispatchEvent(new Event('change',{bubbles:true}));close();
 };
 const mark=()=>{[...list.querySelectorAll('[role=option]')].forEach((el,i)=>{el.classList.toggle('active',i===active);el.setAttribute('aria-selected',String(i===active));if(i===active){input.setAttribute('aria-activedescendant',el.id);el.scrollIntoView({block:'nearest'});}});};
 const render=()=>{
  const query=motifSearchText(input.value),compact=query.replace(/\./g,'');
  filtered=motifCatalogue.filter(m=>!query||motifSearchText(m.name).includes(query)||motifSearchText(m.code).includes(query)||(compact&&motifSearchText(m.code).replace(/\./g,'').includes(compact)));
  filtered=filtered.slice(0,100);
  filtered.push({id:'__autre',name:'Autre (saisie libre)',code:''});active=-1;
  list.innerHTML='<div class="motif-limit-note">100 résultats maximum — affinez par nom ou code</div>'+filtered.map((m,i)=>`<div role="option" id="${list.id}-${i}" aria-selected="false" data-choice="${i}"><span>${esc(m.name)}</span><span class="cim-code">${esc(m.code||'')}</span></div>`).join('');
  list.querySelectorAll('[data-choice]').forEach(el=>el.onmousedown=e=>{e.preventDefault();choose(filtered[Number(el.dataset.choice)]);});
  list.hidden=false;input.setAttribute('aria-expanded','true');
 };
 select.addEventListener('change',sync);
 input.addEventListener('input',()=>{select.value='';sync();render();});
 input.addEventListener('focus',()=>{const chosen=select.value;input.value='';render();if(chosen)input.placeholder=selectedLabel()||'Rechercher…';});
 input.addEventListener('blur',()=>{close();if(!input.value&&select.value)input.value=select.selectedOptions[0]?.textContent||'';});
 input.addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(list.hidden)render();active=Math.max(0,Math.min(filtered.length-1,active+(e.key==='ArrowDown'?1:-1)));mark();}
  else if(e.key==='Enter'&&!list.hidden){e.preventDefault();if(active>=0)choose(filtered[active]);}
  else if(e.key==='Escape'){e.preventDefault();close();}
 });
 input.value=select.value?select.selectedOptions[0]?.textContent||'':'';sync();
}
function motifPayload(v){
 const {motif_choice,motif_libre,motif_code_libre,...rest}=v;
 if(motif_choice==='__autre'){
  if(!String(motif_libre||'').trim())throw new Error('Précisez le motif libre.');
  return {...rest,motif:String(motif_libre).trim(),motif_code:String(motif_code_libre||'').trim().toUpperCase(),motif_id:null};
 }
 const selected=motifCatalogue.find(m=>String(m.id)===motif_choice);
 if(!selected)throw new Error('Choisissez un motif dans les résultats ou sélectionnez Autre.');
 return {...rest,motif:selected.name,motif_code:selected.code||'',motif_id:selected.id};
}

async function admitForm(pre) {
  const m = S.meta, motifs = await loadMotifs();
  const values = { ...pre, groupe: 'Inconnu', loc_type: pre.hors_service ? 'hs' : 'room', hors_service: (pre.hors_service || '').trim(), date_entree: today(), motif_choice: '' };
  const form = formModal({
    title: 'Admettre un patient', submit: 'Admettre', values,
    fields: [
      { name: 'nom', label: 'Nom', required: true, placeholder: 'Nom et prénom' },
      { name: 'sexe', label: 'Sexe', type: 'select', options: [['', 'Non renseigné'], ['M', 'Masculin'], ['F', 'Féminin']] }, { name: 'age', label: 'Âge', type: 'number' }, { name: 'ip', label: 'IP', required: true }, { name: 'cin', label: 'CIN — Carte nationale d’identité', placeholder: 'Facultatif' },
      { name: 'mutuelle', label: 'Mutuelle', type: 'select', options: m.mutuelles }, { name: 'groupe', label: 'Groupe sanguin', type: 'select', options: m.groupes },
      { name: 'date_entree', label: 'Date d\'entrée', type: 'date' },
      ...motifFields(motifs),
      ...locationFields(m),
    ],
    onSubmit: async (v) => {
      if (v.loc_type === 'hs' && !v.hors_service.trim()) throw new Error('Indiquez le service d\'hébergement.');
      if (v.loc_type === 'room' && (!v.room || !v.position)) throw new Error('Choisissez la chambre et le lit.');
      const { loc_type, ...rest } = motifPayload(v);
      const r = await api('/api/patients', { method: 'POST', body: { ...rest, prenom: '', ...locPayload(v) } });
      toast('Patient admis'); location.hash = `#/patient/${r.id}/maj`;
    },
  });
  bindLocToggle(form); bindMotifToggle(form);
}

async function editIdentity() {
  const p = S.patient, m = S.meta, motifs = await loadMotifs();
  const form = formModal({
    title: 'Identité, motif & emplacement',
    values: { ...p, nom: [p.nom, p.prenom].filter(Boolean).join(' '), groupe: p.groupe || 'Inconnu', loc_type: p.hors_service ? 'hs' : 'room', ...motifValues(p.motif, motifs,p.motif_id,p.motif_code) },
    fields: [
      { name: 'nom', label: 'Nom', required: true, placeholder: 'Nom et prénom' },
      { name: 'sexe', label: 'Sexe', type: 'select', options: [['', 'Non renseigné'], ['M', 'Masculin'], ['F', 'Féminin']] }, { name: 'age', label: 'Âge', type: 'number' }, { name: 'ip', label: 'IP', required: true }, { name: 'cin', label: 'CIN — Carte nationale d’identité', placeholder: 'Facultatif' },
      { name: 'mutuelle', label: 'Mutuelle', type: 'select', options: m.mutuelles }, { name: 'groupe', label: 'Groupe sanguin', type: 'select', options: m.groupes },
      { name: 'date_entree', label: 'Date d\'entrée', type: 'date' },
      ...motifFields(motifs),
      ...(p.status === 'sorti' ? [] : locationFields(m)),
    ],
    onSubmit: async (v) => {
      const { loc_type, ...rest } = motifPayload(v);
      let body = { ...rest, prenom: '' };
      if (p.status !== 'sorti') {
        if (loc_type === 'hs' && !v.hors_service.trim()) throw new Error('Indiquez le service d\'hébergement.');
        if (loc_type === 'room' && (!v.room || !v.position)) throw new Error('Choisissez la chambre et le lit.');
        body = { ...body, ...locPayload(v) };
      }
      await api('/api/patients/' + p.id, { method: 'PUT', body });
      toast('Dossier mis à jour'); refresh();
    },
    onDelete: isAdmin() ? async () => {
      if (await adminDeletePatient(p)) location.hash = p.status === 'sorti' ? '#/archives' : '#/home';
    } : null,
  });
  if (p.status !== 'sorti') bindLocToggle(form, {existingId:p.id});
  bindMotifToggle(form);
}

// ------------------------------------------------- SUPPRESSION DÉFINITIVE (administrateur)
function isAdmin() { return !!(S.user && S.user.role === 'admin'); }
async function adminDeletePatient(p) {
  const info = await api('/api/patients/' + p.id + '/suppression');
  const who = `${p.nom} ${p.prenom || ''}`.trim();
  const typed = prompt(`Suppression DÉFINITIVE du dossier de ${who} (IP ${p.ip}) — ${p.status === 'sorti' ? 'patient sorti' : 'patient hospitalisé'}.\n\n`
    + `Seront effacés : ${info.entries} entrée(s), ${info.files} fichier(s) (imageries, documents, CRO), ${info.logs} ligne(s) de journal`
    + (info.urgences ? `, ${info.urgences} passage(s) aux urgences liés` : '') + `.\nCette action est irréversible.\n\nPour confirmer, saisissez l’IP du patient :`);
  if (typed === null) return false;
  if (typed.trim() !== String(p.ip)) throw new Error('IP incorrecte : suppression annulée.');
  await api('/api/patients/' + p.id, { method: 'DELETE' });
  toast('Dossier supprimé définitivement');
  return true;
}
async function adminDeleteUrgence(p) {
  const info = await api('/api/urgences/patients/' + p.id + '/suppression');
  const typed = prompt(`Suppression DÉFINITIVE de ${p.nom} des urgences avec tout son historique :\n`
    + `${info.passages} passage(s), ${info.consignes} consigne(s), ${info.fichiers} fichier(s) (imageries et documents).`
    + (info.dossiers_service.length ? `\nLe dossier d’hospitalisation dans le service n’est pas supprimé (à supprimer depuis la plateforme si besoin).` : '')
    + `\nCette action est irréversible.\n\nPour confirmer, saisissez SUPPRIMER :`);
  if (typed === null) return false;
  if (typed.trim().toUpperCase() !== 'SUPPRIMER') throw new Error('Confirmation incorrecte : suppression annulée.');
  await api('/api/urgences/patients/' + p.id, { method: 'DELETE' });
  toast('Patient supprimé définitivement des urgences');
  return true;
}
// FIN ROLES MODERATEUR ET MOTIFS V1

// ------------------------------------------------- ÉCHANGE DE LITS V1
function bedPlace(p) { return p.room ? 'Chambre ' + p.room + (p.position || '') : 'Hors service : ' + (p.hors_service || '—'); }
async function swapBedForm(p, onDone) {
  let data;
  try { data = await api('/api/lits'); } catch (ex) { toast(ex.message, true); return; }
  const others = (data.patients || []).filter(x => x.id !== p.id);
  const free = data.free_beds || [];
  if (!others.length && !free.length) { toast('Aucun lit libre ni autre patient hospitalisé.', true); return; }
  const options = [['', '— Choisir le nouvel emplacement —'],
    ...free.map(b => ['bed:' + b.room + ':' + b.position, 'Lit libre : ' + b.label]),
    ...others.map(x => ['pat:' + x.id, `Échanger avec : ${bedPlace(x)} — ${x.nom} ${x.prenom || ''} (IP ${x.ip})`.trim()])];
  formModal({
    title: 'Changer de chambre / de lit', submit: 'Déplacer',
    extra: `<p class="urg-muted" style="margin:0 0 8px">${esc(p.nom)} ${esc(p.prenom || '')} occupe actuellement <b>${esc(bedPlace(p))}</b>. Choisissez un lit libre, ou un patient avec qui échanger les emplacements ; les dossiers et l’historique sont conservés.</p>`,
    fields: [{ name: 'target', label: 'Nouvel emplacement', type: 'select', options, full: true, required: true }],
    onSubmit: async (v) => {
      if (!v.target) throw new Error('Choisissez un lit libre ou un patient avec qui échanger.');
      if (v.target.startsWith('pat:')) {
        const other = others.find(x => String(x.id) === v.target.slice(4));
        await api('/api/patients/' + p.id + '/echanger-lit', { method: 'POST', body: { target_id: Number(v.target.slice(4)) } });
        toast(`Lits échangés : ${p.nom} → ${bedPlace(other)}, ${other.nom} → ${bedPlace(p)}`);
      } else {
        const [, room, position] = v.target.split(':');
        await api('/api/patients/' + p.id + '/echanger-lit', { method: 'POST', body: { room, position } });
        toast(`${p.nom} déplacé vers la chambre ${room}${position}`);
      }
      if (onDone) onDone(); else if (S.patient && S.patient.id === p.id) refresh(); else location.hash = '#/home';
    },
  });
}

// ------------------------------------------------------------------ router
async function render() {
  const parts = (location.hash || '#/home').slice(2).split('/');
  if (!S.token) { if (parts[0] !== 'login') { location.hash = '#/login'; } viewLogin(); return; }
  if (!S.user) { try { S.user = (await api('/api/me')).user; } catch { return; } }
  closeModal();
  if (S.user.must_change_password) {viewFirstLogin(); return;}
  try {
    await syncClock();
    if (!S.meta) S.meta = await api('/api/meta');
    if (parts[0] === 'patient' && parts[1]) {
      const tab = visiblePatientTabs().some(t => t[0] === parts[2]) ? parts[2] : 'maj';
      if(parts[2]&&parts[2]!==tab){location.hash='#/patient/'+parts[1]+'/'+tab;return;}
      if (!S.patient || String(S.patient.id) !== parts[1]) S.patient = null;
      await viewPatient(parts[1], tab);
    } else if (parts[0] === 'patients-a-staffer') { S.patient = null; await viewPatientsAStaffer(); }
    else if (parts[0] === 'service-stats') { S.patient = null; await viewStatisticsV2(); }
    else if (parts[0] === 'cro-admin') { S.patient = null; await viewStatisticsV2(); }
    else if (parts[0] === 'statistiques') { S.patient = null; if (isStaff()) { location.hash = '#/cro-admin'; return; } await viewMyStats(); }
    else if (parts[0] === 'parametres') { S.patient = null; await viewParametres(); }
    else if (parts[0] === 'archives') { S.patient = null; await viewArchives(); }
    else if (parts[0] === 'users') { S.patient = null; await viewUsers(); }
    else if (parts[0] === 'journal') { S.patient = null; await viewJournal(); }
    else if (parts[0] === 'urgences') { S.patient = null; await viewUrgences(); }
    else { if (parts[0] !== 'home') { location.hash = '#/home'; return; } S.patient = null; await viewHome(); }
  } catch (err) { toast(err.message, true); }
}

// BEGIN SORTIE WORD INTEGRATED V2
// Documents Word uniquement. Chargé après app.js.
(() => {
'use strict';
// CRH V4.1 : sources strictement séparées, observation initiale structurée.
function crhNorm(t){return String(t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[’']/g,' ').replace(/\s+/g,' ').trim();}
function crhSections(text){
 const result={identity:[],hdm:[],clinical:[]};let section=null;
 for(const raw of String(text||'').split(/\r?\n/)){
  const clean=raw.trim().replace(/^\*+|\*+$/g,'').trim();
  const n=crhNorm(clean.replace(/\s*:\s*$/,''));
  let next=null;
  if(/^identite$/.test(n))next='identity';
  else if(/^(hdm|histoire (de |de la |de l |d une )?maladie|histoire de la maladie actuelle)$/.test(n))next='hdm';
  else if(/^examen clinique$/.test(n))next='clinical';
  else if(/^(motif|atcd|antecedent|bilan|bb\b|examen complementaire|examens complementaires|tdm\b|irm\b|echograph|avis\b|conclusion|diagnostic|prise en charge|traitement|evolution)/.test(n))next='skip';
  if(next){section=next;continue;}
  // Tout autre titre marqué ferme la rubrique, sauf les sous-titres cliniques.
  const sub=section==='clinical'&&/^examen\s+/.test(n);
  if(!sub&&/^\*+.*:\s*\*+$/.test(raw.trim())){section='skip';continue;}
  if(result[section])result[section].push(clean);
 }
 return Object.fromEntries(Object.entries(result).map(([k,v])=>[k,v.join('\n').trim()]));
}
buildCrhDraft=function(p,E,options={}){
 const obs=crhOrdered(crhStayEntries(E.observation||[],p));
 // Une seule observation de référence : la première contenant les rubriques demandées.
 const sections=obs.map(o=>crhSections(crhText(o)));
 const ref=sections.find(o=>o.identity&&o.hdm&&o.clinical)||sections.find(o=>o.identity||o.hdm||o.clinical)||{};
 const lines=['Identité :',ref.identity||'Non renseignée dans l’observation.', '', 'Motif :',p.motif||'Non renseigné', ''];
 const atcd=(E.atcd||[]).map(crhText).filter(Boolean);
 lines.push(atcd.length?'ATCDs :\n'+atcd.join('\n'):'ATCDs : RAS', '', 'HDM :',ref.hdm||'Non renseignée dans l’observation.', '', 'Examen clinique :',ref.clinical||'Non renseigné dans l’observation.');
 const bilans=E.bilan||[]; // Bilans du dossier, y compris avant admission.
 if(bilans.length)lines.push('',...crhBilanLines(bilans));
 const exams=crhOrdered(E.examen||[]); // Examens du dossier, sans filtre de séjour.
 if(exams.length){
  lines.push('');
  exams.forEach((e,index)=>{
   if(index)lines.push('');
   lines.push(examCrhHeading(e));
   const conclusion=String(e.content||'').trim();
   if(conclusion)lines.push(conclusion);
  });
 }
 lines.push('',crhCareText(options));
 const who=p.sexe==='F'?'Patiente déclarée sortante':p.sexe==='M'?'Patient déclaré sortant':'Patient(e) déclaré(e) sortant(e)';
 lines.push('',who+' le '+(fmtDate(p.sortie_date)||'date à préciser')+' sous :','');
 for(const line of String(p.sortie_ordonnance||'').split('\n')){
  const m=line.match(/^• (.*?) — Posologie : (.*?) — Durée : (.*)$/);
  if(m)lines.push(m[1],[m[2],m[3]].filter(v=>v.trim()).map(v=>v.trim()).join(' '),'');
  else if(line.trim())lines.push(line);
 }
 return lines.join('\n').trim();
};
crhCareText=function(options={}){
 const ops=options.care==='intervention'?(options.operations||[]).filter(o=>String(o.name||'').trim()):[];
 if(ops.length)return ops.map(o=>'Intervention le '+(fmtDate(o.date)||'date à préciser')+' : '+String(o.name).trim()).join('\n');
 return options.care==='intervention'?'Intervention : type et date à renseigner.':'Le patient a bénéficié d’une surveillance clinico-biologique.';
};
function wordMenu(){
 // SORTIE V3 : impression possible avant la validation ; la fiche modifiée est enregistrée en brouillon avant le téléchargement.
 const patient=S.patient;
 if(!patient)return;
 const form=document.querySelector('#sortie-form');
 const fields=['date_entree','sortie_date','sortie_mode','sortie_destination','sortie_medecin','sortie_resume','sortie_ordonnance'];
 const saveIfNeeded=async()=>{
  if(!form||!form.isConnected)return;
  const body=sortieBody(form);
  if(!fields.some(key=>key in body&&String(body[key]||'').trim()!==String(patient[key]||'').trim()))return;
  await api('/api/patients/'+patient.id+'/sortie',{method:'POST',body:{...body,valider:false}});
  for(const key of fields)if(key in body)patient[key]=String(body[key]||'').trim();
  toast('Fiche de sortie enregistrée (brouillon)');
 };
 const overlay=modal(`<div class="dialog-head"><h2>Documents de sortie — Word</h2><button class="btn" type="button" data-word-close>Fermer</button></div><div class="word-download-body"><p>Téléchargez le document, puis ouvrez-le dans Word pour le modifier ou l’imprimer.</p><p class="word-download-note">La sortie n’a pas besoin d’être validée. Vos modifications sont enregistrées en brouillon avant le téléchargement.</p><div class="word-download-actions"><button type="button" class="btn primary" data-word-kind="crh">Télécharger le CRH (.docx)</button><button type="button" class="btn primary" data-word-kind="ordonnance">Télécharger l’ordonnance (.docx)</button></div></div>`, 'word-download-dialog');
 overlay.querySelector('[data-word-close]').onclick=closeModal;
 overlay.querySelectorAll('[data-word-kind]').forEach(button=>button.onclick=async()=>{
  button.disabled=true;
  try{
   const kind=button.dataset.wordKind;
   await saveIfNeeded();
   const response=await fetch(API+'/api/patients/'+patient.id+'/sortie-document/'+kind+'/docx',{headers:{Authorization:'Bearer '+S.token},credentials:'same-origin'});
   if(!response.ok){let message='Téléchargement impossible.';try{message=(await response.json()).error||message;}catch{}if(response.status===401)logout(true);throw new Error(message);}
   const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');
   link.href=url;link.download=kind+'_'+String(patient.nom||'patient').replace(/[^\p{L}\p{N}_-]+/gu,'_')+'_'+patient.id+'.docx';
   document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }catch(error){toast(error.message,true);}finally{if(button.isConnected)button.disabled=false;}
 });
}
document.addEventListener('click',event=>{
 if(event.target.closest('#print')&&document.querySelector('#sortie-form')){
  event.preventDefault();event.stopImmediatePropagation();wordMenu();
 }
},true);
})();

// END SORTIE WORD INTEGRATED V2

// REGIME ALIMENTAIRE PATIENT V1
async function renderPatientRegime(box,pid){
 box.innerHTML=`<div class="panel"><div class="panel-head"><h3>AUTRES</h3></div><section style="max-width:620px" aria-labelledby="regime-heading"><h4 id="regime-heading" style="margin:0 0 14px">Régime alimentaire</h4><form data-regime-form class="fgrid" style="grid-template-columns:minmax(0,1fr)"><div class="field full"><label for="patient-regime-choice">Régime du patient</label><select id="patient-regime-choice" name="regime_code" disabled><option value="">Chargement…</option></select></div><div class="field full" data-regime-other hidden><label for="patient-regime-other">Préciser le régime</label><textarea id="patient-regime-other" name="regime_texte" maxlength="1000" placeholder="Régime alimentaire à préciser"></textarea></div><p class="form-err full" role="status" data-regime-message style="margin:0"></p><div class="full"><button class="btn primary" type="submit" disabled>Enregistrer le régime</button></div></form></section></div>`;
 const form=box.querySelector('[data-regime-form]'),choice=form.elements.regime_code,text=form.elements.regime_texte,other=form.querySelector('[data-regime-other]'),message=form.querySelector('[data-regime-message]'),save=form.querySelector('[type=submit]');
 const toggle=()=>{const on=choice.value==='AUTRE';other.hidden=!on;text.required=on;};
 const status=(value,error=false)=>{message.textContent=value;message.style.color=error?'var(--danger,#b42c3a)':'var(--muted,#5d6f86)';};
 form.onsubmit=e=>e.preventDefault();
 try{
  const data=await api('/api/patients/'+pid+'/regime');if(!form.isConnected)return;
  choice.replaceChildren(new Option('— Non renseigné —',''));
  data.options.forEach(row=>choice.add(new Option(row.label,row.code)));
  choice.value=data.regime.code||'';text.value=data.regime.texte||'';toggle();choice.disabled=false;save.disabled=false;
  if(data.regime.updated_at)status('Enregistré le '+fmtTs(data.regime.updated_at));
  choice.onchange=()=>{toggle();status('Modification non enregistrée');};text.oninput=()=>status('Modification non enregistrée');
  form.onsubmit=async event=>{
   event.preventDefault();if(save.disabled)return;
   if(choice.value==='AUTRE'&&!text.value.trim()){status('Précisez le régime alimentaire.',true);text.focus();return;}
   const body={code:choice.value,texte:choice.value==='AUTRE'?text.value.trim():''};
   save.disabled=true;choice.disabled=true;text.disabled=true;
   try{await api('/api/patients/'+pid+'/regime',{method:'PUT',body});if(!form.isConnected)return;status('Régime enregistré');toast('Régime alimentaire enregistré');}
   catch(error){if(form.isConnected)status(error.message,true);}
   finally{if(form.isConnected){save.disabled=false;choice.disabled=false;text.disabled=false;}}
  };
 }catch(error){if(form.isConnected)status('Chargement impossible : '+error.message,true);}
}


// IMPORT OBSERVATION V1 — dans le bloc privé de l'application.
function addObservationImportButton(box,pid){
 const target=box.querySelector('#motif-edit');if(!target||target.querySelector('[data-observation-import]'))return;
 const button=document.createElement('button');button.type='button';button.className='btn primary no-print';button.dataset.observationImport='1';button.textContent='Préremplir depuis l’observation';
 button.style.cssText='position:fixed;right:14px;bottom:14px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:18;font-size:11px;padding:8px 12px;max-width:230px;box-shadow:0 2px 8px #0f2d4f22';
 button.onclick=event=>{event.stopPropagation();openObservationImport(pid);};target.append(button);
}
async function openObservationImport(pid){
 if(!document.getElementById('obs-import-compact-style')){
  const style=document.createElement('style');style.id='obs-import-compact-style';style.textContent=`.obs-import-dialog{width:min(900px,96vw)}.obs-import-dialog .dialog-head{padding:12px 16px;align-items:center}.obs-import-dialog .dialog-head h2{font-size:19px}.obs-import-dialog .dialog-body{padding:12px 16px;gap:8px}.obs-import-dialog label{font-size:12px}.obs-import-dialog input[type=text],.obs-import-dialog select,.obs-import-dialog textarea{box-sizing:border-box;width:100%;border:1px solid var(--line);border-radius:5px;padding:5px 7px;font:inherit;font-size:12px}.obs-import-dialog textarea{height:64px;min-height:48px;resize:vertical}.obs-import-dialog [data-import-item]{border:1px solid var(--line);border-radius:8px;padding:8px;margin-bottom:8px;display:grid;gap:5px}.obs-import-dialog .oi-two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}.obs-import-dialog .oi-warning{font-size:11px;color:#925b10;margin:2px 0;white-space:pre-wrap}.obs-import-dialog .oi-lab{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px 8px}.obs-import-dialog .oi-lab label{display:grid;grid-template-columns:46px minmax(0,1fr);gap:4px;align-items:center}.obs-import-dialog .oi-lab input{min-width:0;padding:4px 5px}.obs-import-dialog .oi-actions{position:sticky;bottom:0;background:var(--surface,#fff);padding:7px 0;display:grid;gap:6px}.obs-import-dialog [data-error]{margin:0;font-size:12px}.obs-import-dialog [data-source-note]{margin:0;font-size:12px}.obs-import-dialog .oi-actions[hidden]{display:none}.obs-import-dialog .oi-heading{font-weight:600;font-size:12px;overflow-wrap:anywhere}@media(max-width:600px){.obs-import-dialog .oi-lab{grid-template-columns:repeat(2,minmax(0,1fr))}.obs-import-dialog .oi-lab label{grid-template-columns:40px minmax(0,1fr)}.obs-import-dialog .oi-two{grid-template-columns:1fr}.obs-import-dialog input[type=text],.obs-import-dialog select,.obs-import-dialog textarea{font-size:16px}.obs-import-dialog .oi-lab input{font-size:16px}.obs-import-dialog .dialog-body{padding:10px;gap:7px}}`;document.head.append(style);
 }
 const ov=modal(`<div class="dialog-head"><h2>Préremplir MAJ</h2><button class="icon-btn" data-close aria-label="Fermer">✕</button></div><div class="dialog-body"><label>Observation source<select data-source disabled></select></label><p data-source-note></p><button class="btn" type="button" data-preview disabled>Analyser l’observation</button><p class="form-err" data-error role="status"></p><div data-items></div><div class="oi-actions" data-actions hidden><label><input type="checkbox" data-confirm> Éléments, dates et valeurs vérifiés.</label><button class="btn primary" type="button" data-apply>Enregistrer dans MAJ</button></div></div>`,'obs-import-dialog');
 ov.querySelector('[data-close]').onclick=closeModal;
 const select=ov.querySelector('[data-source]'),preview=ov.querySelector('[data-preview]'),apply=ov.querySelector('[data-apply]'),error=ov.querySelector('[data-error]'),list=ov.querySelector('[data-items]'),confirm=ov.querySelector('[data-confirm]'),actions=ov.querySelector('[data-actions]');
 let draft=null,sourceKey='';
 const displayDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')?value.slice(8,10)+'/'+value.slice(5,7)+'/'+value.slice(0,4):value||'';
 const sourceDate=item=>item.date?displayDate(item.date):(item.title||'').match(/\d{1,2}[/.\-]\d{1,2}[/.\-](?:\d{4}|\d{2})(?!\d)/)?.[0]||'';
 const isoDate=value=>{
  const text=String(value).trim();let m=text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})$/),y,mo,d;
  if(m){d=+m[1];mo=+m[2];y=m[3].length===2?2000+Number(m[3]):Number(m[3]);}else{m=text.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return '';y=+m[1];mo=+m[2];d=+m[3];}
  const dt=new Date(0);dt.setUTCFullYear(y,mo-1,d);dt.setUTCHours(0,0,0,0);
  if(y<1900||dt.getUTCFullYear()!==y||dt.getUTCMonth()!==mo-1||dt.getUTCDate()!==d)return '';
  return String(y).padStart(4,'0')+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0');
 };
 const clear=()=>{draft=null;list.replaceChildren();actions.hidden=true;confirm.checked=false;};select.onchange=clear;
 try{
  const data=await api('/api/patients/'+pid+'/observation-import/sources');if(!ov.isConnected)return;
  select.add(new Option('— Choisir l’observation —',''));data.sources.forEach(row=>select.add(new Option(row.label,row.id)));
  select.disabled=false;preview.disabled=false;ov.querySelector('[data-source-note]').textContent=data.sources.length?'':'Aucune observation trouvée pour ce séjour.';
 }catch(e){if(ov.isConnected)error.textContent=e.message;}
 preview.onclick=async()=>{
  if(!select.value){error.textContent='Choisissez une observation.';return;}
  clear();error.textContent='';preview.disabled=true;
  try{
   sourceKey=select.value;draft=await api('/api/patients/'+pid+'/observation-import/preview',{method:'POST',body:{source:sourceKey}});if(!ov.isConnected)return;
   list.innerHTML=draft.items.map((item,i)=>{
    const warnings=(item.warnings||[]).filter(w=>!w.startsWith('Catégorie proposée')).map(w=>`<p class="oi-warning">${esc(w)}</p>`).join('');
    let fields='';
    if(item.kind==='bilan')fields=`<label>Date<input type="text" data-date value="${esc(sourceDate(item))}" placeholder="jj/mm/aaaa"></label><div class="oi-lab">${renderObservationBilanValues(item.values)}</div>`;
    else if(item.kind==='examen')fields=`<div class="oi-two"><label>Date à vérifier<input type="text" data-date value="${esc(sourceDate(item))}" placeholder="jj/mm/aaaa"></label><label>Lieu<input data-place value="${esc(item.place||'')}"></label></div><label>Compte rendu<textarea data-content>${esc(item.content)}</textarea></label>`;
    else fields=`<label>Antécédents<textarea data-content style="height:90px">${esc(item.content)}</textarea></label>`;
    return `<section data-import-item="${i}"><label class="oi-heading"><input type="checkbox" data-include ${item.kind==='atcd'||item.date?'checked':''}> ${item.kind==='atcd'?'Antécédents':esc(item.title)}</label>${warnings}${fields}</section>`;
   }).join('')||'<p>Aucun élément reconnu.</p>';
   actions.hidden=!draft.items.length;
  }catch(e){if(ov.isConnected)error.textContent=e.message;}finally{if(ov.isConnected)preview.disabled=false;}
 };
 apply.onclick=async()=>{
  error.textContent='';if(!draft||!confirm.checked){error.textContent='Vérifiez les éléments puis confirmez.';return;}
  const items=[];
  for(const section of list.querySelectorAll('[data-import-item]')){
   if(!section.querySelector('[data-include]').checked)continue;
   const item={...draft.items[Number(section.dataset.importItem)]};
   if(item.kind!=='atcd'){
    const raw=section.querySelector('[data-date]').value;item.date=isoDate(raw);
    if(!item.date){error.textContent='Date à corriger avant enregistrement : '+raw+'. Aucune correction automatique.';section.querySelector('[data-date]').focus();return;}
   }
   if(item.kind==='bilan'){item.units_confirmed=true;item.values=Object.fromEntries([...section.querySelectorAll('[data-value]')].map(input=>[input.dataset.value,input.value.trim()]));}
   else{
    item.content=section.querySelector('[data-content]').value;
    if(item.kind==='examen'){item.place=section.querySelector('[data-place]').value;item.title=item.title.replace(/\d{1,2}[/.\-]\d{1,2}[/.\-](?:\d{4}|\d{2})(?!\d)/,displayDate(item.date));}
    else item.category='';
   }
   items.push(item);
  }
  if(!items.length){error.textContent='Sélectionnez au moins un élément.';return;}
  apply.disabled=true;preview.disabled=true;select.disabled=true;
  try{
   const result=await api('/api/patients/'+pid+'/observation-import/apply',{method:'POST',body:{source:sourceKey,source_hash:draft.source_hash,items}});
   draft=null;actions.hidden=true;
   if(result.skipped?.length)alert(result.added+' élément(s) ajouté(s).\n'+result.skipped.join('\n'));
   closeModal();toast(result.added+' élément(s) ajouté(s) dans MAJ');if(String(S.patient?.id)===String(pid))await refresh();
  }catch(e){if(ov.isConnected)error.textContent=e.message;}
  finally{if(ov.isConnected){apply.disabled=false;preview.disabled=false;select.disabled=false;}}
 };
}

function renderObservationBilanValues(values){
 if(!document.getElementById('oi-bilan-order-style')){
  const style=document.createElement('style');style.id='oi-bilan-order-style';style.textContent=`.obs-import-dialog .oi-lab{display:flex;flex-direction:column;gap:4px}.obs-import-dialog .oi-lab .oi-bilan-row{display:grid;grid-template-columns:88px minmax(0,1fr);gap:6px;align-items:center;font-size:12px}.obs-import-dialog .oi-bilan-values{display:flex;gap:5px;align-items:center;max-width:310px}.obs-import-dialog .oi-bilan-values input{width:0;min-width:0;flex:1;padding:4px 6px}.obs-import-dialog .oi-bilan-row>span{font-weight:500}@media(max-width:600px){.obs-import-dialog .oi-lab .oi-bilan-row{grid-template-columns:82px minmax(0,1fr)}.obs-import-dialog .oi-bilan-values{max-width:none}}`;document.head.append(style);
 }
 const groups=LAB_GROUPS.map(([label,keys])=>[label,[...keys]]);
 const known=new Set(groups.flatMap(([,keys])=>keys));
 Object.keys(values).filter(key=>!known.has(key)).forEach(key=>groups.push([key,[key]]));
 return groups.filter(([,keys])=>keys.some(key=>String(values[key]??'').trim())).map(([label,keys])=>
 `<div class="oi-bilan-row"><span>${esc(label)} :</span><div class="oi-bilan-values">${keys.map(key=>`<input data-value="${esc(key)}" value="${esc(values[key]??'')}" aria-label="${esc(key)}">`).join('<span aria-hidden="true">/</span>')}</div></div>`
 ).join('');
}


// COPY OBSERVATION BUTTON V1
async function copyMedicalObservationText(text){
 if(navigator.clipboard?.writeText){
  try{await navigator.clipboard.writeText(text);return true;}catch(error){}
 }
 const textarea=document.createElement('textarea');textarea.value=text;textarea.readOnly=true;
 textarea.style.cssText='position:fixed;left:-9999px;top:0;opacity:0;font-size:16px';
 const previous=document.activeElement;document.body.append(textarea);textarea.select();textarea.setSelectionRange(0,textarea.value.length);
 try{return typeof document.execCommand==='function'&&document.execCommand('copy')===true;}
 catch(error){return false;}
 finally{textarea.remove();try{previous?.focus({preventScroll:true});}catch(error){}}
}
function bindObservationCopyButtons(box,observations){
 box.querySelectorAll('[data-eid^="observation:"]').forEach(card=>{
  if(card.querySelector('[data-copy-observation]'))return;
  const id=card.dataset.eid.split(':')[1],observation=observations.find(row=>String(row.id)===id);
  if(!observation)return;
  const text=String(observation.content||'');
  const button=document.createElement('button');button.type='button';button.className='btn no-print';button.dataset.copyObservation=id;button.textContent='Copier';
  button.setAttribute('aria-label','Copier le texte de cette observation');button.title='Copier l’observation';
  button.style.cssText='float:right;margin:0 0 6px 8px;font-size:11px;padding:5px 10px;min-height:32px';
  button.onclick=async event=>{
   event.preventDefault();event.stopPropagation();if(button.disabled)return;
   if(!text){toast('Cette observation est vide.',true);return;}
   button.disabled=true;
   try{
    if(await copyMedicalObservationText(text)){toast('Observation copiée');}
    else{
     const ov=modal(`<div class="dialog-head"><h2>Copier l’observation</h2><button type="button" class="icon-btn" data-copy-close aria-label="Fermer">✕</button></div><div class="dialog-body"><p style="margin:0;font-size:13px">La copie automatique n’est pas disponible dans ce navigateur. Le texte est sélectionné : utilisez Copier.</p><textarea data-copy-text readonly style="width:100%;min-height:220px;font-size:16px">${esc(text)}</textarea></div>`,'form-dialog');
     ov.querySelector('[data-copy-close]').onclick=closeModal;
     const area=ov.querySelector('[data-copy-text]');area.focus();area.select();area.setSelectionRange(0,area.value.length);
    }
   }catch(error){toast('Impossible de copier l’observation : '+error.message,true);}
   finally{if(button.isConnected)button.disabled=false;}
  };
  card.prepend(button);
 });
}


// STATS_UI_V2_BEGIN
const statsV2State={tab:'overview',from:'',to:'',group:'mensuel',metric:'admissions',search:'',sort:'desc',limit:'10',mode:'bars',data:null};
const statsV2Tabs=[['overview','Vue d’ensemble'],['activity','Activité'],['outcomes','Mortalité & réadmissions'],['treatments','Médicaments'],['surgery','Interventions'],['residents','Résidents'],['quality','Qualité des données']];
function statsV2Nav(active){return `<nav class="sv-tabs" aria-label="Rubriques statistiques">${statsV2Tabs.map(([k,l])=>`<button type="button" data-sv-tab="${k}" class="${k===active?'active':''}" aria-current="${k===active?'page':'false'}">${esc(l)}</button>`).join('')}</nav>`;}
function statsV2BindTabs(root){root.querySelectorAll('[data-sv-tab]').forEach(b=>b.onclick=()=>{statsV2State.tab=b.dataset.svTab;statsV2State.search='';viewStatisticsV2();});}
function statsV2Table(rows,columns){return `<div class="sv-table"><table class="tbl"><thead><tr>${columns.map(([k,l])=>`<th scope="col">${esc(l)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${columns.map(([k,l])=>`<td>${esc(r[k]??'—')}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="${columns.length}">Aucune donnée sur cette sélection.</td></tr>`}</tbody></table></div>`;}
function statsV2Bars(rows,percent=false){
 const max=Math.max(1,...rows.map(r=>Number(r.n)||0));
 return rows.length?`<div class="sv-bars">${rows.map(r=>`<div class="sv-bar-row"><span title="${esc(r.libelle)}">${esc(r.libelle)}</span><div class="sv-track"><i style="width:${Math.max(0,Number(r.n)||0)/max*100}%"></i></div><strong>${esc(r.n??'—')}${percent&&r.n!=null?' %':''}</strong></div>`).join('')}</div>`:'<p class="sv-empty">Aucune donnée sur cette sélection.</p>';
}
function statsV2Card(label,value,note=''){return `<article class="sv-card"><span>${esc(label)}</span><strong>${esc(value??'—')}</strong><small>${esc(note)}</small></article>`;}
function statsV2Panel(title,body,note=''){return `<section class="sv-panel"><header><h3>${esc(title)}</h3>${note?`<p>${esc(note)}</p>`:''}</header>${body}</section>`;}
function statsV2Pairs(obj){return Object.entries(obj||{}).map(([libelle,n])=>({libelle,n}));}
function statsV2SelectRows(rows){
 const s=statsV2State,q=s.search.toLocaleLowerCase();
 const filtered=rows.filter(r=>!q||String(r.libelle).toLocaleLowerCase().includes(q));
 filtered.sort((a,b)=>s.sort==='name'?String(a.libelle).localeCompare(String(b.libelle),'fr'):s.sort==='asc'?a.n-b.n:b.n-a.n);
 return s.limit==='all'?filtered:filtered.slice(0,Number(s.limit));
}
function statsV2List(rows,label='Nombre'){
 const selected=statsV2SelectRows(rows);
 return statsV2State.mode==='table'?statsV2Table(selected,[['libelle','Libellé'],['n',label]]):statsV2Bars(selected);
}
function statsV2Controls(){const s=statsV2State;return `<div class="sv-local"><input type="search" data-sv-search placeholder="Rechercher un libellé…" value="${esc(s.search)}" aria-label="Rechercher un libellé"><label>Trier <select data-sv-sort><option value="desc">Nombre décroissant</option><option value="asc">Nombre croissant</option><option value="name">Nom A → Z</option></select></label><label>Afficher <select data-sv-limit><option value="10">10 premiers</option><option value="20">20 premiers</option><option value="all">Tout</option></select></label><label>Vue <select data-sv-mode><option value="bars">Barres</option><option value="table">Tableau</option></select></label></div>`;}
async function viewStatisticsV2(){
 if(!isStaff()){location.hash='#/statistiques';return;}
 const s=statsV2State;
 if(s.tab==='residents'){
  const loading = viewCroAdmin();
  const page = document.querySelector('.sv-stable-main > .cro-page');
  const period = document.getElementById('cro-admin-period');
  if (!page || !period) { await loading; return; }
  const config = page.querySelector('.cro-admin-grid');
  if (config) {
    const details = document.createElement('details');details.className='sv-panel';
    details.innerHTML='<summary>Configuration des résidents et des types d’intervention</summary>';
    config.before(details);details.append(config);
  }
  const from=period.querySelector('[name="from"]'),to=period.querySelector('[name="to"]');
  from.value=s.from;to.value=s.to;
  const remember=()=>{s.from=from.value;s.to=to.value;s.data=null;};
  period.addEventListener('change',remember);
  period.querySelectorAll('[data-range]').forEach(button=>button.addEventListener('click',remember));
  await loading;
  if(!period.isConnected || s.tab!=='residents')return;
  if(s.from||s.to)from.dispatchEvent(new Event('change'));
  return;
 }

 if(!s.from)s.from=today().slice(0,8)+'01';if(!s.to)s.to=today();
 croPageShell('Statistiques',`<div class="sv-page">${statsV2Nav(s.tab)}<section class="sv-filter"><div><span class="sv-eyebrow">PÉRIODE D’ANALYSE</span><p>Filtres partagés entre les rubriques du service</p></div><form id="sv-date-form"><label>Du<input type="date" name="from" required value="${esc(s.from)}"></label><label>Au<input type="date" name="to" required value="${esc(s.to)}" max="${today()}"></label><button class="btn primary" type="submit">Appliquer</button><button class="btn" type="button" data-sv-range="month">Ce mois</button><button class="btn" type="button" data-sv-range="year">Cette année</button><button class="btn" type="button" data-sv-range="previous">Mois précédent</button></form></section><p id="sv-status" class="sv-status" role="status"></p><div id="sv-content"></div></div>`);
 const root=document.querySelector('.sv-page');statsV2BindTabs(root);
 const form=document.getElementById('sv-date-form');
 form.onsubmit=e=>{e.preventDefault();s.from=form.elements.from.value;s.to=form.elements.to.value;s.data=null;viewStatisticsV2();};
 root.querySelectorAll('[data-sv-range]').forEach(b=>b.onclick=()=>{
  const d=today();s.to=d;
  if(b.dataset.svRange==='year')s.from=d.slice(0,4)+'-01-01';
  else if(b.dataset.svRange==='previous'){const [y,m]=d.split('-').map(Number),last=new Date(Date.UTC(y,m-1,0));s.to=last.toISOString().slice(0,10);s.from=s.to.slice(0,8)+'01';}
  else s.from=d.slice(0,8)+'01';
  s.data=null;viewStatisticsV2();
 });
 const content=document.getElementById('sv-content'),status=document.getElementById('sv-status');
 status.textContent='Chargement des statistiques…';
 try{
  const key=s.from+'|'+s.to;
  let r=s.data?.key===key?s.data.r:null;
  if(!r){r=await api('/api/service-stats'+croQuery(s.from,s.to));if(!content.isConnected)return;s.data={key,r};}
  if(!content.isConnected)return;
  status.textContent=`${fmtDate(r.debut)} → ${fmtDate(r.fin)} · Données descriptives · Historique conservé depuis le ${fmtDate(r.started.slice(0,10))}`;
  const redraw=()=>{if(content.isConnected)statsV2Render(content,r);};redraw();
 }catch(e){if(content.isConnected){status.textContent='Chargement impossible';content.innerHTML=`<div class="sv-panel sv-warning">${esc(e.message)}<p>Vérifie que la mise à jour backend V1 est installée et que la période est valide.</p></div>`;}}
}
function statsV2Render(content,r){
 const s=statsV2State,t=r.total,p=r.precedente;
 const card=(label,k,unit='')=>statsV2Card(label,t[k]==null?null:t[k]+unit,`Période précédente : ${p[k]??'—'}${p[k]!=null?unit:''}`);
 const groups=`<div class="sv-local"><label>Regrouper par <select data-sv-group><option value="mensuel">Mois</option><option value="annuel">Année</option></select></label></div>`;
 const periodRows=r[s.group]||[];
 const columns=[['periode','Période'],['admissions','Admissions'],['sorties','Sorties'],['deces','Décès'],['mortalite','Mortalité %'],['dms','DMS (j)'],['mediane','Médiane (j)']];
 const readRows=periodRows.flatMap(row=>[7,30].map(d=>({periode:row.periode,delai:d+' jours',...row['j'+d]})));
 let html='';
 if(s.tab==='overview'){
  html=`<div class="sv-kpis">${statsV2Card('Patients présents maintenant',r.presents,`${r.hors_service} hors service · indépendant du filtre`)}${card('Admissions','admissions')}${card('Séjours clôturés','sorties')}${card('Mortalité','mortalite',' %')}${card('Durée moyenne','dms',' j')}${card('Patients réhospitalisés','patients_readmis')}</div>`;
  html+=`<div class="sv-grid">${statsV2Panel('Admissions et sorties par mois',`<div class="sv-legend"><span>■ Admissions</span><span>■ Sorties</span></div><div class="sv-trend">${r.mensuel.map(row=>{const max=Math.max(1,...r.mensuel.flatMap(m=>[m.admissions,m.sorties]));return `<div class="sv-trend-col"><div class="sv-trend-bars"><i style="height:${row.admissions/max*100}%" title="${row.admissions} admissions"><span>${row.admissions}</span></i><i style="height:${row.sorties/max*100}%" title="${row.sorties} sorties"><span>${row.sorties}</span></i></div><small>${esc(row.periode)}</small></div>`;}).join('')}</div>`)}${statsV2Panel('Répartition des modes de sortie',statsV2Bars(statsV2Pairs(r.modes)))}</div>`;
  html+=`<aside class="sv-warning">Les séjours antérieurs à l’installation peuvent être incomplets. Les taux sont descriptifs, non ajustés au risque. Consulte « Qualité des données » pour les limites.</aside>`;
 }else if(s.tab==='activity'){
  html=`<div class="sv-kpis">${card('Admissions','admissions')}${card('Sorties','sorties')}${card('Durée moyenne','dms',' j')}${card('Durée médiane','mediane',' j')}</div>${groups}`;
  html+=statsV2Panel('Évolution de l’activité',statsV2Table(periodRows,columns),'Le récapitulatif annuel porte uniquement sur les dates sélectionnées.');
  html+=statsV2Controls()+`<div class="sv-grid">${statsV2Panel('Motifs et codes CIM-10',statsV2List(statsV2Pairs(r.motifs)))}${statsV2Panel('Modes de sortie',statsV2List(statsV2Pairs(r.modes)))}</div>`;
 }else if(s.tab==='outcomes'){
  html=`<div class="sv-kpis">${card('Décès','deces')}${statsV2Card('Mortalité',t.mortalite==null?null:t.mortalite+' %',`${t.deces} décès / ${t.sorties} séjours clôturés`)}${statsV2Card('Réadmission à 7 jours',t.j7.taux==null?null:t.j7.taux+' %',`${t.j7.n} / ${t.j7.denominateur} sorties éligibles · ${t.j7.suivi_incomplet} suivis incomplets`)}${statsV2Card('Réadmission à 30 jours',t.j30.taux==null?null:t.j30.taux+' %',`${t.j30.n} / ${t.j30.denominateur} sorties éligibles · ${t.j30.suivi_incomplet} suivis incomplets`)}</div>${groups}`;
  html+=`<div class="sv-grid">${statsV2Panel('Mortalité par période',statsV2Bars(periodRows.map(x=>({libelle:x.periode,n:x.mortalite})),true))}${statsV2Panel('Réhospitalisations observées',statsV2Table(periodRows,[['periode','Période'],['readmissions','Réadmissions'],['patients_readmis','Patients distincts']]))}</div>`;
  html+=statsV2Panel('Détail des réadmissions à 7 et 30 jours',statsV2Table(readRows,[['periode','Période de sortie'],['delai','Suivi'],['n','Numérateur'],['denominateur','Dénominateur'],['suivi_incomplet','Suivis incomplets'],['taux','Taux %']]),'Même dossier, même service. Décès exclus des sorties éligibles. Programmées/non programmées non distinguées.');
 }else if(s.tab==='treatments'){
  html=`<div class="sv-kpis">${statsV2Card('Patients hospitalisés maintenant',r.presents,'Photographie actuelle')}${statsV2Card('Intitulés de traitements actifs',r.traitements.length,'Ne représente pas un nombre de patients')}${statsV2Card('Intitulés des ordonnances',r.ordonnances.length,'Sur la période de sortie sélectionnée')}</div>${statsV2Controls()}<div class="sv-grid">${statsV2Panel('Traitements hospitaliers en cours',statsV2List(r.traitements,'Patients distincts'),'Patients distincts actuellement hospitalisés. Indépendant du filtre de dates, des triangles et du nombre de prises.')}${statsV2Panel('Médicaments des ordonnances de sortie',statsV2List(r.ordonnances,'Séjours distincts'),'Séjours distincts dans la période. Lignes structurées uniquement, pas les prescriptions en texte libre.')}</div>`;
 }else if(s.tab==='surgery'){
  html=`<div class="sv-kpis">${statsV2Card('Interventions enregistrées',Object.values(r.operations).reduce((a,b)=>a+b,0),'Nombre de comptes rendus opératoires')}${statsV2Card('Délai admission → intervention',r.delai_operatoire_moyen==null?null:r.delai_operatoire_moyen+' j',`${r.delais_valides} CRO associés par concordance de dates`)}${statsV2Card('CRO sans séjour unique',r.cro_non_relies,'Exclus du calcul de délai')}</div>${statsV2Controls()}${statsV2Panel('Interventions par type',statsV2List(statsV2Pairs(r.operations)))}<p class="sv-footnote">La comparaison des participations par résident se trouve dans l’onglet « Résidents ».</p>`;
 }else if(s.tab==='quality'){
  html=`<div class="sv-kpis">${statsV2Card('Dossiers présents',r.completude.presents,'Base du contrôle de complétude')}${statsV2Card('Sans motif',r.completude.sans_motif)}${statsV2Card('Sans code CIM-10',r.completude.sans_cim10)}${statsV2Card('Sans date d’entrée valide',r.completude.sans_date_entree)}</div>${statsV2Panel('Périmètre et limites',`<ul class="sv-notes">${r.limites.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`)}${statsV2Panel('Traçabilité des calculs',`<p>Début de conservation : ${esc(r.started)}.</p><p>La mortalité annuelle utilise les totaux, pas la moyenne des pourcentages mensuels. Les champs absents restent « — », jamais assimilés à zéro.</p><p>La complétude ci-dessus concerne les patients présents, pas les sorties de la période. Aucun taux d’occupation n’est calculé sans historique de capacité disponible.</p>`)}`;
 }
 content.innerHTML=html;
 const rerender=()=>statsV2Render(content,r);
 const bind=(selector,key,event='change')=>{const el=content.querySelector(selector);if(el){el.value=s[key];el.addEventListener(event,()=>{s[key]=el.value;rerender();if(key==='search'){const input=content.querySelector(selector);input.focus();input.setSelectionRange(input.value.length,input.value.length);}});}};
 bind('[data-sv-group]','group');bind('[data-sv-sort]','sort');bind('[data-sv-limit]','limit');bind('[data-sv-mode]','mode');bind('[data-sv-search]','search','input');
}
// STATS_UI_V2_END

// URGENCES VISCERALES V1 — interface adaptée du prototype, données sur le serveur de la plateforme.
const URG = { data: null, timer: null, obsExpanded: false };
const URG_ARROW_R = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const URG_ARROW_D = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
const URG_EXIT_OPTIONS = [['avis', 'Déposer un avis écrit'], ['rdv', 'RDV consultation à froid'], ['contre-avis', 'Sortie contre avis médical'], ['evasion', 'Évasion'], ['autre', 'Autre']];
const URG_ACCEPT = { imagerie: 'video/mp4,video/webm,video/quicktime,video/ogg,.m4v,.mp4,.webm,.mov,.ogg,image/jpeg,image/png,.jpg,.jpeg,.png', document: '.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png,image/gif,image/webp,.jpg,.jpeg,.png,.gif,.webp' };
const urgZoneLabel = (id) => (URG.data?.zones || []).find(z => z.id === id)?.label || id;
const urgHour = (ts) => (ts ? String(ts).slice(11, 16) : '');
const urgCount = (zone) => (URG.data?.patients || []).filter(p => p.zone === zone).length;
const urgPlural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const urgSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' Mo' : Math.max(1, Math.round(b / 1024)) + ' Ko';

function urgZoneButton(id, cls) {
  const n = urgCount(id), label = urgZoneLabel(id);
  return `<button type="button" class="urg-zone ${n ? 'occupied' : ''} ${cls}" data-zone="${id}" aria-label="${esc(label)}, ${n} patient(s)">
    <span class="urg-zone-name">${esc(label)}</span><span class="urg-zone-plus">${I.plus}</span><span class="urg-zone-count">${I.bed(20)} ${n}</span></button>`;
}
function urgBoardHtml() {
  const boxes = ['box1', 'box2', 'box3', 'box4'].map(id => { const n = urgCount(id); return `<button type="button" class="urg-zone urg-box ${n ? 'occupied' : ''}" data-zone="${id}" aria-label="${esc(urgZoneLabel(id))}, ${n ? 'occupé' : 'libre'}"><b>${id.slice(3)}</b><small>${n ? (n > 1 ? n + ' patients' : 'occupé') : 'libre'}</small></button>`; }).join('');
  return `<div class="urg-plan">
    <div class="urg-corridor urg-c-mh" aria-hidden="true">${URG_ARROW_D}${URG_ARROW_D}</div>
    <div class="urg-corridor urg-c-mv" aria-hidden="true">${URG_ARROW_D}${URG_ARROW_D}${URG_ARROW_D}</div>
    ${urgZoneButton('triage', 'urg-triage')}
    <div class="urg-corridor urg-c-dv" aria-hidden="true">${URG_ARROW_D}</div>
    <div class="urg-corridor urg-c-dh" aria-hidden="true">${URG_ARROW_R}${URG_ARROW_R}${URG_ARROW_R}</div>
    ${urgZoneButton('consultation', 'urg-consult')}
    ${urgZoneButton('observation', 'urg-obs')}
    ${urgZoneButton('dechocage', 'urg-dech')}
    <div class="urg-boxes"><p>BOX</p><div class="urg-box-grid">${boxes}</div></div>
    ${urgZoneButton('bloc', 'urg-bloc')}
  </div>`;
}
function urgRenderBoard() {
  const host = $('#urg-board'); if (!host || !URG.data) return;
  host.innerHTML = urgBoardHtml();
  const n = URG.data.patients.length;
  $('#urg-count').textContent = urgPlural(n, 'patient présent', 'patients présents');
  host.querySelectorAll('[data-zone]').forEach(b => b.onclick = () => urgOpenZone(b.dataset.zone));
}
async function urgLoad() {
  URG.data = await api('/api/urgences');
  urgRenderBoard();
  return URG.data;
}
function urgBindViewport() {
  URG.viewportCleanup?.();
  const page = document.querySelector('.urg-page');
  if(!page) return;
  const fit = () => {
    if(!page.isConnected) { URG.viewportCleanup?.(); return; }
    const viewport = window.visualViewport;
    const bottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;
    const top = page.getBoundingClientRect().top;
    page.style.height = Math.max(0, Math.floor(bottom - top)) + 'px';
  };
  const observer = new ResizeObserver(fit);
  const bar = document.querySelector('#app > .topbar');
  if(bar) observer.observe(bar);
  window.addEventListener('resize',fit);
  window.visualViewport?.addEventListener('resize',fit);
  window.visualViewport?.addEventListener('scroll',fit);
  URG.viewportCleanup = () => {
    observer.disconnect(); window.removeEventListener('resize',fit);
    window.visualViewport?.removeEventListener('resize',fit);
    window.visualViewport?.removeEventListener('scroll',fit);
    URG.viewportCleanup = null;
  };
  fit();
}
async function viewUrgences() {
  $('#app').innerHTML = topbar() + `<main class="urg-page">
    <header class="urg-head">
      <span class="urg-date">${esc(clockDate().toLocaleDateString('fr-FR', { timeZone: 'UTC' }))}</span>
      <div class="urg-title"><h2>Urgences Viscérales</h2><p>Patients de chirurgie viscérale</p></div>
      <div class="urg-head-r"><span class="urg-pill" id="urg-count">…</span><button type="button" class="btn urg-history-btn" id="urg-history">Historique</button></div>
    </header>
    <section id="urg-board" aria-label="Plan des urgences"></section>
  </main>`;
  bindChrome();
  urgBindViewport();
  $('#urg-history').onclick = urgOpenHistory;
  await urgLoad();
  clearInterval(URG.timer);
  URG.timer = setInterval(() => {
    if (!location.hash.startsWith('#/urgences') || !S.token) { clearInterval(URG.timer); return; }
    if (!document.hidden) urgLoad().catch(() => {});
  }, 20000);
}

// ---------------------------------------------------------------- zone
function urgOpenZone(zone) {
  const list = URG.data.patients.filter(p => p.zone === zone);
  const card = (p) => `<button type="button" class="urg-card" data-pid="${p.id}">
      <span class="urg-card-ico">${I.bed(24)}</span>
      <span class="urg-card-main"><b>${esc(p.nom)}</b><small>arrivé ${esc(urgHour(p.arrivee))}</small>
      <span class="urg-card-sub">${p.age != null ? esc(p.age) + ' ans · ' : ''}${esc(p.motif || 'Motif non renseigné')}</span>
      <span class="urg-badges">${urgVisibilityBadge(p)}<span class="urg-badge ${p.has_observation ? 'ok' : ''}">${p.has_observation ? 'Observation faite' : 'Sans observation'}</span>${p.pending_consignes ? `<span class="urg-badge warn">${urgPlural(p.pending_consignes, 'consigne', 'consignes')}</span>` : ''}${p.files_count ? `<span class="urg-badge">${urgPlural(p.files_count, 'fichier', 'fichiers')}</span>` : ''}</span></span>
      <span class="urg-card-go">${I.chev}</span></button>`;
  const ov = modal(`
    <div class="dialog-head"><div><h2>${esc(urgZoneLabel(zone).toUpperCase())}</h2><p>${urgPlural(list.length, 'patient', 'patients')} dans cette zone</p></div>
      <button class="icon-btn" data-close aria-label="Fermer">✕</button></div>
    <div class="dialog-body urg-body">
      <div class="urg-list">${list.map(card).join('') || '<div class="empty">Aucun patient.</div>'}</div>
      <form class="urg-add" id="urg-add" novalidate>
        <h3>Ajouter un patient</h3>
        <div class="urg-add-grid">
          <div class="field urg-f-nom"><label for="urg-nom">Nom du patient</label><input id="urg-nom" name="nom" maxlength="160" required autocomplete="off"></div>
          <div class="field"><label for="urg-age">Âge</label><input id="urg-age" name="age" type="number" min="0" max="130" inputmode="numeric"></div>
          <div class="field full"><label for="urg-motif">Motif de consultation</label><input id="urg-motif" name="motif" maxlength="300" autocomplete="off"></div>
        </div>
        <div class="form-err" id="urg-add-err"></div>
        <button class="btn primary" type="submit">${I.plus} Ajouter un patient</button>
      </form>
    </div>`, 'urg-dialog');
  ov.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
  ov.querySelectorAll('[data-pid]').forEach(b => b.onclick = () => urgOpenPatient(+b.dataset.pid));
  $('#urg-add').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, err = $('#urg-add-err');
    if (!f.nom.value.trim()) { err.textContent = 'Champ obligatoire : Nom du patient'; return; }
    try {
      await api('/api/urgences/patients', { method: 'POST', body: { nom: f.nom.value, age: f.age.value, motif: f.motif.value, zone } });
      toast('Patient ajouté'); await urgLoad(); urgOpenZone(zone);
    } catch (ex) { err.textContent = ex.message; }
  };
}

// ---------------------------------------------------------------- visibilité (partage)
function urgVisibilityBadge(p) {
  if (p.shared_all) return '<span class="urg-badge share all" title="Visible par tous les utilisateurs">Visible par tous</span>';
  if (p.shares_count || (p.shares && p.shares.length)) return `<span class="urg-badge share" title="Partagé avec des utilisateurs choisis">Partagé (${p.shares_count || p.shares.length})</span>`;
  return `<span class="urg-badge share private" title="Visible uniquement par ${esc(p.created_by || 'son auteur')}${p.is_owner ? ' (vous)' : ''}">${p.is_owner ? 'Privé (vous)' : 'Privé · ' + esc(p.created_by || '')}</span>`;
}
function urgVisibilityHtml(p) {
  const who = p.is_owner && p.created_by === (S.user && S.user.username) ? 'vous' : (p.created_by || 'inconnu');
  const status = p.shared_all ? 'Visible par <b>tous les utilisateurs</b> de la plateforme.' : (p.shares && p.shares.length ? `Partagé avec ${p.shares.length} utilisateur(s).` : 'Visible uniquement par son auteur' + (S.user && S.user.role === 'admin' ? ' et les administrateurs' : '') + '.');
  const list = (p.shares || []).map(u => `<li><span>${esc(u.full_name || u.username)}<small> · ${esc(u.role || '')}</small></span>${p.is_owner ? `<button type="button" class="icon-btn urg-del" data-share-remove="${esc(u.username)}" aria-label="Retirer le partage">✕</button>` : ''}</li>`).join('');
  const controls = p.is_owner ? `
    <div class="urg-share-controls">
      <form class="urg-inline-form" data-share-form><select name="username" aria-label="Partager avec un utilisateur" data-share-users><option value="">Chargement des utilisateurs…</option></select><button class="btn primary" type="submit">Partager</button></form>
      <button type="button" class="btn ${p.shared_all ? '' : 'primary'}" data-share-all="${p.shared_all ? '0' : '1'}">${p.shared_all ? 'Restreindre la visibilité' : 'Partager avec tous les utilisateurs'}</button>
    </div>` : '<p class="urg-muted">Seul l’utilisateur qui a ajouté ce patient (ou un administrateur) peut modifier le partage.</p>';
  return `<header><h3>Visibilité</h3>${urgVisibilityBadge(p)}</header>
    <p class="urg-muted">Ajouté par <b>${esc(who)}</b>. ${status}</p>
    ${list ? `<ul class="urg-share-list">${list}</ul>` : ''}${controls}`;
}

// ---------------------------------------------------------------- patient
function urgObservationHtml(p) {
  const obs = (p.observation || '').trim();
  if (!obs) return '<p class="urg-muted">Observation indisponible.</p>';
  const words = obs.split(/\s+/);
  const long = words.length > 12 || obs.length > 90;
  const short = long ? words.slice(0, 12).join(' ').slice(0, 90) + '…' : obs;
  return `<p class="urg-obs-text">${esc(URG.obsExpanded || !long ? obs : short)}</p>${long ? `<button type="button" class="urg-link" data-obs-toggle>${URG.obsExpanded ? 'Moins' : 'Plus'}</button>` : ''}`;
}
async function urgOpenPatient(id, keepState) {
  if (!keepState) { URG.obsExpanded = false; URG.editObs = false; }
  let p;
  try { p = (await api('/api/urgences/patients/' + id)).patient; } catch (ex) { toast(ex.message, true); return; }
  if (p.status !== 'present') { await urgOpenArchived(p); return; }
  const todo = p.consignes.filter(c => !c.fait).length;
  const zones = URG.data.zones.map(z => `<option value="${esc(z.id)}" ${z.id === p.zone ? 'selected' : ''}>${esc(z.label)}</option>`).join('');
  const consigne = (c) => `<li class="urg-cons ${c.fait ? 'done' : ''}"><label><input type="checkbox" data-cons="${c.id}" ${c.fait ? 'checked' : ''}><span>${esc(c.texte)}<small>${esc(c.created_by)}${c.fait && c.done_by ? ' · fait par ' + esc(c.done_by) + ' ' + esc(urgHour(c.done_at)) : ''}</small></span></label><button type="button" class="icon-btn urg-del" data-cons-del="${c.id}" aria-label="Supprimer la consigne">✕</button></li>`;
  const file = (f) => `<li class="urg-file"><span class="urg-file-kind ${f.kind}">${f.kind === 'imagerie' ? 'Imagerie' : 'Document'}</span><span class="urg-file-main"><b>${esc(f.title)}</b><small>${esc(f.original_name)} · ${urgSize(f.size_bytes)}</small></span>
      <span class="urg-file-act">${/^(image|video)\/|application\/pdf/.test(f.mime) ? `<button type="button" class="btn" data-file-view="${f.id}">Voir</button>` : ''}<button type="button" class="btn" data-file-dl="${f.id}">Télécharger</button><button type="button" class="btn danger" data-file-del="${f.id}">Supprimer</button></span></li>`;
  const ov = modal(`
    <div class="dialog-head"><div><h2>${esc(p.nom.toUpperCase())}</h2><p>${p.age != null ? esc(p.age) + ' ans · ' : ''}${esc(p.motif || 'Motif non renseigné')} · arrivé à ${esc(urgHour(p.arrivee))}</p></div>
      <div class="urg-head-actions"><button class="btn" data-back>&lt; ${esc(urgZoneLabel(p.zone))}</button><button class="icon-btn" data-close aria-label="Fermer">✕</button></div></div>
    <div class="dialog-body urg-body">
      <div class="urg-row"><label for="urg-zone" class="urg-label">Zone :</label><select id="urg-zone" class="urg-select">${zones}</select>
        <button type="button" class="btn urg-edit-id" data-edit-id>Modifier l’identité</button></div>

      <section class="urg-section urg-visibility" data-urg-visibility>${urgVisibilityHtml(p)}</section>

      <section class="urg-section" data-urg-observation><header><h3>Observation</h3>${URG.editObs ? '' : `<button type="button" class="btn" data-obs-edit>${p.observation ? 'Modifier' : 'Ajouter'}</button>`}</header>
        ${URG.editObs ? `<textarea id="urg-obs-input" class="urg-textarea" placeholder="Anamnèse, examen clinique, hypothèses...">${esc(p.observation)}</textarea><div class="urg-inline-actions"><button type="button" class="btn" data-obs-cancel>Annuler</button><button type="button" class="btn primary" data-obs-save>Enregistrer</button></div>` : urgObservationHtml(p)}
      </section>

      <section class="urg-section"><header><h3 data-urg-cons-title>Consignes à faire${todo ? ` <span class="urg-badge warn">${todo}</span>` : ''}</h3></header>
        <ul class="urg-cons-list">${p.consignes.map(consigne).join('') || '<li class="urg-muted">Aucune consigne.</li>'}</ul>
        <form class="urg-inline-form" id="urg-cons-form"><input name="texte" maxlength="500" placeholder="Nouvelle consigne (bilan, traitement...)" aria-label="Nouvelle consigne" autocomplete="off"><button class="btn primary" type="submit" aria-label="Ajouter la consigne">${I.plus}</button></form>
      </section>

      <section class="urg-section"><header><h3>Imagerie et documents</h3></header>
        <form class="urg-file-form" id="urg-file-form">
          <select name="kind" aria-label="Type de fichier"><option value="document" selected>Document</option><option value="imagerie">Imagerie</option></select>
          <input name="title" maxlength="240" placeholder="Titre du document" aria-label="Titre du document" autocomplete="off" data-urg-document>
          <div class="urg-imaging-fields" data-urg-imaging hidden>
            <label>Type d’imagerie<select name="imaging_type"><option value="">— Choisir —</option><option>TDM</option><option>IRM</option><option>Bili-IRM</option><option>Autre</option></select></label>
            <label data-urg-custom="custom_title" hidden>Précision du type<input name="custom_title" maxlength="200"></label>
            <label>Coupe<select name="plane"><option value="">— Choisir —</option><option>Axiale</option><option>Sagittale</option><option>Coronale</option><option>Autre</option></select></label>
            <label data-urg-custom="custom_plane" hidden>Précision de coupe<input name="custom_plane" maxlength="200"></label>
            <label>Temps d’acquisition<select name="phase"><option value="">— Choisir —</option><option>Sans injection</option><option value="Veineux">TV — Veineux</option><option value="Artériel">TA — Artériel</option><option value="Portal">TP — Portal</option><option value="Tardif">TT — Tardif</option><option>Autre</option></select></label>
            <label data-urg-custom="custom_phase" hidden>Précision du temps<input name="custom_phase" maxlength="200"></label>
          </div>
          <label class="btn urg-file-pick">Ajouter des fichiers<input type="file" name="file" multiple accept="${URG_ACCEPT.document}" hidden></label>
        </form>
        <div class="form-err" id="urg-file-err"></div>
        <ul class="urg-file-list">${p.files.map(file).join('') || '<li class="urg-muted">Aucun fichier joint.</li>'}</ul>
      </section>

      <button type="button" class="btn urg-share" data-share>Partager sur WhatsApp</button>

      <section class="urg-section urg-actions"><header><h3>Orientation du patient</h3></header>
        <div class="urg-action-btns"><button type="button" class="btn primary" data-act-hosp>Hospitaliser</button><button type="button" class="btn" data-act-exit>Sortie</button>${isAdmin() ? '<button type="button" class="btn danger" data-act-purge title="Supprimer définitivement ce patient et son historique aux urgences">Supprimer définitivement</button>' : ''}</div>
        <div id="urg-action-panel"></div>
      </section>
      <div class="form-err" id="urg-err"></div>
    </div>`, 'urg-dialog urg-patient-dialog');
  const err = $('#urg-err');
  const fail = (ex) => { err.textContent = ex.message; toast(ex.message, true); };
  const renderObservation = () => {
    const section = ov.querySelector('[data-urg-observation]');
    section.innerHTML = `<header><h3>Observation</h3>${URG.editObs ? '' : `<button type="button" class="btn" data-obs-edit>${p.observation ? 'Modifier' : 'Ajouter'}</button>`}</header>
      ${URG.editObs ? `<textarea id="urg-obs-input" class="urg-textarea" placeholder="Anamnèse, examen clinique, hypothèses...">${esc(p.observation)}</textarea><div class="urg-inline-actions"><button type="button" class="btn" data-obs-cancel>Annuler</button><button type="button" class="btn primary" data-obs-save>Enregistrer</button></div>` : urgObservationHtml(p)}`;
  };
  let shareUsers = null;
  const renderVisibility = async () => {
    const section = ov.querySelector('[data-urg-visibility]');
    if (!section) return;
    section.innerHTML = urgVisibilityHtml(p);
    const select = section.querySelector('[data-share-users]');
    if (!select) return;
    try { if (!shareUsers) shareUsers = (await api('/api/urgences/utilisateurs')).users; } catch (ex) { select.innerHTML = '<option value="">Utilisateurs indisponibles</option>'; return; }
    if (!select.isConnected) return;
    const already = new Set((p.shares || []).map(u => u.username));
    const options = shareUsers.filter(u => !already.has(u.username) && u.username !== p.created_by);
    select.innerHTML = '<option value="">— Choisir un utilisateur —</option>' + options.map(u => `<option value="${esc(u.username)}">${esc(u.full_name || u.username)} (${esc(u.role)})</option>`).join('');
    if (!options.length) select.innerHTML = '<option value="">Tous les utilisateurs ont déjà accès</option>';
  };
  const share = async (body, message) => { const r = await api(`/api/urgences/patients/${id}/partage`, { method: 'PUT', body }); p = { ...p, shared_all: r.shared_all ? 1 : 0, shares: r.shares }; await renderVisibility(); toast(message); urgLoad().catch(() => {}); };
  ov.addEventListener('submit', async event => {
    const form = event.target;
    if (!form.matches('[data-share-form]')) return;
    event.preventDefault();
    const username = form.elements.username.value;
    if (!username) { fail(new Error('Choisissez un utilisateur.')); return; }
    const button = form.querySelector('button'); button.disabled = true;
    try { await share({ add: [username] }, 'Dossier partagé'); } catch (ex) { fail(ex); } finally { if (button.isConnected) button.disabled = false; }
  });
  renderVisibility();
  const reopen = async () => {
    const updated = (await api('/api/urgences/patients/' + id)).patient;
    if (!ov.isConnected) return;
    if (updated.status !== 'present') { closeModal(); toast('Ce patient a quitté les urgences.'); urgLoad().catch(() => {}); return; }
    const previous = p; p = updated;
    if (previous.shared_all !== p.shared_all || JSON.stringify(previous.shares) !== JSON.stringify(p.shares)) renderVisibility();
    if (JSON.stringify(previous.consignes) !== JSON.stringify(p.consignes)) {
      ov.querySelector('.urg-cons-list').innerHTML = p.consignes.map(consigne).join('') || '<li class="urg-muted">Aucune consigne.</li>';
      const n = p.consignes.filter(c => !c.fait).length;
      ov.querySelector('[data-urg-cons-title]').innerHTML = `Consignes à faire${n ? ` <span class="urg-badge warn">${n}</span>` : ''}`;
    }
    if (JSON.stringify(previous.files) !== JSON.stringify(p.files)) ov.querySelector('.urg-file-list').innerHTML = p.files.map(file).join('') || '<li class="urg-muted">Aucun fichier joint.</li>';
    if (!URG.editObs && (previous.observation !== p.observation || ov.querySelector('#urg-obs-input'))) renderObservation();
    ov.querySelector('#urg-zone').value = p.zone;
    ov.querySelector('[data-back]').textContent = '< ' + urgZoneLabel(p.zone);
    urgLoad().catch(() => {});
  };
  ov.querySelector('[data-close]').onclick = () => { URG.editObs = false; closeModal(); };
  ov.querySelector('[data-back]').onclick = () => { URG.editObs = false; urgOpenZone(p.zone); };
  $('#urg-zone').onchange = async (e) => { try { await api('/api/urgences/patients/' + id, { method: 'PUT', body: { zone: e.target.value } }); toast('Patient déplacé : ' + urgZoneLabel(e.target.value)); reopen(); } catch (ex) { fail(ex); } };
  ov.querySelector('[data-edit-id]').onclick = () => urgEditIdentity(p);
  ov.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || !ov.contains(button)) return;
    if (button.matches('[data-share-all]')) {
      const all = button.dataset.shareAll === '1';
      if (all && !confirm('Rendre ce patient visible par tous les utilisateurs de la plateforme ?')) return;
      button.disabled = true;
      try { await share({ shared_all: all }, all ? 'Visible par tous les utilisateurs' : 'Visibilité restreinte'); } catch (ex) { fail(ex); } finally { if (button.isConnected) button.disabled = false; }
      return;
    }
    if (button.matches('[data-share-remove]')) {
      button.disabled = true;
      try { await share({ remove: [button.dataset.shareRemove] }, 'Partage retiré'); } catch (ex) { fail(ex); } finally { if (button.isConnected) button.disabled = false; }
      return;
    }
    if (button.matches('[data-obs-toggle]')) { URG.obsExpanded = !URG.obsExpanded; renderObservation(); return; }
    if (button.matches('[data-obs-edit]')) { URG.editObs = true; renderObservation(); ov.querySelector('#urg-obs-input')?.focus(); return; }
    if (button.matches('[data-obs-cancel]')) { URG.editObs = false; renderObservation(); return; }
    if (button.matches('[data-obs-save]')) {
      const text = ov.querySelector('#urg-obs-input').value;
      button.disabled = true;
      try { await api('/api/urgences/patients/' + id, {method:'PUT',body:{observation:text}}); URG.editObs = false; await reopen(); toast('Observation enregistrée'); }
      catch (ex) { fail(ex); } finally { if (button.isConnected) button.disabled = false; }
      return;
    }
    if (button.matches('[data-cons-del]')) {
      if (!confirm('Supprimer cette consigne ?')) return;
      button.disabled = true;
      try { await api('/api/urgences/consignes/' + button.dataset.consDel,{method:'DELETE'}); await reopen(); }
      catch (ex) { fail(ex); } finally { if (button.isConnected) button.disabled = false; }
      return;
    }
    const f = p.files.find(row => String(row.id) === String(button.dataset.fileView || button.dataset.fileDl || button.dataset.fileDel));
    if (!f) return;
    if (button.matches('[data-file-view]')) { urgPreviewFile(f).catch(fail); return; }
    if (button.matches('[data-file-dl]')) { urgDownloadFile(f).catch(fail); return; }
    if (button.matches('[data-file-del]')) {
      if (!confirm('Supprimer ce fichier ?')) return;
      button.disabled = true;
      try { await api('/api/urgences/files/' + f.id,{method:'DELETE'}); await reopen(); toast('Fichier supprimé'); }
      catch (ex) { fail(ex); } finally { if (button.isConnected) button.disabled = false; }
    }
  });
  ov.addEventListener('change', async event => {
    const input = event.target;
    if (!input.matches('[data-cons]')) return;
    input.disabled = true;
    try { await api('/api/urgences/consignes/' + input.dataset.cons,{method:'PUT',body:{fait:input.checked}}); await reopen(); }
    catch (ex) { input.checked = !input.checked; fail(ex); } finally { if (input.isConnected) input.disabled = false; }
  });
  $('#urg-cons-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.target, input = form.elements.texte, text = input.value.trim(), button = form.querySelector('button');
    if (!text || button.disabled) return;
    button.disabled = true;
    try { await api(`/api/urgences/patients/${id}/consignes`,{method:'POST',body:{texte:text}}); if(input.value.trim() === text) input.value = ''; await reopen(); input.focus({preventScroll:true}); }
    catch(ex) { fail(ex); } finally { if(button.isConnected) button.disabled = false; }
  };
  const ff = $('#urg-file-form');
  const syncImagingFields = () => {
    const imaging = ff.elements.kind.value === 'imagerie';
    ff.elements.file.accept = URG_ACCEPT[ff.elements.kind.value];
    ff.querySelector('[data-urg-document]').hidden = imaging;
    ff.elements.title.required = !imaging; ff.elements.title.disabled = imaging;
    ff.querySelector('[data-urg-imaging]').hidden = !imaging;
    for (const [key, custom] of [['imaging_type','custom_title'],['plane','custom_plane'],['phase','custom_phase']]) {
      const field = ff.elements[key], input = ff.elements[custom];
      field.required = imaging; field.disabled = !imaging;
      const other = imaging && field.value === 'Autre';
      ff.querySelector('[data-urg-custom="' + custom + '"]').hidden = !other;
      input.required = other; input.disabled = !other;
    }
  };
  ff.onsubmit = event => event.preventDefault();
  ff.elements.kind.onchange = syncImagingFields;
  ['imaging_type','plane','phase'].forEach(key => ff.elements[key].onchange = syncImagingFields);
  syncImagingFields();
  ff.file.onchange = async () => {
    const files = [...ff.file.files]; if (!files.length || ff.dataset.uploading === '1') return;
    const ferr = $('#urg-file-err'); ferr.textContent = '';
    if (!ff.reportValidity()) { ferr.textContent = 'Complétez les champs avant de choisir les fichiers.'; ff.file.value = ''; return; }
    const fd = new FormData(); fd.append('kind', ff.elements.kind.value);
    if (ff.elements.kind.value === 'document') fd.append('title', ff.elements.title.value.trim());
    else ['imaging_type','plane','phase','custom_title','custom_plane','custom_phase'].forEach(key => fd.append(key, ff.elements[key].disabled ? '' : ff.elements[key].value.trim()));
    files.forEach(f => fd.append('file', f));
    const pick = ff.querySelector('.urg-file-pick'); ff.dataset.uploading = '1'; ff.file.disabled = true; pick.classList.add('busy'); pick.firstChild.textContent = 'Envoi en cours…';
    try { await api(`/api/urgences/patients/${id}/files`, { method: 'POST', body: fd }); await reopen(); toast(urgPlural(files.length, 'fichier ajouté', 'fichiers ajoutés')); }
    catch (ex) { ferr.textContent = ex.message; }
    finally { if (ff.isConnected) { ff.dataset.uploading = ''; ff.file.disabled = false; ff.file.value = ''; pick.classList.remove('busy'); pick.firstChild.textContent = 'Ajouter des fichiers'; } }
  };
  ov.querySelector('[data-share]').onclick = () => urgShare(p).catch(fail);
  const panel = $('#urg-action-panel');
  ov.querySelector('[data-act-hosp]').onclick = () => {
    panel.innerHTML = `<div class="urg-panel"><p class="urg-panel-t">Où hospitaliser le patient ?</p>
      <div class="urg-action-btns"><button type="button" class="btn primary" data-hosp-cva>Chirurgie viscérale A (notre service)</button><button type="button" class="btn" data-hosp-other>Autre service</button></div>
      <p class="urg-muted">Dans notre service, un dossier est créé (ou le dossier archivé est réadmis) avec l’observation, les consignes non faites, les imageries et les documents des urgences.</p>
      <div id="urg-hosp-other"></div></div>`;
    panel.querySelector('[data-hosp-cva]').onclick = () => urgAdmitForm(p);
    panel.querySelector('[data-hosp-other]').onclick = () => urgAdmitForm(p, true).catch(fail);
  };
  const purgeBtn = ov.querySelector('[data-act-purge]');
  if (purgeBtn) purgeBtn.onclick = async () => {
    purgeBtn.disabled = true;
    try { if (await adminDeleteUrgence(p)) { closeModal(); await urgLoad(); } } catch (ex) { fail(ex); }
    finally { if (purgeBtn.isConnected) purgeBtn.disabled = false; }
  };
  ov.querySelector('[data-act-exit]').onclick = () => {
    panel.innerHTML = `<form class="urg-panel urg-exit" id="urg-exit-form" novalidate>
      <div class="field"><label for="urg-exit-type">Motif de sortie</label><select id="urg-exit-type" name="type"><option value="">— Choisir —</option>${URG_EXIT_OPTIONS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></div>
      <div class="field hidden" data-exit-rdv><label for="urg-exit-rdv">Date et heure du rendez-vous</label><input id="urg-exit-rdv" name="appointment" type="datetime-local"></div>
      <div class="field hidden" data-exit-note><label for="urg-exit-note">Texte</label><textarea id="urg-exit-note" name="note" class="urg-textarea" placeholder="Avis, conduite à tenir, précisions..."></textarea></div>
      <button class="btn primary" type="submit" disabled>Confirmer la sortie</button></form>`;
    const f = $('#urg-exit-form'), submit = f.querySelector('[type=submit]');
    const sync = () => {
      const t = f.type.value;
      f.querySelector('[data-exit-rdv]').classList.toggle('hidden', t !== 'rdv');
      f.querySelector('[data-exit-note]').classList.toggle('hidden', !t || t === 'evasion');
      f.querySelector('#urg-exit-note').placeholder = t === 'avis' || t === 'autre' ? 'Texte obligatoire' : 'Précisions (facultatif)';
      submit.disabled = !t || (t === 'rdv' && !f.appointment.value) || ((t === 'avis' || t === 'autre') && !f.note.value.trim());
    };
    f.type.onchange = sync; f.appointment.oninput = sync; f.note.oninput = sync; sync();
    f.onsubmit = async (e) => { e.preventDefault(); if (submit.disabled) return;
      try { await api(`/api/urgences/patients/${id}/sortie`, { method: 'POST', body: { type: f.type.value, note: f.note.value, appointment: f.appointment.value } }); toast('Sortie enregistrée'); closeModal(); await urgLoad(); await urgOpenPatient(id); } catch (ex) { fail(ex); } };
  };
}
function urgEditIdentity(p) {
  formModal({ title: 'Identité aux urgences', values: p, submit: 'Enregistrer',
    fields: [{ name: 'nom', label: 'Nom du patient', required: true, full: true }, { name: 'age', label: 'Âge', type: 'number' }, { name: 'motif', label: 'Motif de consultation' }],
    onSubmit: async (v) => { await api('/api/urgences/patients/' + p.id, { method: 'PUT', body: v }); toast('Identité modifiée'); setTimeout(() => urgLoad().then(() => urgOpenPatient(p.id, true)), 0); },
  });
  $('#modal-root').querySelectorAll('[data-close]').forEach(b => b.onclick = () => urgOpenPatient(p.id, true));
}
async function urgAdmitForm(p, external = false) {
  const m = S.meta, motifs = await loadMotifs();
  const ips = observationIpCandidates(p.observation);
  const values = { ip: ips.length === 1 ? ips[0] : '', nom: p.nom, age: p.age ?? '', groupe: 'Inconnu', loc_type: external ? 'hs' : 'room', hors_service: external ? (p.exit_service || '') : '', ...motifValues(p.motif, motifs) };
  const send = async (body) => api(`/api/urgences/patients/${p.id}/hospitaliser`, { method: 'POST', body });
  const form = formModal({
    title: external ? 'Admettre un patient hors service' : 'Hospitaliser en Chirurgie viscérale A', submit: 'Hospitaliser', values,
    extra: `<p class="urg-muted urg-admit-note">Motif aux urgences : ${esc(p.motif || '—')}. L’observation, les consignes non faites, les imageries et les documents seront copiés dans le dossier.</p>`,
    fields: [
      { name: 'nom', label: 'Nom', required: true, placeholder: 'Nom et prénom' },
      { name: 'sexe', label: 'Sexe', type: 'select', options: [['', 'Non renseigné'], ['M', 'Masculin'], ['F', 'Féminin']] }, { name: 'age', label: 'Âge', type: 'number' }, { name: 'ip', label: 'IP', required: true }, { name: 'cin', label: 'CIN — Carte nationale d’identité', placeholder: 'Facultatif' },
      { name: 'mutuelle', label: 'Mutuelle', type: 'select', options: m.mutuelles }, { name: 'groupe', label: 'Groupe sanguin', type: 'select', options: m.groupes },
      ...motifFields(motifs),
      ...(external ? [{ name:'hors_service', label:'Service d’hébergement', required:true, full:true, placeholder:'Ex. Cardiologie — chambre / lit si connu' }] : locationFields(m)),
    ],
    onSubmit: async (v) => {
      if (external) v.loc_type = 'hs';
      if (v.loc_type === 'hs' && !v.hors_service.trim()) throw new Error('Indiquez le service d\'hébergement.');
      if (v.loc_type === 'room' && (!v.room || !v.position)) throw new Error('Choisissez la chambre et le lit.');
      const { loc_type, ...rest } = motifPayload(v);
      const body = { ...rest, mode: external ? 'autre' : 'service', ...locPayload(v) };
      let r;
      try { r = await send(body); }
      catch (ex) {
        if (ex.data?.code !== 'archived') throw ex;
        if (!confirm(ex.message + '\n\nRéadmettre ce patient dans son dossier existant ? L’ancien motif d’hospitalisation sera archivé dans ses antécédents.')) throw new Error('Hospitalisation annulée : vérifiez l’IP.');
        r = await send({ ...body, readmit: true });
      }
      toast(r.readmitted ? 'Patient réadmis dans son dossier' : 'Patient hospitalisé dans le service');
      location.hash = `#/patient/${r.patient_id}/maj`;
    },
  });
  if (!external) bindLocToggle(form);
  bindMotifToggle(form);
  if(ips.length > 1) {
    const note = document.createElement('p'); note.className = 'form-err';
    note.textContent = 'Plusieurs IP trouvées dans l’observation : '+ips.join(', ')+'. Vérifiez et saisissez la bonne IP.';
    form.elements.ip.closest('.field')?.appendChild(note);
  }
}

// ---------------------------------------------------------------- fichiers
async function urgFetchFile(f) {
  const res = await fetch(API + '/api/urgences/files/' + f.id, { headers: { Authorization: 'Bearer ' + S.token }, credentials: 'same-origin' });
  if (res.status === 401) { logout(true); throw new Error('Session expirée'); }
  if (!res.ok) { let msg = 'Fichier indisponible.'; try { msg = (await res.json()).error || msg; } catch {} throw new Error(msg); }
  return res.blob();
}
async function urgDownloadFile(f) {
  const url = URL.createObjectURL(await urgFetchFile(f));
  const a = document.createElement('a'); a.href = url; a.download = f.original_name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function urgPreviewFile(f) {
  if (f.extension === '.pdf' || f.mime === 'application/pdf') return urgPreviewPdf(f);
  if(/\.(?:doc|docx)$/i.test(f.original_name || '')) { await urgDownloadFile(f); return; }
  const isVideo = f.mime.startsWith('video/'), isImage = f.mime.startsWith('image/');
  let url, player;
  if (isVideo || isImage) {
    // Lecture en flux (requêtes partielles) via un ticket temporaire : défilement fluide sans télécharger tout le fichier.
    const access = await api('/api/urgences/files/' + f.id + '/ticket', { method: 'POST' });
    url = API + '/api/urgences/files/' + f.id + '/media?ticket=' + encodeURIComponent(access.ticket);
  } else {
    const blob = await urgFetchFile(f);
    url = URL.createObjectURL(new Blob([blob], { type: f.mime }));
  }
  const layer = document.createElement('div');
  layer.className = 'urg-preview'; layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-modal', 'true');
  layer.innerHTML = `<div class="urg-preview-box"><header><b>${esc(f.title)}</b><span>${esc(f.original_name)}</span><button type="button" class="btn" data-dl>Télécharger</button><button type="button" class="icon-btn" data-x aria-label="Fermer l’aperçu">✕</button></header><div class="urg-preview-media"></div></div>`;
  const media = layer.querySelector('.urg-preview-media');
  let el;
  if (isImage) { el = document.createElement('img'); el.alt = f.title; el.src = url; }
  else if (isVideo) { player = buildImagingPlayer(url); el = player; }
  else { el = document.createElement('iframe'); el.title = f.title; el.src = url; }
  media.appendChild(el);
  const close = () => { layer.remove(); if (player) player.destroy(); if (url.startsWith('blob:')) URL.revokeObjectURL(url); document.removeEventListener('keydown', onKey, true); window.removeEventListener('hashchange', close); };
  window.addEventListener('hashchange', close);
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  layer.querySelector('[data-x]').onclick = close;
  layer.querySelector('[data-dl]').onclick = () => urgDownloadFile(f).catch(ex => toast(ex.message, true));
  layer.addEventListener('mousedown', (e) => { if (e.target === layer) close(); });
  document.body.appendChild(layer);
}
function urgObservationText(value) {
  return String(value || '').replace(/^\s*Urgences viscérales\s*[—–-]\s*arrivée[^\r\n]*(?:\r?\n|$)/i, '').trim();
}

function observationIpCandidates(text) {
  const found = new Set();
  for(const line of String(text || '').split(/\r?\n/)) {
    const clean = line.replace(/[*_]/g,'').trim();
    const match = clean.match(/^I\s*\.?\s*P\s*\.?\s*(?:[:=：#-]\s*|\s+)([A-Za-z0-9][A-Za-z0-9-]{0,79})(?=\s|$|[;,])/i);
    if(match && /\d/.test(match[1])) found.add(match[1]);
  }
  return [...found];
}
function whatsappObservation(value, patientName='') {
  const text = urgObservationText(value);
  const key = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
  const nameKey = key(patientName).replace(/[*_]/g,'');
  const heading = /^(?:identit[eé]|motif(?:\s+(?:d['’]hospitalisation|de\s+consultation))?|a\.?\s*t\.?\s*c\.?\s*d\.?\s*s?\.?|ant[eé]c[eé]dents?|h\.?\s*d\.?\s*m\.?|histoire\s+de\s+la\s+maladie|examen(?:\s+(?:clinique|g[eé]n[eé]ral|abdominal)){0,3}|clinique|g[eé]n[eé]ral|abdominal|bilan(?:s)?(?:\s+biologique(?:s)?)?|biologie|imagerie(?:s)?|tdm|scanner|irm|bili[-\s]?irm|[eé]chographie|[eé]cho|radiographie|radio)(?=\s*[:：]|\s*$)/i;
  let firstContent = true;
  return text.split(/\r?\n/).map(line => {
    const indent = line.match(/^\s*/)[0], raw = line.trim();
    if(!raw) return line;
    const clean = raw.replace(/\*+/g,'');
    const wasFirst = firstContent; firstContent = false;
    if(observationIpCandidates(clean).length === 1) return indent+'*'+clean+'*';
    if(/^(?:nom\s*(?:et\s+)?(?:pr[eé]nom)?|pr[eé]nom)\s*[:：]/i.test(clean)) return indent+'*'+clean+'*';
    if(nameKey && key(clean) === nameKey) return indent+'*'+clean+'*';
    if(wasFirst && !heading.test(clean) && /^[\p{L}][\p{L}\s'’\-]{2,100}$/u.test(clean) && clean === clean.toLocaleUpperCase('fr')) return indent+'*'+clean+'*';
    const match = clean.match(heading);
    if(match) {
      const end = match[0].length;
      const colon = clean.slice(end).match(/^\s*[:：]/);
      if(colon) return indent+'*'+clean.slice(0,end+colon[0].length)+'*'+clean.slice(end+colon[0].length);
      return indent+'*'+clean+'*';
    }
    // Imagerie datée : le titre est seul sur sa ligne, sans réécrire le compte rendu.
    if(/^(?:TDM|IRM|Bili[- ]?IRM|Scanner|[ÉE]chographie)\s+(?:du\s+|le\s+)?\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}(?:\s*[:：])?$/i.test(clean)) return indent+'*'+clean+'*';
    return line;
  }).join('\n');
}

async function urgShare(p) {
  if (!confirm('Données médicales confidentielles. Confirmez que vous êtes autorisé à les transmettre et vérifiez le destinataire.')) return;
  const text = whatsappObservation(p.observation, p.nom);
  const groups = {
    document: {sources:(p.files || []).filter(f => f.kind === 'document'), files:[], state:'loading'},
    imagerie: {sources:(p.files || []).filter(f => f.kind === 'imagerie'), files:[], state:'loading'}
  };
  const layer = document.createElement('div');
  layer.className = 'urg-share-layer'; layer.setAttribute('role','dialog'); layer.setAttribute('aria-modal','true'); layer.setAttribute('aria-label','Partager sur WhatsApp');
  layer.innerHTML = `<section class="urg-share-box"><header><h3>Partager sur WhatsApp</h3><button type="button" class="icon-btn" data-share-close aria-label="Fermer">✕</button></header>
    <div class="urg-share-actions">
      <button type="button" class="btn primary" data-share-observation ${text ? '' : 'disabled'}>Partager observation</button>
      <button type="button" class="btn primary" data-share-document disabled>Partager document</button>
      <button type="button" class="btn primary" data-share-imagerie disabled>Partager imagerie</button>
    </div><p class="urg-muted" data-share-status role="status" aria-live="polite">Préparation des fichiers…</p></section>`;
  document.body.appendChild(layer);
  const previous = document.activeElement, status = layer.querySelector('[data-share-status]');
  let busy = false;
  const buttons = {observation:layer.querySelector('[data-share-observation]'), document:layer.querySelector('[data-share-document]'), imagerie:layer.querySelector('[data-share-imagerie]')};
  const close = () => { layer.remove(); Object.values(groups).forEach(group => group.files.length = 0); document.removeEventListener('keydown', keydown, true); if(previous?.isConnected) previous.focus({preventScroll:true}); };
  const keydown = event => { if(event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); } };
  document.addEventListener('keydown', keydown, true);
  layer.querySelector('[data-share-close]').onclick = close;
  layer.addEventListener('mousedown', event => { if(event.target === layer) close(); });
  layer.querySelector('[data-share-close]').focus({preventScroll:true});
  const update = () => {
    buttons.observation.disabled = busy || !text;
    for(const key of ['document','imagerie']) buttons[key].disabled = busy || groups[key].state !== 'ready' || !groups[key].files.length;
  };
  const send = async key => {
    if(busy) return;
    const data = key === 'observation' ? {text} : {files:groups[key].files.slice()};
    if(key === 'observation' && !text) return;
    if(key !== 'observation' && !data.files.length) return;
    if(!navigator.share) {
      if(key === 'observation') window.open('https://wa.me/?text='+encodeURIComponent(text),'_blank','noopener');
      else status.textContent = 'Ce navigateur ne permet pas le partage de fichiers. Utilisez un navigateur mobile compatible.';
      return;
    }
    if(key !== 'observation') {
      let supported = false;
      try { supported = !!navigator.canShare?.({files:data.files}); } catch {}
      if(!supported) { status.textContent = 'Le navigateur refuse ces fichiers ou leur combinaison. Aucun partage n’a été effectué.'; return; }
    }
    busy = true; update();
    try { await navigator.share(data); if(layer.isConnected) status.textContent = 'Choisissez WhatsApp et vérifiez le contenu avant l’envoi.'; }
    catch(error) { if(layer.isConnected) status.textContent = error.name === 'AbortError' ? 'Partage annulé.' : 'Partage non effectué : '+error.message; }
    finally { busy = false; if(layer.isConnected) update(); }
  };
  for(const key of Object.keys(buttons)) buttons[key].onclick = () => send(key);
  await Promise.all(Object.entries(groups).map(async ([key,group]) => {
    if(!group.sources.length) { group.state = 'empty'; update(); return; }
    try {
      for(const source of group.sources) {
        if(!layer.isConnected) return;
        const blob = await urgFetchFile(source);
        if(!layer.isConnected) return;
        group.files.push(new File([blob],source.original_name,{type:source.mime || blob.type}));
      }
      group.state = 'ready';
    } catch(error) { group.state = 'error'; group.files.length = 0; group.error = error.message; }
    if(layer.isConnected) update();
  }));
  if(!layer.isConnected) return;
  update();
  const errors = Object.entries(groups).filter(([,group]) => group.state === 'error');
  status.textContent = errors.length ? errors.map(([key,group]) => (key === 'document' ? 'Documents' : 'Imageries')+' indisponibles : '+group.error).join(' · ') :
    [text ? 'Observation prête' : 'Aucune observation', groups.document.sources.length+' document(s)',groups.imagerie.sources.length+' imagerie(s)'].join(' · ');
}

// ---------------------------------------------------------------- historique

async function urgDownloadAdvice(p, button) {
  if (button) button.disabled=true;
  try {
    const response=await fetch(API+`/api/urgences/patients/${p.id}/avis.docx`,{headers:{Authorization:'Bearer '+S.token},credentials:'same-origin'});
    if(!response.ok){const info=await response.json().catch(()=>({}));throw new Error(info.error||'Téléchargement de l’avis impossible.');}
    const blob=await response.blob(), url=URL.createObjectURL(blob), link=document.createElement('a');
    link.href=url;link.download=`avis-urgences-${p.id}.docx`;document.body.appendChild(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  } catch(e) {toast(e.message,true);} finally {if(button?.isConnected)button.disabled=false;}
}

async function urgReturnForm(p) {
  if(!URG.data)await urgLoad();
  formModal({title:'Retour aux urgences — '+p.nom,submit:'Confirmer le retour',values:{zone:'triage'},
    extra:'<p>Un nouveau passage sera créé avec l’observation, tous les documents et imageries, ainsi que toutes les consignes et leur état fait / non fait. Le passage précédent restera conservé.</p>',
    fields:[{name:'zone',label:'Zone d’accueil',type:'select',required:true,options:URG.data.zones.map(z=>[z.id,z.label])}],
    onSubmit:async v=>{const result=await api(`/api/urgences/patients/${p.id}/revenir`,{method:'POST',body:{zone:v.zone}});setTimeout(()=>urgLoad().then(()=>urgOpenPatient(result.id)).catch(e=>toast(e.message,true)),0);}
  });
}

function urgHistoryActions(p) {
  return `<div class="urg-history-actions" role="group" aria-label="Actions pour ${esc(p.nom)}">
    <button type="button" class="btn primary" data-urg-open="${p.id}">Ouvrir le dossier urgences</button>
    ${p.patient_id?`<button type="button" class="btn" data-service-open="${p.patient_id}">Dossier d’hospitalisation</button>`:''}
    ${p.exit_type==='avis'&&p.exit_note?`<button type="button" class="btn" data-advice="${p.id}">Télécharger l’avis Word</button>`:''}
    ${p.status==='sorti'?`<button type="button" class="btn urg-return-btn" data-return="${p.id}">Retour aux urgences</button>`:''}
    ${p.status==='hospitalise'&&!p.patient_id&&p.exit_service?`<button type="button" class="btn" data-convert="${p.id}">Créer le dossier hors service</button>`:''}
    ${isAdmin()?`<button type="button" class="btn danger" data-urg-purge="${p.id}" title="Supprimer définitivement ce patient et son historique aux urgences">Supprimer définitivement</button>`:''}
  </div>`;
}

function urgBindHistoryActions(root, patients) {
  const find=id=>patients.find(p=>String(p.id)===String(id));
  root.querySelectorAll('[data-urg-open]').forEach(b=>b.onclick=()=>urgOpenPatient(Number(b.dataset.urgOpen)));
  root.querySelectorAll('[data-service-open]').forEach(b=>b.onclick=()=>{closeModal();location.hash=`#/patient/${b.dataset.serviceOpen}/maj`;});
  root.querySelectorAll('[data-advice]').forEach(b=>b.onclick=()=>urgDownloadAdvice(find(b.dataset.advice),b));
  root.querySelectorAll('[data-return]').forEach(b=>b.onclick=()=>urgReturnForm(find(b.dataset.return)).catch(e=>toast(e.message,true)));
  root.querySelectorAll('[data-convert]').forEach(b=>b.onclick=async()=>{
    try{const p=(await api('/api/urgences/patients/'+b.dataset.convert)).patient;await urgAdmitForm(p,true);}catch(e){toast(e.message,true);}
  });
  root.querySelectorAll('[data-urg-purge]').forEach(b=>b.onclick=async()=>{
    b.disabled=true;
    try{if(await adminDeleteUrgence(find(b.dataset.urgPurge))){await urgLoad().catch(()=>{});await urgOpenHistory();}}
    catch(e){toast(e.message,true);}finally{if(b.isConnected)b.disabled=false;}
  });
}

async function urgOpenArchived(p) {
  const files=p.files.map(f=>`<li class="urg-file"><span class="urg-file-main"><b>${esc(f.title)}</b><small>${esc(f.original_name)}</small></span><span class="urg-file-act">${/^(image|video)\/|application\/pdf/.test(f.mime)?`<button type="button" class="btn" data-view="${f.id}">Voir</button>`:''}<button type="button" class="btn" data-download="${f.id}">Télécharger</button></span></li>`).join('');
  const ov=modal(`<div class="dialog-head"><div><h2>${esc(p.nom)} — Dossier des urgences</h2><p>Passage n° ${p.id} · ${esc(p.status==='hospitalise'?'Hospitalisé : '+p.exit_service:'Patient sorti')}</p></div><button type="button" class="btn" data-close>Fermer</button></div><div class="dialog-body urg-body">
    ${urgHistoryActions(p)}<p>Arrivée : ${esc(fmtTs(p.arrivee))} · Départ : ${esc(fmtTs(p.closed_at))}</p><p>${esc(p.motif)}</p>
    ${p.previous_urg_id?'<button type="button" class="btn" data-previous>Voir le passage précédent</button>':''}
    <section class="urg-section"><h3>Observation</h3><div class="urg-archive-text">${esc(p.observation||'Aucune observation.')}</div></section>
    <section class="urg-section"><h3>Consignes</h3><ul>${p.consignes.map(c=>`<li>${esc(c.texte)} — ${c.fait?'Faite':'Non faite'}</li>`).join('')||'<li>Aucune consigne.</li>'}</ul></section>
    <section class="urg-section"><h3>Documents et imageries</h3><ul class="urg-file-list">${files||'<li>Aucun fichier.</li>'}</ul></section>
    <section class="urg-section"><h3>${p.exit_type==='avis'?'Avis écrit':'Note de sortie'}</h3><div class="urg-archive-text">${esc(p.exit_note||'Aucune note.')}</div>${p.exit_appointment?`<p>Rendez-vous : ${esc(fmtTs(p.exit_appointment.replace('T',' ')))}</p>`:''}</section>
    <button type="button" class="btn" data-history>Retour à l’historique</button></div>`, 'urg-dialog urg-patient-dialog');
  urgBindHistoryActions(ov,[p]);
  ov.querySelector('[data-close]').onclick=closeModal;
  ov.querySelector('[data-history]').onclick=()=>urgOpenHistory().catch(e=>toast(e.message,true));
  ov.querySelector('[data-previous]')?.addEventListener('click',()=>urgOpenPatient(p.previous_urg_id));
  ov.querySelectorAll('[data-view],[data-download]').forEach(b=>b.onclick=()=>{
    const f=p.files.find(f=>String(f.id)===String(b.dataset.view||b.dataset.download));
    (b.dataset.view?urgPreviewFile(f):urgDownloadFile(f)).catch(e=>toast(e.message,true));
  });
}

async function urgPreviewPdf(f) {
  const layer=document.createElement('div');layer.className='urg-preview';layer.setAttribute('role','dialog');layer.setAttribute('aria-modal','true');
  layer.innerHTML=`<div class="urg-preview-box"><header><b>${esc(f.title)}</b><button type="button" class="btn" data-dl>Télécharger</button><button type="button" class="btn" data-x>Fermer</button></header><div class="document-preview-content"><div class="pdf-local-toolbar"><button type="button" class="btn" data-prev>Précédente</button><span data-label></span><button type="button" class="btn" data-next>Suivante</button><button type="button" class="btn" data-minus>−</button><button type="button" class="btn" data-plus>+</button><span data-zoom></span></div><div class="pdf-local-stage">Chargement…</div></div></div>`;
  document.body.appendChild(layer);
  let url=null,page=1,pages=0,zoom=1,busy=false;
  const controller=new AbortController(),stage=layer.querySelector('.pdf-local-stage');
  const close=()=>{controller.abort();layer.remove();if(url)URL.revokeObjectURL(url);document.removeEventListener('keydown',key,true);window.removeEventListener('hashchange',close);};
  const key=e=>{if(e.key==='Escape'){e.stopPropagation();close();}};
  document.addEventListener('keydown',key,true);window.addEventListener('hashchange',close);
  layer.querySelector('[data-x]').onclick=close;
  layer.querySelector('[data-dl]').onclick=()=>urgDownloadFile(f).catch(e=>toast(e.message,true));
  const update=()=>{
    layer.querySelector('[data-prev]').disabled=busy||page<=1;
    layer.querySelector('[data-next]').disabled=busy||page>=pages;
    layer.querySelector('[data-label]').textContent=pages?`Page ${page} / ${pages}`:'Ouverture…';
    layer.querySelector('[data-zoom]').textContent=Math.round(zoom*100)+' %';
    const image=stage.querySelector('img');if(image)image.style.width=Math.round(zoom*100)+'%';
  };
  const show=async target=>{
    if(busy||!layer.isConnected||target<1||target>pages)return;
    busy=true;update();
    try{
      const response=await fetch(API+`/api/urgences/files/${f.id}/pdf-page/${target}`,{headers:{Authorization:'Bearer '+S.token},credentials:'same-origin',signal:controller.signal});
      if(!response.ok){const info=await response.json().catch(()=>({}));throw new Error(info.error||'Lecture impossible.');}
      const blob=await response.blob();if(!layer.isConnected)return;
      if(url)URL.revokeObjectURL(url);url=URL.createObjectURL(blob);
      const image=document.createElement('img');image.className='pdf-local-image';image.alt=f.title+' — page '+target;image.src=url;stage.replaceChildren(image);page=target;
    }catch(e){if(e.name!=='AbortError'&&layer.isConnected){if(!url)stage.textContent=e.message;toast(e.message,true);}}
    finally{busy=false;if(layer.isConnected)update();}
  };
  layer.querySelector('[data-prev]').onclick=()=>show(page-1);layer.querySelector('[data-next]').onclick=()=>show(page+1);
  layer.querySelector('[data-minus]').onclick=()=>{zoom=Math.max(.5,zoom-.25);update();};layer.querySelector('[data-plus]').onclick=()=>{zoom=Math.min(3,zoom+.25);update();};update();
  try{pages=(await api(`/api/urgences/files/${f.id}/pdf-info`)).pages;if(!pages)throw new Error('PDF sans pages.');await show(1);}catch(e){if(layer.isConnected)stage.textContent=e.message;}
}

async function urgOpenHistory() {
  let q='',offset=0,sequence=0,timer;
  const ov=modal(`<div class="dialog-head"><div><h2>Historique des urgences</h2><p>Patients sortis ou hospitalisés — dossiers et actions</p></div><button type="button" class="btn" data-close>Fermer</button></div><div class="dialog-body urg-body"><input type="search" class="urg-search" data-search placeholder="Rechercher un nom ou un motif" aria-label="Rechercher dans l’historique"><div class="urg-history-list" data-list>Chargement…</div><nav class="urg-history-pagination" aria-label="Pages de l’historique"><button type="button" class="btn" data-prev>Précédente</button><span data-page></span><button type="button" class="btn" data-next>Suivante</button></nav></div>`, 'urg-dialog urg-history-dialog');
  const render=async()=>{
    const serial=++sequence,r=await api('/api/urgences/historique?q='+encodeURIComponent(q)+'&offset='+offset);
    if(!ov.isConnected||serial!==sequence)return;
    ov.querySelector('[data-list]').innerHTML=r.patients.length?r.patients.map(p=>`<article class="urg-history-card"><div class="urg-history-card-head"><div><h3>${esc(p.nom)}</h3><p>${p.age!=null?esc(p.age)+' ans · ':''}${esc(p.motif)}</p></div><span class="urg-history-status">${esc(p.status==='hospitalise'?'Hospitalisé : '+(p.exit_service||'—'):(r.exit_reasons[p.exit_type]||'Sortie'))}</span></div><div class="urg-history-dates"><span>Arrivée : ${esc(fmtTs(p.arrivee))}</span><span>Départ : ${esc(fmtTs(p.closed_at))}</span></div>${urgHistoryActions(p)}</article>`).join(''):'<div class="empty">Aucun passage.</div>';
    urgBindHistoryActions(ov.querySelector('[data-list]'),r.patients);
    ov.querySelector('[data-prev]').disabled=offset===0;ov.querySelector('[data-next]').disabled=!r.has_more;
    ov.querySelector('[data-page]').textContent='Page '+(offset/100+1);
  };
  ov.querySelector('[data-close]').onclick=closeModal;
  ov.querySelector('[data-search]').oninput=e=>{q=e.target.value.trim();offset=0;++sequence;clearTimeout(timer);timer=setTimeout(()=>render().catch(e=>toast(e.message,true)),250);};
  ov.querySelector('[data-prev]').onclick=()=>{offset=Math.max(0,offset-100);render().catch(e=>toast(e.message,true));};
  ov.querySelector('[data-next]').onclick=()=>{offset+=100;render().catch(e=>toast(e.message,true));};
  await render();
}

// FIN URGENCES VISCERALES V1

window.addEventListener('hashchange', render);
S.token = store.get('cva_token');
render();
})();

/* V11 : numéro seul sur mobile, sans modifier les données des chambres. */
(() => {
  const mobile = window.matchMedia('(max-width:900px), (pointer:coarse) and (max-height:500px)');
  const update = () => {
    document.querySelectorAll('.plan-v8 .plan-number').forEach(label => {
      const match = label.textContent.trim().match(/^(?:CH\s*)?(20[1-9]|21[0-8])$/i);
      if (!match) return;
      const text = mobile.matches ? match[1] : 'CH ' + match[1];
      if (label.textContent !== text) label.textContent = text;
    });
  };
  const start = () => {
    update();
    new MutationObserver(update).observe(document.getElementById('app') || document.body, {childList:true,subtree:true});
    mobile.addEventListener('change', update);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();
