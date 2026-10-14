import {createDb,migrate,transaction} from '../packages/storage/dist/index.js';
const db=createDb(process.env.DATABASE_URL);
try{
 await migrate(db);
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
 });
 console.log(JSON.stringify({event:'migrations_complete'}));
}finally{await db.end();}
