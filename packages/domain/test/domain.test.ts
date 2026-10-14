import {describe,it,expect} from 'vitest';
import {authorize,atomicAmount,minorToAtomic,periodIndex,canonicalJson,digest,assertTransition,type Budget,type Permission} from '../src/index.js';
const budget:Budget={perOrder:'1000',perPeriod:'2000',periodStart:100,periodSeconds:60,validAfter:100,validUntil:500,status:'active'};
const permission:Permission={connectionId:'00000000-0000-4000-8000-000000000001',revision:1,perOrder:'800',perPeriod:'1200',validUntil:500,merchants:[{id:'shop',origin:'https://shop.example',payTo:'0x0000000000000000000000000000000000000001'}]};
const input={budget,permission,connectionActive:true,now:150,amount:'500',merchantId:'shop',payTo:permission.merchants[0].payTo,accountSpent:'0',accountReserved:'0',agentSpent:'0',agentReserved:'0'};
describe('authorization boundaries',()=>{
 it('checks reserved amounts as well as settled spends',()=>{
  expect(authorize(input).kind).toBe('allow');
  expect(authorize({...input,agentReserved:'701'})).toEqual({kind:'approval_required',reasons:['period_budget']});
  expect(authorize({...input,accountReserved:'1501'}).kind).toBe('approval_required');
 });
 it('cannot override revocation, expiry or pre-start',()=>{
  expect(authorize({...input,connectionActive:false})).toEqual({kind:'deny',reason:'inactive'});
  expect(authorize({...input,now:500})).toEqual({kind:'deny',reason:'expired'});
  expect(authorize({...input,now:99})).toEqual({kind:'deny',reason:'not_started'});
 });
 it('binds the merchant receiving address',()=>{
  expect(authorize({...input,payTo:'0x0000000000000000000000000000000000000002'})).toEqual({kind:'approval_required',reasons:['merchant']});
 });
 it('uses an immutable period anchor',()=>{
  expect(periodIndex(budget,159)).toBe(0);expect(periodIndex(budget,160)).toBe(1);
  expect(()=>periodIndex({...budget,periodSeconds:0},160)).toThrow();
 });
});
it('never uses floating point token quantities',()=>{
 expect(minorToAtomic(1000,'JPY',18)).toBe('1000000000000000000000');
 expect(minorToAtomic(1000,'USD',6)).toBe('10000000');
 for(const value of ['1.0','01','-1','1e18',(1n<<256n).toString()]) expect(atomicAmount.safeParse(value).success).toBe(false);
 expect(()=>minorToAtomic(Number.MAX_SAFE_INTEGER+1,'JPY',18)).toThrow();
});
it('canonicalizes nested signed payloads deterministically',()=>{
 expect(canonicalJson({z:1,a:[true,{b:2,a:1}]})).toBe('{"a":[true,{"a":1,"b":2}],"z":1}');
 expect(digest({b:2,a:1})).toBe(digest({a:1,b:2}));
 expect(()=>canonicalJson({a:undefined})).toThrow();
});
it('does not retry an ambiguous payment as a new payment',()=>{
 assertTransition('submitted','confirmed');
 expect(()=>assertTransition('submitted','authorized')).toThrow();
 expect(()=>assertTransition('confirmed','canceled')).toThrow();
});
