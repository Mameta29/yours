import {it,expect} from 'vitest';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {publicKeyToAddress} from 'viem/accounts';
import {toHex,recoverAddress} from 'viem';
import {decodeDerSignature,evmSignature,crc32c} from '../src/index.js';
it('validates DER boundaries and CRC-32C test vector',()=>{
 expect(crc32c(new TextEncoder().encode('123456789'))).toBe(0xe3069283);
 expect(()=>decodeDerSignature(new Uint8Array([48,6,2,1,0,2,1,1]))).toThrow();
 expect(()=>decodeDerSignature(new Uint8Array([48,6,2,1,128,2,1,1]))).toThrow();
});
it('recovers a real secp256k1 signature and normalizes low-s',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'secp256k1'});
 const key=publicKey.export({format:'jwk'});
 const address=publicKeyToAddress(toHex(Buffer.concat([Buffer.from([4]),Buffer.from(key.x!,'base64url'),Buffer.from(key.y!,'base64url')])));
 const message=Buffer.from('real kms-compatible test input');
 const hash=toHex(createHash('sha256').update(message).digest());
 const der=sign('sha256',message,privateKey);
 const signature=await evmSignature(hash,der,address);
 expect(await recoverAddress({hash,signature})).toBe(address);
 await expect(evmSignature(hash,der,'0x0000000000000000000000000000000000000001')).rejects.toThrow('kms_signature_key_mismatch');
});
