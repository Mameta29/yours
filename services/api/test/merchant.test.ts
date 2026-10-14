import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID,randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {createDb,migrate} from '@yours/storage';
import {sha256} from '@yours/domain';
import {verifyCheckout,verifyHttp,validateSchema} from '@yours/ucp';
import {createApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
const db=createDb(process.env.TEST_DATABASE_URL??'postgresql://localhost/yours_test');
const merchant=randomUUID(),account=randomUUID(),connection=randomUUID(),token=randomBytes(32).toString('base64url');
const config=readConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://localhost/yours_test',PUBLIC_ORIGIN:'http://localhost:8080',MERCHANT_ID:merchant,MERCHANT_PAY_TO:'0x0000000000000000000000000000000000000001'});
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const signer={kid:'merchant-test',publicJwk:{...pair.publicKey.export({format:'jwk'}),kid:'merchant-test',alg:'ES256',use:'sig'},sign:async(data:Uint8Array)=>new Uint8Array(sign('sha256',data,{key:pair.privateKey,dsaEncoding:'ieee-p1363'}))};
const app=createApp(db,config,signer);
const headers={'Content-Type':'application/json','UCP-Agent':'profile="'+config.PUBLIC_ORIGIN+'/.well-known/ucp"','Authorization':'Bearer '+token};
async function post(path:string,body:unknown,key=randomUUID(),more:Record<string,string>={}){
 return app.request('/ucp'+path,{method:'POST',headers:{...headers,'Idempotency-Key':key,...more},body:JSON.stringify(body)});
}
beforeAll(async()=>{
 await migrate(db);
 await db.query('INSERT INTO accounts(id,address,chain_id) VALUES($1,$2,80002)',[account,'0x'+randomBytes(20).toString('hex')]);
 await db.query("INSERT INTO connections(id,account_id,name,provider,token_hash,status) VALUES($1,$2,'test','external',$3,'active')",[connection,account,sha256(token)]);
 for(const [id,stock,shipping] of [['digital',3,false],['physical',10,true],['race',1,false]]){
  await db.query("INSERT INTO merchant_products(merchant_id,id,title,description,currency,amount_minor,stock,requires_shipping) VALUES($1,$2,'お茶','商品説明','JPY',500,$3,$4)",[merchant,id,stock,shipping]);
 }
});
afterAll(()=>db.end());
it('serves catalog search, lookup and detail with official schemas',async()=>{
 for(const [path,body,schema] of [['/catalog/search',{query:'お茶'},'shopping/catalog_search.json#/$defs/search_response'],['/catalog/lookup',{ids:['digital']},'shopping/catalog_lookup.json#/$defs/lookup_response'],['/catalog/product',{id:'digital'},'shopping/catalog_lookup.json#/$defs/get_product_response']] as const){
  const response=await post(path,body);expect(response.status).toBe(200);validateSchema(schema,await response.json());
 }
});
it('creates a real signed checkout once and refuses lost updates',async()=>{
 const body={line_items:[{item:{id:'digital'},quantity:1}]},key=randomUUID();
 const responses=await Promise.all([post('/checkout-sessions',body,key),post('/checkout-sessions',body,key)]);
 await verifyHttp({status:responses[0].status,headers:Object.fromEntries(responses[0].headers)},new Uint8Array(await responses[0].clone().arrayBuffer()),[signer.publicJwk]);
 const a=await responses[0].json(),b=await responses[1].json();expect(a).toEqual(b);expect(responses[0].status).toBe(201);
 await verifyCheckout(a,[signer.publicJwk]);
 const bad=await app.request('/ucp/checkout-sessions/'+a.id,{method:'PUT',headers:{...headers,'Idempotency-Key':randomUUID(),'If-Match':'"0"'},body:JSON.stringify(body)});
 expect(bad.status).toBe(412);
 const canceled=await post('/checkout-sessions/'+a.id+'/cancel',{});expect(canceled.status).toBe(200);expect((await canceled.json()).status).toBe('canceled');
});
it('holds the last item for only one concurrent checkout',async()=>{
 const request={line_items:[{item:{id:'race'},quantity:1}]};
 const results=await Promise.all([post('/checkout-sessions',request),post('/checkout-sessions',request)]);
 expect(results.map(r=>r.status).sort()).toEqual([201,409]);
});
it('converts a cart using its stored contents and protects it from other actors',async()=>{
 const cart=await (await post('/carts',{line_items:[{item:{id:'digital'},quantity:1}]})).json();
 const response=await post('/checkout-sessions',{cart_id:cart.id,line_items:[{item:{id:'nonexistent'},quantity:999}]});
 expect(response.status).toBe(201);expect((await response.json()).line_items[0].quantity).toBe(1);
 const other=randomUUID(),otherToken=randomBytes(32).toString('base64url');
 await db.query("INSERT INTO connections(id,account_id,name,provider,token_hash,status) VALUES($1,$2,'other','external',$3,'active')",[other,account,sha256(otherToken)]);
 const inaccessible=await app.request('/ucp/carts/'+cart.id,{headers:{...headers,Authorization:'Bearer '+otherToken}});
 expect(inaccessible.status).toBe(404);
});
it('requires a complete destination and selected shipping option before completion',async()=>{
 const first=await (await post('/checkout-sessions',{line_items:[{item:{id:'physical'},quantity:1}]})).json();
 expect(first.status).toBe('incomplete');
 const response=await app.request('/ucp/checkout-sessions/'+first.id,{method:'PUT',headers:{...headers,'Idempotency-Key':randomUUID(),'If-Match':'"1"'},body:JSON.stringify({
  line_items:[{id:'line-1',item:{id:'physical'},quantity:1}],
  fulfillment:{methods:[{id:'shipping',type:'shipping',line_item_ids:['line-1'],destinations:[{id:'home',address_country:'JP',address_region:'東京都',address_locality:'千代田区',street_address:'テスト1',postal_code:'1000000'}],selected_destination_id:'home',groups:[{id:'shipping-group',selected_option_id:'standard'}]}]}
 })});
 expect(response.status).toBe(200);const result=await response.json();expect(result.status).toBe('ready_for_complete');expect(result.totals.at(-1).amount).toBe(850);
 await verifyCheckout(result,[signer.publicJwk]);
});

it('publishes cacheable discovery and handler schemas and standard UCP errors',async()=>{
 for(const path of ['/.well-known/ucp','/schemas/stablecoin-handler.json','/payment-handler']){
  const response=await app.request(path);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('public, max-age=');
 }
 const error=await post('/catalog/product',{id:'does-not-exist'});expect(error.status).toBe(404);validateSchema('common/types/error_response.json',await error.json());
});

it('binds the authenticated API key to its enrolled UCP platform',async()=>{
 await db.query('UPDATE connections SET platform_profile=$2 WHERE id=$1',[connection,'https://different-platform.example/profile']);
 try{
  const response=await post('/carts',{line_items:[{item:{id:'digital'},quantity:1}]});
  expect(response.status).toBe(403);expect((await response.json()).messages[0].code).toBe('profile_identity_mismatch');
 }finally{await db.query('UPDATE connections SET platform_profile=NULL WHERE id=$1',[connection]);}
});
