import {it,expect} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {profile,negotiate,UCP_VERSION,AP2_CAPABILITY,validateSchema,validateRequest,authorizeCheckout,verifyCheckout,fetchProfile,parseAgentHeader} from '../src/index.js';
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const jwk={...pair.publicKey.export({format:'jwk'}),kid:'merchant-1'};
const signer={kid:'merchant-1',sign:async(input:Uint8Array)=>new Uint8Array(sign('sha256',input,{key:pair.privateKey,dsaEncoding:'ieee-p1363'}))};
const checkout={ucp:{version:UCP_VERSION,payment_handlers:{}},id:'c1',line_items:[{id:'l1',item:{id:'sku',title:'茶',price:500},quantity:2,totals:[{type:'total',amount:1000}]}],status:'ready_for_complete',currency:'JPY',totals:[{type:'subtotal',amount:1000},{type:'total',amount:1000}],links:[]};
it('validates real stable-version profiles and negotiates AP2',()=>{
 const business=profile('https://shop.example','business',[jwk]);
 const platform=profile('https://yours.example','platform',[jwk]);
 expect(negotiate(business,platform)[AP2_CAPABILITY]).toBeDefined();
 delete platform.ucp.capabilities[AP2_CAPABILITY];expect(()=>negotiate(business,platform)).toThrow('mandate_required');
});
it('rejects private keys in discovery',()=>{
 expect(()=>profile('https://shop.example','business',[{...jwk,d:'secret'}])).toThrow('ucp_schema_invalid');
});
it('validates checkout and derives nested request fields from official annotations',()=>{
 validateSchema('shopping/checkout.json',checkout);
 validateRequest('checkout','create',{line_items:[{item:{id:'sku'},quantity:1}]});
 expect(()=>validateRequest('checkout','create',{line_items:[{item:{id:'sku',price:1},quantity:1}]})).toThrow();
 expect(()=>validateRequest('checkout','create',{line_items:[{item:{id:'sku'},quantity:1.5}]})).toThrow();
 expect(()=>validateRequest('checkout','complete',{})).toThrow();
 validateRequest('checkout','complete',{payment:{instruments:[]}});
});
it('verifies merchant ES256 signatures and rejects changed prices and injected keys',async()=>{
 const signed={...checkout,ap2:{merchant_authorization:await authorizeCheckout(checkout,signer)}};
 expect((await verifyCheckout(signed,[jwk])).split('.')).toHaveLength(3);
 await expect(verifyCheckout({...signed,totals:[{type:'total',amount:1}]},[jwk])).rejects.toThrow('merchant_authorization_invalid');
 await expect(verifyCheckout(signed,[{...jwk,kid:'wrong'}])).rejects.toThrow();
});
it('does not fetch an attacker-controlled profile',async()=>{
 await expect(fetchProfile('http://169.254.169.254/computeMetadata/v1',new Set())).rejects.toThrow('profile_origin_not_allowed');
 expect(parseAgentHeader('profile="https://yours.example/.well-known/ucp"')).toBe('https://yours.example/.well-known/ucp');
 expect(()=>parseAgentHeader('profile="https://a.example", profile="https://b.example"')).toThrow();
});
