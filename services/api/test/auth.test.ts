import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomBytes,randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {createDb,migrate} from '@yours/storage';
import {createApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
const db=createDb(process.env.TEST_DATABASE_URL??'postgresql://localhost/yours_test');
const config=readConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://localhost/yours_test',PUBLIC_ORIGIN:'http://localhost:8080',AGENT_ADDRESS:'0x0000000000000000000000000000000000000001'});
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const signer={kid:'test',publicJwk:{...pair.publicKey.export({format:'jwk'}),kid:'test',alg:'ES256',use:'sig'},sign:async(data:Uint8Array)=>new Uint8Array(sign('sha256',data,{key:pair.privateKey,dsaEncoding:'ieee-p1363'}))};
const app=createApp(db,config,signer);
const wallet=privateKeyToAccount(generatePrivateKey());
const headers={'Content-Type':'application/json',Origin:config.PUBLIC_ORIGIN};
beforeAll(()=>migrate(db));afterAll(()=>db.end());
async function login(wallet=privateKeyToAccount(generatePrivateKey())){
 const challenge=await (await app.request('/api/auth/challenge',{method:'POST',headers,body:JSON.stringify({address:wallet.address})})).json();
 const signature=await wallet.signMessage({message:challenge.message});
 const response=await app.request('/api/auth/verify',{method:'POST',headers,body:JSON.stringify({nonce:challenge.nonce,signature})});
 expect(response.status).toBe(200);
 return {cookie:response.headers.get('set-cookie')!.split(';')[0],challenge,signature};
}
it('authenticates an actual wallet signature and consumes the challenge once',async()=>{
 const session=await login(wallet);
 const me=await app.request('/api/owner/me',{headers:{Cookie:session.cookie}});
 expect(me.status).toBe(200);expect((await me.json()).account.address).toBe(wallet.address.toLowerCase());
 const replay=await app.request('/api/auth/verify',{method:'POST',headers,body:JSON.stringify({nonce:session.challenge.nonce,signature:session.signature})});
 expect(replay.status).toBe(401);
});
it('rejects cross-origin writes and keeps user records isolated',async()=>{
 const session=await login();
 const response=await app.request('/api/owner/connections',{method:'POST',headers:{...headers,Cookie:session.cookie},body:JSON.stringify({name:'Gemini',provider:'gemini'})});
 expect(response.status).toBe(201);
 const connection=await response.json();expect(connection.agentToken).toHaveLength(43);
 const crossOrigin=await app.request('/api/owner/connections/'+connection.id+'/pause',{method:'POST',headers:{Origin:'https://evil.example',Cookie:session.cookie}});
 expect(crossOrigin.status).toBe(403);
 const anonymous=await app.request('/api/owner/me');expect(anonymous.status).toBe(401);
 const agent=await app.request('/api/owner/me',{headers:{Authorization:'Bearer '+connection.agentToken}});expect(agent.status).toBe(401);
});
it('rejects private key material in API requests',async()=>{
 const session=await login();
 const response=await app.request('/api/owner/connections',{method:'POST',headers:{...headers,Cookie:session.cookie},body:JSON.stringify({name:'Bad key',provider:'external',agentAddress:'0x'+randomBytes(20).toString('hex'),ap2PublicJwk:{d:'secret'}})});
 expect(response.status).toBe(422);
});
it('only lets the owner rotate an external AI token and invalidates the old token immediately',async()=>{
 const session=await login(),other=await login();
 const created=await app.request('/api/owner/connections',{method:'POST',headers:{...headers,Cookie:session.cookie},body:JSON.stringify({name:'External',provider:'external',agentAddress:privateKeyToAccount(generatePrivateKey()).address,ap2PublicJwk:signer.publicJwk})});
 expect(created.status).toBe(201);const connection=await created.json();
 await db.query("UPDATE connections SET status='active' WHERE id=$1",[connection.id]);
 const path='/api/owner/connections/'+connection.id+'/token';
 expect((await app.request('/api/agent/tasks',{headers:{Authorization:'Bearer '+connection.agentToken}})).status).toBe(200);
 expect((await app.request(path,{method:'POST',headers:{...headers,Authorization:'Bearer '+connection.agentToken}})).status).toBe(403);
 expect((await app.request(path,{method:'POST',headers:{...headers,Cookie:other.cookie}})).status).toBe(404);
 const response=await app.request(path,{method:'POST',headers:{...headers,Cookie:session.cookie}});
 expect(response.status).toBe(200);const rotated=await response.json();
 expect(rotated.agentToken).not.toBe(connection.agentToken);
 expect((await app.request('/api/agent/tasks',{headers:{Authorization:'Bearer '+connection.agentToken}})).status).toBe(401);
 expect((await app.request('/api/agent/tasks',{headers:{Authorization:'Bearer '+rotated.agentToken}})).status).toBe(200);
 expect((await db.query('SELECT status FROM connections WHERE id=$1',[connection.id])).rows[0].status).toBe('active');
});
it('rejects invalid public AP2 keys and an owner address used as an AI address',async()=>{
 const session=await login(wallet);
 for(const body of [
  {agentAddress:wallet.address,ap2PublicJwk:signer.publicJwk},
  {agentAddress:privateKeyToAccount(generatePrivateKey()).address,ap2PublicJwk:{kty:'EC',crv:'P-256',x:'invalid',y:'invalid'}},
  {agentAddress:privateKeyToAccount(generatePrivateKey()).address,ap2PublicJwk:{...signer.publicJwk,crv:'secp256k1'}},
 ]){
  const response=await app.request('/api/owner/connections',{method:'POST',headers:{...headers,Cookie:session.cookie},body:JSON.stringify({name:'Invalid',provider:'external',...body})});
  expect(response.status).toBe(422);
 }
});
