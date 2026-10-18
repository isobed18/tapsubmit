// Multi-city selection with local, country-scoped data. The widget is loaded only when needed.
export function createCityPicker({onChange,onError=()=>{},endpoint='/applyburst/api/locations/cities'}){
 const host=document.querySelector('#city-picker-wrap'),select=document.querySelector('#city-picker');
 let picker=null,loading=null,country='',revision=0;
 const cities=()=>picker?[...picker.items]:[...select.selectedOptions].map(option=>option.value);
 function sync(values){
  const selected=[...new Set((values||[]).map(String).filter(Boolean))].slice(0,5);
  if(picker){for(const value of selected)picker.addOption({value,label:value});picker.setValue(selected,true);}
  else select.replaceChildren(...selected.map(value=>new Option(value,value,true,true)));
 }
 async function update({country:nextCountry,visible,values=[]}){
  const changed=country!==nextCountry;country=nextCountry;const updateRevision=++revision;host.hidden=!visible;
  sync(values);if(!visible)return;
  select.disabled=!country||country==='worldwide';
  if(!country||country==='worldwide'){picker?.disable();return;}
  if(!loading)loading=import('./tom-select.js').then(()=>{
   picker=new window.TomSelect(select,{
    plugins:['remove_button'],maxItems:5,maxOptions:40,create:false,valueField:'value',labelField:'label',searchField:['label'],
    placeholder:'Search and select cities',loadThrottle:200,shouldLoad:query=>query.trim().length>=2,
    load(query,callback){
     const expected=revision;
     fetch(endpoint+'?country='+encodeURIComponent(country)+'&q='+encodeURIComponent(query),{signal:AbortSignal.timeout(5000)})
      .then(async response=>{if(!response.ok)throw Error('Could not load cities.');return response.json();})
      .then(data=>callback(expected===revision?data.cities:[])).catch(()=>{callback();onError('City list could not load. Try again.');});
    },
    onChange(){onChange(cities());},
    render:{option:(data,escape)=>'<div>'+escape(data.label)+'</div>',item:(data,escape)=>'<div>'+escape(data.value)+'</div>',not_loading:()=>'<div class="no-results">Type at least 2 letters to find a city</div>'}
   });return picker;
  }).catch(error=>{loading=null;onError('City selector could not load. Reload to retry.');throw error;});
  try{await loading;if(updateRevision!==revision)return;if(changed){picker.clear(true);picker.clearOptions();picker.loadedSearches={};}sync(values);if(country&&country!=='worldwide')picker.enable();else picker.disable();}catch{}
 }
 return{update,cities};
}
