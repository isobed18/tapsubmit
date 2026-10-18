// Export only named PUBLIC ESCO reference vectors, never CV vectors or a whole candidate cache.
// Usage: APPLYBURST_MODEL_CACHE=... node scripts/build_occupation_vectors.mjs <vector-cache.sqlite>
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {occupationAnchors} from '../web/lib/occupations.mjs';
import {MODEL_ID,MODEL_VERSION,textKey} from '../web/lib/semantic.mjs';
const db=new DatabaseSync(process.argv[2],{readOnly:true}),get=db.prepare('SELECT vector FROM text_vectors WHERE key=?');
const entries=occupationAnchors().map(({title})=>{const row=get.get(textKey('passage:'+title));if(!row)throw new Error('Missing public reference: '+title);return[title,Buffer.from(row.vector).toString('base64')];});db.close();
const source_sha256=createHash('sha256').update(readFileSync('config/occupations.esco.json.gz')).digest('hex');
const bytes=gzipSync(JSON.stringify({model:MODEL_ID,version:MODEL_VERSION,source_sha256,entries}),{level:9});
writeFileSync('config/occupation-vectors.pmml12-q8.json.gz',bytes);
console.log(JSON.stringify({public_reference_vectors:entries.length,bytes:bytes.length,model:MODEL_ID,version:MODEL_VERSION}));
