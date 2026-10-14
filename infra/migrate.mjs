import {createDb,migrate,transaction} from '../packages/storage/dist/index.js';
import {seedCatalog} from './catalog.mjs';
const db=createDb(process.env.DATABASE_URL);
try{
 await migrate(db);
 await seedCatalog(db);
 await transaction(db,async tx=>{
  // Dedicated application role; the LLM service never receives this credential.
  await tx.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='yours_app') THEN CREATE ROLE yours_app NOLOGIN; END IF; END $$");
  await tx.query('GRANT CONNECT ON DATABASE yours TO yours_app');
  await tx.query('GRANT USAGE ON SCHEMA public TO yours_app');
  await tx.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO yours_app');
  await tx.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO yours_app');
  await tx.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO yours_app');
  await tx.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO yours_app');
  await tx.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await tx.query('GRANT yours_app TO yours_runtime');
  await tx.query('REVOKE cloudsqlsuperuser FROM yours_runtime');
  await tx.query('ALTER ROLE yours_runtime NOCREATEDB NOCREATEROLE');
  const {rows:[runtime]}=await tx.query("SELECT rolcreatedb,rolcreaterole,rolsuper,pg_has_role('yours_runtime','cloudsqlsuperuser','member') AS admin_member FROM pg_roles WHERE rolname='yours_runtime'");
  if(!runtime||runtime.rolcreatedb||runtime.rolcreaterole||runtime.rolsuper||runtime.admin_member)throw new Error('runtime_database_role_not_restricted');
 });
 console.log(JSON.stringify({event:'migrations_complete'}));
}finally{await db.end();}
