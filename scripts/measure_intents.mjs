// Bounded multilingual check of canonical form intents (fields, buttons, yes/no, confirmations).
// Same meaning in several languages should map to one intent; custom questions must stay unknown.
import {DatabaseSync} from 'node:sqlite';
import {Intents} from '../web/lib/intents.mjs';
const db=new DatabaseSync('.data/model-eval/planner.sqlite'),intents=new Intents({store:{db},dataDirectory:'.data/model-eval'});
const FIELDS=[
 ['first_name',['First name','Ad','Vorname','Nombre','Prénom']],['last_name',['Last name','Soyad','Nachname','Apellidos','Nom de famille']],
 ['email',['Email address','E-posta adresi','E-Mail-Adresse','Correo electrónico','Adresse e-mail']],['phone',['Phone number','Telefon numarası','Telefonnummer','Número de teléfono','Numéro de téléphone']],
 ['resume',['Resume/CV','Özgeçmiş (CV)','Lebenslauf','Currículum','CV']],['linkedin',['LinkedIn profile','LinkedIn profili','LinkedIn-Profil','Perfil de LinkedIn','Profil LinkedIn']],
 ['salary_expectation',['Expected salary','Maaş beklentiniz','Gehaltsvorstellung','Expectativa salarial','Prétentions salariales']],
 ['notice_period',['Notice period','İhbar süreniz','Kündigungsfrist','Período de preaviso','Préavis']],
 ['work_authorization',['Are you legally authorized to work in Germany?','Türkiye\'de çalışma izniniz var mı?','Haben Sie eine Arbeitserlaubnis für Deutschland?','¿Tiene permiso de trabajo en España?','Êtes-vous autorisé à travailler en France ?']],
 ['sponsorship',['Will you require visa sponsorship?','Vize sponsorluğuna ihtiyacınız olacak mı?','Benötigen Sie ein Visum-Sponsoring?','¿Necesitará patrocinio de visa?','Aurez-vous besoin d\'un parrainage de visa ?']],
 ['years_experience',['Years of experience','Kaç yıllık deneyiminiz var?','Wie viele Jahre Berufserfahrung haben Sie?','Años de experiencia','Années d\'expérience']],
];
// Phrasings that are NOT exemplars, to check generalisation rather than memorised strings.
const HELD_OUT=[['first_name',['Your first name','Adınız nedir?','Ihr Vorname','Tu nombre de pila']],['email',['Contact email','İletişim e-postanız','Ihre E-Mail','Tu correo']],['phone',['Contact number','İletişim numaranız','Ihre Handynummer','Tu número de móvil']],
 ['resume',['Attach your CV here','Özgeçmişinizi ekleyin','Laden Sie Ihren Lebenslauf hoch','Adjunta tu CV']],['notice_period',['How soon could you join us?','İşe ne zaman başlayabilirsiniz?','Ab wann könnten Sie anfangen?','¿Cuándo podrías empezar?']],
 ['salary_expectation',['What salary are you expecting?','Ücret beklentiniz nedir?','Welches Gehalt erwarten Sie?','¿Qué salario esperas?']]];
// Held out from the custom exemplars.
const UNKNOWN=['Why do you want to join Example Labs specifically?','Describe a project you are proud of and your role in it','Bu pozisyon için neden uygun olduğunuzu düşünüyorsunuz?','Was motiviert Sie an dieser Stelle?','What is your favourite programming paradigm and why?','Share a time you disagreed with a teammate'];
const BUTTONS=[['next',['Next','İleri','Weiter','Siguiente','Suivant']],['review',['Review','İncele','Überprüfen','Revisar','Vérifier']],['submit',['Submit application','Başvuruyu gönder','Bewerbung absenden','Enviar solicitud','Envoyer la candidature']],['other',['Back','Geri','Zurück','Atrás','Retour']]];
const POLARITY=[['yes',['Yes','Evet','Ja','Sí','Oui']],['no',['No','Hayır','Nein','No','Non']]];
const SUCCESS=['Thanks, your application has been received.','Başvurunuz başarıyla alınmıştır.','Vielen Dank! Ihre Bewerbung ist bei uns eingegangen.','¡Gracias! Hemos recibido tu candidatura.','Merci, votre candidature a bien été envoyée.'];
const ERRORS=['This field is required','Bu alan zorunludur','Dieses Feld ist erforderlich','Este campo es obligatorio','Ce champ est obligatoire'];
const t0=performance.now();await intents.prepare();const prep=performance.now()-t0;
let ok=0,total=0,wrong=[],abstain=[];
for(const [label,texts] of FIELDS){const out=await intents.classify('fields',texts);out.forEach((r,i)=>{total++;if(r?.label===label)ok++;else if(r)wrong.push(texts[i]+' -> '+r.label);else abstain.push(texts[i]);});}
let hok=0,htotal=0,hwrong=[],habstain=[];for(const [label,texts] of HELD_OUT){const out=await intents.classify('fields',texts);out.forEach((r,i)=>{htotal++;if(r?.label===label)hok++;else if(r)hwrong.push(texts[i]+' -> '+r.label);else habstain.push(texts[i]);});}
const unk=await intents.classify('fields',UNKNOWN),falsePositive=unk.filter(Boolean).map((r,i)=>UNKNOWN[i]+' -> '+r.label);
let bok=0,btotal=0,bwrong=[];for(const [label,texts] of BUTTONS){const out=await intents.classify('buttons',texts,{floor:0.5,margin:0.04});out.forEach((r,i)=>{btotal++;if(r?.label===label)bok++;else bwrong.push(texts[i]+' -> '+(r?.label||'none'));});}
let pok=0,ptotal=0;for(const [label,texts] of POLARITY){const out=await intents.classify('polarity',texts,{floor:0.5,margin:0.05});out.forEach(r=>{ptotal++;if(r?.label===label)pok++;});}
const succ=await intents.success(SUCCESS),errs=await intents.success(ERRORS);
console.log(JSON.stringify({fields:{correct:ok,total,wrong,abstained:abstain.length},held_out:{correct:hok,total:htotal,wrong:hwrong,abstained:habstain},custom_questions_false_positive:falsePositive,buttons:{correct:bok,total:btotal,wrong:bwrong},polarity:{correct:pok,total:ptotal},success_detected:succ.filter(Boolean).length+'/'+SUCCESS.length,errors_misread_as_success:errs.filter(Boolean).length+'/'+ERRORS.length,prepare_ms:Math.round(prep)},null,1));
