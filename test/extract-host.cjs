// Extract @deepseek-ai packages from the installed DSH app.asar: node extract-host.cjs <pkg,pkg> <outDir>
const fs=require('fs'),path=require('path');const f='C:/Deepseek Harness/resources/app.asar';
const fd=fs.openSync(f,'r');const b=Buffer.alloc(16);fs.readSync(fd,b,0,16,0);
const hs=b.readUInt32LE(4);const slen=b.readUInt32LE(12);const hb=Buffer.alloc(slen);fs.readSync(fd,hb,0,slen,16);
const h=JSON.parse(hb.toString());const base=8+hs;
const root=h.files.dsh.files.node_modules.files['@deepseek-ai'].files;
const want=process.argv[2];
if(!want){console.log(Object.keys(root).join('\n'));process.exit()}
const out=process.argv[3];
function walk(node,rel){for(const[k,v]of Object.entries(node.files)){const r=path.join(rel,k);if(v.files)walk(v,r);else if(!v.unpacked&&!v.link){const buf=Buffer.alloc(v.size);fs.readSync(fd,buf,0,v.size,base+Number(v.offset));fs.mkdirSync(path.dirname(path.join(out,r)),{recursive:true});fs.writeFileSync(path.join(out,r),buf)}}}
for(const w of want.split(','))walk(root[w],w);


