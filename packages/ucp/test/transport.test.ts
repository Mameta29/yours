import {it,expect} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {httpbis} from 'http-message-signatures';
import {signHttp,verifyHttp,contentDigest} from '../src/transport.js';
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const signer={kid:'merchant',publicJwk:{...pair.publicKey.export({format:'jwk'}),kid:'merchant',alg:'ES256',use:'sig'},sign:async(bytes:Uint8Array)=>new Uint8Array(sign('sha256',bytes,{key:pair.privateKey,dsaEncoding:'ieee-p1363'}))};
const body=Buffer.from('{"order":"one"}');
const message={method:'POST',url:'https://platform.example/events?tenant=one',headers:{'content-type':'application/json','ucp-agent':'profile="https://merchant.example/.well-known/ucp"','idempotency-key':'event-one','webhook-id':'event-one','webhook-timestamp':String(Math.floor(Date.now()/1000))}};
it('round trips real RFC 9421 request and response signatures',async()=>{
 const signed=await signHttp(message,body,signer);expect(await verifyHttp(signed,body,[signer.publicJwk])).toBe('merchant');
 const response=await signHttp({status:202,headers:{'content-type':'application/json',etag:'"1"'}},body,signer);expect(await verifyHttp(response,body,[signer.publicJwk])).toBe('merchant');
 await expect(verifyHttp({...response,status:200},body,[signer.publicJwk])).rejects.toThrow();
});
it('binds raw bytes, identity, method, host, query, path and event id',async()=>{
 const signed=await signHttp(message,body,signer);
 for(const patch of [{method:'PUT'},{url:'https://evil.example/events?tenant=one'},{url:'https://platform.example/other?tenant=one'},{url:'https://platform.example/events?tenant=two'},{headers:{...signed.headers,'ucp-agent':'profile="https://evil.example/.well-known/ucp"'}},{headers:{...signed.headers,'webhook-id':'event-two'}}])await expect(verifyHttp({...signed,...patch},body,[signer.publicJwk])).rejects.toThrow();
 const altered=Buffer.from('{ "order":"one"}');await expect(verifyHttp(signed,altered,[signer.publicJwk])).rejects.toThrow('digest_mismatch');
 await expect(verifyHttp({...signed,headers:{...signed.headers,'content-digest':contentDigest(altered)}},altered,[signer.publicJwk])).rejects.toThrow();
});
it('rejects valid signatures with insufficient coverage or expired lifetime',async()=>{
 const key={id:signer.kid,alg:'ecdsa-p256-sha256',sign:async(bytes:Buffer)=>Buffer.from(await signer.sign(bytes))};
 const input={...message,headers:{...message.headers,'content-digest':contentDigest(body)}};
 const weak=await httpbis.signMessage({key,fields:['@method','@authority','@path']},input);
 await expect(verifyHttp(weak,body,[signer.publicJwk])).rejects.toThrow();
 const expired=await httpbis.signMessage({key,fields:['@method','@authority','@path','@query','ucp-agent','idempotency-key','webhook-id','webhook-timestamp','content-type','content-digest'],paramValues:{created:new Date(Date.now()-600000),expires:new Date(Date.now()-500000)}},input);
 await expect(verifyHttp(expired,body,[signer.publicJwk])).rejects.toThrow();
});
it('does not accept an unrelated enrolled key or lose a valid signature to a bad extra signature',async()=>{
 const signed=await signHttp(message,body,signer);
 await expect(verifyHttp(signed,body,[{...signer.publicJwk,kid:'different'}])).rejects.toThrow();
 const extra={...signed,headers:{...signed.headers,'signature-input':signed.headers['signature-input']+', invalid=("@method");keyid="unknown"',signature:signed.headers.signature+', invalid=:AA==:'}};
 expect(await verifyHttp(extra,body,[signer.publicJwk])).toBe('merchant');
});
