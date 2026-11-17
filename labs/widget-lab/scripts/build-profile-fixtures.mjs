import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary=await mkdtemp(join(tmpdir(),'paprika-profile-fixtures-'));
try{
 const bundled=await build({entryPoints:['src/lenses/profiling/profile-fixtures.ts'],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const modulePath=join(temporary,'fixtures.mjs');await writeFile(modulePath,bundled.outputFiles[0].text);
 const {PROFILE_FIXTURES,buildProfileFixture,speedscopeFile}=await import(pathToFileURL(modulePath).href);
 const output=resolve('public/fixtures/profiling');await mkdir(output,{recursive:true});
 const manifest=[];
 for(const meta of PROFILE_FIXTURES){
   const fixture=buildProfileFixture(meta.id), files=[`${meta.id}.flamebearer.json`];
   await writeFile(join(output,files[0]),JSON.stringify(fixture.raw,null,2)+'\n');
   if(fixture.samples){const file=`${meta.id}.speedscope.json`;await writeFile(join(output,file),JSON.stringify(speedscopeFile(fixture.samples,fixture.profile.name),null,2)+'\n');files.push(file);}
   if(fixture.folded){const file=`${meta.id}.folded`;await writeFile(join(output,file),fixture.folded+'\n');files.push(file);}
   manifest.push({id:meta.id,label:meta.label,synthetic:true,unit:fixture.profile.unit,sampleRate:fixture.profile.sampleRate,total:fixture.profile.total,frames:fixture.profile.frames.length,samples:fixture.samples?.length??0,files});
 }
 await writeFile(join(output,'manifest.json'),JSON.stringify({description:'Deterministic Paprika mock profiles. No live or captured production data.',profiles:manifest},null,2)+'\n');
 console.log(`Wrote ${manifest.reduce((sum,item)=>sum+item.files.length,1)} profiling fixture files to public/fixtures/profiling.`);
}finally{await rm(temporary,{recursive:true,force:true});}
