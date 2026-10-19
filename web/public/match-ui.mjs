// Match percentage badge + "Why this match" details, shared by the local app and the public site.
// fit = {percent, verdict, calibrated, dimensions:[{id,label,status,detail,matched,missing,preferred_matched}], strengths, gaps}
const el=(tag,cls='',text='')=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node;};
const ICON={match:'✓',partial:'◐',gap:'✗',unknown:'○'};
const tier=p=>p>=75?'strong':p>=50?'good':p>=25?'possible':'weak';

export function matchBadge(fit){
 if(!fit||typeof fit.percent!=='number')return null;
 const badge=el('span','match-badge match-'+tier(fit.percent),fit.percent+'% · '+fit.verdict);
 badge.title=fit.calibrated===false?'Estimated match (calibration pending)':'Match percentage: how likely a recruiter would rate your CV a good fit for this job';
 return badge;
}
export function matchDetails(fit,{open=false}={}){
 if(!fit?.dimensions?.length)return null;
 const box=el('details','match-why');if(open)box.open=true;
 const summary=el('summary','','Why this match');box.append(summary);
 const list=el('ul','match-dims');
 for(const d of fit.dimensions){
  const li=el('li','dim dim-'+d.status);li.append(el('span','dim-icon',ICON[d.status]||'○'),el('b','',d.label+' '),el('span','dim-detail',d.detail||''));
  if(d.matched?.length)li.append(el('small','dim-has','Has: '+d.matched.slice(0,8).join(', ')));
  if(d.missing?.length)li.append(el('small','dim-missing','Missing: '+d.missing.slice(0,8).join(', ')));
  if(d.preferred_matched?.length)li.append(el('small','dim-pref','Nice-to-have you have: '+d.preferred_matched.slice(0,6).join(', ')));
  list.append(li);
 }
 box.append(list);
 if(fit.calibrated===false)box.append(el('small','match-note','Percentages are provisional until the matcher is calibrated.'));
 return box;
}
