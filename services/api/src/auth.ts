import {randomBytes,randomUUID} from 'node:crypto';
import {createSiweMessage} from 'viem/siwe';
import {verifyMessage,type Address,type Hex} from 'viem';
import {getCookie,setCookie,deleteCookie} from 'hono/cookie';
import {Hono,type Context} from 'hono';
import {z} from 'zod';
import {addressSchema,DomainError,sha256} from '@yours/domain';
import {transaction,audit,type Db} from '@yours/storage';
import type {Config} from './config.js';

export type Actor={kind:'owner';accountId:string;address:Address;authenticatedAt:Date}|{kind:'agent';accountId:string;connectionId:string};
export type Env={Variables:{actor:Actor}};
export function requireOrigin(c:Context,config:Config){
 if(c.req.header('origin')!==new URL(config.PUBLIC_ORIGIN).origin)throw new DomainError('origin_mismatch',403);
}
export async function authenticate(c:Context,db:Db,config:Config):Promise<Actor>{
 const authorization=c.req.header('authorization');
 if(authorization?.startsWith('Bearer ')){
  const token=authorization.slice(7);if(token.length>256)throw new DomainError('unauthorized',401);
  const {rows:[row]}=await db.query("SELECT id,account_id FROM connections WHERE token_hash=$1 AND status='active'",[sha256(token)]);
  if(!row)throw new DomainError('unauthorized',401);
  return {kind:'agent',accountId:row.account_id,connectionId:row.id};
 }
 const token=getCookie(c,'yours_session');if(!token)throw new DomainError('unauthorized',401);
 if(!['GET','HEAD','OPTIONS'].includes(c.req.method))requireOrigin(c,config);
 const {rows:[session]}=await db.query('SELECT s.*,a.address FROM owner_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now()',[sha256(token)]);
 if(!session)throw new DomainError('unauthorized',401);
 return {kind:'owner',accountId:session.account_id,address:session.address,authenticatedAt:session.authenticated_at};
}
export function owner(c:Context<Env>){const actor=c.get('actor');if(actor.kind!=='owner')throw new DomainError('owner_required',403);return actor;}
export function authRoutes(db:Db,config:Config){
 const router=new Hono<Env>();
 router.post('/challenge',async c=>{
  requireOrigin(c,config);
  const {address}=z.object({address:addressSchema}).strict().parse(await c.req.json());
  const {rows:[rate]}=await db.query('SELECT count(*)::int AS count FROM auth_challenges WHERE address=$1 AND expires_at>now()',[address.toLowerCase()]);
  if(rate.count>=10)throw new DomainError('too_many_challenges',429);
  const nonce=randomBytes(16).toString('hex'),expires=new Date(Date.now()+300000);
  const message=createSiweMessage({address,chainId:config.CHAIN_ID,domain:new URL(config.PUBLIC_ORIGIN).host,uri:config.PUBLIC_ORIGIN,version:'1',nonce,statement:'Sign in to yours. This does not authorize spending or token transfers.',issuedAt:new Date(),expirationTime:expires});
  await db.query('INSERT INTO auth_challenges(nonce,address,message,expires_at) VALUES($1,$2,$3,$4)',[nonce,address.toLowerCase(),message,expires]);
  return c.json({nonce,message,expiresAt:expires.toISOString()});
 });
 router.post('/verify',async c=>{
  requireOrigin(c,config);
  const body=z.object({nonce:z.string().regex(/^[a-f0-9]{32}$/),signature:z.string().regex(/^0x[0-9a-fA-F]+$/).max(2048)}).strict().parse(await c.req.json());
  const sessionToken=randomBytes(32).toString('base64url');
  const result=await transaction(db,async tx=>{
   const {rows:[challenge]}=await tx.query('SELECT * FROM auth_challenges WHERE nonce=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE',[body.nonce]);
   if(!challenge||!await verifyMessage({address:challenge.address as Address,message:challenge.message,signature:body.signature as Hex}))throw new DomainError('invalid_wallet_signature',401);
   await tx.query('UPDATE auth_challenges SET used_at=now() WHERE nonce=$1',[body.nonce]);
   const {rows:[account]}=await tx.query('INSERT INTO accounts(id,address,chain_id) VALUES($1,$2,$3) ON CONFLICT(address,chain_id) DO UPDATE SET address=excluded.address RETURNING *',[randomUUID(),challenge.address,config.CHAIN_ID]);
   await tx.query('INSERT INTO owner_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval \'12 hours\')',[sha256(sessionToken),account.id]);
   await audit(tx,account.id,'owner:'+account.id,'session.created',account.id);
   return {id:account.id,address:account.address,chainId:account.chain_id};
  });
  setCookie(c,'yours_session',sessionToken,{httpOnly:true,secure:config.NODE_ENV==='production',sameSite:'Strict',path:'/',maxAge:43200});
  return c.json(result);
 });
 router.post('/logout',async c=>{
  requireOrigin(c,config);const token=getCookie(c,'yours_session');if(token)await db.query('DELETE FROM owner_sessions WHERE token_hash=$1',[sha256(token)]);
  deleteCookie(c,'yours_session',{path:'/'});return c.json({ok:true});
 });
 return router;
}
