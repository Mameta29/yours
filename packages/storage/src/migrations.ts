import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {transaction,type Db} from './index.js';
export async function migrate(db:Db,directory=fileURLToPath(new URL('../migrations/',import.meta.url))):Promise<void>{
 await transaction(db,async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(917481027)');
  await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,hash text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of (await readdir(directory)).filter(n=>/^\d+.*\.sql$/.test(n)).sort()){
   const sql=await readFile(directory+'/'+name,'utf8'); const hash=createHash('sha256').update(sql).digest('hex');
   const {rows:[old]}=await tx.query('SELECT hash FROM schema_migrations WHERE name=$1',[name]);
   if(old){if(old.hash!==hash)throw new Error('migration_changed:'+name);continue;}
   await tx.query(sql);await tx.query('INSERT INTO schema_migrations(name,hash) VALUES($1,$2)',[name,hash]);
  }
 });
}
