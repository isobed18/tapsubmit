// Reproducible dependency-free ZIP. Package source, never local profiles or storage.
import {readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
const root=new URL('../',import.meta.url),source=new URL('extension/',root),parts=[],directory=[];
const crc32=data=>{let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;};
let offset=0;
for(const file of readdirSync(source).filter(name=>/\.(js|json|html|css|png|svg)$/.test(name)).sort()){
 const name=Buffer.from(file),raw=readFileSync(new URL(file,source)),compressed=deflateRawSync(raw),crc=crc32(raw);
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt16LE(33,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(name.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);central.writeUInt16LE(33,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
 parts.push(local,name,compressed);directory.push(central,name);offset+=local.length+name.length+compressed.length;
}
const table=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(directory.length/2,8);end.writeUInt16LE(directory.length/2,10);end.writeUInt32LE(table.length,12);end.writeUInt32LE(offset,16);
mkdirSync(new URL('dist/',root),{recursive:true});writeFileSync(new URL('dist/tapsubmit-extension.zip',root),Buffer.concat([...parts,table,end]));
console.log('Packaged TapSubmit extension source.');
