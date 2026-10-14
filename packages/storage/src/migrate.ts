import {createDb,migrate} from './index.js';
const url=process.env.DATABASE_URL;if(!url)throw new Error('DATABASE_URL is required');
const db=createDb(url);try{await migrate(db);process.stdout.write('Database migrated.\n');}finally{await db.end();}
