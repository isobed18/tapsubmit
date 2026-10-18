// Canonical form intents by meaning, in any language: field labels, buttons, yes/no options and
// confirmation messages. One small multilingual encoder; exemplars are English plus a few others.
// Low similarity or a small margin returns null: the caller then treats the item as unknown.
import {VectorCache,dot} from './semantic.mjs';

const FIELDS={
 first_name:['First name','Given name','Ad','Adınız','Vorname','Nombre','Prénom'],last_name:['Last name','Surname','Family name','Soyad','Soyadınız','Nachname','Apellidos','Nom de famille'],
 name:['Full name','Your name','Name and surname','Ad Soyad','Vollständiger Name','Nombre completo','Nom complet'],
 email:['Email address','E-mail','E-posta adresi','E-Mail-Adresse','Correo electrónico','Adresse e-mail'],phone:['Phone number','Mobile phone number','Telephone','Telefon numarası','Telefonnummer','Número de teléfono','Numéro de téléphone'],
 phone_country:['Phone country code','Country calling code','Ülke telefon kodu','Ländervorwahl'],
 location:['Current location','City of residence','Where are you based?','Yaşadığınız şehir','Wohnort','Ciudad de residencia'],country:['Country of residence','Yaşadığınız ülke','Wohnsitzland'],address:['Street address','Home address','Adres','Anschrift','Dirección'],postal_code:['Postal code','ZIP code','Posta kodu','Postleitzahl','Código postal'],
 linkedin:['LinkedIn profile URL','LinkedIn','LinkedIn profili','LinkedIn-Profil'],github:['GitHub profile URL','GitHub'],website:['Personal website','Portfolio URL','Kişisel web sitesi','Webseite'],
 resume:['Resume / CV','Upload your resume','Attach CV','Özgeçmiş','CV yükleyin','Lebenslauf','Currículum vitae','Curriculum vitae'],cover_letter:['Cover letter','Motivation letter','Ön yazı','Anschreiben','Carta de presentación','Lettre de motivation'],
 current_company:['Current company','Current employer','Şu anki şirketiniz','Aktueller Arbeitgeber','Empresa actual'],current_title:['Current job title','Mevcut pozisyonunuz','Aktuelle Position'],
 years_experience:['Years of professional experience','How many years of experience do you have?','Kaç yıllık deneyiminiz var?','Berufserfahrung in Jahren','Años de experiencia','Années d\'expérience'],
 salary_expectation:['Expected salary','Salary expectations','Desired compensation','Maaş beklentiniz','Gehaltsvorstellung','Expectativa salarial','Prétentions salariales'],
 notice_period:['Notice period','Earliest start date','When can you start?','İhbar süreniz','Ne zaman başlayabilirsiniz?','Kündigungsfrist','Frühester Eintrittstermin','Período de preaviso','Préavis'],
 work_authorization:['Are you legally authorized to work in this country?','Do you have the right to work here?','Çalışma izniniz var mı?','Haben Sie eine Arbeitserlaubnis?','¿Tiene permiso de trabajo?'],
 sponsorship:['Will you now or in the future require visa sponsorship?','Vize sponsorluğuna ihtiyacınız var mı?','Benötigen Sie ein Visum?'],
 relocation:['Are you willing to relocate?','Taşınmaya hazır mısınız?','Sind Sie umzugsbereit?'],weekly_hours:['How many hours per week can you work?','Haftada kaç saat çalışabilirsiniz?','Wie viele Stunden pro Woche?'],
 how_heard:['How did you hear about us?','Referral source','Bizi nereden duydunuz?','Wie haben Sie von uns erfahren?'],consent:['I agree to the privacy policy','I consent to the processing of my personal data','KVKK aydınlatma metnini okudum','Ich stimme der Datenschutzerklärung zu'],
 gender:['Gender','Cinsiyet','Geschlecht','Género'],ethnicity:['Race / ethnicity'],veteran:['Veteran status'],disability:['Disability status','Engellilik durumu'],
 date_of_birth:['Date of birth','Doğum tarihi','Geburtsdatum','Fecha de nacimiento'],nationality:['Nationality','Citizenship','Uyruk','Staatsangehörigkeit','Nacionalidad'],
 education:['Highest level of education','Degree','Eğitim durumu','Höchster Bildungsabschluss'],university:['University / school','Üniversite','Hochschule'],
 graduation_year:['Graduation year','Mezuniyet yılı','Abschlussjahr'],
 // Open-ended questions answered in the person's own words: winning this class means "unknown", never a fact.
 custom:['Why do you want to work here?','Tell us about yourself','Describe a project you worked on','What motivates you?','Why are you a good fit for this role?','Neden bu pozisyona başvuruyorsunuz?','Kendinizden bahsedin','Warum möchten Sie bei uns arbeiten?','Beschreiben Sie ein Projekt','¿Por qué quieres trabajar aquí?','Pourquoi voulez-vous travailler chez nous ?'],languages:['Languages you speak','Bildiğiniz diller','Sprachkenntnisse'],preferred_name:['Preferred name'],pronouns:['Pronouns','Pronomen']
};
const BUTTONS={
 next:['Next','Continue','Continue to next step','Next step','İleri','Devam','Weiter','Siguiente','Suivant','Avanti'],
 review:['Review','Review your application','İncele','Überprüfen','Revisar'],
 submit:['Submit application','Submit','Send application','Apply now','Başvuruyu gönder','Gönder','Bewerbung absenden','Absenden','Enviar solicitud','Envoyer la candidature'],
 other:['Back','Cancel','Save draft','Close','Upload file','Add another','Sign in','Share','Geri','Kaydet','Zurück','Abbrechen']
};
const SUCCESS=['Your application was submitted','Thank you for applying','We have received your application','Application sent','Başvurunuz alındı','Başvurunuz gönderildi','Vielen Dank für Ihre Bewerbung','Su solicitud ha sido enviada','Votre candidature a été envoyée'];
const NOT_SUCCESS=['Please fix the errors','This field is required','Something went wrong','Sign in to continue','Bitte füllen Sie alle Pflichtfelder aus','Lütfen zorunlu alanları doldurun'];
const POLARITY={yes:['Yes','Evet','Ja','Sí','Oui','Sì','Sim','Да'],no:['No','Hayır','Nein','Non','Não','Нет']};

export class Intents{
 constructor({store,dataDirectory}){this.cache=new VectorCache(store.db,dataDirectory);this.sets=null;}
 async prepare(){
  if(this.sets)return this.sets;const sets={};
  for(const [name,groups]of Object.entries({fields:FIELDS,buttons:BUTTONS,polarity:POLARITY})){const entries=Object.entries(groups).flatMap(([label,phrases])=>phrases.map(text=>({label,text})));const vectors=await this.cache.vectors(entries.map(e=>e.text),'passage');sets[name]=entries.map((e,i)=>({...e,vector:vectors[i]}));}
  const success=await this.cache.vectors([...SUCCESS,...NOT_SUCCESS],'passage');sets.success=success.slice(0,SUCCESS.length);sets.not_success=success.slice(SUCCESS.length);
  this.sets=sets;return sets;
 }
 // Best label by its closest exemplar; accept only a clear winner.
 async classify(kind,texts,{floor=0.55,margin=0.05}={}){
  const groups={fields:FIELDS,buttons:BUTTONS,polarity:POLARITY}[kind];if(!groups)throw new Error('Unknown intent kind.');
  // Required/optional markers are layout, not meaning ("Vorname*", "Name (required)").
  const clean=t=>String(t||'').replace(/[*✱]+/g,' ').replace(/\((?:required|optional|zorunlu|isteğe bağlı|erforderlich|optional|obligatorio|obligatoire)\)/gi,' ').replace(/\s+/g,' ').trim().slice(0,200);
  // An exact exemplar (any language) wins outright: short twins like Vorname/Nachname sit too close in
  // embedding space for a confident margin, but the exemplar data already says which is which.
  const key=t=>clean(t).toLocaleLowerCase(),exact=new Map(Object.entries(groups).flatMap(([label,phrases])=>phrases.map(text=>[key(text),label])));
  const result=texts.map(text=>{const hit=exact.get(key(text));return hit&&hit!=='custom'?{label:hit,score:1,margin:1,exact:true}:null;}),pending=texts.map((text,index)=>({text,index})).filter(({text})=>!exact.has(key(text)));
  // Ordinary Next/Back/Yes/No must not initialize an encoder or spend the fast application budget.
  if(!pending.length)return result;
  const sets=await this.prepare(),pool=sets[kind],vectors=await this.cache.vectors(pending.map(({text})=>clean(text)),'query');
  vectors.forEach((v,index)=>{const best=new Map();for(const e of pool){const s=dot(v,e.vector);if(s>(best.get(e.label)??-1))best.set(e.label,s);}
   const ranked=[...best.entries()].sort((a,b)=>b[1]-a[1]),[top,second]=ranked;const ok=top&&top[1]>=floor&&(!second||top[1]-second[1]>=margin);
   result[pending[index].index]=ok&&top[0]!=='custom'?{label:top[0],score:+top[1].toFixed(3),margin:+(top[1]-(second?.[1]??0)).toFixed(3)}:null;});return result;
 }
 // Newly visible text after a final click: confirmation-like and not an error.
 async success(texts){const sets=await this.prepare(),vectors=await this.cache.vectors(texts.map(t=>String(t||'').slice(0,300)),'query');
  return vectors.map(v=>{const yes=Math.max(...sets.success.map(s=>dot(v,s))),no=Math.max(...sets.not_success.map(s=>dot(v,s)));return yes>=0.62&&yes-no>=0.08?{score:+yes.toFixed(3)}:null;});}
}
export const FIELD_INTENTS=Object.keys(FIELDS).filter(k=>k!=='custom');
