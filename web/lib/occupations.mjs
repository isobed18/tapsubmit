// Occupation identity is data, separate from semantic similarity and from eligibility/permission.
// ESCO's multilingual labels share a stable concept ID. Exact, unambiguous aliases can establish
// identity; an encoder's high cosine alone cannot. No network or candidate data is used here.
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';

let index=null,anchors=null,referenceEntries=null;
const CORE_LANGS=new Set(['en','de','es','fr','nl','pl','it','pt','tr']);
const LEVEL_RE=/\b(?:senior|junior|principal|staff|sr\.?|jr\.?)\b/gi;
const key=text=>String(text||'').replaceAll('ı','i').normalize('NFKC').replace(/\([^)]*\)|\[[^\]]*\]/g,' ')
 .replace(LEVEL_RE,' ').toLowerCase()
 .replace(/[^\p{L}\p{N}+#]+/gu,' ').replace(/\s+/g,' ').trim();

// Canonical market and Turkish bridges onto ESCO occupation concepts (by ESCO preferred English title).
// Turkish is absent from ESCO v1.2.1; common market synonyms also use non-Euro-English phrasing.
const BRIDGES={
 'nurse responsible for general care':['Registered Nurse','Staff Nurse','ICU Nurse','Clinical Nurse','Specialist Nurse','Advanced Nurse Practitioner','Hemşire','Yoğun Bakım Hemşiresi','Servis Hemşiresi','Klinik Hemşiresi','Krankenpfleger','Pflegefachkraft'],
 'general practitioner':['Physician','Medical Doctor','General Practitioner','Specialised Doctor','Doktor','Tıp Doktoru','Pratisyen Hekim','Uzman Doktor'],
 'general veterinarian':['Veterinarian','Specialised Veterinarian','Official Veterinarian','Veteriner','Veteriner Hekim'],
 'dentist':['Dentist','Specialist Dentist','Dental Practitioner','Diş Hekimi'],
 'pharmacist':['Pharmacist','Hospital Pharmacist','Specialist Pharmacist','Industrial Pharmacist','Eczacı'],
 'physiotherapist':['Physiotherapist','Advanced Physiotherapist','Fizyoterapist'],
 'psychologist':['Psychologist','Clinical Psychologist','Health Psychologist','Educational Psychologist','Psikolog','Klinik Psikolog'],
 'medical laboratory assistant':['Medical Laboratory Technician','Tıbbi Laboratuvar Teknisyeni'],
 'software developer':['Software Engineer','Software Developer','Computer Engineer','Computer Engineering','Bilgisayar Mühendisi','Bilgisayar Mühendisliği','Yazılım Mühendisi','Yazılım Geliştirici','Softwareentwickler'],
 'web developer':['Frontend Developer','Frontend Engineer','Front-End Developer','Web Developer','Önyüz Geliştirici','Web Geliştirici','Frontend-Entwickler'],
 'artificial intelligence engineer':['Artificial Intelligence Engineer','AI Engineer','Machine Learning Engineer','ML Engineer','Deep Learning Engineer','Applied Scientist','NLP Engineer','KI-Ingenieur','KI Ingenieur','Yapay Zeka Mühendisi','Makine Öğrenmesi Mühendisi'],
 'computer vision engineer':['Computer Vision Engineer','Bilgisayarlı Görü Mühendisi'],
 'data scientist':['Data Scientist','Veri Bilimci'],
 'data analyst':['Data Analyst','Business Intelligence Analyst','Veri Analisti','İş Zekası Uzmanı','Datenanalyst'],
 'data engineer':['Data Engineer','Veri Mühendisi'],
 'cloud DevOps engineer':['DevOps Engineer','Site Reliability Engineer','Platform Engineer'],
 'cloud engineer':['Cloud Engineer','Bulut Mühendisi'],
 'software architect':['Solutions Architect','Software Architect','Çözüm Mimarı','Yazılım Mimarı'],
 'embedded systems software developer':['Embedded Software Engineer','Firmware Engineer','Gömülü Sistemler Mühendisi','Gömülü Yazılım Mühendisi'],
 'digital games developer':['Game Developer','Oyun Geliştirici'],
 'mobile application developer':['Mobile Developer','iOS Developer','Android Developer','Mobil Uygulama Geliştirici'],
 'software tester':['QA Engineer','Test Automation Engineer','Quality Assurance Engineer','Yazılım Test Mühendisi','Test Uzmanı'],
 'ICT security administrator':['Security Engineer','Cybersecurity Analyst','Cybersecurity Engineer','Siber Güvenlik Uzmanı','Bilgi Güvenliği Uzmanı'],
 'ICT network technician':['Network Engineer','Ağ Uzmanı','Ağ Mühendisi'],
 'ICT system administrator':['System Administrator','Sistem Yöneticisi'],
 'ICT help desk agent':['IT Support Specialist','Technical Support Specialist','Service Desk Engineer','Teknik Destek Uzmanı','Teknik Destek Elemanı','BT Destek Uzmanı'],
 'database administrator':['Database Administrator','Veritabanı Yöneticisi'],
 'user experience analyst':['Product Designer','UX Designer','UI Designer','UX/UI Designer','Kullanıcı Deneyimi Tasarımcısı'],
 'graphic designer':['Graphic Designer','Grafik Tasarımcı'],
 'product manager':['Product Manager','Product Owner','Ürün Yöneticisi','Ürün Sorumlusu'],
 'project manager':['Project Manager','Program Manager','Proje Yöneticisi','Projektleiter'],
 'business analyst':['Business Analyst','İş Analisti'],
 'sales engineer':['Sales Engineer','Solutions Consultant','Satış Mühendisi'],
 'commercial sales representative':['Sales Representative','Account Executive','Business Development Representative','Satış Temsilcisi','Satış Danışmanı','Saha Satış Temsilcisi','Vertriebsmitarbeiter'],
 'customer service representative':['Customer Service Representative','Customer Support Specialist','Customer Success Manager','Call Center Agent','Müşteri Temsilcisi','Çağrı Merkezi Müşteri Temsilcisi','Müşteri Destek Uzmanı','Kundenberater'],
 'marketing manager':['Marketing Specialist','Marketing Manager','Pazarlama Uzmanı'],
 'digital marketing manager':['Digital Marketing Specialist','SEO Specialist','Social Media Specialist','Dijital Pazarlama Uzmanı','Sosyal Medya Uzmanı','Especialista en Marketing Digital'],
 'public relations officer':['Public Relations Specialist','Halkla İlişkiler Uzmanı'],
 'human resources officer':['HR Specialist','HR Business Partner','Recruiter','Talent Acquisition Specialist','İnsan Kaynakları Uzmanı','İşe Alım Uzmanı','Personalreferent'],
 'payroll clerk':['Payroll Specialist','Bordro Uzmanı'],
 'accountant':['Accountant','Senior Accountant','Financial Accountant','Management Accountant','Staff Accountant','Public Finance Accountant','Muhasebe Uzmanı','Muhasebeci','Mali Müşavir','Buchhalter'],
 'financial analyst':['Financial Analyst','Investment Analyst','Finans Uzmanı','Finansal Analist'],
 'financial auditor':['Auditor','Internal Auditor','Denetçi','İç Denetçi'],
 'tax advisor':['Tax Specialist','Tax Advisor','Vergi Uzmanı'],
 'financial controller':['Financial Controller','Finansal Kontrolör'],
 'bank teller':['Bank Teller','Banka Gişe Yetkilisi'],
 'insurance broker':['Insurance Agent','Sigorta Danışmanı'],
 'office manager':['Office Manager','Ofis Yöneticisi','Mağaza Müdürü','Store Manager'],
 'administrative assistant':['Administrative Assistant','Executive Assistant','Receptionist','Sekreter','Ofis Asistanı','Yönetici Asistanı'],
 'operations manager':['Operations Manager','Operations Specialist','Operasyon Yöneticisi','Operasyon Uzmanı'],
 'supply chain manager':['Supply Chain Specialist','Logistics Coordinator','Lojistik Uzmanı','Tedarik Zinciri Uzmanı'],
 'procurement category specialist':['Procurement Specialist','Satın Alma Uzmanı'],
 'warehouse worker':['Warehouse Worker','Warehouse Associate','Depo Personeli','Lagerarbeiter'],
 'cargo vehicle driver':['Truck Driver','Delivery Driver','Şoför','Kamyon Şoförü'],
 'mechanical engineer':['Mechanical Engineer','Makine Mühendisi','Maschinenbauingenieur'],
 'electrical engineer':['Electrical Engineer','Elektrik Mühendisi','Elektrik-Elektronik Mühendisi','Elektroingenieur'],
 'electronics engineer':['Electronics Engineer','Elektronik Mühendisi'],
 'civil engineer':['Civil Engineer','Site Engineer','İnşaat Mühendisi','Saha Mühendisi','Bauingenieur'],
 'industrial engineer':['Industrial Engineer','Manufacturing Engineer','Production Planner','Endüstri Mühendisi','Üretim Mühendisi','Üretim Planlama Uzmanı'],
 'chemical engineer':['Chemical Engineer','Kimya Mühendisi'],
 'quality engineer':['Quality Engineer','Kalite Mühendisi','Talaşlı İmalat Kalite Mühendisi'],
 'automation engineer':['Automation Engineer','Industrial Automation Engineer','Endüstriyel Otomasyon Mühendisi','Otomasyon Ve Kontrol Mühendisi'],
 'design engineer':['Mechanical Design Engineer','Mekanik Tasarım Mühendisi'],
 'electromechanical engineering technician':['Maintenance Technician','Bakım Teknisyeni'],
 'electrician':['Electrician','Elektrikçi'],
 'welder':['Welder','Kaynakçı'],
 'computer numerical control machine operator':['CNC Operator','CNC Operatörü'],
 'building construction worker':['Construction Worker','İnşaat İşçisi'],
 'architect':['Architect','Mimar'],
 'interior architect':['Interior Designer','İç Mimar'],
 'environmental engineer':['Environmental Engineer','Çevre Mühendisi'],
 'energy engineer':['Energy Engineer','Enerji Mühendisi'],
 'secondary school teacher':['Teacher','English Teacher','Mathematics Teacher','Primary School Teacher','Öğretmen','İngilizce Öğretmeni','Matematik Öğretmeni','Sınıf Öğretmeni','Lehrer'],
 'early Years teacher':['Preschool Teacher','Okul Öncesi Öğretmeni','Anaokulu Öğretmeni'],
 'university teaching assistant':['Teaching Assistant','University Lecturer','Araştırma Görevlisi','Öğretim Görevlisi'],
 'lawyer':['Lawyer','Corporate Lawyer','Avukat','Hukuk Müşaviri'],
 'legal assistant':['Legal Assistant','Paralegal','Hukuk Asistanı'],
 'compliance engineer':['Compliance Specialist','Uyum Uzmanı'],
 'technical communicator':['Technical Writer','Teknik Yazar'],
 'chef':['Chef','Sous Chef','Head Chef','Pastry Chef','Private Chef','Chef de Partie','Cook','Line Cook','Industrial Cook','Şef','Aşçı','Koch'],
 'waiter/waitress':['Waiter','Garson'],
 'barista':['Barista'],
 'hotel receptionist':['Hotel Receptionist','Otel Resepsiyonisti'],
 'domestic housekeeper':['Housekeeper','Kat Görevlisi'],
 'tour guide':['Tour Guide','Tur Rehberi'],
 'cabin crew member':['Flight Attendant','Kabin Memuru'],
 'aircraft pilot':['Pilot','Uçak Pilotu'],
 'shop assistant':['Retail Sales Associate','Satış Görevlisi','Verkäufer'],
 'cashier':['Cashier','Kasiyer'],
 'real estate agent':['Real Estate Agent','Emlak Danışmanı'],
 'translator':['Translator','Interpreter','Çevirmen','Tercüman'],
 'journalist':['Journalist','Gazeteci'],
 'Copy Editor':['Editor','Editör'],
 'video and motion picture editor':['Video Editor','Video Editörü','Video Kreatif Uzmanı'],
 'photographer':['Photographer','Fotoğrafçı'],
 'animator':['Animator','Animatör'],
 'fitness instructor':['Fitness Trainer','Fitness Eğitmeni'],
 'security guard':['Security Guard','Güvenlik Görevlisi'],
 'building cleaner':['Cleaner','Temizlik Personeli'],
 'social worker':['Social Worker','Sosyal Hizmet Uzmanı'],
 'event manager':['Event Coordinator','Etkinlik Koordinatörü'],
 'online sales channel manager':['E-commerce Specialist','Category Manager','Merchandiser','E-ticaret Uzmanı','Kategori Yöneticisi'],
 'data entry clerk':['Data Entry Clerk','Veri Giriş Elemanı']
};

function prepare(){
 if(index)return index;
 const dataset=JSON.parse(gunzipSync(readFileSync(new URL('../../config/occupations.esco.json.gz',import.meta.url))).toString('utf8'));
 const terms=new Map(),abbreviations=new Map(),byTitle=new Map();
 const add=(text,occupation,priority)=>{
  const k=key(text);if(k.length<3)return;
  const old=terms.get(k);
  if(!old||priority>old.priority)terms.set(k,{occupation,priority});
  else if(priority===old.priority&&old.occupation?.id!==occupation.id)old.occupation=null;
 };
 for(const occupation of dataset.occupations){
  byTitle.set(occupation.title.toLowerCase(),occupation);
  // Priority order: English preferred (5) > other preferred (4) > English alt (3) > core alt (2).
  // Non-core languages index their preferred label (priority 4) plus up to 2 short aliases so
  // startup takes ~100 ms instead of 3.5 s while keeping all 28 languages represented.
  for(const [lang,labels]of Object.entries(occupation.labels)){
   const limit=lang==='en'?labels.length:CORE_LANGS.has(lang)?Math.min(labels.length,5):Math.min(labels.length,2);
   for(let i=0;i<limit;i++){
    const label=labels[i],priority=i===0?(lang==='en'?5:4):(lang==='en'?3:2);
    add(label,occupation,priority);
    if(label.includes('/'))for(const part of label.split('/'))add(part,occupation,priority);
   }
  }
  // Derive initialisms from declared English aliases, skipping seniority abbreviations (sr/jr)
  // that key() would strip down to a bare noun ("sr cook" -> "cook").
  for(const [i,label]of (occupation.labels.en||[]).entries()){
   const words=label.split(/\s+/);
   for(let n=2;n<Math.min(words.length,5);n++){
    if(words.slice(0,n).every(w=>/^[a-z]+$/i.test(w))){
     const init=words.slice(0,n).map(w=>w[0]).join('');
     if(/^(?:sr|jr|iv|ii|iii)$/i.test(init))continue;
     const alias=init+' '+words.slice(n).join(' '),k=key(alias);
     if(!abbreviations.has(k))abbreviations.set(k,occupation.id);
     else if(abbreviations.get(k)!==occupation.id)abbreviations.set(k,null);
     add(alias,occupation,i===0?1:0);
    }
   }
  }
 }
 // Conflicting initialisms only invalidate synthetic abbreviation entries (priority <= 1),
 // never explicit preferred/alternative occupation labels (priority >= 2).
 for(const [k,id]of abbreviations){
  const entry=terms.get(k);
  if(entry&&entry.priority<=1&&(!id||entry.occupation?.id!==id))terms.set(k,{occupation:null,priority:1});
 }
 for(const [target,aliases]of Object.entries(BRIDGES)){
  const occupation=byTitle.get(target.toLowerCase())||terms.get(key(target))?.occupation;
  if(!occupation)continue;
  occupation.labels.en??=[];occupation.labels.tr??=[];occupation.labels.de??=[];
  for(const alias of aliases){
   const lang=/[çğıöşüİ]|\b(?:mühendis\w*|uzman\w*|danışman\w*|temsilci\w*|yönetici\w*|hekim\w*|hemşire\w*|öğretmen\w*|geliştirici|analist\w*|sorumlu\w*|eleman\w*|personel\w*|asistan\w*|operatör\w*|teknisyen\w*|memur\w*|müşavir\w*|kontrolör|garson|kasiyer|şoför|avukat|eczacı|mimar|aşçı|şef|stajyer|doktor|veteriner|sekreter|rehber\w*|editör|çevirmen|tercüman|gazeteci|fotoğrafçı|animatör|eğitmen\w*|müdür\w*|bilimci|tasarımcı\w*|yazar|işçi\w*|görevli\w*|yetkili\w*)\b/i.test(alias)?'tr':/\b(?:ingenieur|entwickler|berater|leiter|pfleger|fachkraft|buchhalter|lehrer|verkäufer|arbeiter|koch|datenanalyst|personalreferent|werkstudent|praktikant)\b/i.test(alias)?'de':'en';
   if(!occupation.labels[lang].includes(alias))occupation.labels[lang].push(alias);
   if(alias.toLowerCase()!=='ai engineer')add(alias,occupation,5.5);
  }
 }
 index={dataset,terms,version:dataset.version,count:dataset.occupations.length,languages:[...new Set([...dataset.languages,'tr'])].sort()};
 return index;
}
export function occupationFor(title){return prepare().terms.get(key(title))?.occupation||null;}
export function occupationAliases(title,langFilter=null){
 const data=prepare(),occupation=data.terms.get(key(title))?.occupation;if(!occupation)return[];
 const cacheKey=langFilter||'all';
 occupation._aliases??={};
 if(occupation._aliases[cacheKey])return occupation._aliases[cacheKey];
 const out=[];
 for(const [lang,labels]of Object.entries(occupation.labels)){
  if(langFilter?langFilter==='en'?(lang==='tr'||lang==='de'||!CORE_LANGS.has(lang)):lang!==langFilter:(lang!=='en'&&!CORE_LANGS.has(lang)))continue;
  const max=lang==='en'||lang==='tr'?labels.length:3;
  for(let i=0;i<Math.min(labels.length,max);i++){
   const label=labels[i];
   if((i===0||label.trim().split(/\s+/).length>1)&&data.terms.get(key(label))?.occupation?.id===occupation.id)out.push(label);
  }
 }
 occupation._aliases[cacheKey]=[...new Set(out)];
 return occupation._aliases[cacheKey];
}
export function occupationAnchors(){
 if(!anchors){const {dataset}=prepare();anchors=dataset.occupations.flatMap(occupation=>occupation.labels.en?.[0]?[{title:occupation.labels.en[0],occupation_id:occupationFor(occupation.labels.en[0])?.id||occupation.id}]:[]);}
 return anchors;
}
export function occupationReferenceEntries(){
 if(!referenceEntries){const {dataset}=prepare();referenceEntries=dataset.occupations.flatMap(occupation=>occupation.labels.en?.[0]?[{title:occupation.labels.en[0],occupation_id:occupationFor(occupation.labels.en[0])?.id||occupation.id,aliases:occupationAliases(occupation.labels.en[0])}]:[]);}
 return referenceEntries;
}
export function sameOccupation(a,b){const left=occupationFor(a),right=occupationFor(b);return !!left&&!!right&&left.id===right.id;}
export function occupationStats(){const data=prepare();return{version:data.version,occupations:data.count,aliases:data.terms.size,languages:data.languages};}
