import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
export const COUNTRY_CODES={turkey:'TR',germany:'DE',uk:'GB',usa:'US',netherlands:'NL',france:'FR',canada:'CA',ireland:'IE',spain:'ES',poland:'PL',uae:'AE',india:'IN',singapore:'SG'};
const fold=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replaceAll('ı','i');
const catalogs=new Map();
export async function cityOptions(root,country,query=''){
 const code=COUNTRY_CODES[country];if(!code)throw Object.assign(new Error('Choose a country before selecting cities.'),{status:400});
 const key=join(root,'config/cities',code+'.json');
 if(!catalogs.has(key))catalogs.set(key,readFile(key,'utf8').then(JSON.parse).catch(error=>{catalogs.delete(key);throw error;}));
 const cities=await catalogs.get(key),q=fold(query.trim()).slice(0,80);
 return cities.filter(city=>!q||fold(city.name).includes(q)||fold(city.region).includes(q))
  .sort((a,b)=>Number(fold(b.name)===q)-Number(fold(a.name)===q)||Number(fold(b.name).startsWith(q))-Number(fold(a.name).startsWith(q))||a.name.localeCompare(b.name))
  .slice(0,40).map(city=>({value:city.name,label:city.name+(city.region&&fold(city.region)!==fold(city.name)?' · '+city.region:''),name:city.name}));
}
