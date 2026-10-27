// Builds tiny real .docx/.xlsx/.pptx test files (stored zips) for tools/test-search.cjs.
const zlib=require('zlib');
const crc=(b)=>{let c,t=[];for(let n=0;n<256;n++){c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}let r=0xffffffff;for(const x of b)r=t[(r^x)&255]^(r>>>8);return(r^0xffffffff)>>>0;};
module.exports=function zip(files){const parts=[],cd=[];let off=0;
for(const [name,text] of Object.entries(files)){const data=Buffer.from(text,'utf8'),nm=Buffer.from(name),c=crc(data);
const lh=Buffer.alloc(30);lh.writeUInt32LE(0x04034b50,0);lh.writeUInt16LE(20,4);lh.writeUInt32LE(c,14);lh.writeUInt32LE(data.length,18);lh.writeUInt32LE(data.length,22);lh.writeUInt16LE(nm.length,26);
parts.push(lh,nm,data);
const ch=Buffer.alloc(46);ch.writeUInt32LE(0x02014b50,0);ch.writeUInt16LE(20,4);ch.writeUInt16LE(20,6);ch.writeUInt32LE(c,16);ch.writeUInt32LE(data.length,20);ch.writeUInt32LE(data.length,24);ch.writeUInt16LE(nm.length,28);ch.writeUInt32LE(off,42);
cd.push(ch,nm);off+=30+nm.length+data.length;}
const cdb=Buffer.concat(cd),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(cd.length/2,8);end.writeUInt16LE(cd.length/2,10);end.writeUInt32LE(cdb.length,12);end.writeUInt32LE(off,16);
return Buffer.concat([...parts,cdb,end]);};
