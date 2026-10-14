import {readFile,writeFile} from 'node:fs/promises';
for(const [name,exportName,file] of [['AgentPermissionRegistry','agentPermissionRegistryAbi','agent-registry-abi.ts'],['YoursPurchaseGate','yoursPurchaseGateAbi','yours-gate-abi.ts']]){
 const artifact=JSON.parse(await readFile(new URL('../packages/contracts/out/'+name+'.sol/'+name+'.json',import.meta.url),'utf8'));
 const output='// Generated from '+name+'.sol by scripts/sync-contracts.mjs.\nexport const '+exportName+' = '+JSON.stringify(artifact.abi,null,2)+' as const;\n';
 await writeFile(new URL('../packages/wallet-sdk/src/'+file,import.meta.url),output);
}
